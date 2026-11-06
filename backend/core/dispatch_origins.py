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
        if entry.get('direction') != 'incoming':
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
    return list(groups.values())


def selected_origins(origins, asset_ids):
    ids = set(asset_ids)
    return [{**origin, 'asset_ids': [aid for aid in origin.get('asset_ids', []) if aid in ids]}
            for origin in origins if ids.intersection(origin.get('asset_ids', []))]
