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
    """Auto-generate a challan number from CompanySettings. Returns '' on failure."""
    try:
        from .models import CompanySettings, generate_challan_number
        settings_obj = CompanySettings.objects.first()
        if settings_obj:
            return generate_challan_number(settings_obj)
    except Exception as ex:
        print("Warning: could not generate truck challan number:", ex)
    return ''


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
@permission_classes([IsAuthenticated])
def conference_trucks(request, pk):
    """
    GET  /api/conferences/{pk}/trucks/  - list trucks for this conference
    POST /api/conferences/{pk}/trucks/  - add next truck
    """
    conference = get_object_or_404(Conference, pk=pk)

    if request.method == 'GET':
        _heal_unassigned_conference_assets(conference)
        trucks = TruckChallan.objects.filter(conference=conference).prefetch_related('assets').order_by('truck_number')
        for t in trucks:
            if not t.challan_number:
                if t.truck_number == 1 and conference.challan_number:
                    t.challan_number = conference.challan_number
                else:
                    t.challan_number = _get_next_challan_number()
                if t.challan_number:
                    t.save(update_fields=['challan_number'])
        return Response([_serialize_truck(t) for t in trucks])

    elif request.method == 'POST':
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
                conference.challan_assets.set(initial_ids)

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

        _heal_unassigned_conference_assets(conference)
        trucks = TruckChallan.objects.filter(conference=conference).prefetch_related('assets').order_by('truck_number')
        return Response([_serialize_truck(t) for t in trucks], status=201)


@api_view(['PATCH', 'DELETE'])
@permission_classes([IsAuthenticated])
def truck_challan_detail(request, truck_pk):
    """
    PATCH  /api/truck-challans/{truck_pk}/  - update vehicle/driver/label/assets/challan_number/asset_quantities
    DELETE /api/truck-challans/{truck_pk}/  - delete ALL trucks for this conference (resets to main challan)
    """
    truck = get_object_or_404(TruckChallan, pk=truck_pk)

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
            truck.challan_number = str(data['challan_number']).strip()
        if 'asset_quantities' in data and isinstance(data['asset_quantities'], dict):
            truck.asset_quantities = data['asset_quantities']
        truck.save()

        if 'assets' in data:
            clean_ids = [int(aid) for aid in data['assets'] if str(aid).isdigit()]
            truck.assets.set(clean_ids)

        return Response(_serialize_truck(truck))

    elif request.method == 'DELETE':
        # Per specification: deleting any truck resets all trucks for that conference back to main challan only
        conference = truck.conference
        TruckChallan.objects.filter(conference=conference).delete()
        return Response({'status': 'all_trucks_deleted', 'conference_id': conference.pk})


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def truck_transfer_assets(request, truck_pk):
    """
    POST /api/truck-challans/{truck_pk}/transfer/
    Body:
      { "to_truck_id": 5, "asset_ids": [1, 2, 3] }
      OR
      { "to_truck_id": 5, "transfers": [{ "asset_id": 1, "quantity": 1 }] }
    """
    source_truck = get_object_or_404(TruckChallan, pk=truck_pk)
    to_truck_id = request.data.get('to_truck_id')
    raw_transfers = request.data.get('transfers')
    raw_asset_ids = request.data.get('asset_ids', [])

    if not to_truck_id or (not raw_transfers and not raw_asset_ids):
        return Response({'error': 'to_truck_id and either transfers or asset_ids required'}, status=400)

    try:
        to_truck_id = int(to_truck_id)
    except (ValueError, TypeError):
        return Response({'error': 'Invalid to_truck_id'}, status=400)

    dest_truck = get_object_or_404(TruckChallan, pk=to_truck_id, conference=source_truck.conference)

    items_to_transfer = []
    if raw_transfers and isinstance(raw_transfers, list):
        for item in raw_transfers:
            try:
                aid = int(item.get('asset_id'))
                qty = int(item.get('quantity', 1))
                if qty > 0:
                    items_to_transfer.append((aid, qty))
            except (ValueError, TypeError):
                continue
    elif raw_asset_ids:
        for aid_raw in raw_asset_ids:
            if str(aid_raw).isdigit():
                items_to_transfer.append((int(aid_raw), None))

    if not items_to_transfer:
        return Response({'error': 'No valid assets to transfer'}, status=400)

    source_quantities = dict(source_truck.asset_quantities or {})
    dest_quantities = dict(dest_truck.asset_quantities or {})

    assets_to_fetch = [aid for aid, _ in items_to_transfer]
    asset_map = {a.pk: a for a in Asset.objects.filter(pk__in=assets_to_fetch)}

    for aid, requested_qty in items_to_transfer:
        asset = asset_map.get(aid)
        if not asset:
            continue

        aid_str = str(aid)
        base_qty = int(asset.quantity or 1)

        # Current quantity in source truck
        if aid_str in source_quantities:
            current_src_qty = int(source_quantities[aid_str])
        else:
            current_src_qty = base_qty

        if current_src_qty <= 0:
            continue

        qty_to_move = current_src_qty if requested_qty is None else min(int(requested_qty), current_src_qty)
        if qty_to_move <= 0:
            continue

        new_src_qty = current_src_qty - qty_to_move
        if new_src_qty <= 0:
            source_truck.assets.remove(asset)
            source_quantities.pop(aid_str, None)
        else:
            source_quantities[aid_str] = new_src_qty

        dest_truck.assets.add(asset)
        current_dest_qty = int(dest_quantities.get(aid_str, 0))
        dest_quantities[aid_str] = current_dest_qty + qty_to_move

    source_truck.asset_quantities = source_quantities
    source_truck.save(update_fields=['asset_quantities'])

    dest_truck.asset_quantities = dest_quantities
    dest_truck.save(update_fields=['asset_quantities'])

    return Response({
        'source': _serialize_truck(source_truck),
        'dest': _serialize_truck(dest_truck),
    })


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def add_asset_to_truck(request, pk):
    """
    POST /api/conferences/{pk}/trucks/add-to-truck/
    POST /api/conferences/{pk}/trucks/add-to-truck1/
    Body: { "asset_ids": [1, 2, 3], "truck_id": 5 (optional), "truck_number": 2 (optional) }
    Adds new assets to the designated truck (or latest truck if unspecified) of this conference.
    """
    conference = get_object_or_404(Conference, pk=pk)
    raw_asset_ids = request.data.get('asset_ids', [])
    clean_asset_ids = [int(aid) for aid in raw_asset_ids if str(aid).isdigit()]
    truck_id = request.data.get('truck_id')
    truck_number = request.data.get('truck_number')

    target_truck = None
    if truck_id:
        target_truck = TruckChallan.objects.filter(conference=conference, pk=truck_id).first()
    elif truck_number:
        target_truck = TruckChallan.objects.filter(conference=conference, truck_number=truck_number).first()

    if not target_truck:
        target_truck = TruckChallan.objects.filter(conference=conference).order_by('-truck_number').first()

    if target_truck and clean_asset_ids:
        target_truck.assets.add(*clean_asset_ids)
        return Response({
            'status': 'added',
            'truck_id': target_truck.pk,
            'truck_number': target_truck.truck_number,
            'label': target_truck.label or f"Truck {target_truck.truck_number}"
        })
    return Response({'status': 'no_truck_or_no_assets'})

# Backwards compatibility alias
add_asset_to_truck1 = add_asset_to_truck


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def release_audit_conference_locks(request, pk):
    """
    POST /api/conferences/{pk}/release-audit-locks/

    For an audit conference (is_audit=True), releases all assets that are
    still marked as 'In Use' in the DB but are not held by any other
    non-audit conference.

    This is safe to call multiple times — it is idempotent.
    Returns a count of assets released.
    """
    conference = get_object_or_404(Conference, pk=pk)

    if not conference.is_audit:
        return Response(
            {'error': 'This conference is not marked as an audit conference.'},
            status=400
        )

    # All assets in this audit conference (assets M2M)
    audit_asset_ids = set(conference.assets.values_list('pk', flat=True))
    # Also include challan_assets — they may have been stamped In Use before is_audit was set
    challan_asset_ids = set(conference.challan_assets.values_list('pk', flat=True))
    all_candidate_ids = audit_asset_ids | challan_asset_ids

    if not all_candidate_ids:
        return Response({'released': 0, 'message': 'No assets found in this audit conference.'})

    # Find assets held by other NON-audit conferences via assets or crosscheck_assets
    locked_by_others = set(
        Conference.objects
        .exclude(pk=conference.pk)
        .exclude(is_audit=True)
        .filter(assets__in=all_candidate_ids)
        .values_list('assets__id', flat=True)
    )
    crosscheck_locked = set(
        Conference.objects
        .exclude(pk=conference.pk)
        .filter(crosscheck_assets__in=all_candidate_ids)
        .values_list('crosscheck_assets__id', flat=True)
    )
    genuinely_locked = locked_by_others | crosscheck_locked

    # Safe to release: in audit conf but NOT locked by anyone else, and currently In Use
    safe_to_release = [
        aid for aid in all_candidate_ids
        if aid not in genuinely_locked
    ]

    released_count = 0
    if safe_to_release:
        released_count = Asset.objects.filter(
            pk__in=safe_to_release,
            status='In Use'
        ).update(status='Available')

    return Response({
        'released': released_count,
        'total_candidates': len(all_candidate_ids),
        'skipped_still_locked_elsewhere': len(genuinely_locked & all_candidate_ids),
        'message': f'Successfully released {released_count} asset(s) from audit conference lock.'
    })
