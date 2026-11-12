"""Atomic venue-to-venue reusable quantities, with optional physical items in the same receipt."""
import hashlib
import json
from uuid import UUID, uuid5
from django.db import transaction
from django.utils import timezone
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .asset_commands import CommandError, RESTRICTED, canonical_conference, execute_command
from .models import Asset, Conference, MovementReceipt, QuantityAllocation, QuantityMovement
from .permissions import WAREHOUSE_ROLES, get_business_role
from .quantity_commands import allocation_data, is_quantity_stock, outstanding, synchronize_memberships, validate_legacy


def normalize(payload):
    required={'request_id','expected_revision','target_conference_id','expected_target_revision','items','physical_asset_ids'}
    if not isinstance(payload,dict) or set(payload)!=required:
        raise CommandError('invalid_quantity_transfer_payload',400)
    try:request_id=str(UUID(str(payload['request_id'])))
    except (ValueError,TypeError,AttributeError):raise CommandError('invalid_request_id',400)
    for field in ('expected_revision','expected_target_revision','target_conference_id'):
        value=payload[field]
        if type(value) is not int or value<(1 if field=='target_conference_id' else 0):
            raise CommandError('transfer_event_revisions_required',428)
    items,physical=payload['items'],payload['physical_asset_ids']
    if not isinstance(items,list) or not isinstance(physical,list) or not 1<=len(items)+len(physical)<=500:
        raise CommandError('invalid_transfer_batch',400)
    for item in items:
        if not isinstance(item,dict) or set(item)!={'asset_id','quantity'} or type(item['asset_id']) is not int or item['asset_id']<=0 or type(item['quantity']) is not int or not 1<=item['quantity']<=1000000:
            raise CommandError('invalid_transfer_quantity',400)
    if any(type(aid) is not int or aid<=0 for aid in physical):raise CommandError('invalid_physical_assets',400)
    ids=[row['asset_id'] for row in items]+physical
    if len(set(ids))!=len(ids):raise CommandError('duplicate_transfer_assets',400)
    return {**payload,'request_id':request_id,'items':sorted(items,key=lambda row:row['asset_id']),'physical_asset_ids':sorted(physical)}


def valid_balance(row):
    return row.dispatched_total==row.dispatched+row.awaiting_verification+row.verified_total+row.transferred_out_total and row.transferred_in_total<=row.dispatched_total


@transaction.atomic
def execute_transfer(user, source_id, payload):
    command=normalize(payload)
    if get_business_role(user) not in WAREHOUSE_ROLES:raise CommandError('not_authorized',403)
    fingerprint=hashlib.sha256(json.dumps({'operation':'quantity_venue_transfer','source_id':source_id,**command},sort_keys=True,separators=(',',':')).encode()).hexdigest()
    receipt,created=MovementReceipt.objects.get_or_create(actor=user,request_id=command['request_id'],defaults={'payload_hash':fingerprint})
    if not created:
        if receipt.payload_hash!=fingerprint:raise CommandError('request_id_reused',409)
        return {**receipt.result,'replayed':True}
    target_id=command['target_conference_id']
    if source_id==target_id:raise CommandError('same_source_and_target',400)
    ids=sorted([row['asset_id'] for row in command['items']]+command['physical_asset_ids'])
    assets={a.pk:a for a in Asset.objects.select_for_update().filter(pk__in=ids).order_by('pk')}
    if len(assets)!=len(ids):raise CommandError('unknown_assets',400)
    events={e.pk:e for e in Conference.objects.select_for_update().filter(pk__in=[source_id,target_id]).order_by('pk')}
    if len(events)!=2:raise CommandError('unknown_conference',404)
    source,target=events[source_id],events[target_id]
    from .event_lifecycle import require_open_event
    for event,revision in [(source,command['expected_revision']),(target,command['expected_target_revision'])]:
        require_open_event(event)
        if event.is_audit:raise CommandError('audit_is_not_quantity_transfer_custody',400)
        if event.revision!=revision:raise CommandError('transfer_program_changed_reload_both_programs',409)
    if not source.transport_address.strip():raise CommandError('save_source_delivery_address_before_transfer',400)
    from .models import TruckManifest
    for event in (source,target):
        if command['items'] and event.truck_challans.exists() and not TruckManifest.objects.filter(conference=event).exists():
            raise CommandError('quantity_trucks_require_coordinated_workflow',409)
    rows={(row.conference_id,row.asset_id):row for row in QuantityAllocation.objects.select_for_update().filter(conference_id__in=[source_id,target_id],asset_id__in=ids).order_by('conference_id','asset_id')}
    from .dispatch_origins import venue_origin
    from .inventory_ownership import require_warehouse_quantity_source
    context={'dispatch_origin':venue_origin(source),'source_conference_id':source_id,'target_conference_id':target_id,
             'destination_address':target.transport_address or ''}
    moved={}
    for item in command['items']:
        aid,amount=item['asset_id'],item['quantity'];asset=assets[aid]
        if not is_quantity_stock(asset) or asset.type=='Consumables' or asset.stock_kind=='led_case' or asset.is_temporary or asset.parent_asset_id or asset.sub_assets.exists():
            raise CommandError('use_individual_or_consumable_workflow',400)
        require_warehouse_quantity_source(asset);validate_legacy(asset)
        if asset.status in RESTRICTED or asset.flag or asset.condition=='Damaged' or asset.assigned_to_id:
            raise CommandError('unavailable_or_staff_allocated',409)
        outgoing=rows.get((source_id,aid));incoming=rows.get((target_id,aid)) or QuantityAllocation(conference=target,asset=asset)
        if outgoing is None or outgoing.dispatched<amount:raise CommandError('insufficient_on_site_quantity',409,[{'asset_id':aid}])
        if not valid_balance(outgoing) or not valid_balance(incoming) or outstanding(asset)>asset.quantity:
            raise CommandError('quantity_balance_requires_review',409,[{'asset_id':aid}])
        for event,row in ((source,outgoing),(target,incoming)):
            for field,count in (('assets',row.dispatched),('staged_assets',row.reserved),('crosscheck_assets',row.awaiting_verification)):
                if getattr(event,field).filter(pk=aid).exists()!=bool(count):
                    raise CommandError('quantity_membership_requires_review',409,[{'asset_id':aid,'conference_id':event.pk}])
        before_out,before_in=allocation_data(outgoing),allocation_data(incoming)
        outgoing.dispatched-=amount;outgoing.transferred_out_total+=amount
        incoming.dispatched+=amount;incoming.dispatched_total+=amount;incoming.transferred_in_total+=amount
        outgoing.save();incoming.save()
        synchronize_memberships(source,asset,outgoing);synchronize_memberships(target,asset,incoming)
        QuantityMovement.objects.create(allocation=outgoing,receipt=receipt,action='transfer_out',quantity=amount,before=before_out,after=allocation_data(outgoing),context=context)
        QuantityMovement.objects.create(allocation=incoming,receipt=receipt,action='transfer_in',quantity=amount,before=before_in,after=allocation_data(incoming),context=context)
        moved[str(aid)]=amount
    if moved:
        common={'timestamp':timezone.now().isoformat(),'request_id':command['request_id'],'transferred_asset_ids':[int(aid) for aid in moved],
            'asset_quantities':moved,'quantity_total':sum(moved.values()),'asset_names':[f'{assets[int(aid)].alias_name or assets[int(aid)].sku} × {amount}' for aid,amount in moved.items()],
            'transferred_by':user.pk,'from_address':source.transport_address,'to_address':target.transport_address,'dispatch_origin':context['dispatch_origin']}
        source.transfer_log=[*(source.transfer_log or []),{**common,'direction':'outgoing','to_conference_id':target_id,'to_conference_name':target.name}]
        target.transfer_log=[*(target.transfer_log or []),{**common,'direction':'incoming','from_conference_id':source_id,'from_conference_name':source.name}]
        source.save(update_fields=['transfer_log']);target.save(update_fields=['transfer_log'])
    if command['physical_asset_ids']:
        execute_command(user,source_id,{'request_id':str(uuid5(UUID(command['request_id']),'physical-venue-transfer')),'action':'transfer',
            'asset_ids':command['physical_asset_ids'],'target_conference_id':target_id,'source':'quantity-transfer'})
    source.refresh_from_db();target.refresh_from_db()
    from .serializers import AssetSerializer
    result={'request_id':command['request_id'],'action':'transfer','replayed':False,'asset_ids':ids,'asset_quantities':moved,
        'transferred_quantity':sum(moved.values())+len(command['physical_asset_ids']),
        'conference':canonical_conference(source),'target_conference':canonical_conference(target),
        'asset_states':AssetSerializer(Asset.objects.filter(pk__in=ids).order_by('pk'),many=True).data}
    receipt.result=result;receipt.save(update_fields=['result'])
    return result


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def quantity_transfers(request,pk):
    try:return Response(execute_transfer(request.user,pk,request.data))
    except CommandError as error:return Response({'error':error.code,'conflicts':error.details},status=error.status)
