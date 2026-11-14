"""Allocate recorded Packup equipment to return challans, independently of custody."""

from datetime import date
from decimal import Decimal
from uuid import UUID

from django.db import transaction
from django.db.models import Sum
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework.decorators import api_view, permission_classes
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .asset_commands import CommandError
from .challan_documents import allocate_number
from .challan_lock import INDIA, challans_locked
from .inventory_ownership import warehouse_managed
from .models import (
    Asset, ChallanLine, ChallanNumberReservation, CompanySettings, Conference, MovementReceipt,
    QuantityMovement, ReturnDelivery, ReturnDeliveryLine,
)
from .program_deliveries import access, digest, label, party
from .revisions import lock_conference_for_write


def require_issuable(event):
    if event.is_audit or event.lifecycle_state == 'archived' or challans_locked(event):
        raise ValidationError('This program is closed for new return challans.')


def eligible_asset(asset):
    return asset.type != 'Consumables' and warehouse_managed(asset)


def source(event):
    """Select only real transitions into Crosscheck, including completed returns."""
    physical = event.physical_movements.filter(
        action='return', snapshot__before__active=True,
        snapshot__after__active=False, snapshot__after__unchecked=True,
        return_delivery_line__isnull=True,
    )
    quantities = QuantityMovement.objects.filter(
        allocation__conference=event, action='return', quantity__gt=0,
    )
    legacy_claims = ReturnDeliveryLine.objects.filter(
        delivery__conference=event, quantity_movement__isnull=False, quantity__isnull=True,
    ).values('quantity_movement_id')
    quantities = quantities.exclude(pk__in=legacy_claims)
    # Legacy lines claimed the whole movement. New lines claim their explicit quantities.
    allocated = dict(ReturnDeliveryLine.objects.filter(
        delivery__conference=event, quantity_movement__isnull=False, quantity__isnull=False,
    ).values('quantity_movement_id').annotate(total=Sum('quantity')).values_list('quantity_movement_id', 'total'))
    items = []
    for movement in physical.select_related('asset__subrental_company', 'receipt__actor'):
        if eligible_asset(movement.asset):
            items.append(('physical', movement, movement.asset, 1))
    for movement in quantities.select_related('allocation__asset__subrental_company', 'receipt__actor'):
        remaining = movement.quantity - allocated.get(movement.pk, 0)
        if remaining > 0 and eligible_asset(movement.allocation.asset):
            items.append(('quantity', movement, movement.allocation.asset, remaining))

    company = CompanySettings.objects.order_by('pk').first()
    lines = ChallanLine.objects.filter(
        document__conference=event, document__scope='master',
        asset_id__in={asset.pk for _, _, asset, _ in items}, ticket_item__isnull=True,
    ).order_by('position', 'pk')
    outward = {}
    for line in lines:
        outward.setdefault(line.asset_id, []).append(line)

    rows = []
    for kind, movement, asset, quantity in sorted(items, key=lambda item: (item[1].created_at, item[0], item[1].pk)):
        candidates = outward.get(asset.pk, [])
        line = candidates[0] if len(candidates) == 1 else None
        recorded_asset = movement.snapshot.get('asset', {}) if kind == 'physical' else {}
        if line:
            unit_value = line.unit_value
        elif asset.stock_kind == 'led_panel' or asset.purchased_date:
            unit_value = Decimal(asset.current_value)
        else:
            unit_value = asset.item_price or Decimal('0.00')
        rows.append({
            'key': f'{kind}:{movement.pk}', 'asset_id': asset.pk, 'quantity': quantity,
            'name': recorded_asset.get('label') or asset.alias_name or asset.sku,
            'sku': recorded_asset.get('sku') or asset.sku, 'type': asset.type,
            'owner_id': asset.subrental_company_id, 'owner': party(asset.subrental_company),
            'unit_value': f'{unit_value:.2f}', 'value_source': 'outward_challan' if line else 'inventory',
            'packed_at': movement.created_at.isoformat(), 'packed_by': movement.receipt.actor.get_username(),
        })
    return {
        'rows': rows,
        'program': {'name': event.name, 'start_date': event.start_date.isoformat() if event.start_date else '',
                    'end_date': event.end_date.isoformat() if event.end_date else ''},
        'issuer': party(company),
        'origin': event.transport_address or '',
        'destination': company.address if company else '',
        'reference': f'Return {event.return_deliveries.count() + 1}',
        'return_date': timezone.localdate(timezone=INDIA).isoformat(),
    }


def serialize(delivery):
    return {
        'id': delivery.pk, 'number': delivery.number, 'snapshot': delivery.snapshot,
        'issued_at': delivery.issued_at.isoformat(),
    }


def parse_keys(raw):
    if not isinstance(raw, list) or not 1 <= len(raw) <= 2500:
        raise ValidationError('Select between 1 and 2500 recorded Packup rows.')
    keys = set()
    for key in raw:
        if not isinstance(key, str):
            raise ValidationError('Invalid Packup row.')
        kind, _, number = key.partition(':')
        if kind not in {'physical', 'quantity'} or not number.isascii() or not number.isdigit() or len(number) > 18:
            raise ValidationError('Invalid Packup row.')
        pk = int(number)
        if pk <= 0 or str(pk) != number or (kind, pk) in keys:
            raise ValidationError('Invalid or repeated Packup row.')
        keys.add((kind, pk))
    return keys


def review_hash(review):
    # Reference and default date are suggestions. The operator confirms both separately.
    return digest({key: value for key, value in review.items() if key not in {'reference', 'return_date'}})


def parse_loads(data, split):
    if not split:
        return [{**data, 'rows': {key: None for key in data['rows']}}]
    raw_loads = data['loads']
    if not isinstance(raw_loads, list) or not 1 <= len(raw_loads) <= 20:
        raise ValidationError('Choose between 1 and 20 return trucks.')
    loads, line_count = [], 0
    for raw in raw_loads:
        if not isinstance(raw, dict) or set(raw) != {'reference', 'vehicle_number', 'driver_phone', 'rows'}:
            raise ValidationError('Review the details for each return truck.')
        raw_rows = raw['rows']
        if not isinstance(raw_rows, list) or any(
            not isinstance(row, dict) or set(row) != {'key', 'quantity'}
            or type(row['quantity']) is not int or row['quantity'] <= 0 for row in raw_rows
        ):
            raise ValidationError('Enter a positive whole quantity for each truck item.')
        parse_keys([row['key'] for row in raw_rows])
        line_count += len(raw_rows)
        if line_count > 2500:
            raise ValidationError('Select up to 2500 equipment rows per issue.')
        loads.append({**raw, 'rows': {row['key']: row['quantity'] for row in raw_rows}})
    return loads


@transaction.atomic
def issue_return(user, event_id, data):
    common_fields = {'request_key', 'source_hash', 'return_date', 'origin', 'destination'}
    split = isinstance(data, dict) and 'loads' in data
    load_fields = {'loads'} if split else {'rows', 'reference', 'vehicle_number', 'driver_phone'}
    if not isinstance(data, dict) or set(data) != common_fields | load_fields:
        raise ValidationError('Invalid return challan request.')
    if not split:
        parse_keys(data['rows'])
    loads = parse_loads(data, split)
    try:
        request_key = UUID(str(data['request_key']))
        return_date = date.fromisoformat(data['return_date'])
    except (ValueError, TypeError):
        raise ValidationError('Enter a valid request key and return date.')
    fingerprint = digest({'operation': 'issue_return_delivery', 'conference_id': event_id, **data})
    receipt, created = MovementReceipt.objects.get_or_create(
        actor=user, request_id=request_key, defaults={'payload_hash': fingerprint},
    )
    if not created:
        if receipt.payload_hash != fingerprint:
            raise CommandError('request_id_reused')
        return issue_response(list(receipt.return_deliveries.order_by('pk')), split), 200

    event = lock_conference_for_write(event_id, {})
    require_issuable(event)
    preview = source(event)
    if data['source_hash'] != review_hash(preview):
        raise CommandError('return_preview_changed')
    if not preview['issuer']['name']:
        raise ValidationError('Set up the issuing company before saving a return challan.')
    available = {row['key']: row for row in preview['rows']}
    remaining = {key: row['quantity'] for key, row in available.items()}
    common = {
        'version': 1, 'issuer': preview['issuer'], 'program': preview['program'],
        'origin': label(data['origin'], 4000, required=True),
        'destination': label(data['destination'], 4000, required=True),
        'return_date': return_date.isoformat(),
        'issued_by': user.get_username(),
    }
    snapshots = []
    for load in loads:
        rows = []
        for key, quantity in load['rows'].items():
            if key not in available:
                raise CommandError('return_rows_unavailable')
            amount = remaining[key] if quantity is None else quantity
            if amount <= 0 or amount > remaining[key]:
                raise CommandError('return_quantity_exceeded')
            remaining[key] -= amount
            rows.append({**available[key], 'quantity': amount})
        snapshots.append({
            **common, 'rows': rows,
            'reference': label(load['reference'], 100, required=True),
            'vehicle_number': label(load['vehicle_number'], 50, required=len(loads) > 1),
            'driver_phone': label(load['driver_phone'], 50),
            'total': f'{sum(Decimal(row["unit_value"]) * row["quantity"] for row in rows):.2f}',
        })

    deliveries = []
    for snapshot in snapshots:
        number = allocate_number()
        ChallanNumberReservation.objects.create(number=number, conference=event)
        delivery = ReturnDelivery.objects.create(
            conference=event, number=number, snapshot=snapshot, receipt=receipt,
        )
        claims = []
        for row in snapshot['rows']:
            kind, pk = row['key'].split(':')
            claims.append(ReturnDeliveryLine(
                delivery=delivery, quantity=row['quantity'], **{f'{kind}_movement_id': int(pk)},
            ))
        ReturnDeliveryLine.objects.bulk_create(claims)
        deliveries.append(delivery)
    receipt.result = {'return_delivery_ids': [delivery.pk for delivery in deliveries]} if split else {
        'return_delivery_id': deliveries[0].pk, 'number': deliveries[0].number,
    }
    receipt.save(update_fields=['result'])
    return issue_response(deliveries, split), 201


def issue_response(deliveries, split):
    if split:
        return {'deliveries': [serialize(delivery) for delivery in deliveries]}
    return serialize(deliveries[0])


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def return_preview(request, pk):
    access(request.user, write=True)
    event = get_object_or_404(Conference, pk=pk)
    require_issuable(event)
    preview = source(event)
    source_hash = review_hash(preview)
    identities = Asset.objects.in_bulk({row['asset_id'] for row in preview['rows']})
    for row in preview['rows']:
        asset = identities.get(row['asset_id'])
        if asset:
            row.update(barcode=asset.barcode, qr_code=asset.qr_code, serial_number=asset.serial_number)
    return Response({'source': preview, 'source_hash': source_hash})


@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
def return_deliveries(request, pk):
    access(request.user, write=request.method == 'POST')
    event = get_object_or_404(Conference, pk=pk)
    if request.method == 'GET':
        return Response([serialize(delivery) for delivery in event.return_deliveries.all()])
    try:
        result, status = issue_return(request.user, event.pk, request.data)
    except CommandError as error:
        messages = {
            'request_id_reused': 'This request was already used.',
            'return_preview_changed': 'Packup records or costs changed. Review the latest returns.',
            'return_rows_unavailable': 'A selected Packup row is unavailable for this challan.',
            'return_quantity_exceeded': 'The truck assignments exceed the recorded Packup quantity.',
        }
        return Response({'detail': messages[error.code]}, status=error.status)
    return Response(result, status=status)
