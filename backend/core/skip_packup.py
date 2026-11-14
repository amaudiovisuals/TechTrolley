"""Admin declaration that the current, reviewed Packup list is ready for Crosscheck."""

from uuid import UUID, uuid5

from django.db import transaction
from django.shortcuts import get_object_or_404
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .asset_commands import CommandError, canonical_conference, execute_command
from .event_lifecycle import require_open_event
from .inventory_ownership import warehouse_managed
from .models import Asset, Conference, MovementReceipt
from .permissions import get_business_role
from .program_deliveries import digest
from .quantity_commands import execute_quantity_command, is_quantity_stock
from .revisions import lock_conference_for_write
from .serializers import AssetSerializer


def review(event):
    require_open_event(event)
    if event.is_audit:
        raise CommandError('skip_packup_audit_program', 400)
    assets = list(event.assets.select_related('subrental_company').prefetch_related('sub_assets').order_by('pk'))
    active_ids = {asset.pk for asset in assets}
    quantities = {
        entry.asset_id: entry.dispatched for entry in event.quantity_allocations.all() if entry.dispatched
    }
    unchecked_ids = set(event.crosscheck_assets.values_list('pk', flat=True))
    staff_ids = set(Asset.objects.filter(
        pk__in=active_ids, staff_allocations__returned_at__isnull=True,
        staff_allocations__isnull=False,
    ).values_list('pk', flat=True))
    rows, blockers = [], []
    for asset in assets:
        reason = None
        bulk = is_quantity_stock(asset)
        quantity = quantities.get(asset.pk) if bulk else 1
        if asset.type == 'Consumables':
            reason = 'Settle this item through consumable returns.'
        elif not warehouse_managed(asset):
            reason = 'Review this item through its supplier or container workflow.'
        elif 'Missing' in (asset.status, asset.flag):
            reason = 'Resolve the missing-item flag before moving it to Crosscheck.'
        elif asset.assigned_to_id or asset.pk in staff_ids:
            reason = 'Resolve the staff assignment before returning this item.'
        elif not bulk and asset.pk in unchecked_ids:
            reason = 'Reconcile this item in both Packup and Crosscheck.'
        elif bulk and not quantity:
            reason = 'Reconcile the on-site quantity before returning this item.'
        elif bulk and (asset.parent_asset_id or asset.sub_assets.all()):
            reason = 'Review the linked components before returning this bulk item.'
        elif (asset.parent_asset_id is not None and asset.parent_asset_id not in active_ids
              or any(child.pk not in active_ids for child in asset.sub_assets.all())):
            reason = 'The full linked equipment set must be in Packup.'
        if reason:
            blockers.append({'asset_id': asset.pk, 'sku': asset.sku, 'reason': reason})
        rows.append({'asset_id': asset.pk, 'sku': asset.sku, 'name': asset.alias_name or asset.sku,
                     'quantity': quantity, 'bulk': bulk})
    for asset_id in sorted(quantities.keys() - active_ids):
        blockers.append({'asset_id': asset_id, 'reason': 'The quantity ledger and Packup list need reconciliation.'})
    payload = {'revision': event.revision, 'rows': rows, 'blockers': blockers}
    return {**payload, 'unit_count': sum(row['quantity'] or 0 for row in rows), 'review_hash': digest(payload)}


@transaction.atomic
def execute_skip_packup(user, event_id, payload):
    if get_business_role(user) != 'admin':
        raise CommandError('skip_packup_admin_required', 403)
    if not isinstance(payload, dict) or set(payload) != {'request_id', 'expected_revision', 'review_hash', 'reason'}:
        raise CommandError('invalid_payload', 400)
    try:
        request_id = UUID(str(payload['request_id']))
    except (ValueError, TypeError):
        raise CommandError('invalid_request_id', 400)
    reason = payload['reason']
    if not isinstance(reason, str) or not 1 <= len(reason.strip()) <= 500:
        raise CommandError('skip_packup_reason_required', 400)
    if type(payload['expected_revision']) is not int or payload['expected_revision'] < 0:
        raise CommandError('expected_revision_required', 428)
    fingerprint = digest({'operation': 'skip_packup', 'event_id': event_id, **payload})
    receipt, created = MovementReceipt.objects.get_or_create(
        actor=user, request_id=request_id, defaults={'payload_hash': fingerprint},
    )
    if not created:
        if receipt.payload_hash != fingerprint:
            raise CommandError('request_id_reused')
        return {**receipt.result, 'replayed': True}

    event = lock_conference_for_write(event_id, {})
    current = review(event)
    if current['revision'] != payload['expected_revision'] or current['review_hash'] != payload['review_hash']:
        raise CommandError('skip_packup_review_changed')
    if current['blockers']:
        raise CommandError('skip_packup_review_blocked', details=current['blockers'])
    if not current['rows']:
        raise CommandError('skip_packup_empty', 400)

    physical = [row['asset_id'] for row in current['rows'] if not row['bulk']]
    bulk = [{'asset_id': row['asset_id'], 'quantity': row['quantity']} for row in current['rows'] if row['bulk']]
    children = []
    # The reviewed whole list stays atomic, including linked sets above the normal scan batch size.
    if physical:
        child_id = str(uuid5(request_id, 'skip-packup-physical'))
        execute_command(user, event.pk, {
            'request_id': child_id, 'action': 'return', 'source': 'admin-skip-packup', 'asset_ids': physical,
        }, batch_limit=len(physical))
        children.append(child_id)
    if bulk:
        event.refresh_from_db()
        child_id = str(uuid5(request_id, 'skip-packup-quantity'))
        execute_quantity_command(user, event.pk, {
            'request_id': child_id, 'action': 'return', 'expected_revision': event.revision, 'items': bulk,
        }, batch_limit=len(bulk), movement_source='admin-skip-packup')
        children.append(child_id)
    result = {
        'operation': 'skip_packup', 'request_id': str(request_id), 'reason': reason.strip(),
        'unit_count': current['unit_count'], 'packup_rows': current['rows'], 'child_request_ids': children,
        'conference': canonical_conference(event),
        'asset_states': AssetSerializer(Asset.objects.filter(pk__in=[row['asset_id'] for row in current['rows']]).order_by('pk'), many=True).data,
        'replayed': False,
    }
    receipt.result = result
    receipt.save(update_fields=['result'])
    return result


@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
def skip_packup(request, pk):
    if get_business_role(request.user) != 'admin':
        return Response({'error': 'skip_packup_admin_required'}, status=403)
    event = get_object_or_404(Conference, pk=pk)
    try:
        if request.method == 'GET':
            return Response(review(event))
        return Response(execute_skip_packup(request.user, pk, request.data))
    except Conference.DoesNotExist:
        return Response({'error': 'unknown_conference'}, status=404)
    except CommandError as error:
        return Response({'error': error.code, 'conflicts': error.details}, status=error.status)
