"""Read-only legacy migration preview. No import/backfill execution is provided."""
import uuid
from .challan_documents import capture_header
from .models import Conference


def preview_legacy_documents(conference_id=None):
    events = Conference.objects.order_by('pk')
    if conference_id is not None:
        events = events.filter(pk=conference_id)
    documents, warnings = [], []
    numbers = {}
    for event in events:
        consumables = {row.asset_id: row for row in event.consumable_allocations.all()}
        tickets = list(event.subrental_tickets.select_related('company').prefetch_related('items__asset'))
        ticket_asset_ids = {item.asset_id for ticket in tickets for item in ticket.items.all()}
        scopes = [('master', None)] + [(f'truck-{truck.pk}', truck) for truck in event.truck_challans.order_by('pk')]
        for scope, truck in scopes:
            if event.challan_documents.filter(scope=scope).exists():
                continue
            assets = truck.assets.all() if truck else event.challan_assets.all()
            if not truck and not assets.exists():
                ids = set(event.assets.values_list('pk', flat=True)) | set(event.staged_assets.values_list('pk', flat=True)) | set(event.crosscheck_assets.values_list('pk', flat=True))
                from .models import Asset
                assets = Asset.objects.filter(pk__in=ids)
                if ids:
                    warnings.append({'conference_id': event.pk, 'scope': scope, 'code': 'no_frozen_legacy_membership_used_current_relations'})
            if not truck:
                from .models import Asset
                assets = Asset.objects.filter(pk__in=set(assets.values_list('pk', flat=True)) |
                                             {aid for aid, row in consumables.items() if row.requested > 0})
            rows = []
            for asset in assets.order_by('pk').select_related('subrental_company'):
                if not truck and asset.pk in ticket_asset_ids:
                    continue
                if asset.is_temporary and not asset.subrental_company_id:
                    warnings.append({'conference_id': event.pk, 'scope': scope, 'asset_id': asset.pk, 'code': 'legacy_temporary_item_requires_manual_source_review'})
                quantity = (truck.asset_quantities or {}).get(str(asset.pk), asset.quantity) if truck else asset.quantity
                if asset.type == 'Consumables':
                    if truck:
                        warnings.append({'conference_id': event.pk, 'scope': scope, 'asset_id': asset.pk,
                                         'code': 'consumable_truck_allocation_requires_review'})
                    elif asset.pk not in consumables:
                        warnings.append({'conference_id': event.pk, 'scope': scope, 'asset_id': asset.pk,
                                         'code': 'consumable_legacy_ledger_requires_settlement_review'})
                        continue
                    else:
                        quantity = consumables[asset.pk].requested
                if not truck:
                    from .quantity_commands import is_quantity_stock, quantity_capacity
                    if is_quantity_stock(asset) and asset.type != 'Consumables':
                        if asset.quantity_allocations.filter(conference=event).exists():
                            quantity = quantity_capacity(asset, event)
                        else:
                            warnings.append({'conference_id': event.pk, 'scope': scope, 'asset_id': asset.pk,
                                             'code': 'bulk_quantity_inferred_from_stock_requires_reconciliation'})
                if type(quantity) is not int or quantity <= 0:
                    warnings.append({'conference_id': event.pk, 'scope': scope, 'asset_id': asset.pk, 'code': 'invalid_or_zero_legacy_quantity'})
                    continue
                if truck and str(asset.pk) not in (truck.asset_quantities or {}) and asset.quantity > 1:
                    warnings.append({'conference_id': event.pk, 'scope': scope, 'asset_id': asset.pk, 'code': 'truck_quantity_inferred_from_current_stock_requires_review'})
                rows.append({'id': str(uuid.uuid5(uuid.NAMESPACE_URL, f'techtrolley:legacy:{event.pk}:{scope}:asset:{asset.pk}')),
                    'asset_id': asset.pk, 'ticket_item_id': None, 'supplier_id': asset.subrental_company_id,
                    'source_kind': 'supplier' if asset.subrental_company_id else 'owned',
                    'quantity': quantity, 'unit_value': str(asset.item_price or 0),
                    'snapshot': {'sku': asset.sku or '', 'alias_name': asset.alias_name or asset.description or asset.sku or f'Item {asset.pk}',
                                 'serial_number': asset.serial_number or '', 'type': asset.type, 'description': asset.description or '',
                                 'supplier_name': asset.subrental_company.name if asset.subrental_company else ''}})
            if not truck:
                for ticket in tickets:
                    for item in ticket.items.all():
                        rows.append({'id': str(uuid.uuid5(uuid.NAMESPACE_URL, f'techtrolley:legacy:{event.pk}:master:ticket:{item.pk}')),
                            'asset_id': item.asset_id, 'ticket_item_id': item.pk, 'supplier_id': ticket.company_id,
                            'source_kind': 'supplier', 'quantity': item.quantity, 'unit_value': str(item.rental_price),
                            'snapshot': {'sku': item.asset.sku or '', 'alias_name': item.asset.alias_name or item.asset.sku or 'Rental item',
                                         'serial_number': item.asset.serial_number or '', 'type': item.asset.type, 'supplier_name': ticket.company.name}})
                legacy_consumables = event.consumable_data or {}
                if not isinstance(legacy_consumables, dict):
                    warnings.append({'conference_id': event.pk, 'scope': scope, 'code': 'invalid_legacy_consumable_data'})
                    legacy_consumables = {}
                for key, data in legacy_consumables.items():
                    if isinstance(data, dict) and data.get('requested', 0) and str(key) not in {str(aid) for aid in consumables}:
                        warnings.append({'conference_id': event.pk, 'scope': scope, 'asset_id': key, 'code': 'consumable_legacy_ledger_requires_settlement_review'})
            number = (truck.challan_number if truck else event.challan_number) or ''
            owners = numbers.setdefault(number, []) if number else []
            owners.append({'conference_id': event.pk, 'scope': scope, 'truck_number': truck.truck_number if truck else None})
            for position, row in enumerate(rows):
                row['position'] = position
            documents.append({'conference_id': event.pk, 'scope': scope, 'truck_id': truck.pk if truck else None,
                'number': number, 'expected_event_revision': event.revision, 'provenance': 'legacy_snapshot_at_preview',
                'header': capture_header(event, truck), 'lines': rows})
    for number, owners in numbers.items():
        if len({owner['conference_id'] for owner in owners}) > 1 or any(owner['truck_number'] not in (None, 1) for owner in owners) and len(owners) > 1:
            warnings.append({'number': number, 'code': 'legacy_number_collision', 'owners': owners})
    return {'mode': 'preview_only', 'documents': documents, 'warnings': warnings,
            'limitations': ['Current inventory/header/value snapshots cannot reconstruct original historical print data.',
                            'Quantities and values require human review; this preview is not an executable backfill.',
                            'Browser-only manual entries are not present in the database preview.']}
