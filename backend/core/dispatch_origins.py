"""Recorded physical dispatch locations; never replace an issued paper's header."""
from .models import CompanySettings, PhysicalMovement


def warehouse_origin():
    company = CompanySettings.objects.order_by('pk').first()
    return {'kind': 'warehouse', 'name': company.name if company else 'Godown',
            'address': company.address if company else '', 'conference_id': None}


def venue_origin(event):
    return {'kind': 'venue', 'name': event.name, 'address': event.transport_address or '',
            'conference_id': event.pk}


def event_origins(event):
    """Latest accepted arrival for each physical item, including repeated transfers."""
    latest = {}
    for row in PhysicalMovement.objects.filter(conference=event, action__in=['dispatch', 'transfer_in']).order_by('created_at', 'pk'):
        latest[row.asset_id] = row.snapshot.get('dispatch_origin')
    # Older transfer logs have operator-entered addresses, not verified origins.
    # Keep those records intact; do not infer a new address from a mutable event.
    for entry in event.transfer_log or []:
        if entry.get('direction') != 'incoming' or entry.get('asset_quantities'):
            continue
        for asset_id in entry.get('transferred_asset_ids', []):
            if asset_id not in latest:
                latest[asset_id] = entry.get('dispatch_origin')
    groups = {}
    for asset_id, origin in latest.items():
        if not isinstance(origin, dict):
            continue
        key = (origin.get('kind'), origin.get('conference_id'), origin.get('name'), origin.get('address'))
        group = groups.setdefault(key, {**origin, 'asset_ids': []})
        group['asset_ids'].append(asset_id)
    result = list(groups.values())
    # Keep bulk arrivals in movement order, even if a venue appears more than
    # once. Delivery snapshots allocate fungible units in this recorded order.
    for allocation in event.quantity_allocations.order_by('asset_id'):
        arrivals=list(allocation.movements.filter(action__in=['dispatch','transfer_in']).order_by('created_at','pk'))
        missing=max(0,allocation.dispatched_total-sum(row.quantity for row in arrivals))
        batches=([(None,missing,{})] if missing else [])+[(row.pk,row.quantity,row.context) for row in arrivals]
        for movement_id,amount,context in batches:
            origin=context.get('dispatch_origin') or {'kind':'unknown','name':'Earlier dispatch — address not recorded','address':'','conference_id':None}
            result.append({**origin,'asset_ids':[allocation.asset_id], 'asset_quantities':{str(allocation.asset_id):amount},'quantity_movement_id':movement_id})
    return result


def selected_origins(origins, asset_ids, quantities=None, previously_delivered=None):
    ids = set(asset_ids)
    if quantities is None:
        return [{**origin,'asset_ids':[aid for aid in origin.get('asset_ids',[]) if aid in ids],
                 **({'asset_quantities':{str(aid):amount for aid,amount in origin['asset_quantities'].items() if int(aid) in ids}} if 'asset_quantities' in origin else {})}
                for origin in origins if ids.intersection(origin.get('asset_ids',[]))]
    remaining={str(key):amount for key,amount in quantities.items()}
    skip={str(key):amount for key,amount in (previously_delivered or {}).items()}
    result=[]
    for origin in origins:
        if not ids.intersection(origin.get('asset_ids',[])):continue
        if 'asset_quantities' not in origin:
            result.extend(selected_origins([origin],ids));continue
        chosen={}
        for aid,amount in origin['asset_quantities'].items():
            aid=str(aid)
            ignored=min(skip.get(aid,0),amount);skip[aid]=skip.get(aid,0)-ignored
            count=min(remaining.get(aid,0),amount-ignored)
            if count>0:chosen[aid]=count;remaining[aid]-=count
        if chosen:result.append({**origin,'asset_ids':[int(key) for key in chosen],'asset_quantities':chosen})
    return result
