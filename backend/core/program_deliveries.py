"""Saved delivery papers. Issuing/reprinting never dispatches or duplicates stock."""
import hashlib
import json
from datetime import date
from uuid import UUID

from django.db import IntegrityError, transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework.decorators import api_view, permission_classes
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .models import Asset, CompanySettings, Conference, ProgramDelivery, SubrentalTicketItem, TruckChallan


def access(user, write=False):
    from .permissions import get_business_role, WAREHOUSE_ROLES
    allowed = WAREHOUSE_ROLES | (set() if write else {'accounts'})
    if get_business_role(user) not in allowed:
        raise PermissionDenied('This login cannot issue delivery challans.' if write else 'This login cannot access delivery challans.')


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()).hexdigest()


def label(value, limit=500, required=False):
    if not isinstance(value, str) or len(value.strip()) > limit or (required and not value.strip()):
        raise ValidationError(f'Enter a valid text value of up to {limit} characters.')
    return value.strip()


def integer(value):
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 1000000:
        raise ValidationError('Quantities must be whole numbers between 1 and 1000000.')
    return value


def party(obj):
    return {key: getattr(obj, key, '') or '' for key in ('name', 'address', 'gst_number', 'phone', 'email', 'website')}


SUPPLIER_FIELDS = {
    'issuer_name': 200, 'issuer_address': 4000, 'issuer_gst_number': 20,
    'recipient_name': 200, 'recipient_address': 4000, 'recipient_gst_number': 20,
    'destination': 4000, 'vehicle_number': 50, 'driver_phone': 50,
}


def supplier_edits(data, selected):
    """Paper-only corrections cannot change equipment ownership or row identity."""
    owners = {str(row['owner_id']) for row in selected if row['owner_id']}
    if not isinstance(data, dict) or set(data) - owners:
        raise ValidationError('Supplier details must belong to the selected delivery equipment.')
    result = {}
    for owner_id, changes in data.items():
        if not isinstance(changes, dict) or set(changes) - SUPPLIER_FIELDS.keys():
            raise ValidationError('Invalid supplier paper fields.')
        result[owner_id] = {field: label(value, SUPPLIER_FIELDS[field], required=field.endswith('_name'))
                            for field, value in changes.items()}
    return result


def supplier_paper(common, source, rows, number, changes):
    issuer, recipient = dict(rows[0]['owner']), dict(source['issuer'])
    for prefix, target in [('issuer', issuer), ('recipient', recipient)]:
        for field in ('name', 'address', 'gst_number'):
            key = f'{prefix}_{field}'
            if key in changes:
                target[field] = changes[key]
    from .dispatch_origins import selected_origins
    return {**common, 'dispatch_origins': selected_origins(source.get('dispatch_origins', []), [row['asset_id'] for row in rows]),
            'number': number, 'direction': 'supplier', 'issuer': issuer, 'recipient': recipient, 'rows': rows,
            'destination': changes.get('destination', source['issuer'].get('address', '')),
            'vehicle_number': changes.get('vehicle_number', ''), 'driver_phone': changes.get('driver_phone', '')}


def sources(conference, truck_id=None, lock=False):
    """Use reviewed durable lines and ledger capacity, never today's stock total."""
    from .models import ChallanDocument
    scope = f'truck-{truck_id}' if truck_id is not None else 'master'
    if truck_id is not None:
        get_object_or_404(TruckChallan, pk=truck_id, conference=conference)
    document = ChallanDocument.objects.filter(conference=conference, scope=scope).first()
    if document is None:
        raise ValidationError('Save a reviewed customer challan before creating this delivery. Existing saved delivery copies remain available.')
    header = document.header
    issuer = header.get('company')
    if not isinstance(issuer, dict) or not issuer.get('name'):
        raise ValidationError('The saved customer challan needs its issuing-company details reviewed.')
    quantities = {row.asset_id: row for row in conference.quantity_allocations.all()}
    consumers = {row.asset_id: row for row in conference.consumable_allocations.all()}
    rows, seen = [], set()
    for line in document.lines.select_related('asset__subrental_company', 'supplier', 'ticket_item__ticket').order_by('position', 'id'):
        asset, owner, item = line.asset, line.supplier, line.ticket_item
        if asset and asset.stock_kind == 'led_case':
            raise ValidationError('This historical LED box was converted to panels. Select its panels for a new delivery; existing saved papers remain available.')
        snapshot = line.snapshot
        quantity = integer(line.quantity)
        if line.source_kind == 'manual':
            key = f'line:{line.pk}'
            if asset or owner or item:
                raise ValidationError('Review the manual challan source before issuing.')
        else:
            if not asset or asset.subrental_company_id != line.supplier_id:
                raise ValidationError('The saved equipment owner changed. Review the customer challan before issuing a new delivery.')
            key = f'ticket:{item.pk}' if item else f'asset:{asset.pk}'
            if asset.pk in seen:
                raise ValidationError('The same equipment appears in multiple saved challan sources. Review the duplicate before issuing.')
            seen.add(asset.pk)
            if item:
                from .supplier_balances import balance_data
                if item.ticket.conference_id != conference.pk or item.ticket.company_id != line.supplier_id:
                    raise ValidationError('Review the saved supplier ticket identity before issuing.')
                if owner and owner.inventory_mode == 'shared_warehouse':
                    raise ValidationError('Shared godown stock uses its warehouse allocation, not a supplier order.')
                balance = balance_data(item)
                if balance['state'] != 'recorded' or quantity > balance['received']:
                    raise ValidationError('The supplier receipt balance needs review before issuing this delivery.')
            elif asset.type == 'Consumables':
                allocation = consumers.get(asset.pk)
                if allocation is None or quantity > allocation.requested:
                    raise ValidationError('The saved consumable quantity exceeds its recorded program allocation.')
            elif asset.quantity_tracking or asset.quantity != 1:
                allocation = quantities.get(asset.pk)
                if allocation is None or quantity > allocation.dispatched_total + allocation.reserved:
                    raise ValidationError('The saved bulk quantity exceeds its recorded program allocation.')
            elif quantity > 1:
                raise ValidationError('A single physical unit cannot have a delivery quantity above one.')
        owner_snapshot = party(owner) if owner else None
        if owner_snapshot:
            owner_snapshot['name'] = snapshot.get('supplier_name') or owner.name
        rows.append({'key': key, 'line_id': str(line.pk), 'asset_id': asset.pk if asset else None,
            'quantity': quantity, 'name': snapshot.get('alias_name') or snapshot.get('description') or snapshot.get('sku') or 'Manual addition',
            'sku': snapshot.get('sku') or '', 'serial': snapshot.get('serial_number') or '',
            'owner_id': line.supplier_id, 'owner': owner_snapshot})
    return {'version': 2, 'conference_id': conference.pk, 'truck_id': truck_id,
        'dispatch_origins': header.get('dispatch_origins', []),
        'document_id': str(document.pk), 'document_revision': document.revision,
        'event_revision': conference.revision,
        'program': {'name': header.get('name', ''), 'start_date': header.get('start_date', ''), 'end_date': header.get('end_date', '')},
        'issuer': issuer, 'customer': {'name': header.get('association_name') or header.get('name', ''),
            'address': header.get('billing_address', ''), 'gst_number': header.get('gst_number', '')},
        'destination': header.get('transport_address', ''), 'vehicle_number': header.get('vehicle_number', ''),
        'driver_phone': header.get('driver_phone', ''), 'rows': rows}


def serialized(delivery):
    return {'id': delivery.pk, 'reference': delivery.reference, 'snapshot': delivery.snapshot,
            'issued_at': delivery.issued_at.isoformat(), 'issued_by': delivery.issued_by,
            'voided_at': delivery.voided_at.isoformat() if delivery.voided_at else None,
            'voided_by': delivery.voided_by, 'void_reason': delivery.void_reason}


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def delivery_preview(request, pk):
    access(request.user, write=True)
    conference = get_object_or_404(Conference, pk=pk)
    if conference.is_audit or conference.lifecycle_state != 'open':
        raise ValidationError('Audit programs cannot issue delivery papers.')
    raw = request.query_params.get('truck_id')
    try:
        truck_id = int(raw) if raw else None
    except ValueError:
        raise ValidationError('Invalid truck.')
    preview = sources(conference, truck_id)
    delivered = {}
    for saved in conference.issued_deliveries.filter(voided_at__isnull=True):
        for row in saved.snapshot['customer_document']['rows']:
            delivered[row['key']] = delivered.get(row['key'], 0) + row['quantity']
    return Response({'source': preview, 'source_hash': digest(preview), 'previously_delivered': delivered,
                     'suggested_reference': f'Delivery {conference.issued_deliveries.count() + 1}'})


@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
def program_deliveries(request, pk):
    access(request.user, write=request.method == 'POST')
    conference = get_object_or_404(Conference, pk=pk)
    if request.method == 'GET':
        return Response([serialized(row) for row in conference.issued_deliveries.all()])
    data = request.data
    if not isinstance(data, dict) or len(json.dumps(data)) > 1024 * 1024:
        raise ValidationError('Delivery request is too large or invalid.')
    try:
        key = UUID(str(data.get('request_key', '')))
    except ValueError:
        raise ValidationError('A valid delivery request key is required.')
    request_hash = digest(data)
    try:
        with transaction.atomic():
            from .revisions import lock_conference_for_write
            conference = lock_conference_for_write(pk, {})
            existing = ProgramDelivery.objects.filter(request_key=key).first()
            if existing:
                if existing.conference_id != pk or existing.request_hash != request_hash:
                    return Response({'detail': 'This request key was already used for another delivery.'}, status=409)
                return Response(serialized(existing))
            if conference.is_audit or conference.lifecycle_state != 'open':
                raise ValidationError('Audit programs cannot issue delivery papers.')
            truck_id = data.get('truck_id')
            if truck_id is not None:
                integer(truck_id)
            source = sources(conference, truck_id, lock=True)
            if data.get('source_hash') != digest(source):
                return Response({'detail': 'The program, equipment or company details changed. Reload the delivery preview.'}, status=409)
            reference = label(data.get('reference'), 100, required=True)
            if conference.issued_deliveries.filter(reference__iexact=reference).exists():
                return Response({'detail': 'That delivery reference already exists. Open its saved challans or use a new reference.'}, status=409)
            try:
                delivery_date = date.fromisoformat(data.get('delivery_date', ''))
            except (ValueError, TypeError):
                raise ValidationError('Enter the delivery date as YYYY-MM-DD.')
            available = {row['key']: row for row in source['rows']}
            selected, seen = [], set()
            raw_rows = data.get('rows')
            if not isinstance(raw_rows, list) or not 1 <= len(raw_rows) <= 2500:
                raise ValidationError('Select between 1 and 2500 delivery rows.')
            for entry in raw_rows:
                if not isinstance(entry, dict):
                    raise ValidationError('Invalid delivery row.')
                source_key = entry.get('key')
                if not isinstance(source_key, str) or source_key in seen or source_key not in available:
                    raise ValidationError('A delivery row is missing, repeated or outside this program/truck.')
                seen.add(source_key)
                quantity = integer(entry.get('quantity'))
                original = available[source_key]
                if quantity > original['quantity']:
                    raise ValidationError('A selected quantity exceeds the program/truck source quantity.')
                selected.append({**original, 'quantity': quantity, 'name': label(entry.get('name', original['name']), 500, required=True)})
            edits = supplier_edits(data.get('supplier_details', {}), selected)
            delivery = ProgramDelivery.objects.create(conference=conference, request_key=key,
                request_hash=request_hash, reference=reference, issued_by=request.user.get_username())
            fy = f'{str(delivery_date.year if delivery_date.month >= 4 else delivery_date.year - 1)[2:]}-{str(delivery_date.year + 1 if delivery_date.month >= 4 else delivery_date.year)[2:]}'
            common = {key: source[key] for key in ('program', 'destination', 'truck_id')}
            common.update(delivery_date=delivery_date.isoformat(), reference=reference,
                          vehicle_number=label(data.get('vehicle_number', source['vehicle_number']), 50),
                          driver_phone=label(data.get('driver_phone', source['driver_phone']), 50))
            from .dispatch_origins import selected_origins
            customer = {**common, 'dispatch_origins': selected_origins(source.get('dispatch_origins', []), [row['asset_id'] for row in selected]),
                        'number': f'{fy}/OUT-{delivery.pk:06d}', 'direction': 'customer',
                        'issuer': source['issuer'], 'recipient': source['customer'], 'rows': selected}
            suppliers = []
            for owner_id in sorted({row['owner_id'] for row in selected if row['owner_id']}):
                rows = [row for row in selected if row['owner_id'] == owner_id]
                suppliers.append(supplier_paper(common, source, rows, f'{fy}/SR{owner_id}-{delivery.pk:06d}', edits.get(str(owner_id), {})))
            delivery.snapshot = {'version': 1, 'customer_document': customer, 'supplier_documents': suppliers}
            delivery.save(update_fields=['snapshot'])
            return Response(serialized(delivery), status=201)
    except IntegrityError:
        return Response({'detail': 'A delivery with that reference or request key was just saved. Reload the saved deliveries.'}, status=409)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def void_delivery(request, pk, delivery_pk):
    access(request.user, write=True)
    reason = label(request.data.get('reason'), 500, required=True)
    with transaction.atomic():
        delivery = get_object_or_404(ProgramDelivery.objects.select_for_update(), pk=delivery_pk, conference_id=pk)
        if not delivery.voided_at:
            delivery.voided_at, delivery.voided_by, delivery.void_reason = timezone.now(), request.user.get_username(), reason
            delivery.save(update_fields=['voided_at', 'voided_by', 'void_reason'])
        return Response(serialized(delivery))
