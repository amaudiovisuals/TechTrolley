"""Transactional physical-item commands. Never replace unrelated memberships."""
import hashlib
import json
import uuid

from django.db import transaction
from django.db.models import Q
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .models import Asset, Conference, MovementReceipt, TruckChallan
from .permissions import WAREHOUSE_ROLES, get_business_role, technician_has_event
from .serializers import ConferenceSerializer, AssetSerializer

ACTIONS = {'require', 'unrequire', 'stage', 'unstage', 'dispatch', 'return', 'verify_return',
           'transfer', 'audit_observe', 'audit_remove'}
RESTRICTED = {'Missing', 'Damaged', 'On Service', 'Expired'}


class CommandError(Exception):
    def __init__(self, code, status=409, details=None):
        self.code, self.status, self.details = code, status, details or []


def normalize_command(payload):
    if not isinstance(payload, dict) or set(payload) - {'request_id', 'action', 'asset_ids', 'target_conference_id', 'truck_id', 'source'}:
        raise CommandError('invalid_payload', 400)
    try:
        request_id = uuid.UUID(str(payload.get('request_id')))
    except (ValueError, TypeError, AttributeError):
        raise CommandError('invalid_request_id', 400)
    action = payload.get('action')
    ids = payload.get('asset_ids')
    if action not in ACTIONS or not isinstance(ids, list) or not 1 <= len(ids) <= 500:
        raise CommandError('invalid_action_or_batch', 400)
    if any(type(value) is not int or value <= 0 for value in ids):
        raise CommandError('invalid_asset_ids', 400)
    result = {'request_id': str(request_id), 'action': action, 'asset_ids': sorted(set(ids)),
              'source': str(payload.get('source', 'qr'))[:100]}
    for field in ('target_conference_id', 'truck_id'):
        value = payload.get(field)
        if value is not None:
            if type(value) is not int or value <= 0:
                raise CommandError('invalid_' + field, 400)
            result[field] = value
    if action == 'transfer' and 'target_conference_id' not in result:
        raise CommandError('target_required', 400)
    if action != 'transfer' and 'target_conference_id' in result:
        raise CommandError('unexpected_target', 400)
    if action != 'dispatch' and 'truck_id' in result:
        raise CommandError('unexpected_truck', 400)
    return result


def canonical_conference(conference):
    conference.refresh_from_db()
    conference._prefetched_objects_cache = {}
    return ConferenceSerializer(conference).data


@transaction.atomic
def execute_command(user, conference_id, payload):
    command = normalize_command(payload)
    role = get_business_role(user)
    action = command['action']
    envelope = {'conference_id': conference_id, **command}
    fingerprint = hashlib.sha256(json.dumps(envelope, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    existing = MovementReceipt.objects.filter(actor=user, request_id=command['request_id']).first()
    if existing:
        if existing.payload_hash != fingerprint:
            raise CommandError('request_id_reused')
        return {**existing.result, 'replayed': True}
    if role not in WAREHOUSE_ROLES:
        if role != 'technician' or action not in {'require', 'unrequire', 'return', 'audit_observe', 'audit_remove'} or not technician_has_event(user, conference_id):
            raise CommandError('not_authorized', 403)
    receipt, created = MovementReceipt.objects.get_or_create(actor=user, request_id=command['request_id'], defaults={'payload_hash': fingerprint})
    if not created:
        if receipt.payload_hash != fingerprint:
            raise CommandError('request_id_reused', 409)
        return {**receipt.result, 'replayed': True}

    # All commands use asset -> conference -> truck lock order. Asset locks serialize
    # competing devices even when their destination conference IDs differ.
    ids = command['asset_ids']
    assets = list(Asset.objects.select_for_update().filter(pk__in=ids).order_by('pk'))
    if len(assets) != len(ids):
        raise CommandError('unknown_assets', 400, [{'asset_id': aid} for aid in set(ids) - {a.pk for a in assets}])
    conference_ids = sorted({conference_id, command.get('target_conference_id', conference_id)})
    events = {c.pk: c for c in Conference.objects.select_for_update().filter(pk__in=conference_ids).order_by('pk')}
    if len(events) != len(conference_ids):
        raise CommandError('unknown_conference', 404)
    event = events[conference_id]
    if action in {'require', 'stage', 'dispatch', 'transfer'}:
        if any(a.subrental_company_id and not a.is_temporary and a.subrental_company.inventory_mode == 'external_supplier' for a in assets):
            raise CommandError('external_rental_uses_supplier_balance')
        if any(a.is_temporary for a in assets):
            raise CommandError('external_rental_uses_supplier_balance')
    target = events.get(command.get('target_conference_id'))
    from .dispatch_origins import venue_origin, warehouse_origin
    dispatch_origin = venue_origin(event) if target else warehouse_origin() if action == 'dispatch' else None
    from .event_lifecycle import require_open_event
    require_open_event(event)
    if target:
        require_open_event(target)
    if target is event:
        raise CommandError('same_source_and_target', 400)
    if action.startswith('audit_') != event.is_audit and action not in {'require', 'unrequire'}:
        raise CommandError('audit_requires_observation_action', 400)
    if target and target.is_audit:
        raise CommandError('audit_is_not_a_transfer_destination', 400)

    active = set(event.assets.values_list('pk', flat=True))
    crosscheck = set(event.crosscheck_assets.values_list('pk', flat=True))
    staged = set(event.staged_assets.values_list('pk', flat=True))
    blocking = Conference.objects.filter(is_audit=False).filter(Q(assets__in=ids) | Q(crosscheck_assets__in=ids)).distinct()
    conflicts = []
    from .quantity_commands import is_quantity_stock
    if action not in {'require', 'unrequire', 'audit_observe', 'audit_remove'}:
        if any(is_quantity_stock(a) for a in assets):
            raise CommandError('quantity_stock_requires_quantity_workflow', 400)
        for asset in assets:
            children = set(asset.sub_assets.values_list('pk', flat=True))
            if not children <= set(ids) or (asset.parent_asset_id and asset.parent_asset_id not in ids):
                conflicts.append({'asset_id': asset.pk, 'reason': 'component_set_required'})
            other_holders = blocking.exclude(pk=event.pk).filter(Q(assets=asset) | Q(crosscheck_assets=asset))
            if other_holders.exists():
                conflicts.append({'asset_id': asset.pk, 'reason': 'held_by_other_event'})
            if action in {'stage', 'dispatch', 'transfer'} and (asset.status in RESTRICTED or asset.flag or asset.condition == 'Damaged' or asset.assigned_to_id or asset.staff_allocations.filter(returned_at__isnull=True).exists()):
                conflicts.append({'asset_id': asset.pk, 'reason': 'unavailable_or_staff_allocated'})
            if action == 'dispatch' and asset.pk not in staged | active:
                conflicts.append({'asset_id': asset.pk, 'reason': 'not_staged'})
            if action in {'stage', 'dispatch'} and asset.pk in crosscheck:
                conflicts.append({'asset_id': asset.pk, 'reason': 'crosscheck_pending'})
            if action in {'return', 'transfer'} and asset.pk not in active and not (action == 'return' and asset.pk in crosscheck):
                conflicts.append({'asset_id': asset.pk, 'reason': 'not_dispatched_here'})
            if action == 'verify_return' and asset.pk not in crosscheck:
                conflicts.append({'asset_id': asset.pk, 'reason': 'not_awaiting_crosscheck'})
        if conflicts:
            raise CommandError('asset_conflict', details=conflicts)

    if action == 'require':
        event.requirements.add(*ids)
    elif action == 'unrequire':
        event.requirements.remove(*ids)
    elif action in {'stage', 'audit_observe'}:
        event.staged_assets.add(*ids)
        event.requirements.remove(*ids)
    elif action == 'unstage':
        event.staged_assets.remove(*ids)
    elif action == 'audit_remove':
        event.staged_assets.remove(*ids)
        event.assets.remove(*ids)
        event.crosscheck_assets.remove(*ids)
    elif action == 'dispatch':
        trucks = list(TruckChallan.objects.select_for_update().filter(conference=event).order_by('pk'))
        truck = next((t for t in trucks if t.pk == command.get('truck_id')), None) if command.get('truck_id') else (trucks[-1] if trucks else None)
        if command.get('truck_id') and truck is None:
            raise CommandError('truck_not_in_event', 400)
        event.staged_assets.remove(*ids)
        event.requirements.remove(*ids)
        event.assets.add(*ids)
        event.challan_assets.add(*ids)
        from .models import TruckManifest
        if truck and not TruckManifest.objects.filter(conference=event).exists():
            truck.assets.add(*ids)
    elif action == 'return':
        event.assets.remove(*ids)
        event.crosscheck_assets.add(*ids)
    elif action == 'verify_return':
        event.crosscheck_assets.remove(*ids)
    elif action == 'transfer':
        event.challan_assets.add(*ids)
        event.assets.remove(*ids)
        target.assets.add(*ids)
        target.challan_assets.add(*ids)
        from django.utils import timezone
        common = {'timestamp': timezone.now().isoformat(), 'request_id': command['request_id'],
                  'transferred_asset_ids': ids, 'asset_names': [a.alias_name or a.sku for a in assets],
                  'transferred_by': user.pk, 'from_address': dispatch_origin['address'],
                  'dispatch_origin': dispatch_origin, 'to_address': target.transport_address or ''}
        event.transfer_log = [*(event.transfer_log or []), {**common, 'direction': 'outgoing', 'to_conference_id': target.pk, 'to_conference_name': target.name}]
        target.transfer_log = [*(target.transfer_log or []), {**common, 'direction': 'incoming', 'from_conference_id': event.pk, 'from_conference_name': event.name}]
        event.save(update_fields=['transfer_log']); target.save(update_fields=['transfer_log'])

    from .custody import synchronize_statuses
    if action not in {'require', 'unrequire', 'stage', 'unstage', 'audit_observe', 'audit_remove'}:
        synchronize_statuses(ids)
    if action in {'dispatch', 'return', 'verify_return', 'transfer'}:
        from .models import PhysicalMovement
        for asset in assets:
            snapshot = {'asset': {'id': asset.pk, 'sku': asset.sku, 'label': asset.alias_name or asset.sku, 'quantity': asset.quantity},
                        'source': command['source'],
                        'before': {'active': asset.pk in active, 'unchecked': asset.pk in crosscheck, 'staged': asset.pk in staged},
                        'after': {'active': event.assets.filter(pk=asset.pk).exists(), 'unchecked': event.crosscheck_assets.filter(pk=asset.pk).exists(), 'staged': event.staged_assets.filter(pk=asset.pk).exists()}}
            if dispatch_origin is not None:
                snapshot['dispatch_origin'] = dispatch_origin
            PhysicalMovement.objects.create(asset=asset, conference=event, target_conference=target, receipt=receipt,
                                            action='transfer_out' if target else action, snapshot=snapshot)
            if target:
                PhysicalMovement.objects.create(asset=asset, conference=target, target_conference=event, receipt=receipt,
                                                action='transfer_in', snapshot={'asset': snapshot['asset'], 'accepted_from_event_id': event.pk, 'source': command['source'], 'dispatch_origin': dispatch_origin})
    result = {'request_id': command['request_id'], 'action': action, 'asset_ids': ids,
              'conference': canonical_conference(event),
              'asset_states': AssetSerializer(Asset.objects.filter(pk__in=ids).order_by('pk'), many=True).data, 'replayed': False}
    if target:
        result['target_conference'] = canonical_conference(target)
    receipt.result = result
    receipt.save(update_fields=['result'])
    return result


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def asset_commands(request, pk):
    try:
        return Response(execute_command(request.user, pk, request.data))
    except CommandError as error:
        return Response({'error': error.code, 'conflicts': error.details}, status=error.status)
