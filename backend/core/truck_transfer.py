"""Idempotent movement of existing truck allocations; never create stock."""
import hashlib
import json
import uuid
from django.db import transaction
from .asset_commands import CommandError, canonical_conference
from .models import Asset, Conference, MovementReceipt, TruckChallan
from .permissions import WAREHOUSE_ROLES, get_business_role


@transaction.atomic
def transfer_truck_allocation(user, truck_id, payload):
    if set(payload) - {'request_id', 'to_truck_id', 'transfers', 'asset_ids'}:
        raise CommandError('invalid_payload', 400)
    try:
        request_id = uuid.UUID(str(payload.get('request_id')))
    except (ValueError, TypeError, AttributeError):
        raise CommandError('invalid_request_id', 400)
    fingerprint = hashlib.sha256(json.dumps({'truck_id': truck_id, **payload}, sort_keys=True).encode()).hexdigest()
    existing = MovementReceipt.objects.filter(actor=user, request_id=request_id).first()
    if existing:
        if existing.payload_hash != fingerprint: raise CommandError('request_id_reused')
        return {**existing.result, 'replayed': True}
    if get_business_role(user) not in WAREHOUSE_ROLES: raise CommandError('not_authorized', 403)
    destination_id = payload.get('to_truck_id')
    if type(destination_id) is not int or destination_id == truck_id: raise CommandError('invalid_destination', 400)
    transfers = payload.get('transfers')
    if transfers is None:
        ids = payload.get('asset_ids', [])
        if not isinstance(ids, list): raise CommandError('invalid_assets', 400)
        transfers = [{'asset_id': value, 'quantity': None} for value in ids]
    if not isinstance(transfers, list) or not 1 <= len(transfers) <= 500: raise CommandError('invalid_batch', 400)
    if any(not isinstance(item, dict) or set(item) != {'asset_id', 'quantity'} or type(item['asset_id']) is not int or item['asset_id'] <= 0
           or (item['quantity'] is not None and (type(item['quantity']) is not int or item['quantity'] <= 0)) for item in transfers):
        raise CommandError('invalid_quantity', 400)
    ids = [item['asset_id'] for item in transfers]
    if len(set(ids)) != len(ids): raise CommandError('duplicate_assets', 400)
    receipt, created = MovementReceipt.objects.get_or_create(actor=user, request_id=request_id, defaults={'payload_hash': fingerprint})
    if not created:
        if receipt.payload_hash != fingerprint: raise CommandError('request_id_reused')
        return {**receipt.result, 'replayed': True}
    assets = {a.pk: a for a in Asset.objects.select_for_update().filter(pk__in=ids).order_by('pk')}
    if len(assets) != len(ids): raise CommandError('unknown_assets', 400)
    if any(asset.stock_kind == 'led_case' for asset in assets.values()): raise CommandError('select_led_case_panels_not_historical_box', 400)
    source_info = TruckChallan.objects.filter(pk=truck_id).values('conference_id').first()
    if not source_info: raise CommandError('unknown_source', 404)
    event = Conference.objects.select_for_update().get(pk=source_info['conference_id'])
    from .challan_lock import require_challan_edit
    require_challan_edit(event, require_open=True)
    from .models import TruckManifest
    if TruckManifest.objects.filter(conference=event).exists(): raise CommandError('use_manifest_commands')
    if event.consumable_allocations.exists() or event.consumable_data or any(asset.type == 'Consumables' for asset in assets.values()):
        raise CommandError('consumable_trucks_require_coordinated_workflow')
    trucks = {t.pk: t for t in TruckChallan.objects.select_for_update().filter(conference=event).order_by('pk')}
    if truck_id not in trucks or destination_id not in trucks: raise CommandError('destination_not_in_event', 400)
    source, destination = trucks[truck_id], trucks[destination_id]
    # Transfers need a coordinated revision of both saved documents. Until that
    # operation is implemented, never silently detach a printed snapshot from its allocation.
    if event.challan_documents.filter(truck_id__in=[truck_id, destination_id]).exists():
        raise CommandError('saved_truck_documents_require_coordinated_transfer')
    source_ids = set(source.assets.values_list('pk', flat=True))
    source_qty, destination_qty = dict(source.asset_quantities or {}), dict(destination.asset_quantities or {})
    membership = {t.pk: set(t.assets.values_list('pk', flat=True)) for t in trucks.values()}
    for item in transfers:
        aid = item['asset_id']; key = str(aid); asset = assets[aid]
        if aid not in source_ids: raise CommandError('asset_not_in_source_truck', details=[{'asset_id': aid}])
        values = []
        for truck in trucks.values():
            value = (truck.asset_quantities or {}).get(key, asset.quantity if aid in membership[truck.pk] else 0)
            if type(value) is not int or value < 0: raise CommandError('invalid_existing_allocation')
            if value and aid not in membership[truck.pk]: raise CommandError('allocation_membership_mismatch')
            values.append(value)
        if sum(values) > asset.quantity: raise CommandError('existing_allocations_exceed_stock')
        available = source_qty.get(key, asset.quantity)
        amount = available if item['quantity'] is None else item['quantity']
        if not amount or amount > available: raise CommandError('insufficient_source_quantity', details=[{'asset_id': aid}])
        current_dest = destination_qty.get(key, asset.quantity if aid in membership[destination.pk] else 0)
        source_qty[key] = available - amount; destination_qty[key] = current_dest + amount
    for item in transfers:
        aid = item['asset_id']
        if source_qty[str(aid)] == 0: source.assets.remove(aid)
        destination.assets.add(aid)
    source.asset_quantities = source_qty; destination.asset_quantities = destination_qty
    source.save(update_fields=['asset_quantities']); destination.save(update_fields=['asset_quantities'])
    from .truck_views import _serialize_truck
    result = {'status': 'transferred', 'request_id': str(request_id), 'source': _serialize_truck(source),
              'dest': _serialize_truck(destination), 'conference': canonical_conference(event), 'replayed': False}
    receipt.result = result; receipt.save(update_fields=['result'])
    return result
