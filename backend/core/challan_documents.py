"""Documentary lines are snapshots, not inventory writes or custody commands.

The stable event/scope endpoint also supports first save. GET never initializes a
document. Every successful save has an immutable revision and an exact retry receipt.
"""
import hashlib
import json
import uuid
from datetime import date
from decimal import Decimal, InvalidOperation

from django.db import transaction
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .asset_commands import CommandError, canonical_conference
from .models import (Asset, Conference, TruckChallan, SubrentalTicketItem, SubrentalCompany,
                     ChallanDocument, ChallanLine, ChallanRevision, MovementReceipt,
                     ChallanNumberLock, ChallanNumberReservation, CompanySettings)
from .permissions import WAREHOUSE_ROLES, get_business_role
from .challan_lock import require_challan_edit

SNAPSHOT_FIELDS = {'sku': 100, 'alias_name': 200, 'serial_number': 2000,
                   'description': 10000, 'type': 100, 'mac_address': 100,
                   'imei_number_1': 100, 'imei_number_2': 100, 'supplier_name': 200}


def decimal_value(value, nullable=False):
    if nullable and value is None:
        return None
    if isinstance(value, bool) or value is None:
        raise CommandError('invalid_value', 400)
    try:
        result = Decimal(str(value))
        if not result.is_finite() or result < 0 or result >= Decimal('1e18') or result != result.quantize(Decimal('.01')):
            raise CommandError('invalid_value', 400)
        return result.quantize(Decimal('.01'))
    except (InvalidOperation, ValueError, TypeError):
        raise CommandError('invalid_value', 400)


def document_data(document):
    return {
        'id': str(document.pk), 'conference_id': document.conference_id,
        'truck_id': document.truck_id, 'scope': document.scope,
        'revision': document.revision, 'number': document.number, 'state': document.state,
        'document_date': document.document_date.isoformat() if document.document_date else None,
        'total_override': str(document.total_override) if document.total_override is not None else None,
        'header': document.header, 'provenance': document.provenance,
        'lines': [{'id': str(line.pk), 'asset_id': line.asset_id,
                   'ticket_item_id': line.ticket_item_id, 'supplier_id': line.supplier_id,
                   'source_kind': line.source_kind, 'snapshot': line.snapshot,
                   'quantity': line.quantity, 'unit_value': str(line.unit_value),
                   'position': line.position} for line in document.lines.all()],
    }


def number_mutex():
    ChallanNumberLock.objects.get_or_create(pk=1)
    return ChallanNumberLock.objects.select_for_update().get(pk=1)


@transaction.atomic
def allocate_number(settings_obj=None):
    """One lock for legacy creation and new documents; never allocate on a read."""
    from .models import get_current_financial_year
    number_mutex()
    config = CompanySettings.objects.select_for_update().order_by('pk').first()
    fy = get_current_financial_year()
    prefix = ((config.challan_prefix if config else '') or 'AMDL').strip()
    counter = max(1, config.next_challan_number) if config and config.challan_fy == fy else 1
    while True:
        candidate = f'{fy}/{prefix}-{counter:05d}'
        if not (Conference.objects.filter(challan_number=candidate).exists()
                or TruckChallan.objects.filter(challan_number=candidate).exists()
                or ChallanNumberReservation.objects.filter(number=candidate).exists()):
            break
        counter += 1
    if config:
        config.challan_fy = fy
        config.next_challan_number = counter + 1
        config.save(update_fields=['challan_fy', 'next_challan_number'])
    else:
        # Creation occurs under the singleton mutex, including the first settings row.
        CompanySettings.objects.create(challan_fy=fy, next_challan_number=counter + 1)
    return candidate


@transaction.atomic
def reserve_number(number, event, truck, document=None):
    number_mutex()
    if not number:
        number = allocate_number()
    if (Conference.objects.exclude(pk=event.pk).filter(challan_number=number).exists()
            or TruckChallan.objects.exclude(conference=event).filter(challan_number=number).exists()):
        raise CommandError('number_already_used')
    reservation, _ = ChallanNumberReservation.objects.get_or_create(number=number, defaults={'conference': event})
    if reservation.conference_id != event.pk:
        raise CommandError('number_already_used')
    # Historical Truck 1 is an alias of the master number, within the same event.
    # Other truck scopes must have their own number. Old reservations are retained.
    others = ChallanDocument.objects.filter(number=number)
    if document:
        others = others.exclude(pk=document.pk)
    for other in others:
        if other.conference_id != event.pk or (truck and truck.truck_number != 1) or (other.truck_id and other.truck.truck_number != 1):
            raise CommandError('number_already_used')
    for other in event.truck_challans.filter(challan_number=number):
        if other.pk != (truck.pk if truck else None) and other.truck_number != 1:
            raise CommandError('number_already_used')
    if truck and truck.truck_number != 1 and event.challan_number == number:
        raise CommandError('number_already_used')
    return number


def normalize(payload):
    allowed = {'request_id', 'expected_revision', 'expected_event_revision', 'lines', 'number',
               'total_override', 'document_date', 'state', 'correction_reason'}
    if not isinstance(payload, dict) or set(payload) - allowed:
        raise CommandError('invalid_payload', 400)
    try:
        request_id = str(uuid.UUID(str(payload.get('request_id'))))
    except (ValueError, TypeError, AttributeError):
        raise CommandError('invalid_request_id', 400)
    if type(payload.get('expected_revision')) is not int or payload['expected_revision'] < 0:
        raise CommandError('expected_revision_required', 428)
    if type(payload.get('expected_event_revision')) is not int or payload['expected_event_revision'] < 0:
        raise CommandError('expected_event_revision_required', 428)
    lines = payload.get('lines')
    if not isinstance(lines, list) or len(lines) > 1000:
        raise CommandError('invalid_lines', 400)
    normalized, ids, sources, asset_sources = [], set(), set(), {}
    for position, line in enumerate(lines):
        if not isinstance(line, dict) or set(line) - {'id', 'asset_id', 'ticket_item_id', 'supplier_id', 'source_kind', 'snapshot', 'quantity', 'unit_value', 'position'}:
            raise CommandError('invalid_line', 400)
        try:
            line_id = str(uuid.UUID(str(line.get('id'))))
        except (ValueError, TypeError, AttributeError):
            raise CommandError('invalid_line_id', 400)
        if line_id in ids:
            raise CommandError('duplicate_line', 400)
        ids.add(line_id)
        kind = line.get('source_kind')
        if kind not in {'owned', 'supplier', 'manual'} or type(line.get('quantity')) is not int or not 1 <= line['quantity'] <= 1000000:
            raise CommandError('invalid_line_quantity_or_source', 400)
        refs = {key: line.get(key) for key in ('asset_id', 'ticket_item_id', 'supplier_id')}
        if any(value is not None and (type(value) is not int or value <= 0) for value in refs.values()):
            raise CommandError('invalid_source_reference', 400)
        if kind == 'manual' and any(refs.values()):
            raise CommandError('manual_line_has_inventory_reference', 400)
        if kind != 'manual' and not refs['asset_id']:
            raise CommandError('asset_reference_required', 400)
        if kind == 'owned' and (refs['ticket_item_id'] or refs['supplier_id']):
            raise CommandError('invalid_owned_reference', 400)
        if kind == 'supplier' and not refs['supplier_id']:
            raise CommandError('supplier_reference_required', 400)
        source = ('ticket', refs['ticket_item_id']) if refs['ticket_item_id'] else ('asset', refs['asset_id'])
        if kind != 'manual':
            if source in sources:
                raise CommandError('duplicate_source', 400)
            previous_kind = asset_sources.get(refs['asset_id'])
            kind_of_reference = 'ticket' if refs['ticket_item_id'] else 'inventory'
            if previous_kind and previous_kind != kind_of_reference:
                raise CommandError('overlapping_inventory_and_supplier_ticket', 400)
            asset_sources[refs['asset_id']] = kind_of_reference
            sources.add(source)
        snapshot = line.get('snapshot')
        if not isinstance(snapshot, dict) or set(snapshot) - set(SNAPSHOT_FIELDS):
            raise CommandError('invalid_snapshot', 400)
        if any(not isinstance(value, str) or len(value) > SNAPSHOT_FIELDS[key] for key, value in snapshot.items()):
            raise CommandError('invalid_snapshot', 400)
        if not (snapshot.get('alias_name') or snapshot.get('description') or snapshot.get('sku')):
            raise CommandError('line_description_required', 400)
        normalized.append({'id': line_id, **refs, 'source_kind': kind, 'snapshot': snapshot,
                           'quantity': line['quantity'], 'unit_value': str(decimal_value(line.get('unit_value'))), 'position': position})
    number = payload.get('number', '')
    if not isinstance(number, str) or len(number.strip()) > 50:
        raise CommandError('invalid_number', 400)
    state = payload.get('state', 'draft')
    if state not in {'draft', 'issued'}:
        raise CommandError('invalid_state', 400)
    try:
        document_date = date.fromisoformat(payload['document_date']) if payload.get('document_date') else None
    except (TypeError, ValueError):
        raise CommandError('invalid_date', 400)
    reason = payload.get('correction_reason', '')
    if not isinstance(reason, str) or len(reason) > 2000:
        raise CommandError('invalid_correction_reason', 400)
    return {'request_id': request_id, 'expected_revision': payload['expected_revision'],
            'expected_event_revision': payload['expected_event_revision'], 'lines': normalized,
            'number': number.strip(), 'total_override': str(decimal_value(payload['total_override'])) if payload.get('total_override') is not None else None,
            'document_date': document_date.isoformat() if document_date else None,
            'state': state, 'correction_reason': reason.strip()}


def capture_header(event, truck=None, owner_sections_version=1, *, issuer=None):
    settings = issuer or CompanySettings.objects.order_by('pk').first()
    keys = ['name', 'association_name', 'billing_address', 'transport_address', 'gst_number',
            'contact_person', 'contact_phone', 'contact_email', 'conference_type', 'start_date', 'end_date']
    header = {key: str(getattr(event, key) or '') for key in keys}
    from .dispatch_origins import event_origins
    header['dispatch_origins'] = event_origins(event)
    multi_truck = not truck and event.truck_challans.exists()
    header.update(vehicle_number=truck.vehicle_number if truck else '' if multi_truck else event.vehicle_number,
                  driver_phone=truck.driver_phone if truck else '' if multi_truck else event.driver_phone)
    if settings:
        header['company'] = {key: str(getattr(settings, key) or '') for key in ['name', 'address', 'phone', 'email', 'gst_number', 'website', 'powered_by_name']}
        header['company']['logo'] = settings.logo.url if settings.logo else None
    if owner_sections_version == 1: header['owner_sections_version'] = 1
    return header


def capture_saved_header(event, truck=None, owner_sections_version=1):
    from .challan_archive_files import archive_file, issuer_logo
    issuer = CompanySettings.objects.order_by('pk').first()
    header = capture_header(event, truck, owner_sections_version, issuer=issuer)
    logo = issuer_logo(issuer)
    if logo:
        archive_file(*logo)
        header['company']['logo'] = f'/api/challan-logos/{logo[0]}/'
    return header


def replace_lines(document, lines):
    """Retain source UUIDs/FKs; park positions before a reorder to avoid collisions."""
    from django.db.models import F
    ids = [line['id'] for line in lines]
    if ChallanLine.objects.filter(pk__in=ids).exclude(document=document).exists():
        raise CommandError('line_belongs_to_another_document', 400)
    document.lines.all().update(position=F('position') + 2000)
    document.lines.exclude(pk__in=ids).delete()
    for line in lines:
        values = dict(line); key = values.pop('id')
        ChallanLine.objects.update_or_create(pk=key, defaults={'document': document, **values})


@transaction.atomic
def save_document(user, event_id, scope, payload, coordinated=False):
    command = normalize(payload)
    fingerprint = hashlib.sha256(json.dumps({'operation': 'challan_document', 'event_id': event_id,
                                            'scope': scope, **command}, sort_keys=True).encode()).hexdigest()
    existing = MovementReceipt.objects.filter(actor=user, request_id=command['request_id']).first()
    if existing:
        if existing.payload_hash != fingerprint:
            raise CommandError('request_id_reused')
        return {**existing.result, 'replayed': True}
    if get_business_role(user) not in WAREHOUSE_ROLES:
        raise CommandError('not_authorized', 403)
    receipt, created = MovementReceipt.objects.get_or_create(actor=user, request_id=command['request_id'], defaults={'payload_hash': fingerprint})
    if not created:
        if receipt.payload_hash != fingerprint:
            raise CommandError('request_id_reused')
        return {**receipt.result, 'replayed': True}
    # Match the movement lock order. Include previous references for removals.
    previous_ids = ChallanLine.objects.filter(document__conference_id=event_id, document__scope=scope).values_list('asset_id', flat=True)
    asset_ids = {line['asset_id'] for line in command['lines'] if line['asset_id']} | set(previous_ids)
    from .event_lifecycle import referenced_asset_ids
    asset_ids.update(referenced_asset_ids(event_id))
    assets = {a.pk: a for a in Asset.objects.select_for_update().filter(pk__in=asset_ids).order_by('pk')}
    try:
        event = Conference.objects.select_for_update().get(pk=event_id)
    except Conference.DoesNotExist:
        raise CommandError('unknown_conference', 404)
    trucks = list(TruckChallan.objects.select_for_update().filter(conference=event).order_by('pk'))
    from .models import TruckManifest
    if TruckManifest.objects.filter(conference=event).exists() and not coordinated:
        raise CommandError('use_manifest_commands')
    truck = None
    if scope != 'master':
        truck = next((t for t in trucks if scope == f'truck-{t.pk}'), None)
        if not truck:
            raise CommandError('unknown_document_scope', 404)
    document = ChallanDocument.objects.select_for_update().filter(conference=event, scope=scope).first()
    late_correction = require_challan_edit(
        event, user, correction=bool(document and command['state'] == 'issued'),
        reason=command['correction_reason'], require_open=True,
    )
    if command['expected_revision'] != (document.revision if document else 0):
        raise CommandError('document_changed')
    if command['expected_event_revision'] != event.revision:
        raise CommandError('event_changed')
    was_issued = bool(document and document.state == 'issued')
    if was_issued or late_correction:
        if command['state'] != 'issued' or not command['correction_reason']:
            raise CommandError('issued_document_requires_correction_reason')
        if command['number'] != document.number:
            raise CommandError('issued_number_is_permanent')
    if command['state'] == 'issued' and (not command['lines'] or not command['document_date']) and not (
        was_issued and document.provenance == 'reviewed_legacy_archive'
        and (command['lines'] or document.header.get('original_pdf_sha256'))
    ):
        raise CommandError('issued_document_requires_lines_and_date', 400)
    originals = {str(line.pk): line for line in document.lines.all()} if document else {}
    foreign_ids = ChallanLine.objects.filter(pk__in=[line['id'] for line in command['lines']])
    if document:
        foreign_ids = foreign_ids.exclude(document=document)
    if foreign_ids.exists():
        raise CommandError('line_belongs_to_another_document', 400)
    ticket_ids = [line['ticket_item_id'] for line in command['lines'] if line['ticket_item_id']]
    tickets = {item.pk: item for item in SubrentalTicketItem.objects.select_for_update().select_related('ticket').filter(pk__in=ticket_ids).order_by('pk')}
    linked = set(event.assets.values_list('pk', flat=True)) | set(event.staged_assets.values_list('pk', flat=True)) | set(event.challan_assets.values_list('pk', flat=True)) | set(event.crosscheck_assets.values_list('pk', flat=True))
    consumables = {row.asset_id: row for row in event.consumable_allocations.all()}
    quantities = {row.asset_id: row for row in event.quantity_allocations.all()}
    linked.update(aid for aid, row in consumables.items() if row.requested > 0)
    linked.update(aid for aid, row in quantities.items() if row.dispatched_total + row.reserved)
    allocated = {}
    if truck and event.quantity_allocations.exists():
        raise CommandError('quantity_trucks_require_coordinated_workflow')
    if truck and (event.consumable_allocations.exists() or any(assets[aid].type == 'Consumables' for aid in assets)):
        raise CommandError('consumable_trucks_require_coordinated_workflow')
    for line in command['lines']:
        original = originals.get(line['id'])
        same_ref = original and all(getattr(original, field) == line[field] for field in ('asset_id', 'ticket_item_id', 'supplier_id', 'source_kind'))
        if original and not same_ref:
            raise CommandError('line_source_is_immutable', 400)
        asset = assets.get(line['asset_id'])
        if line['asset_id'] and not asset:
            raise CommandError('unknown_asset', 400)
        if line['ticket_item_id']:
            item = tickets.get(line['ticket_item_id'])
            if not item or item.ticket.conference_id != event.pk or item.asset_id != line['asset_id'] or (not same_ref and item.ticket.company_id != line['supplier_id']):
                raise CommandError('ticket_not_in_document_event', 400)
            if (not same_ref or line['quantity'] > original.quantity) and line['quantity'] > item.quantity:
                raise CommandError('document_quantity_exceeds_supplier_order')
            if not same_ref or line['quantity'] > original.quantity:
                from .models import SupplierBalance
                from .supplier_balances import balance_data
                if SupplierBalance.objects.filter(item=item).exists():
                    balance = balance_data(item)
                    if balance['state'] != 'recorded' or line['quantity'] > balance['received']:
                        raise CommandError('document_quantity_exceeds_supplier_receipts')
            if not same_ref and asset.subrental_company_id and asset.subrental_company.inventory_mode == 'shared_warehouse':
                raise CommandError('shared_stock_ticket_requires_review')
        elif asset:
            allocation = quantities.get(asset.pk)
            if not same_ref and asset.subrental_company_id and (asset.quantity_tracking or asset.quantity != 1) and asset.type != 'Consumables':
                from .inventory_ownership import require_warehouse_quantity_source
                require_warehouse_quantity_source(asset)
                if not allocation: raise CommandError('legacy_quantity_requires_reconciliation')
            if allocation and (not same_ref or line['quantity'] > original.quantity):
                if line['quantity'] > (allocation.dispatched_total + allocation.reserved):
                    raise CommandError('document_quantity_exceeds_event_allocation')
            if asset.type == 'Consumables' and (not same_ref or line['quantity'] > original.quantity):
                allocation = consumables.get(asset.pk)
                if not allocation:
                    raise CommandError('legacy_consumables_require_reconciliation')
                if line['quantity'] > allocation.requested:
                    raise CommandError('document_quantity_exceeds_consumable_request')
            if not same_ref and asset.pk not in linked:
                raise CommandError('asset_not_in_document_event', 400)
            if not same_ref and (('supplier' if asset.subrental_company_id else 'owned') != line['source_kind'] or asset.subrental_company_id != line['supplier_id']):
                raise CommandError('source_ownership_changed')
            if truck:
                allocated[str(asset.pk)] = line['quantity']
        if line['supplier_id']:
            if same_ref:
                if line['snapshot'].get('supplier_name', '') != original.snapshot.get('supplier_name', ''):
                    raise CommandError('printed_owner_label_is_immutable', 400)
            else:
                supplier = SubrentalCompany.objects.filter(pk=line['supplier_id']).first()
                if not supplier: raise CommandError('unknown_supplier', 400)
                line['snapshot']['supplier_name'] = supplier.name
    if truck:
        for key, quantity in allocated.items():
            asset = assets[int(key)]
            other_quantity = 0
            for other in trucks:
                if other.pk == truck.pk:
                    continue
                member = other.assets.filter(pk=asset.pk).exists()
                value = (other.asset_quantities or {}).get(key, asset.quantity if member else 0)
                if type(value) is not int or value < 0 or (value and not member):
                    raise CommandError('invalid_existing_truck_allocation')
                other_quantity += value
            if quantity + other_quantity > asset.quantity:
                raise CommandError('truck_allocations_exceed_stock')
    number = document.number if was_issued or late_correction else reserve_number(command['number'], event, truck, document)
    new_document = document is None
    if not document:
        document = ChallanDocument(conference=event, truck=truck, scope=scope, provenance='legacy_snapshot_at_first_save')
    document.number = number
    document.state = command['state']
    document.document_date = date.fromisoformat(command['document_date']) if command['document_date'] else None
    document.total_override = Decimal(command['total_override']) if command['total_override'] is not None else None
    # Capture headers at each draft save/issue; issued corrections retain original headers.
    if not (was_issued or late_correction):
        document.header = capture_saved_header(event, truck, 1 if new_document else document.header.get('owner_sections_version'))
    document.revision += 1
    document.save()
    replace_lines(document, command['lines'])
    if late_correction:
        # The late correction revises paper, not the event or its warehouse custody.
        pass
    elif truck:
        event.challan_assets.add(*list(truck.assets.values_list('pk', flat=True)))
        truck.asset_quantities = allocated
        truck.challan_number = number
        truck.save(update_fields=['asset_quantities', 'challan_number'])
        truck.assets.set([int(key) for key in allocated])
    else:
        # Compatibility number only. Custody and frozen legacy membership remain untouched.
        event.challan_number = number
    if not late_correction:
        event.save(update_fields=['challan_number'])
    data = document_data(document)
    ChallanRevision.objects.create(document=document, revision=document.revision, actor=user,
                                   reason=command['correction_reason'], snapshot=data)
    result = {'document': data, 'conference': canonical_conference(event), 'request_id': command['request_id'], 'replayed': False}
    receipt.result = result
    receipt.save(update_fields=['result'])
    return result


@api_view(['GET', 'PUT'])
@permission_classes([IsAuthenticated])
def challan_document(request, pk, scope):
    if request.method == 'GET':
        if not Conference.objects.filter(pk=pk).exists():
            return Response({'error': 'unknown_conference'}, status=404)
        document = ChallanDocument.objects.filter(conference_id=pk, scope=scope).prefetch_related('lines').first()
        return Response({'document': document_data(document) if document else None})
    try:
        return Response(save_document(request.user, pk, scope, request.data))
    except CommandError as error:
        return Response({'error': error.code, 'conflicts': error.details}, status=error.status)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def challan_history(request, document_id):
    if get_business_role(request.user) not in WAREHOUSE_ROLES | {'accounts'}:
        return Response({'error': 'not_authorized'}, status=403)
    if not ChallanDocument.objects.filter(pk=document_id).exists():
        return Response({'error': 'unknown_document'}, status=404)
    return Response([{'revision': row.revision, 'reason': row.reason,
                      'created_at': row.created_at.isoformat(), 'snapshot': row.snapshot}
                     for row in ChallanRevision.objects.filter(document_id=document_id).order_by('revision')])
