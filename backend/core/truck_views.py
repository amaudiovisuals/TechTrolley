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


@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
def conference_trucks(request, pk):
    """
    GET  /api/conferences/{pk}/trucks/  - list trucks for this conference
    POST /api/conferences/{pk}/trucks/  - add next truck
    """
    conference = get_object_or_404(Conference, pk=pk)

    if request.method == 'GET':
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
            # First time: create Truck 1 with all current challan_assets, and Truck 2 empty.
            # Truck 1 inherits the conference's existing challan_number.
            # Truck 2 gets a fresh new challan number from the sequence.
            truck1 = TruckChallan.objects.create(
                conference=conference,
                truck_number=1,
                label='Truck 1',
                vehicle_number=conference.vehicle_number or '',
                driver_phone=conference.driver_phone or '',
                challan_number=conference.challan_number or _get_next_challan_number(),
            )
            # Initialize Truck 1 with all challan_assets (or assets if challan_assets is empty)
            challan_ids = list(conference.challan_assets.values_list('pk', flat=True))
            if not challan_ids:
                challan_ids = list(conference.assets.values_list('pk', flat=True))
            if challan_ids:
                truck1.assets.set(challan_ids)

            # Create Truck 2 (empty) with its own next challan number
            TruckChallan.objects.create(
                conference=conference,
                truck_number=2,
                label='Truck 2',
                vehicle_number='',
                driver_phone='',
                challan_number=_get_next_challan_number(),
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
            )

        trucks = TruckChallan.objects.filter(conference=conference).prefetch_related('assets').order_by('truck_number')
        return Response([_serialize_truck(t) for t in trucks], status=201)


@api_view(['PATCH', 'DELETE'])
@permission_classes([IsAuthenticated])
def truck_challan_detail(request, truck_pk):
    """
    PATCH  /api/truck-challans/{truck_pk}/  - update vehicle/driver/label/assets/challan_number
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
    Body: { "to_truck_id": 5, "asset_ids": [1, 2, 3] }
    """
    source_truck = get_object_or_404(TruckChallan, pk=truck_pk)
    to_truck_id = request.data.get('to_truck_id')
    raw_asset_ids = request.data.get('asset_ids', [])

    if not to_truck_id or not raw_asset_ids:
        return Response({'error': 'to_truck_id and asset_ids required'}, status=400)

    try:
        to_truck_id = int(to_truck_id)
        asset_ids = [int(aid) for aid in raw_asset_ids if str(aid).isdigit()]
    except (ValueError, TypeError):
        return Response({'error': 'Invalid to_truck_id or asset_ids'}, status=400)

    dest_truck = get_object_or_404(TruckChallan, pk=to_truck_id, conference=source_truck.conference)

    # Atomically transfer
    source_truck.assets.remove(*asset_ids)
    dest_truck.assets.add(*asset_ids)

    from .serializers import AssetSerializer
    return Response({
        'source': {
            'id': source_truck.pk,
            'truck_number': source_truck.truck_number,
            'assets': list(source_truck.assets.values_list('pk', flat=True)),
            'assets_details': AssetSerializer(source_truck.assets.all(), many=True).data,
        },
        'dest': {
            'id': dest_truck.pk,
            'truck_number': dest_truck.truck_number,
            'assets': list(dest_truck.assets.values_list('pk', flat=True)),
            'assets_details': AssetSerializer(dest_truck.assets.all(), many=True).data,
        },
    })


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def add_asset_to_truck1(request, pk):
    """
    POST /api/conferences/{pk}/trucks/add-to-truck1/
    Body: { "asset_ids": [1, 2, 3] }
    Adds new assets to Truck 1 of this conference if trucks exist.
    """
    conference = get_object_or_404(Conference, pk=pk)
    raw_asset_ids = request.data.get('asset_ids', [])
    clean_asset_ids = [int(aid) for aid in raw_asset_ids if str(aid).isdigit()]

    truck1 = TruckChallan.objects.filter(conference=conference, truck_number=1).first()
    if truck1 and clean_asset_ids:
        truck1.assets.add(*clean_asset_ids)
        return Response({'status': 'added', 'truck_id': truck1.pk})
    return Response({'status': 'no_truck1_or_no_assets'})


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
