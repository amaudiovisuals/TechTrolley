"""Issue one return challan from selected Packup movements, independently of custody."""

from datetime import date
from decimal import Decimal
from uuid import UUID

from django.db import transaction
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
    ChallanLine, ChallanNumberReservation, CompanySettings, Conference, MovementReceipt,
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
        allocation__conference=event, action='return', quantity__gt=0, return_delivery_line__isnull=True,
    )
    items = []
    for movement in physical.select_related('asset__subrental_company', 'receipt__actor'):
        if eligible_asset(movement.asset):
            items.append(('physical', movement, movement.asset, 1))
    for movement in quantities.select_related('allocation__asset__subrental_company', 'receipt__actor'):
        if eligible_asset(movement.allocation.asset):
            items.append(('quantity', movement, movement.allocation.asset, movement.quantity))

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


@transaction.atomic
def issue_return(user, event_id, data):
    if not isinstance(data, dict) or set(data) != {
        'request_key', 'source_hash', 'rows', 'reference', 'return_date',
        'origin', 'destination', 'vehicle_number', 'driver_phone',
    }:
        raise ValidationError('Invalid return challan request.')
    keys = parse_keys(data['rows'])
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
        return serialize(receipt.return_delivery), 200

    event = lock_conference_for_write(event_id, {})
    require_issuable(event)
    preview = source(event)
    if data['source_hash'] != review_hash(preview):
        raise CommandError('return_preview_changed')
    selected = set(data['rows'])
    rows = [row for row in preview['rows'] if row['key'] in selected]
    if len(rows) != len(keys):
        raise CommandError('return_rows_unavailable')
    if not preview['issuer']['name']:
        raise ValidationError('Set up the issuing company before saving a return challan.')
    snapshot = {
        'version': 1, 'rows': rows, 'issuer': preview['issuer'], 'program': preview['program'],
        'reference': label(data['reference'], 100, required=True),
        'origin': label(data['origin'], 4000, required=True),
        'destination': label(data['destination'], 4000, required=True),
        'return_date': return_date.isoformat(),
        'vehicle_number': label(data['vehicle_number'], 50), 'driver_phone': label(data['driver_phone'], 50),
        'total': f'{sum(Decimal(row["unit_value"]) * row["quantity"] for row in rows):.2f}',
        'issued_by': user.get_username(),
    }
    number = allocate_number()
    ChallanNumberReservation.objects.create(number=number, conference=event)
    delivery = ReturnDelivery.objects.create(
        conference=event, number=number, snapshot=snapshot, receipt=receipt,
    )
    ReturnDeliveryLine.objects.bulk_create([
        ReturnDeliveryLine(delivery=delivery, **{f'{kind}_movement_id': pk}) for kind, pk in keys
    ])
    receipt.result = {'return_delivery_id': delivery.pk, 'number': delivery.number}
    receipt.save(update_fields=['result'])
    return serialize(delivery), 201


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def return_preview(request, pk):
    access(request.user, write=True)
    event = get_object_or_404(Conference, pk=pk)
    require_issuable(event)
    preview = source(event)
    return Response({'source': preview, 'source_hash': review_hash(preview)})


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
        }
        return Response({'detail': messages[error.code]}, status=error.status)
    return Response(result, status=status)
