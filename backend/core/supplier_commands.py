"""Atomic supplier paperwork saves. No inferred physical movements or ownership changes."""
import hashlib
import json
import uuid
from datetime import date
from decimal import Decimal, InvalidOperation
from django.db import transaction
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from .asset_commands import CommandError
from .models import Asset, Conference, MovementReceipt, SubrentalCompany, SubrentalTicket, SubrentalTicketItem, SupplierChange, ChallanLine
from .permissions import WAREHOUSE_ROLES, get_business_role
from .revisions import lock_conference_for_write
from .serializers import SubrentalTicketSerializer

ACTIONS = {'create_ticket', 'create_custom_ticket', 'add_item', 'edit_item', 'edit_ticket'}


def positive_id(value):
    if type(value) is not int or value <= 0: raise CommandError('invalid_supplier_identifier', 400)
    return value


def money(value, maximum=Decimal('999999999999999999.99')):
    if isinstance(value, bool) or not isinstance(value, (int, float, str, Decimal)): raise CommandError('invalid_supplier_amount', 400)
    try: amount = Decimal(str(value))
    except InvalidOperation: raise CommandError('invalid_supplier_amount', 400)
    if not amount.is_finite() or amount < 0 or amount > maximum or amount != amount.quantize(Decimal('.01')):
        raise CommandError('invalid_supplier_amount', 400)
    return str(amount.quantize(Decimal('.01')))


def dates(data):
    result = {}
    for key in ('available_from', 'available_till'):
        value = data.get(key)
        if value in (None, ''): result[key] = None; continue
        try:
            if not isinstance(value, str) or len(value) != 10: raise ValueError()
            result[key] = date.fromisoformat(value).isoformat()
        except ValueError: raise CommandError('invalid_supplier_date', 400)
    if result['available_from'] and result['available_till'] and result['available_till'] < result['available_from']:
        raise CommandError('supplier_date_range_invalid', 400)
    return result


def normalize(payload):
    if not isinstance(payload, dict) or set(payload) != {'request_id', 'action', 'conference_id', 'expected_revision', 'reason', 'data'}:
        raise CommandError('invalid_supplier_command', 400)
    try: request_id = str(uuid.UUID(str(payload['request_id'])))
    except (ValueError, TypeError, AttributeError): raise CommandError('invalid_request_id', 400)
    action = payload['action']; data = payload['data']
    if not isinstance(action, str) or action not in ACTIONS or not isinstance(data, dict): raise CommandError('invalid_supplier_command', 400)
    custom = action == 'create_custom_ticket'
    if custom:
        if payload['conference_id'] is not None or payload['expected_revision'] is not None: raise CommandError('custom_ticket_has_existing_context', 400)
    else:
        positive_id(payload['conference_id'])
        if type(payload['expected_revision']) is not int or payload['expected_revision'] < 0: raise CommandError('expected_revision_required', 428)
    reason = payload['reason']
    if not isinstance(reason, str) or not 1 <= len(reason.strip()) <= 1000: raise CommandError('supplier_reason_required', 400)
    if action in {'create_ticket', 'create_custom_ticket', 'edit_ticket'}:
        keys = {'company_id' if action != 'edit_ticket' else 'ticket_id', 'available_from', 'available_till'} | ({'name'} if custom else set())
        if set(data) != keys: raise CommandError('invalid_supplier_fields', 400)
        result = dates(data)
        key = 'ticket_id' if action == 'edit_ticket' else 'company_id'; result[key] = positive_id(data[key])
        if custom:
            if not isinstance(data['name'], str) or not 1 <= len(data['name'].strip()) <= 200: raise CommandError('supplier_item_name_required', 400)
            result['name'] = data['name'].strip()
    else:
        quantity = data.get('quantity')
        if type(quantity) is not int or not 1 <= quantity <= 1000000: raise CommandError('invalid_supplier_quantity', 400)
        result = {'quantity': quantity, 'rental_price': money(data.get('rental_price'))}
        if action == 'edit_item':
            if set(data) != {'ticket_id', 'item_id', 'quantity', 'rental_price'}: raise CommandError('invalid_supplier_fields', 400)
            result['item_id'] = positive_id(data['item_id']); result['ticket_id'] = positive_id(data['ticket_id'])
        else:
            result['ticket_id'] = positive_id(data.get('ticket_id'))
            if data.get('asset_id') is not None:
                if set(data) != {'ticket_id', 'asset_id', 'quantity', 'rental_price'}: raise CommandError('invalid_supplier_fields', 400)
                result['asset_id'] = positive_id(data['asset_id'])
            else:
                if set(data) != {'ticket_id', 'asset_id', 'name', 'price', 'depreciation', 'quantity', 'rental_price'}: raise CommandError('invalid_supplier_fields', 400)
                if not isinstance(data['name'], str) or not 1 <= len(data['name'].strip()) <= 200: raise CommandError('supplier_item_name_required', 400)
                result.update(asset_id=None, name=data['name'].strip(), price=money(data['price']), depreciation=money(data['depreciation'], Decimal('100')))
    return {'request_id': request_id, 'action': action, 'conference_id': payload['conference_id'], 'expected_revision': payload['expected_revision'], 'reason': reason.strip(), 'data': result}


def snapshot(ticket, item=None):
    result = {'ticket': {'id': ticket.pk, 'company_id': ticket.company_id, 'company_name': ticket.company.name, 'conference_id': ticket.conference_id,
                        'available_from': str(ticket.available_from) if ticket.available_from else None,
                        'available_till': str(ticket.available_till) if ticket.available_till else None}}
    if item: result['item'] = {'id': item.pk, 'asset_id': item.asset_id, 'sku': item.asset.sku, 'alias_name': item.asset.alias_name, 'qr_code': item.asset.qr_code, 'quantity': item.quantity, 'rental_price': str(item.rental_price)}
    return result


def quantity_has_history(item):
    asset = item.asset
    from .models import SupplierBalance
    balance = SupplierBalance.objects.filter(item=item).first()
    return (balance is not None and balance.movements.exists() or ChallanLine.objects.filter(ticket_item=item).exists() or ChallanLine.objects.filter(asset=asset).exists()
        or asset.assigned_to_id or asset.staff_allocations.exists() or asset.physical_movements.exists()
        or asset.quantity_allocations.exists() or asset.consumable_allocations.exists()
        or any(getattr(asset, field).exists() for field in ('assigned_conferences', 'crosscheck_conferences', 'staged_conferences', 'requirement_conferences', 'challan_conferences', 'truck_challans')))


@transaction.atomic
def execute_supplier_command(user, payload):
    from .supplier_balances import BALANCE_ACTIONS, execute_balance, order_capacity
    from .models import SupplierBalance
    if isinstance(payload, dict) and isinstance(payload.get('action'), str) and payload['action'] in BALANCE_ACTIONS:
        return execute_balance(user, payload)
    command = normalize(payload); action = command['action']; data = command['data']
    fingerprint = hashlib.sha256(json.dumps({'operation': 'supplier_paperwork', **command}, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    previous = MovementReceipt.objects.filter(actor=user, request_id=command['request_id']).first()
    if previous:
        if previous.payload_hash != fingerprint: raise CommandError('request_id_reused')
        return {**previous.result, 'replayed': True}
    if get_business_role(user) not in WAREHOUSE_ROLES: raise CommandError('not_authorized', 403)
    receipt, created = MovementReceipt.objects.get_or_create(actor=user, request_id=command['request_id'], defaults={'payload_hash': fingerprint})
    if not created:
        if receipt.payload_hash != fingerprint: raise CommandError('request_id_reused')
        return {**receipt.result, 'replayed': True}
    item = None; ticket = None; before = {}
    if action == 'create_custom_ticket':
        company = SubrentalCompany.objects.select_for_update().filter(pk=data['company_id']).first()
        if company is None: raise CommandError('unknown_supplier', 404)
        event = Conference.objects.create(name=data['name'], start_date=data['available_from'], end_date=data['available_till'])
    else:
        raw_asset = data.get('asset_id')
        if action == 'edit_item':
            source = SubrentalTicketItem.objects.filter(pk=data['item_id']).values('asset_id', 'ticket_id', 'ticket__company_id', 'ticket__conference_id').first()
            if not source or source['ticket__conference_id'] != command['conference_id'] or source['ticket_id'] != data['ticket_id']: raise CommandError('supplier_item_context_changed')
            raw_asset = source['asset_id']; ticket_id = source['ticket_id']; company_id = source['ticket__company_id']
        elif action in {'add_item', 'edit_ticket'}:
            source = SubrentalTicket.objects.filter(pk=data['ticket_id']).values('company_id', 'conference_id').first()
            if not source or source['conference_id'] != command['conference_id']: raise CommandError('supplier_ticket_context_changed')
            ticket_id = data['ticket_id']; company_id = source['company_id']
        else: company_id = data['company_id']
        try: event = lock_conference_for_write(command['conference_id'], {'challan_assets': [raw_asset] if raw_asset else []})
        except Conference.DoesNotExist: raise CommandError('unknown_conference', 404)
        from .event_lifecycle import require_open_event
        require_open_event(event)
        # All supported event writers advance this revision before releasing locks.
        if event.revision != command['expected_revision']: raise CommandError('supplier_event_changed')
        if event.is_audit: raise CommandError('supplier_ticket_requires_real_event')
        company = SubrentalCompany.objects.select_for_update().filter(pk=company_id).first()
        if company is None: raise CommandError('unknown_supplier', 404)
        if action in {'add_item', 'edit_item', 'edit_ticket'}:
            ticket = SubrentalTicket.objects.select_for_update().get(pk=ticket_id)
            if ticket.company_id != company_id or ticket.conference_id != event.pk: raise CommandError('supplier_ticket_context_changed')
            if action == 'edit_item':
                item = SubrentalTicketItem.objects.select_for_update().select_related('asset').get(pk=data['item_id'])
                if item.ticket_id != ticket.pk or item.asset_id != raw_asset: raise CommandError('supplier_item_context_changed')
            before = snapshot(ticket, item)
    before['conference'] = {'id': event.pk, 'revision': event.revision}
    if action in {'create_ticket', 'create_custom_ticket'}:
        ticket = SubrentalTicket.objects.create(company=company, conference=event, available_from=data['available_from'], available_till=data['available_till'])
    elif action == 'edit_ticket':
        ticket.available_from=data['available_from']; ticket.available_till=data['available_till']; ticket.save(update_fields=['available_from','available_till'])
    elif action == 'add_item':
        if data['asset_id'] is None:
            asset = Asset.objects.create(sku=f'SR-{ticket.pk}-{uuid.uuid4().hex[:16]}', alias_name=data['name'], name=data['name'],
                item_price=data['price'], depreciation_percentage=data['depreciation'], quantity=data['quantity'], subrental_company=company, is_temporary=True, type='Other')
        else:
            asset = Asset.objects.filter(pk=data['asset_id']).first()
            if asset is None: raise CommandError('unknown_assets', 400)
            if asset.subrental_company_id != company.pk: raise CommandError('supplier_asset_owner_mismatch')
            if company.inventory_mode == 'shared_warehouse': raise CommandError('shared_stock_uses_warehouse_movements')
            if asset.is_temporary or asset.parent_asset_id or asset.sub_assets.exists() or asset.type == 'Consumables': raise CommandError('supplier_source_requires_review')
            if ticket.items.filter(asset=asset).exists(): raise CommandError('supplier_item_already_on_ticket')
        if data['quantity'] > asset.quantity: raise CommandError('supplier_quantity_exceeds_inventory')
        if data['quantity'] + order_capacity(asset) > asset.quantity: raise CommandError('supplier_catalogue_capacity_exceeded')
        item = SubrentalTicketItem.objects.create(ticket=ticket, asset=asset, quantity=data['quantity'], rental_price=data['rental_price'])
        SupplierBalance.objects.create(item=item, ordered=item.quantity, provenance='new_order', opening_receipt=receipt, order_receipt=receipt)
    else:
        if item.quantity != data['quantity'] and quantity_has_history(item): raise CommandError('supplier_quantity_has_history')
        if data['quantity'] > item.asset.quantity: raise CommandError('supplier_quantity_exceeds_inventory')
        if item.quantity != data['quantity'] and data['quantity'] + order_capacity(item.asset, item.pk) > item.asset.quantity:
            raise CommandError('supplier_catalogue_capacity_exceeded')
        if item.quantity != data['quantity']:
            balance = SupplierBalance.objects.filter(item=item).first()
            if balance:
                balance.ordered=data['quantity']; balance.order_receipt=receipt; balance.revision += 1; balance.save()
        item.quantity=data['quantity']; item.rental_price=data['rental_price']; item.save(update_fields=['quantity','rental_price'])
    event.save(update_fields=['revision'])
    change = SupplierChange.objects.create(receipt=receipt, company=company, ticket=ticket, item=item,
        asset=item.asset if item else None, action=action, reason=command['reason'], before=before, after={**snapshot(ticket, item), 'conference': {'id': event.pk, 'revision': event.revision}})
    result = {'operation':'supplier_paperwork', 'request_id':command['request_id'], 'action':action, 'change_id':change.pk,
              'ticket_id':ticket.pk, 'conference_id':event.pk, 'revision':event.revision, 'replayed':False}
    receipt.result=result; receipt.save(update_fields=['result']); return result


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def supplier_commands(request):
    try: return Response(execute_supplier_command(request.user, request.data))
    except CommandError as error: return Response({'error':error.code,'details':error.details}, status=error.status)
