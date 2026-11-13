"""Unit registration rules and atomic SKU allocation."""
import re
import uuid

from django.db import connection
from rest_framework.exceptions import ValidationError

from .models import Asset, MovementReceipt


def lock_inventory_identifiers():
    # Imports and registration share a lock before taking asset or owner locks.
    if connection.vendor == 'postgresql':
        with connection.cursor() as cursor:
            cursor.execute('SELECT pg_advisory_xact_lock(%s)', [730218746])


def unit_quantity_required(category, owner):
    # A classified external catalogue declares rental capacity, independent of
    # the individually identified equipment held in our warehouse.
    return category != 'Consumables' and (owner is None or owner.inventory_mode != 'external_supplier')


def identity_token(value):
    return ''.join(str(value or '').split()).upper()


IDENTITY_FIELDS = ('sku', 'serial_number', 'barcode', 'qr_code')


def identity_tokens(values):
    tokens = set()
    for field in IDENTITY_FIELDS:
        token = identity_token(values.get(field))
        if token and (field != 'serial_number' or token != 'NIL'):
            tokens.add(token)
    return tokens


def occupied_identifiers(exclude_id=None):
    occupied = set()
    for row in Asset.objects.exclude(pk=exclude_id).values(*IDENTITY_FIELDS).iterator():
        occupied.update(identity_tokens(row))
    return occupied


def batch_payload(data, preview=False):
    allowed = {'sku', 'count'} if preview else {'asset', 'count', 'request_id'}
    if not isinstance(data, dict) or set(data) != allowed or type(data['count']) is not int or not 2 <= data['count'] <= 500:
        raise ValidationError({'count': 'Enter between 2 and 500 equipment items per batch.'})
    if preview:
        asset = data
    else:
        if not isinstance(data['asset'], dict):
            raise ValidationError({'asset': 'Enter the shared equipment details.'})
        asset = data['asset']
    sku = asset.get('sku')
    if not isinstance(sku, str) or not sku.strip() or len(sku.strip()) > 100:
        raise ValidationError({'sku': 'Enter a SKU or SKU prefix up to 100 characters.'})
    return sku.strip()


def allocate_batch_skus(sku, count, occupied):
    match = re.fullmatch(r'(.*?)([-_])([0-9]+)', sku)
    prefix, separator, number = match.groups() if match else (sku, '-', '1')
    next_number = int(number)
    if match is None:
        family = re.compile(re.escape(identity_token(prefix + separator)) + r'([0-9]+)$')
        for token in occupied:
            existing = family.fullmatch(token)
            if existing:
                next_number = max(next_number, int(existing[1]) + 1)
    skus = []
    while len(skus) < count:
        candidate = f'{prefix}{separator}{str(next_number).zfill(len(number))}'
        if len(candidate) > 100:
            raise ValidationError({'sku': 'Use a shorter SKU prefix for this batch.'})
        token = identity_token(candidate)
        if token not in occupied:
            skus.append(candidate)
            occupied.add(token)
        next_number += 1
    return skus


def register_batch(user, data):
    from .reconciliation_commands import digest
    from .serializers import AssetSerializer

    sku = batch_payload(data)
    try:
        request_id = uuid.UUID(str(data['request_id']))
    except (ValueError, TypeError, AttributeError):
        raise ValidationError({'request_id': 'This registration needs a valid request ID.'})
    base = data['asset']
    if base.get('is_temporary') or base.get('type') == 'Consumables':
        raise ValidationError({'type': 'Use batch registration for reusable equipment.'})
    fingerprint = digest({'operation': 'register_equipment_batch', 'asset': base, 'count': data['count']})
    receipt, created = MovementReceipt.objects.get_or_create(
        actor=user, request_id=request_id, defaults={'payload_hash': fingerprint},
    )
    if not created:
        if receipt.payload_hash != fingerprint:
            raise ValidationError({'request_id': 'This request ID already belongs to a different registration.'})
        return receipt.result['assets']

    occupied = occupied_identifiers()
    serials = identity_tokens({'serial_number': base.get('serial_number')})
    if occupied & serials:
        raise ValidationError({'serial_number': 'This serial number already identifies another asset.'})
    skus = allocate_batch_skus(sku, data['count'], occupied | serials)
    rows = [
        {
            **base,
            'sku': generated_sku,
            'qr_code': generated_sku,
            'barcode': generated_sku,
            'is_barcode_added': False,
            'quantity': 1,
            'serial_number': (base.get('serial_number') or '') if index == 0 else '',
            'mac_address': (base.get('mac_address') or '') if index == 0 else '',
            'imei_number_1': (base.get('imei_number_1') or '') if index == 0 else '',
            'imei_number_2': (base.get('imei_number_2') or '') if index == 0 else '',
        }
        for index, generated_sku in enumerate(skus)
    ]
    serializer = AssetSerializer(data=rows, many=True)
    serializer.is_valid(raise_exception=True)
    serializer.save()
    assets = list(serializer.data)
    receipt.result = {'operation': 'register_equipment_batch', 'assets': assets}
    receipt.save(update_fields=['result'])
    return assets
