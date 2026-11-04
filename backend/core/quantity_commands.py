"""Atomic reusable-stock quantities. Consumables and legacy ambiguities fail closed.

Lock order is asset -> event -> allocation. A stock row is the mutex for all of
its event allocations; reserved/on-site/unchecked units all consume availability.
"""
import hashlib
import json
import uuid

from django.db import transaction
from django.db.models import Q
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .asset_commands import CommandError, RESTRICTED, canonical_conference, execute_command
from .models import Asset, Conference, MovementReceipt, QuantityAllocation, QuantityMovement
from .permissions import WAREHOUSE_ROLES, get_business_role, technician_has_event

FIELDS = ('reserved', 'dispatched', 'awaiting_verification', 'dispatched_total', 'verified_total')
ACTIONS = {'stage', 'unstage', 'dispatch', 'return', 'verify_return'}


def is_quantity_stock(asset):
    return asset.quantity_tracking or asset.quantity != 1 or asset.type == 'Consumables'


def allocation_data(allocation):
    return {'asset_id': allocation.asset_id, **{field: getattr(allocation, field) for field in FIELDS}}


def outstanding(asset):
    return sum(a.reserved + a.dispatched + a.awaiting_verification for a in asset.quantity_allocations.all())


def quantity_capacity(asset, event):
    """Documentary cap for a tracked item; history remains after its return."""
    allocation = asset.quantity_allocations.filter(conference=event).first()
    if allocation:
        return allocation.dispatched_total + allocation.reserved
    return asset.quantity


def normalize(payload):
    allowed = {'request_id', 'action', 'items', 'expected_revision', 'physical_asset_ids'}
    if not isinstance(payload, dict) or set(payload) - allowed:
        raise CommandError('invalid_payload', 400)
    try:
        request_id = str(uuid.UUID(str(payload.get('request_id'))))
    except (ValueError, TypeError, AttributeError):
        raise CommandError('invalid_request_id', 400)
    action, items, revision = payload.get('action'), payload.get('items'), payload.get('expected_revision')
    if action not in ACTIONS or not isinstance(items, list) or len(items) > 500:
        raise CommandError('invalid_action_or_batch', 400)
    if type(revision) is not int or revision < 0:
        raise CommandError('expected_revision_required', 428)
    for item in items:
        if (not isinstance(item, dict) or set(item) != {'asset_id', 'quantity'}
                or type(item['asset_id']) is not int or item['asset_id'] <= 0
                or type(item['quantity']) is not int or not 1 <= item['quantity'] <= 1000000):
            raise CommandError('invalid_quantity', 400)
    ids = [item['asset_id'] for item in items]
    physical = payload.get('physical_asset_ids', [])
    if (not isinstance(physical, list) or len(physical) + len(items) > 500
            or any(type(aid) is not int or aid <= 0 for aid in physical)
            or len(set(ids + physical)) != len(ids + physical) or not (ids or physical)
            or (physical and action != 'dispatch')):
        raise CommandError('invalid_or_duplicate_assets', 400)
    return {'request_id': request_id, 'action': action, 'expected_revision': revision,
            'items': sorted(items, key=lambda item: item['asset_id']), 'physical_asset_ids': sorted(physical)}


def validate_legacy(asset):
    # A legacy membership does not tell us how many units were actually moved.
    tracked_events = asset.quantity_allocations.values_list('conference_id', flat=True)
    legacy = Conference.objects.filter(is_audit=False).filter(
        Q(assets=asset) | Q(staged_assets=asset) | Q(crosscheck_assets=asset)
    ).exclude(pk__in=tracked_events)
    if legacy.exists():
        raise CommandError('legacy_quantity_requires_reconciliation', details=[{'asset_id': asset.pk}])
    # Old splitting duplicated identifiers. Do not pretend those rows are safe.
    identity = Q()
    for field in ('sku', 'barcode', 'qr_code', 'serial_number'):
        value = getattr(asset, field)
        if value:
            identity |= Q(**{field + '__iexact': value})
    if identity and Asset.objects.exclude(pk=asset.pk).filter(identity).exists():
        raise CommandError('duplicate_stock_identity_requires_review', details=[{'asset_id': asset.pk}])


def synchronize_memberships(event, asset, allocation):
    for field, count in (('staged_assets', allocation.reserved), ('assets', allocation.dispatched),
                         ('crosscheck_assets', allocation.awaiting_verification)):
        relation = getattr(event, field)
        (relation.add if count else relation.remove)(asset.pk)
    if allocation.dispatched_total:
        event.challan_assets.add(asset.pk)
    from .custody import synchronize_statuses
    synchronize_statuses([asset.pk])


@transaction.atomic
def execute_quantity_command(user, conference_id, payload):
    command = normalize(payload)
    fingerprint = hashlib.sha256(json.dumps({'operation': 'bulk_quantity', 'conference_id': conference_id,
                                            **command}, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    previous = MovementReceipt.objects.filter(actor=user, request_id=command['request_id']).first()
    if previous:
        if previous.payload_hash != fingerprint:
            raise CommandError('request_id_reused')
        return {**previous.result, 'replayed': True}
    role = get_business_role(user)
    if role not in WAREHOUSE_ROLES and not (role == 'technician' and command['action'] == 'return' and technician_has_event(user, conference_id)):
        raise CommandError('not_authorized', 403)
    receipt, created = MovementReceipt.objects.get_or_create(actor=user, request_id=command['request_id'], defaults={'payload_hash': fingerprint})
    if not created:
        if receipt.payload_hash != fingerprint:
            raise CommandError('request_id_reused')
        return {**receipt.result, 'replayed': True}
    ids = [item['asset_id'] for item in command['items']] + command['physical_asset_ids']
    assets = {a.pk: a for a in Asset.objects.select_for_update().filter(pk__in=ids).order_by('pk')}
    if len(assets) != len(ids):
        raise CommandError('unknown_assets', 400)
    event = Conference.objects.select_for_update().filter(pk=conference_id).first()
    if event is None:
        raise CommandError('unknown_conference', 404)
    from .event_lifecycle import require_open_event
    require_open_event(event)
    if event.revision != command['expected_revision']:
        raise CommandError('document_changed', details=[{'revision': event.revision}])
    if event.is_audit:
        raise CommandError('audit_requires_observation_action', 400)
    # Managed documentary manifests remain snapshots during warehouse movements.
    # Legacy truck quantities still need reviewed conversion; never use stock fallback.
    from .models import TruckManifest, ChallanLine
    managed = TruckManifest.objects.filter(conference=event).exists()
    if command['items'] and event.truck_challans.exists() and not managed:
        raise CommandError('quantity_trucks_require_coordinated_workflow')
    allocations = {a.asset_id: a for a in QuantityAllocation.objects.select_for_update().filter(
        conference=event, asset_id__in=ids).order_by('asset_id')}
    for item in command['items']:
        asset = assets[item['asset_id']]
        if not is_quantity_stock(asset) or asset.type == 'Consumables':
            raise CommandError('use_physical_or_consumable_workflow', 400)
        if asset.parent_asset_id or asset.sub_assets.exists() or asset.is_temporary:
            raise CommandError('unsupported_bulk_source', 400)
        if command['action'] in {'stage', 'dispatch'}:
            from .inventory_ownership import require_warehouse_quantity_source
            require_warehouse_quantity_source(asset)
        validate_legacy(asset)
        allocation = allocations.get(asset.pk) or QuantityAllocation(asset=asset, conference=event)
        before = allocation_data(allocation)
        amount, action = item['quantity'], command['action']
        if action in {'stage', 'dispatch'} and (asset.status in RESTRICTED or asset.flag or asset.condition == 'Damaged' or asset.assigned_to_id):
            raise CommandError('unavailable_or_staff_allocated')
        if action == 'stage':
            if amount > max(0, asset.quantity - outstanding(asset)):
                raise CommandError('insufficient_available_quantity', details=[{'asset_id': asset.pk}])
            allocation.reserved += amount
            event.requirements.remove(asset.pk)
        else:
            field = {'unstage': 'reserved', 'dispatch': 'reserved', 'return': 'dispatched', 'verify_return': 'awaiting_verification'}[action]
            if amount > getattr(allocation, field):
                raise CommandError('insufficient_' + field, details=[{'asset_id': asset.pk}])
            setattr(allocation, field, getattr(allocation, field) - amount)
            if action == 'dispatch':
                allocation.dispatched += amount
                allocation.dispatched_total += amount
            elif action == 'return':
                allocation.awaiting_verification += amount
            elif action == 'verify_return':
                allocation.verified_total += amount
        allocation.save()
        if managed and ChallanLine.objects.filter(document__conference=event, document__scope='master', asset=asset,
                                                   quantity__gt=allocation.dispatched_total + allocation.reserved).exists():
            raise CommandError('revise_master_before_reducing_reservation')
        allocations[asset.pk] = allocation
        if not asset.quantity_tracking:
            asset.quantity_tracking = True
            Asset.objects.filter(pk=asset.pk).update(quantity_tracking=True)
        synchronize_memberships(event, asset, allocation)
        QuantityMovement.objects.create(allocation=allocation, receipt=receipt, action=action,
                                        quantity=amount, before=before, after=allocation_data(allocation))
    if command['physical_asset_ids']:
        # Nested transaction: any physical conflict rolls back the bulk part too.
        execute_command(user, conference_id, {'request_id': str(uuid.uuid5(uuid.UUID(command['request_id']), 'physical-dispatch')),
                        'action': 'dispatch', 'asset_ids': command['physical_asset_ids'], 'source': 'mixed-dispatch'})
    event.save(update_fields=['revision'])  # even a change of count with unchanged membership is a revision
    from .serializers import AssetSerializer
    result = {'status': 'saved', 'request_id': command['request_id'], 'replayed': False,
              'conference': canonical_conference(event),
              'asset_states': AssetSerializer(Asset.objects.filter(pk__in=ids).order_by('pk'), many=True).data}
    receipt.result = result
    receipt.save(update_fields=['result'])
    return result


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def quantity_commands(request, pk):
    try:
        return Response(execute_quantity_command(request.user, pk, request.data))
    except CommandError as error:
        return Response({'error': error.code, 'conflicts': error.details}, status=error.status)
