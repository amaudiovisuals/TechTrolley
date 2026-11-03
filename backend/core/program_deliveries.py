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


def role(user):
    return getattr(getattr(user, 'profile', None), 'role', '')


def access(user, write=False):
    allowed = {'admin', 'boss', 'godown_incharge'} | (set() if write else {'accounts'})
    if role(user) not in allowed and not (user.is_staff and role(user) not in {'accounts', 'technician'}):
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


def sources(conference, truck_id=None, lock=False):
    settings = CompanySettings.objects.select_for_update().first() if lock else CompanySettings.objects.first()
    if settings is None:
        raise ValidationError('Save the issuing company details before issuing a delivery.')
    ids = set(conference.challan_assets.values_list('pk', flat=True))
    if not ids:
        ids = set(conference.assets.values_list('pk', flat=True)) | set(conference.staged_assets.values_list('pk', flat=True))
    quantities = {}
    vehicle, phone = conference.vehicle_number, conference.driver_phone
    if truck_id is not None:
        truck = get_object_or_404(TruckChallan, pk=truck_id, conference=conference)
        ids = set(truck.assets.values_list('pk', flat=True))
        quantities = truck.asset_quantities or {}
        vehicle, phone = truck.vehicle_number, truck.driver_phone
    elif conference.truck_challans.exists():
        vehicle, phone = '', ''
    # Legacy consumables are separate from the event M2M; include recorded requests.
    consumables = conference.consumable_data or {}
    if not isinstance(consumables, dict):
        raise ValidationError('Review the program consumable data first.')
    if truck_id is None:
        for aid, data in consumables.items():
            if not isinstance(data, dict):
                raise ValidationError('Review the program consumable quantities first.')
            if data.get('requested'):
                try:
                    ids.add(int(aid))
                    quantities[str(aid)] = integer(data['requested'])
                except (ValueError, TypeError):
                    raise ValidationError('Review the program consumable quantities first.')
    assets = Asset.objects.filter(pk__in=ids).order_by('pk')
    if lock:
        assets = assets.select_for_update()
    # Lock only the assets, not a nullable joined owner (PostgreSQL outer-join rule).
    assets = list(assets)
    if len(assets) != len(ids):
        raise ValidationError('Some source equipment no longer exists. Reload the program.')
    rows = []
    for asset in assets:
        quantity = integer(quantities.get(str(asset.pk), asset.quantity))
        if quantity > asset.quantity:
            raise ValidationError('A truck/program quantity exceeds its current stock record. Review it first.')
        if asset.subrental_company_id and (asset.quantity > 1 or asset.type == 'Consumables') and not asset.is_temporary:
            raise ValidationError('Supplier bulk/consumable custody needs review before issuing these papers.')
        owner = asset.subrental_company
        rows.append({'key': f'asset:{asset.pk}', 'asset_id': asset.pk, 'quantity': quantity,
                     'name': asset.alias_name or asset.name or asset.sku or f'Asset {asset.pk}',
                     'sku': asset.sku or '', 'serial': asset.serial_number or '',
                     'owner_id': asset.subrental_company_id, 'owner': party(owner) if owner else None})
    tickets = SubrentalTicketItem.objects.filter(ticket__conference=conference).order_by('pk')
    if lock:
        tickets = tickets.select_for_update()
    seen = set(ids)
    # Tickets have no truck allocation in the legacy system. Keep them on the
    # program scope, where the operator can select the actual delivered subset.
    if truck_id is None:
        for item in tickets:
            asset, owner = item.asset, item.ticket.company
            if asset.pk in seen:
                raise ValidationError('The same equipment appears in multiple inventory/ticket sources. Review the duplicate before issuing.')
            if asset.subrental_company_id != owner.pk:
                raise ValidationError('A ticket company does not match the equipment owner. Review it first.')
            seen.add(asset.pk)
            rows.append({'key': f'ticket:{item.pk}', 'asset_id': asset.pk, 'quantity': integer(item.quantity),
                         'name': asset.alias_name or asset.name or asset.sku or f'Asset {asset.pk}',
                         'sku': asset.sku or '', 'serial': asset.serial_number or '',
                         'owner_id': owner.pk, 'owner': party(owner)})
    return {'version': 1, 'conference_id': conference.pk, 'truck_id': truck_id,
            'program': {'name': conference.name, 'start_date': str(conference.start_date or ''), 'end_date': str(conference.end_date or '')},
            'issuer': party(settings),
            'customer': {'name': conference.association_name or conference.name, 'address': conference.billing_address,
                         'gst_number': conference.gst_number},
            'destination': conference.transport_address, 'vehicle_number': vehicle or '', 'driver_phone': phone or '', 'rows': rows}


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
    if conference.is_audit:
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
            conference = Conference.objects.select_for_update().get(pk=pk)
            existing = ProgramDelivery.objects.filter(request_key=key).first()
            if existing:
                if existing.conference_id != pk or existing.request_hash != request_hash:
                    return Response({'detail': 'This request key was already used for another delivery.'}, status=409)
                return Response(serialized(existing))
            if conference.is_audit:
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
            delivery = ProgramDelivery.objects.create(conference=conference, request_key=key,
                request_hash=request_hash, reference=reference, issued_by=request.user.get_username())
            fy = f'{str(delivery_date.year if delivery_date.month >= 4 else delivery_date.year - 1)[2:]}-{str(delivery_date.year + 1 if delivery_date.month >= 4 else delivery_date.year)[2:]}'
            common = {key: source[key] for key in ('program', 'destination', 'truck_id')}
            common.update(delivery_date=delivery_date.isoformat(), reference=reference,
                          vehicle_number=label(data.get('vehicle_number', source['vehicle_number']), 50),
                          driver_phone=label(data.get('driver_phone', source['driver_phone']), 50))
            customer = {**common, 'number': f'{fy}/OUT-{delivery.pk:06d}', 'direction': 'customer',
                        'issuer': source['issuer'], 'recipient': source['customer'], 'rows': selected}
            suppliers = []
            for owner_id in sorted({row['owner_id'] for row in selected if row['owner_id']}):
                rows = [row for row in selected if row['owner_id'] == owner_id]
                suppliers.append({**common, 'number': f'{fy}/SR{owner_id}-{delivery.pk:06d}', 'direction': 'supplier',
                                  'issuer': rows[0]['owner'], 'recipient': source['issuer'], 'rows': rows})
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
