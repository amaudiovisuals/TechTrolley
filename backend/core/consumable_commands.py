"""Whole-event consumable saves, dispatch and verified settlement; no legacy inference."""
import hashlib
import json
import re
import uuid

from django.db import transaction
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .asset_commands import CommandError, RESTRICTED, canonical_conference
from .models import Asset, Conference, ConsumableAllocation, ConsumableMovement, MovementReceipt
from .permissions import WAREHOUSE_ROLES, get_business_role, technician_has_event

METADATA = {'name', 'association_name', 'billing_address', 'transport_address', 'gst_number',
            'vehicle_number', 'driver_phone', 'challan_date', 'contact_person', 'contact_phone',
            'contact_email', 'start_date', 'end_date', 'conference_type', 'assigned_employees'}


def allocation_data(row):
    return {'requested': row.requested, 'returned': row.returned, 'consumed': row.consumed,
            'status': 'requested' if row.state == 'reserved' else row.state,
            'ledger': True, 'return_confirmed': row.state == 'settled'}


def outstanding(asset):
    return sum(row.requested for row in asset.consumable_allocations.exclude(state='settled'))


def legacy_usage(asset):
    tracked = set(asset.consumable_allocations.values_list('conference_id', flat=True))
    for event in Conference.objects.exclude(pk__in=tracked).only('id', 'consumable_data'):
        data = event.consumable_data
        if not isinstance(data, dict):
            if data: return True
            continue
        entry = data.get(str(asset.pk))
        if entry and (not isinstance(entry, dict) or entry.get('requested')):
            return True
    # Legacy physical membership also has no consumable quantity proof.
    from django.db.models import Q
    return Conference.objects.filter(Q(assets=asset) | Q(staged_assets=asset) | Q(crosscheck_assets=asset)).exists()


def available(asset):
    return 0 if legacy_usage(asset) else max(0, asset.quantity - outstanding(asset))


def normalize(payload):
    if not isinstance(payload, dict) or set(payload) - {'request_id', 'action', 'expected_revision', 'items', 'metadata', 'client_draft_hash'}:
        raise CommandError('invalid_payload', 400)
    try:
        request_id = str(uuid.UUID(str(payload.get('request_id'))))
    except (ValueError, TypeError, AttributeError):
        raise CommandError('invalid_request_id', 400)
    action, revision, items = payload.get('action'), payload.get('expected_revision'), payload.get('items')
    if action not in {'save', 'dispatch', 'settle'} or not isinstance(items, list) or len(items) > 500:
        raise CommandError('invalid_action_or_batch', 400)
    if type(revision) is not int or revision < 0:
        raise CommandError('expected_revision_required', 428)
    metadata = payload.get('metadata', {})
    if not isinstance(metadata, dict) or set(metadata) - METADATA:
        raise CommandError('invalid_consumable_metadata', 400)
    draft_hash = payload.get('client_draft_hash', '')
    if not isinstance(draft_hash, str) or (draft_hash and not re.fullmatch('[a-f0-9]{64}', draft_hash)):
        raise CommandError('invalid_client_draft_hash', 400)
    ids = []
    for item in items:
        if (not isinstance(item, dict) or set(item) != {'asset_id', 'requested', 'returned', 'confirmed'}
                or type(item['asset_id']) is not int or item['asset_id'] <= 0
                or type(item['requested']) is not int or not 0 <= item['requested'] <= 1000000
                or (item['returned'] is not None and (type(item['returned']) is not int or not 0 <= item['returned'] <= item['requested']))
                or type(item['confirmed']) is not bool):
            raise CommandError('invalid_consumable_quantities', 400)
        ids.append(item['asset_id'])
    if len(ids) != len(set(ids)):
        raise CommandError('duplicate_assets', 400)
    return {'request_id': request_id, 'action': action, 'expected_revision': revision,
            'items': sorted(items, key=lambda item: item['asset_id']), 'metadata': metadata, 'client_draft_hash': draft_hash}


@transaction.atomic
def execute_consumable_command(user, conference_id, payload):
    command = normalize(payload)
    fingerprint = hashlib.sha256(json.dumps({'operation': 'consumable', 'conference_id': conference_id, **command},
                                            sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    previous = MovementReceipt.objects.filter(actor=user, request_id=command['request_id']).first()
    if previous:
        if previous.payload_hash != fingerprint: raise CommandError('request_id_reused')
        return {**previous.result, 'replayed': True}
    role = get_business_role(user)
    if role not in WAREHOUSE_ROLES:
        if role != 'technician' or command['action'] != 'save' or command['metadata'] or not technician_has_event(user, conference_id):
            raise CommandError('not_authorized', 403)
    receipt, created = MovementReceipt.objects.get_or_create(actor=user, request_id=command['request_id'], defaults={'payload_hash': fingerprint})
    if not created:
        if receipt.payload_hash != fingerprint: raise CommandError('request_id_reused')
        return {**receipt.result, 'replayed': True}
    current_ids = ConsumableAllocation.objects.filter(conference_id=conference_id).values_list('asset_id', flat=True)
    ids = sorted(set(current_ids) | {item['asset_id'] for item in command['items']})
    assets = {a.pk: a for a in Asset.objects.select_for_update().filter(pk__in=ids).order_by('pk')}
    if len(assets) != len(ids): raise CommandError('unknown_assets', 400)
    event = Conference.objects.select_for_update().filter(pk=conference_id).first()
    if event is None: raise CommandError('unknown_conference', 404)
    from .event_lifecycle import require_open_event
    require_open_event(event)
    if event.revision != command['expected_revision']: raise CommandError('document_changed')
    if event.is_audit: raise CommandError('audit_is_not_consumable_custody', 400)
    from .models import TruckManifest, ChallanLine
    managed = TruckManifest.objects.filter(conference=event).exists()
    if event.truck_challans.exists() and not managed: raise CommandError('consumable_trucks_require_coordinated_workflow')
    rows = {row.asset_id: row for row in ConsumableAllocation.objects.select_for_update().filter(conference=event).order_by('asset_id')}
    legacy = event.consumable_data or {}
    if not isinstance(legacy, dict) or any(str(key) not in {str(aid) for aid in rows} and entry and
                                         (not isinstance(entry, dict) or entry.get('requested')) for key, entry in legacy.items()):
        raise CommandError('legacy_consumables_require_reconciliation')
    from .serializers import ConferenceSerializer, AssetSerializer
    serializer = ConferenceSerializer(event, data=command['metadata'], partial=True)
    if not serializer.is_valid(): raise CommandError('invalid_event_metadata', 400, serializer.errors)
    submitted = {item['asset_id']: item for item in command['items']}
    for aid, row in rows.items():
        if aid not in submitted:
            if row.state != 'reserved': raise CommandError('dispatched_or_settled_consumable_cannot_be_removed')
            submitted[aid] = {'asset_id': aid, 'requested': 0, 'returned': None, 'confirmed': False}
    settled_count = dispatched_count = 0
    for aid in sorted(submitted):
        item, asset = submitted[aid], assets[aid]
        if asset.type != 'Consumables' or asset.is_temporary or asset.parent_asset_id or asset.sub_assets.exists():
            raise CommandError('unsupported_consumable_source', 400)
        if legacy_usage(asset): raise CommandError('legacy_consumables_require_reconciliation', details=[{'asset_id': aid}])
        row = rows.get(aid) or ConsumableAllocation(asset=asset, conference=event)
        if item['requested'] > row.requested or command['action'] == 'dispatch' and item['requested'] > 0:
            from .inventory_ownership import require_warehouse_quantity_source
            require_warehouse_quantity_source(asset)
        before, stock_before = allocation_data(row), asset.quantity
        if command['action'] == 'settle' and row.state == 'reserved' and not row.requested and not item['requested']:
            continue
        if row.state == 'settled':
            if item['requested'] != row.requested or item['returned'] != row.returned:
                raise CommandError('settled_consumable_is_immutable')
            continue
        if row.state == 'reserved':
            if command['action'] == 'settle': raise CommandError('consumable_not_dispatched')
            if item['returned'] is not None or item['confirmed']: raise CommandError('returns_require_dispatch', 400)
            if item['requested'] > max(0, asset.quantity - outstanding(asset) + row.requested):
                raise CommandError('insufficient_available_consumables', details=[{'asset_id': aid}])
            if (item['requested'] > row.requested or command['action'] == 'dispatch' and item['requested'] > 0) and (asset.status in RESTRICTED or asset.flag or asset.condition == 'Damaged' or asset.assigned_to_id):
                raise CommandError('unavailable_or_staff_allocated')
            row.requested = item['requested']
            if managed and ChallanLine.objects.filter(document__conference=event, document__scope='master', asset=asset, quantity__gt=row.requested).exists():
                raise CommandError('revise_master_before_reducing_reservation')
            if command['action'] == 'dispatch' and row.requested:
                row.state = 'dispatched'; dispatched_count += 1
        else:
            if item['requested'] != row.requested: raise CommandError('dispatched_consumable_quantity_is_locked')
            row.returned = item['returned']
            if command['action'] == 'settle':
                if row.returned is None or not item['confirmed']: raise CommandError('explicit_return_confirmation_required')
                row.consumed = row.requested - row.returned
                if row.consumed > asset.quantity: raise CommandError('stock_changed_requires_reconciliation')
                asset.quantity -= row.consumed
                asset.save(update_fields=['quantity'])
                row.state = 'settled'; settled_count += 1
        after = allocation_data(row)
        if row.pk is None and not row.requested: continue
        row.save(); rows[aid] = row
        if before != after or stock_before != asset.quantity:
            ConsumableMovement.objects.create(allocation=row, receipt=receipt, action=command['action'], before=before, after=after,
                                             stock_before=stock_before, stock_after=asset.quantity)
    if command['action'] == 'dispatch' and not dispatched_count: raise CommandError('no_reserved_consumables_to_dispatch')
    if command['action'] == 'settle' and not settled_count: raise CommandError('no_dispatched_consumables_to_settle')
    serializer.save()
    event.consumable_data = {str(aid): allocation_data(row) for aid, row in rows.items() if row.requested}
    event.save(update_fields=['consumable_data'])
    from .custody import synchronize_statuses
    synchronize_statuses([asset.pk for asset in assets.values()])
    result = {'operation': 'consumable', 'status': 'saved', 'request_id': command['request_id'], 'replayed': False,
              'client_draft_hash': command['client_draft_hash'], 'conference': canonical_conference(event),
              'asset_states': AssetSerializer(Asset.objects.filter(pk__in=ids).order_by('pk'), many=True).data}
    receipt.result = result; receipt.save(update_fields=['result'])
    return result


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def consumable_commands(request, pk):
    try:
        return Response(execute_consumable_command(request.user, pk, request.data))
    except CommandError as error:
        return Response({'error': error.code, 'conflicts': error.details}, status=error.status)
