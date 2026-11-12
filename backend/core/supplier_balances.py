"""External rental obligations; never mutate warehouse stock or infer old returns."""
from django.db import transaction
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from .asset_commands import CommandError
from .models import SupplierBalance, SupplierMovement, SubrentalTicketItem, SupplierChange, MovementReceipt, SubrentalCompany
from .permissions import ADMIN_ROLES, WAREHOUSE_ROLES, get_business_role
from .reconciliation_commands import digest, read_snapshot
from .revisions import lock_conference_for_write

BALANCE_ACTIONS = {'supplier_receive', 'supplier_return', 'supplier_cancel', 'review_supplier_opening'}


def raw_balance(row):
    return {key: getattr(row, key) for key in ('ordered', 'received', 'returned', 'cancelled', 'revision', 'provenance')}


def sane(state):
    return (all(type(state.get(k)) is int and 0 <= state[k] <= 1000000 for k in ('ordered','received','returned','cancelled'))
            and state['ordered'] > 0 and state['received'] + state['cancelled'] <= state['ordered'] and state['returned'] <= state['received'])


def consistent(row):
    current = raw_balance(row)
    if not sane(current) or row.ordered != row.item.quantity:
        return False
    moves = list(row.movements.select_related('receipt').order_by('pk'))
    if row.provenance == 'new_order':
        change = SupplierChange.objects.filter(receipt=row.order_receipt, item=row.item, action__in=['add_item','edit_item']).first()
        opening = SupplierChange.objects.filter(receipt=row.opening_receipt, item=row.item, action='add_item').exists()
        if not opening or not change or change.after.get('item', {}).get('quantity') != row.ordered:
            return False
        state = {**current, 'received': 0, 'returned': 0, 'cancelled': 0,
                 'revision': moves[0].before.get('revision') if moves and isinstance(moves[0].before, dict) else row.revision}
    elif row.provenance == 'reviewed_legacy_opening':
        if not moves or moves[0].action != 'review_supplier_opening' or moves[0].receipt_id != row.opening_receipt_id or moves[0].before is not None:
            return False
        state = moves.pop(0).after
        if not sane(state) or state.get('revision') != 1:
            return False
    else:
        return False
    for move in moves:
        field = {'supplier_receive':'received','supplier_return':'returned','supplier_cancel':'cancelled'}.get(move.action)
        if not field or move.before != state or type(move.quantity) is not int or move.quantity <= 0:
            return False
        state = {**state, field: state[field]+move.quantity, 'revision': state['revision']+1}
        if not sane(state) or move.after != state:
            return False
    return state == current


def balance_data(item):
    row = SupplierBalance.objects.filter(item=item).first()
    if row is None:
        return {'state': 'opening_review_required'}
    if not consistent(row):
        return {'state': 'inconsistent', 'revision': row.revision}
    return {**raw_balance(row), 'state': 'recorded', 'pending_receipt': row.ordered-row.received-row.cancelled,
            'with_us': row.received-row.returned, 'closed': row.received == row.returned and row.received+row.cancelled == row.ordered}


def order_capacity(asset, exclude_item=None):
    """Outstanding orders count against declared catalogue capacity, not verified stock."""
    total = 0
    for item in asset.ticket_items.exclude(pk=exclude_item).select_related('supplier_balance'):
        if item.quantity <= 0: raise CommandError('supplier_catalogue_capacity_requires_review')
        data = balance_data(item)
        total += item.quantity-data['returned']-data['cancelled'] if data['state'] == 'recorded' else item.quantity
    return total


def normalize(payload):
    from .supplier_commands import positive_id
    import uuid
    fields = {'request_id','action','conference_id','expected_revision','reason','data'}
    if not isinstance(payload, dict) or set(payload) != fields or not isinstance(payload.get('action'), str) or payload['action'] not in BALANCE_ACTIONS:
        raise CommandError('invalid_supplier_balance_command', 400)
    try: request_id = str(uuid.UUID(str(payload['request_id'])))
    except (ValueError, TypeError, AttributeError): raise CommandError('invalid_request_id', 400)
    positive_id(payload['conference_id'])
    if type(payload['expected_revision']) is not int or payload['expected_revision'] < 0:
        raise CommandError('expected_revision_required', 428)
    data = payload['data']; opening = payload['action'] == 'review_supplier_opening'
    keys = {'ticket_id','item_id','expected_balance_revision','evidence_reference','confirmed'} | ({'received','returned','cancelled'} if opening else {'quantity'})
    if not isinstance(data, dict) or set(data) != keys or data['confirmed'] is not True:
        raise CommandError('supplier_balance_confirmation_required', 400)
    positive_id(data['ticket_id']); positive_id(data['item_id'])
    if opening:
        if data['expected_balance_revision'] is not None: raise CommandError('legacy_opening_requires_absent_balance', 400)
    elif type(data['expected_balance_revision']) is not int or data['expected_balance_revision'] < 0:
        raise CommandError('supplier_balance_revision_required', 428)
    for key in ('received','returned','cancelled') if opening else ('quantity',):
        if type(data[key]) is not int or not (0 if opening else 1) <= data[key] <= 1000000:
            raise CommandError('invalid_supplier_quantity', 400)
    for value in (payload['reason'], data['evidence_reference']):
        if not isinstance(value, str) or not 1 <= len(value.strip()) <= 1000:
            raise CommandError('supplier_balance_evidence_required', 400)
    return {**payload, 'request_id':request_id, 'reason':payload['reason'].strip(),
            'data':{**data,'evidence_reference':data['evidence_reference'].strip()}}


def source_guard(item):
    asset = item.asset
    if asset.subrental_company_id != item.ticket.company_id:
        raise CommandError('supplier_asset_owner_mismatch')
    if not asset.is_temporary and item.ticket.company.inventory_mode != 'external_supplier':
        raise CommandError('external_supplier_classification_required')
    if asset.status == 'Missing' or asset.flag == 'Missing' or asset.parent_asset_id or asset.sub_assets.exists() or asset.type == 'Consumables':
        raise CommandError('supplier_source_requires_review')
    # Physical warehouse scans and external obligation counts cannot represent
    # the same asset as two independent pools. Do not erase old queues to proceed.
    from .custody import custody_state
    state = custody_state(asset)
    if asset.assigned_to_id or any(state[k] for k in ('active_event_ids','unchecked_event_ids','staged_event_ids','staff_issue_employee_ids','held_quantity','legacy_quantity_unknown')):
        raise CommandError('supplier_asset_has_warehouse_custody')
    latest = {}
    for move in asset.physical_movements.order_by('pk'): latest[move.conference_id] = move.action
    if any(action not in {'verify_return','transfer_out','legacy_return_review'} for action in latest.values()):
        raise CommandError('supplier_asset_has_warehouse_custody')


@transaction.atomic
def execute_balance(user, payload):
    command = normalize(payload); data = command['data']; action = command['action']
    fingerprint = digest({'operation':'supplier_balance', **command})
    previous = MovementReceipt.objects.filter(actor=user, request_id=command['request_id']).first()
    if previous:
        if previous.payload_hash != fingerprint: raise CommandError('request_id_reused')
        return {**previous.result,'replayed':True}
    if get_business_role(user) not in (ADMIN_ROLES if action == 'review_supplier_opening' else WAREHOUSE_ROLES):
        raise CommandError('not_authorized', 403)
    receipt, created = MovementReceipt.objects.get_or_create(actor=user, request_id=command['request_id'], defaults={'payload_hash':fingerprint})
    if not created:
        if receipt.payload_hash != fingerprint: raise CommandError('request_id_reused')
        return {**receipt.result,'replayed':True}
    item = SubrentalTicketItem.objects.filter(pk=data['item_id'], ticket_id=data['ticket_id'], ticket__conference_id=command['conference_id']).first()
    if item is None: raise CommandError('supplier_item_context_changed')
    event = lock_conference_for_write(command['conference_id'], {'challan_assets':[item.asset_id]})
    from .event_lifecycle import require_open_event
    require_open_event(event)
    if event.is_audit: raise CommandError('supplier_ticket_requires_real_event')
    if event.revision != command['expected_revision']: raise CommandError('supplier_event_changed')
    SubrentalCompany.objects.select_for_update().get(pk=item.ticket.company_id)
    item = SubrentalTicketItem.objects.select_for_update().select_related('asset','ticket__company').get(pk=item.pk)
    source_guard(item)
    row = SupplierBalance.objects.select_for_update().filter(item=item).first()
    if action == 'review_supplier_opening':
        if row: raise CommandError('supplier_opening_already_recorded')
        if not sane({'ordered':item.quantity, **data}): raise CommandError('invalid_supplier_opening_counts', 400)
        row = SupplierBalance.objects.create(item=item, ordered=item.quantity, received=data['received'], returned=data['returned'], cancelled=data['cancelled'],
            provenance='reviewed_legacy_opening', opening_receipt=receipt, revision=1)
        before = None; amount = 0
    else:
        if row is None: raise CommandError('supplier_opening_review_required')
        if row.revision != data['expected_balance_revision']: raise CommandError('supplier_balance_changed')
        if not consistent(row): raise CommandError('supplier_balance_requires_review')
        before = raw_balance(row); amount = data['quantity']
        field = {'supplier_receive':'received','supplier_return':'returned','supplier_cancel':'cancelled'}[action]
        after = {**before, field:before[field]+amount}
        if not sane(after): raise CommandError('supplier_quantity_exceeds_recorded_balance')
        setattr(row, field, after[field]); row.revision += 1; row.save()
    movement = SupplierMovement.objects.create(balance=row, receipt=receipt, action=action, quantity=amount,
        reason=command['reason'], evidence_reference=data['evidence_reference'], before=before, after=raw_balance(row),
        source_snapshot={'item_id':item.pk,'ticket_id':item.ticket_id,'conference_id':event.pk,'asset_id':item.asset_id,
                         'sku':item.asset.sku,'alias_name':item.asset.alias_name,'serial_number':item.asset.serial_number,
                         'supplier_id':item.ticket.company_id,'supplier_name':item.ticket.company.name,'provenance':row.provenance,'original_movement_dates':None})
    event.save(update_fields=['revision'])
    result = {'operation':'supplier_balance','request_id':command['request_id'],'action':action,'change_id':movement.pk,
              'ticket_id':item.ticket_id,'conference_id':event.pk,'revision':event.revision,'replayed':False}
    receipt.result=result; receipt.save(update_fields=['result']); return result


@api_view(['GET'])
@permission_classes([IsAuthenticated])
@transaction.atomic
def supplier_history(request, item_id):
    read_snapshot()
    if get_business_role(request.user) not in WAREHOUSE_ROLES | {'accounts'}:
        return Response({'error':'supplier_history_role_required'}, status=403)
    item = SubrentalTicketItem.objects.filter(pk=item_id).first()
    if item is None: return Response({'error':'unknown_supplier_item'}, status=404)
    row = SupplierBalance.objects.filter(item=item).first()
    return Response({'item_id':item.pk, 'balance':balance_data(item), 'history':[
        {'id':m.pk,'action':m.action,'quantity':m.quantity,'operator_id':m.receipt.actor_id,'request_id':str(m.receipt.request_id),
         'reason':m.reason,'evidence_reference':m.evidence_reference,'source_snapshot':m.source_snapshot,'before':m.before,'after':m.after,'recorded_at':m.recorded_at.isoformat()}
        for m in row.movements.select_related('receipt').order_by('pk')] if row else [],
        'limitations':['Reviewed legacy openings record current evidence; original receipt/return dates remain unknown.','These obligations are separate from warehouse master quantities.']})
