"""
Asset Transfer API View — TechTrolley
POST /api/conferences/<pk>/transfer-assets/

Atomically transfers a set of assets from one conference's active packup list
to another conference's packup list. Also:
  - Freezes the source challan (challan_assets) if not already frozen
  - Appends full audit entries to transfer_log on both source and target conferences
  - Blocks transfer of assets currently in crosscheck
  - Returns updated serialized data for both conferences so the frontend can
    update its local state without a full refetch
"""

import traceback
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.response import Response
from django.shortcuts import get_object_or_404
from .models import Asset, Conference
from .serializers import ConferenceSerializer


@api_view(['POST'])
def asset_transfer(request, pk):
    """
    Transfer assets from one conference (source) to another (target).

    Request body (JSON):
    {
        "asset_ids": [12, 45, 67],          # IDs of assets to transfer
        "target_conference_id": 88,          # ID of the destination conference
        "from_address": "HICC Hyderabad"     # Optional: location from where they dispatch
    }

    Returns:
    {
        "success": true,
        "transferred_count": 3,
        "source_conference": { ...ConferenceSerializer data... },
        "target_conference": { ...ConferenceSerializer data... }
    }
    """
    try:
        source_conf = get_object_or_404(Conference, pk=pk)

        # ── Parse & Validate Input ──────────────────────────────────────────
        raw_asset_ids = request.data.get('asset_ids', [])
        target_conference_id = request.data.get('target_conference_id')
        from_address = request.data.get('from_address', '').strip()

        if not raw_asset_ids:
            return Response({'error': 'asset_ids is required and must be a non-empty list.'}, status=400)

        if not target_conference_id:
            return Response({'error': 'target_conference_id is required.'}, status=400)

        # Convert all IDs to int, ignore bad values
        try:
            asset_ids_int = [int(aid) for aid in raw_asset_ids]
        except (TypeError, ValueError):
            return Response({'error': 'asset_ids must be a list of integer IDs.'}, status=400)

        if int(target_conference_id) == pk:
            return Response({'error': 'Source and target conference cannot be the same.'}, status=400)

        target_conf = get_object_or_404(Conference, pk=target_conference_id)

        # Block transfer to audit conferences
        if target_conf.is_audit:
            return Response(
                {'error': 'Cannot transfer assets to an audit conference. '
                          'Audit conferences do not lock assets, which would break tracking.'},
                status=400
            )

        # ── Guard 1: All requested assets must be in source conference ──────
        source_asset_ids = set(source_conf.assets.values_list('pk', flat=True))
        invalid_ids = [aid for aid in asset_ids_int if aid not in source_asset_ids]
        if invalid_ids:
            return Response(
                {'error': f'The following asset IDs are not in this conference\'s active packup list: {invalid_ids}'},
                status=400
            )

        # ── Guard 2: Block assets currently in crosscheck ───────────────────
        crosscheck_ids = set(source_conf.crosscheck_assets.values_list('pk', flat=True))
        in_crosscheck = [aid for aid in asset_ids_int if aid in crosscheck_ids]
        if in_crosscheck:
            return Response(
                {'error': f'The following assets are currently in Crosscheck and cannot be transferred until verified: {in_crosscheck}'},
                status=400
            )

        # ── Step 1: Freeze challan_assets if not already frozen ─────────────
        # challan_assets is the permanent dispatch record. If it's empty, we snapshot
        # the current full asset list before making any changes. Once frozen, it is
        # never overwritten (subsequent transfers only shrink the active assets list).
        current_challan_ids = list(source_conf.challan_assets.values_list('pk', flat=True))
        challan_was_frozen = bool(current_challan_ids)
        if not challan_was_frozen:
            # Snapshot the FULL current assets list as the dispatch record
            source_conf.challan_assets.set(list(source_asset_ids))

        # ── Step 2: Remove assets from source conference ─────────────────────
        source_conf.assets.remove(*asset_ids_int)

        # ── Step 3: Add assets to target conference ──────────────────────────
        target_conf.assets.add(*asset_ids_int)
        # Asset status remains 'In Use' throughout — they move from one active
        # conference to another. No status change needed.

        # ── Step 4: Build human-readable asset names for the log ────────────
        transferred_assets = Asset.objects.filter(pk__in=asset_ids_int)
        asset_names = [
            a.alias_name or a.sku or str(a.pk)
            for a in transferred_assets
        ]

        timestamp = timezone.now().isoformat()
        transferred_by = (
            request.user.username
            if request.user and request.user.is_authenticated
            else 'system'
        )

        # ── Step 5: Append outgoing log to source conference ─────────────────
        outgoing_entry = {
            'timestamp': timestamp,
            'direction': 'outgoing',
            'transferred_asset_ids': asset_ids_int,
            'asset_names': asset_names,
            'to_conference_id': target_conf.pk,
            'to_conference_name': target_conf.name,
            'from_address': from_address,
            'to_address': target_conf.transport_address or target_conf.billing_address or '',
            'transferred_by': transferred_by,
            'challan_was_already_frozen': challan_was_frozen,
        }
        source_log = list(source_conf.transfer_log or [])
        source_log.append(outgoing_entry)
        source_conf.transfer_log = source_log
        source_conf.save(update_fields=['transfer_log'])

        # ── Step 6: Append incoming log to target conference ─────────────────
        incoming_entry = {
            'timestamp': timestamp,
            'direction': 'incoming',
            'transferred_asset_ids': asset_ids_int,
            'asset_names': asset_names,
            'from_conference_id': source_conf.pk,
            'from_conference_name': source_conf.name,
            'from_address': from_address,
            'to_address': target_conf.transport_address or target_conf.billing_address or '',
            'transferred_by': transferred_by,
        }
        target_log = list(target_conf.transfer_log or [])
        target_log.append(incoming_entry)
        target_conf.transfer_log = target_log
        target_conf.save(update_fields=['transfer_log'])

        # ── Return fresh serialized data for both conferences ────────────────
        # Re-fetch with full prefetch so the serializer doesn't hit N+1
        source_conf = Conference.objects.prefetch_related(
            'assets', 'crosscheck_assets', 'challan_assets', 'requirements', 'assigned_employees', 'staged_assets'
        ).get(pk=pk)
        target_conf = Conference.objects.prefetch_related(
            'assets', 'crosscheck_assets', 'challan_assets', 'requirements', 'assigned_employees', 'staged_assets'
        ).get(pk=target_conference_id)

        return Response({
            'success': True,
            'transferred_count': len(asset_ids_int),
            'asset_names': asset_names,
            'source_conference': ConferenceSerializer(source_conf).data,
            'target_conference': ConferenceSerializer(target_conf).data,
        }, status=200)

    except Exception as e:
        return Response(
            {'error': str(e), 'traceback': traceback.format_exc()},
            status=500
        )
