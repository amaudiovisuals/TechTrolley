from .serializers import ConferenceSerializer
from django.db import transaction
from .permissions import TruckMembershipPermission, WarehouseWriteAuthenticatedRead
"""
Views for TruckChallan CRUD and asset transfer between trucks.
"""
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from django.shortcuts import get_object_or_404
from .models import Conference, TruckChallan, Asset


def _serialize_truck(t):
    from .serializers import AssetSerializer
    return {
        'conference_revision': Conference.objects.get(pk=t.conference_id).revision,
        'id': t.pk,
        'conference': t.conference_id,
        'truck_number': t.truck_number,
        'label': t.label or f"Truck {t.truck_number}",
        'vehicle_number': t.vehicle_number or '',
        'driver_phone': t.driver_phone or '',
        # J-113: Each truck has its own challan number
        'challan_number': t.challan_number or '',
        'assets': list(t.assets.values_list('pk', flat=True)),
        'asset_quantities': t.asset_quantities or {},
        'assets_details': AssetSerializer(t.assets.all(), many=True).data,
        'created_at': t.created_at.isoformat() if t.created_at else '',
    }


def _get_next_challan_number():
    from .challan_documents import allocate_number
    return allocate_number()


def _heal_unassigned_conference_assets(conference):
    """
    Ensure any asset associated with the conference (challan_assets, assets, staged_assets)
    that is not yet assigned to ANY truck is automatically assigned to the latest active truck
    (or Truck 1 if only one truck exists).
    """
    try:
        target_truck = TruckChallan.objects.filter(conference=conference).order_by('-truck_number').first()
        if not target_truck:
            return
        all_truck_assigned = set(
            TruckChallan.objects.filter(conference=conference)
            .values_list('assets__pk', flat=True)
        )
        all_master = (
            set(conference.challan_assets.values_list('pk', flat=True)) |
            set(conference.assets.values_list('pk', flat=True)) |
            set(conference.staged_assets.values_list('pk', flat=True))
        )
        all_master.discard(None)
        unassigned = all_master - all_truck_assigned
        if unassigned:
            target_truck.assets.add(*unassigned)
    except Exception as ex:
        print("Warning in _heal_unassigned_conference_assets:", ex)


@api_view(['GET', 'POST'])
@permission_classes([WarehouseWriteAuthenticatedRead])
@transaction.atomic
def conference_trucks(request, pk):
    """
    GET  /api/conferences/{pk}/trucks/  - list trucks for this conference
    POST /api/conferences/{pk}/trucks/  - add next truck
    """
    conference = get_object_or_404(Conference, pk=pk)

    if request.method == 'GET':
        trucks = TruckChallan.objects.filter(conference=conference).prefetch_related('assets').order_by('truck_number')
        return Response([_serialize_truck(t) for t in trucks])

    elif request.method == 'POST':
        expected = request.data.get('expected_revision')
        if expected is None: return Response({'error': 'expected_revision_required'}, status=428)
        if isinstance(expected, bool) or not str(expected).isdigit(): return Response({'error': 'invalid_expected_revision'}, status=400)
        from .revisions import lock_conference_for_write
        conference = lock_conference_for_write(pk, {'challan_assets': request.data.get('asset_ids', [])})
        from .challan_lock import challans_locked
        if challans_locked(conference):
            return Response({'error': 'challan_edit_window_closed'}, status=409)
        if conference.lifecycle_state != 'open':
            return Response({'error': 'event_is_sealed'}, status=409)
        from .models import TruckManifest
        if TruckManifest.objects.filter(conference=conference).exists():
            return Response({'error': 'use_manifest_commands'}, status=409)
        if conference.revision != int(expected): return Response({'error': 'document_changed', 'revision': conference.revision}, status=409)
        if conference.quantity_allocations.exists():
            return Response({'error': 'quantity_trucks_require_coordinated_workflow'}, status=409)
        if Asset.objects.filter(pk__in=[int(aid) for aid in request.data.get('asset_ids', []) if str(aid).isdigit()], stock_kind='led_case').exists():
            return Response({'error':'select_led_case_panels_not_historical_box'}, status=409)
        if (conference.consumable_allocations.exists() or conference.consumable_data
                or conference.challan_assets.filter(type='Consumables').exists()
                or conference.assets.filter(type='Consumables').exists()
                or conference.staged_assets.filter(type='Consumables').exists()
                or Asset.objects.filter(pk__in=[int(aid) for aid in request.data.get('asset_ids', []) if str(aid).isdigit()], type='Consumables').exists()):
            return Response({'error': 'consumable_trucks_require_coordinated_workflow'}, status=409)
        existing = list(TruckChallan.objects.filter(conference=conference).order_by('truck_number'))

        if not existing:
            # First time: create Truck 1 with all master assets, and Truck 2 empty.
            # Truck 1 inherits the conference's existing challan_number.
            # Truck 2 gets a fresh new challan number from the sequence.
            truck1 = TruckChallan.objects.create(
                conference=conference,
                truck_number=1,
                label='Truck 1',
                vehicle_number=conference.vehicle_number or '',
                driver_phone=conference.driver_phone or '',
                challan_number=conference.challan_number or _get_next_challan_number(),
                asset_quantities={},
            )
            # Accept asset_ids explicitly passed from frontend (which matches master challan view),
            # or compute union of all conference asset relations so zero items are missed.
            raw_passed_ids = request.data.get('asset_ids', [])
            passed_ids = [int(aid) for aid in raw_passed_ids if str(aid).isdigit()]
            if passed_ids:
                initial_ids = set(passed_ids)
            else:
                initial_ids = (
                    set(conference.challan_assets.values_list('pk', flat=True)) |
                    set(conference.assets.values_list('pk', flat=True)) |
                    set(conference.staged_assets.values_list('pk', flat=True))
                )
            initial_ids.discard(None)
            if initial_ids:
                truck1.assets.set(initial_ids)
                conference.challan_assets.add(*initial_ids)

            # Create Truck 2 (empty) with its own next challan number
            TruckChallan.objects.create(
                conference=conference,
                truck_number=2,
                label='Truck 2',
                vehicle_number='',
                driver_phone='',
                challan_number=_get_next_challan_number(),
                asset_quantities={},
            )
        else:
            next_num = max(t.truck_number for t in existing) + 1
            TruckChallan.objects.create(
                conference=conference,
                truck_number=next_num,
                label=f'Truck {next_num}',
                vehicle_number='',
                driver_phone='',
                challan_number=_get_next_challan_number(),
                asset_quantities={},
            )

        trucks = TruckChallan.objects.filter(conference=conference).prefetch_related('assets').order_by('truck_number')
        return Response([_serialize_truck(t) for t in trucks], status=201)


@api_view(['PATCH', 'DELETE'])
@permission_classes([TruckMembershipPermission])
@transaction.atomic
def truck_challan_detail(request, truck_pk):
    """
    PATCH  /api/truck-challans/{truck_pk}/  - update vehicle/driver/label/assets/challan_number/asset_quantities
    DELETE /api/truck-challans/{truck_pk}/  - delete ALL trucks for this conference (resets to main challan)
    """
    truck = get_object_or_404(TruckChallan, pk=truck_pk)

    from .revisions import lock_conference_for_write
    expected = request.data.get('expected_revision')
    if expected is None:
        return Response({'error': 'expected_revision_required'}, status=428)
    conference = lock_conference_for_write(truck.conference_id, request.data)
    from .challan_lock import challans_locked
    if challans_locked(conference):
        return Response({'error': 'challan_edit_window_closed'}, status=409)
    if conference.lifecycle_state != 'open':
        return Response({'error': 'event_is_sealed'}, status=409)
    if isinstance(expected, bool) or not str(expected).isdigit() or int(expected) != conference.revision:
        return Response({'error': 'document_changed', 'revision': conference.revision}, status=409)
    truck = TruckChallan.objects.select_for_update().get(pk=truck_pk)
    from .models import TruckManifest
    if TruckManifest.objects.filter(conference=conference).exists() and (request.method == 'DELETE' or {'assets', 'asset_quantities', 'challan_number'} & set(request.data)):
        return Response({'error': 'use_manifest_commands'}, status=409)
    if Asset.objects.filter(pk__in=[int(aid) for aid in request.data.get('assets', []) if str(aid).isdigit()], stock_kind='led_case').exists():
        return Response({'error':'select_led_case_panels_not_historical_box'}, status=409)
    has_consumables = (conference.consumable_allocations.exists() or conference.consumable_data
                       or truck.assets.filter(type='Consumables').exists()
                       or Asset.objects.filter(pk__in=[int(aid) for aid in request.data.get('assets', []) if str(aid).isdigit()], type='Consumables').exists())
    if has_consumables and (request.method == 'DELETE' or {'assets', 'asset_quantities', 'challan_number'} & set(request.data)):
        return Response({'error': 'consumable_trucks_require_coordinated_workflow'}, status=409)
    if conference.challan_documents.filter(truck__isnull=False).exists():
        if request.method == 'DELETE':
            return Response({'error': 'trucks_have_document_history'}, status=409)
        if {'assets', 'asset_quantities', 'challan_number'} & set(request.data):
            return Response({'error': 'use_challan_document'}, status=409)
    if request.method == 'PATCH':
        data = request.data
        if 'vehicle_number' in data:
            truck.vehicle_number = str(data['vehicle_number']).strip()
        if 'driver_phone' in data:
            truck.driver_phone = str(data['driver_phone']).strip()
        if 'label' in data:
            truck.label = str(data['label']).strip()
        # J-113: Allow patching the truck's own challan number independently
        if 'challan_number' in data:
            from .challan_documents import reserve_number
            from .asset_commands import CommandError
            try:
                truck.challan_number = reserve_number(str(data['challan_number']).strip(), conference, truck)
            except CommandError as error:
                return Response({'error': error.code}, status=error.status)
        if 'asset_quantities' in data and isinstance(data['asset_quantities'], dict):
            truck.asset_quantities = data['asset_quantities']
        truck.save()

        if 'assets' in data:
            conference.challan_assets.add(*list(truck.assets.values_list('pk', flat=True)))
            clean_ids = [int(aid) for aid in data['assets'] if str(aid).isdigit()]
            truck.assets.set(clean_ids)

        return Response({**_serialize_truck(truck), 'conference': ConferenceSerializer(Conference.objects.get(pk=conference.pk)).data})

    elif request.method == 'DELETE':
        # Per specification: deleting any truck resets all trucks for that conference back to main challan only
        conference = truck.conference
        prior_ids = set(TruckChallan.objects.filter(conference=conference).values_list('assets__pk', flat=True)) - {None}
        conference.challan_assets.add(*prior_ids)
        TruckChallan.objects.filter(conference=conference).delete()
        return Response({'status': 'all_trucks_deleted', 'conference_id': conference.pk})


@api_view(['POST'])
@permission_classes([WarehouseWriteAuthenticatedRead])
def truck_transfer_assets(request, truck_pk):
    from .truck_transfer import transfer_truck_allocation
    from .asset_commands import CommandError
    try:
        return Response(transfer_truck_allocation(request.user, truck_pk, request.data))
    except CommandError as error:
        return Response({'error': error.code, 'conflicts': error.details}, status=error.status)


@api_view(['POST'])
@permission_classes([TruckMembershipPermission])
@transaction.atomic
def add_asset_to_truck(request, pk):
    """
    POST /api/conferences/{pk}/trucks/add-to-truck/
    POST /api/conferences/{pk}/trucks/add-to-truck1/
    Body: { "asset_ids": [1, 2, 3], "truck_id": 5 (optional), "truck_number": 2 (optional) }
    Adds new assets to the designated truck (or latest truck if unspecified) of this conference.
    """
    expected = request.data.get('expected_revision')
    if expected is None: return Response({'error': 'expected_revision_required'}, status=428)
    if isinstance(expected, bool) or not str(expected).isdigit(): return Response({'error': 'invalid_expected_revision'}, status=400)
    from .revisions import lock_conference_for_write
    conference = lock_conference_for_write(pk, {'challan_assets': request.data.get('asset_ids', [])})
    from .challan_lock import challans_locked
    if challans_locked(conference):
        return Response({'error': 'challan_edit_window_closed'}, status=409)
    if conference.lifecycle_state != 'open':
        return Response({'error': 'event_is_sealed'}, status=409)
    from .models import TruckManifest
    if TruckManifest.objects.filter(conference=conference).exists():
        return Response({'error': 'use_manifest_commands'}, status=409)
    if conference.revision != int(expected): return Response({'error': 'document_changed', 'revision': conference.revision}, status=409)
    raw_asset_ids = request.data.get('asset_ids', [])
    clean_asset_ids = [int(aid) for aid in raw_asset_ids if str(aid).isdigit()]
    if Asset.objects.filter(pk__in=clean_asset_ids, stock_kind='led_case').exists():
        return Response({'error':'select_led_case_panels_not_historical_box'}, status=409)
    if (conference.consumable_allocations.exists() or conference.consumable_data
            or Asset.objects.filter(pk__in=clean_asset_ids, type='Consumables').exists()):
        return Response({'error': 'consumable_trucks_require_coordinated_workflow'}, status=409)
    truck_id = request.data.get('truck_id')
    truck_number = request.data.get('truck_number')

    target_truck = None
    if truck_id:
        target_truck = TruckChallan.objects.filter(conference=conference, pk=truck_id).first()
    elif truck_number:
        target_truck = TruckChallan.objects.filter(conference=conference, truck_number=truck_number).first()

    if not target_truck:
        target_truck = TruckChallan.objects.filter(conference=conference).order_by('-truck_number').first()

    if (truck_id or truck_number) and target_truck and ((truck_id and str(target_truck.pk) != str(truck_id)) or (truck_number and str(target_truck.truck_number) != str(truck_number))):
        return Response({'error': 'requested_truck_not_found'}, status=404)
    if target_truck and clean_asset_ids:
        target_truck = TruckChallan.objects.select_for_update().get(pk=target_truck.pk)
        target_truck.assets.add(*clean_asset_ids)
        return Response({
            'status': 'added',
            'conference': ConferenceSerializer(Conference.objects.get(pk=pk)).data,
            'conference_revision': Conference.objects.get(pk=pk).revision,
            'truck_id': target_truck.pk,
            'truck_number': target_truck.truck_number,
            'label': target_truck.label or f"Truck {target_truck.truck_number}"
        })
    return Response({'status': 'no_truck_or_no_assets'})

# Backwards compatibility alias
add_asset_to_truck1 = add_asset_to_truck


@api_view(['POST'])
@permission_classes([WarehouseWriteAuthenticatedRead])
def release_audit_conference_locks(request, pk):
    # Keep old clients from invoking an unreviewed status backfill.
    get_object_or_404(Conference, pk=pk)
    return Response({'error': 'reviewed_custody_repair_required',
                     'review_url': f'/api/conferences/{pk}/custody-review/',
                     'message': 'Review current custody and verify selected records before any status repair.'}, status=409)
