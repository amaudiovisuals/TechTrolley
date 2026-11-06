"""Schema-aware, SELECT-only evidence for reviewed legacy reconciliation.

No model import, serializer, inferred backfill, apply option or inventory mutation.
Can be piped to an older deployed runtime without installing current migrations.
"""
import collections
import hashlib
import json

TABLES = {
    'core_asset': 'id type quantity quantity_tracking status flag condition assigned_to_id subrental_company_id parent_asset_id is_temporary sku barcode qr_code serial_number',
    'core_employee': 'id',
    'core_conference': 'id revision is_audit start_date end_date challan_number approximate_value consumable_data',
    'core_conference_assets': 'id conference_id asset_id',
    'core_conference_staged_assets': 'id conference_id asset_id',
    'core_conference_crosscheck_assets': 'id conference_id asset_id',
    'core_conference_challan_assets': 'id conference_id asset_id',
    'core_truckchallan': 'id conference_id truck_number challan_number asset_quantities',
    'core_truckchallan_assets': 'id truckchallan_id asset_id',
    'core_subrentalticket': 'id conference_id company_id',
    'core_subrentalticketitem': 'id ticket_id asset_id quantity',
    'core_quantityallocation': 'id asset_id conference_id reserved dispatched awaiting_verification dispatched_total verified_total transferred_in_total transferred_out_total',
    'core_consumableallocation': 'id asset_id conference_id requested returned consumed state',
    'core_challandocument': 'id conference_id truck_id scope number revision state total_override',
    'core_challanline': 'id document_id asset_id ticket_item_id supplier_id source_kind quantity unit_value position',
    'core_truckmanifest': 'id conference_id master_id',
    'core_truckmanifestentry': 'id manifest_id master_line_id truck_id quantity document_line_id',
}
JSON_COLUMNS = {'consumable_data', 'asset_quantities'}
REQUIRED = {'core_asset': {'id', 'type', 'quantity', 'status', 'assigned_to_id'},
            'core_conference': {'id', 'is_audit', 'consumable_data'},
            **{f'core_conference_{r}': {'conference_id', 'asset_id'}
               for r in ('assets', 'staged_assets', 'crosscheck_assets', 'challan_assets')},
            'core_truckchallan': {'id', 'conference_id', 'truck_number', 'asset_quantities'},
            'core_truckchallan_assets': {'truckchallan_id', 'asset_id'}}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True, default=str)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def collect_snapshot(connection):
    """Caller must hold a transaction; PostgreSQL must be REPEATABLE READ READ ONLY."""
    if not connection.in_atomic_block:
        raise ValueError('snapshot_requires_transaction')
    with connection.cursor() as cursor:
        if connection.vendor == 'postgresql':
            cursor.execute('SHOW transaction_read_only')
            if cursor.fetchone()[0] != 'on':
                raise ValueError('postgresql_snapshot_requires_read_only')
            cursor.execute('SHOW transaction_isolation')
            if cursor.fetchone()[0] not in ('repeatable read', 'serializable'):
                raise ValueError('snapshot_requires_repeatable_read')
        elif connection.vendor != 'sqlite':
            raise ValueError('unsupported_snapshot_database')
        existing = set(connection.introspection.table_names(cursor))
        tables, schema = {}, {}
        for table, wanted in TABLES.items():
            if table not in existing:
                schema[table] = None
                continue
            actual = {column.name for column in connection.introspection.get_table_description(cursor, table)}
            fields = [field for field in wanted.split() if field in actual]
            schema[table] = fields
            if not fields:
                raise ValueError('unrecognized_table_schema:' + table)
            quote = connection.ops.quote_name
            cursor.execute('SELECT ' + ', '.join(map(quote, fields)) + ' FROM ' + quote(table))
            rows = []
            for values in cursor.fetchall():
                row = dict(zip(fields, values))
                for field in JSON_COLUMNS & row.keys():
                    if isinstance(row[field], str):
                        try:
                            row[field] = json.loads(row[field])
                        except (ValueError, TypeError):
                            pass  # Preserve invalid legacy evidence; do not manufacture {}.
                rows.append(json.loads(canonical(row)))
            tables[table] = sorted(rows, key=canonical)
        for table, required in REQUIRED.items():
            if not required <= set(schema.get(table) or []):
                raise ValueError('incomplete_required_schema:' + table)
    return {'format': 1, 'schema': schema, 'tables': tables}


def positive(value):
    return type(value) is int and value > 0


def preview_reconciliation(snapshot):
    """Deterministic proposal list; every repair needs external evidence/revalidation."""
    tables, schema = snapshot['tables'], snapshot['schema']
    findings = []
    def rows(table):
        return tables.get('core_' + table, [])
    def add(code, refs, evidence, review):
        finding = {'code': code, 'references': refs, 'evidence': evidence,
                   'review_required': review, 'automatic_apply_allowed': False}
        finding['id'] = digest({'code': code, 'references': refs})
        finding['evidence_sha256'] = digest(evidence)
        findings.append(finding)
    assets = {row['id']: row for row in rows('asset')}
    events = {row['id']: row for row in rows('conference')}
    audit = {eid for eid, event in events.items() if event['is_audit']}
    memberships = {}
    for relation in ('assets', 'staged_assets', 'crosscheck_assets', 'challan_assets'):
        mapping = collections.defaultdict(set)
        for row in rows('conference_' + relation):
            mapping[row['asset_id']].add(row['conference_id'])
        memberships[relation] = mapping
    tracked_bulk = {(r['asset_id'], r['conference_id']) for r in rows('quantityallocation')}
    tracked_consumer = {(r['asset_id'], r['conference_id']) for r in rows('consumableallocation')}
    saved_scopes = {(d['conference_id'], d['scope']) for d in rows('challandocument')}
    for aid, asset in assets.items():
        bulk = asset['quantity'] != 1 or asset.get('quantity_tracking') or asset['type'] == 'Consumables'
        active = memberships['assets'][aid] - audit
        unchecked = memberships['crosscheck_assets'][aid] - audit
        plans = memberships['staged_assets'][aid]
        history = memberships['challan_assets'][aid]
        evidence = {'asset': asset, 'active_event_ids': sorted(active), 'unchecked_event_ids': sorted(unchecked),
                    'audit_active_ids': sorted(memberships['assets'][aid] & audit),
                    'audit_unchecked_ids': sorted(memberships['crosscheck_assets'][aid] & audit),
                    'staged_event_ids': sorted(plans), 'historical_event_ids': sorted(history)}
        review = 'Confirm physical custody, staff issue and restrictions; retain paper/audit history. End dates do not prove return completion.'
        if not bulk and len(active | unchecked) > 1:
            add('multiple_current_event_holders', {'asset_id': aid}, evidence, review)
        if not bulk and asset['status'] == 'Available' and (active or unchecked):
            add('available_despite_current_holder', {'asset_id': aid}, evidence, review)
        if not bulk and asset['status'] in ('In Use', 'Crosscheck') and not active and not unchecked:
            add('custody_status_without_current_holder', {'asset_id': aid}, evidence, review)
        if not bulk and asset['status'] == 'Crosscheck' and not unchecked:
            add('crosscheck_status_without_queue', {'asset_id': aid}, evidence, review)
        if not active and not unchecked and (history or plans):
            add('historical_or_plan_relations_are_not_custody', {'asset_id': aid}, evidence,
                'Fix/retest location projection; do not delete historical relations or infer an inventory repair.')
        if asset.get('assigned_to_id') and (active or unchecked):
            add('staff_issue_and_event_holder_overlap', {'asset_id': aid}, evidence, review)
        if bulk:
            for eid in sorted(memberships['assets'][aid] | memberships['crosscheck_assets'][aid] | plans):
                tracked = tracked_consumer if asset['type'] == 'Consumables' else tracked_bulk
                if (aid, eid) not in tracked:
                    add('legacy_consumer_membership_without_ledger' if asset['type'] == 'Consumables' else 'legacy_bulk_membership_without_ledger',
                        {'asset_id': aid, 'conference_id': eid}, evidence,
                        'Review audit vs operational membership and actual reserved/sent/returned/unchecked quantity. Current stock is not event quantity; do not clone or subtract it.')
    # Matching identifiers are review candidates, never proof that two rows are one asset.
    for field in ('sku', 'barcode', 'qr_code', 'serial_number'):
        groups = collections.defaultdict(list)
        for aid, asset in assets.items():
            value = asset.get(field)
            if isinstance(value, str) and value.strip():
                groups[value.strip().casefold()].append(aid)
        for value, ids in groups.items():
            if len(ids) > 1:
                add('duplicate_identity_requires_review', {'field': field, 'asset_ids': sorted(ids)},
                    {'normalized_identity': value, 'assets': [assets[aid] for aid in sorted(ids)]},
                    'Confirm physical serial/tag/ownership and clone history before any merge. Shared SKU may legitimately identify a model; preserve all custody and documents.')
    for eid, event in events.items():
        if (eid, 'master') not in saved_scopes:
            source_ids = sorted(aid for aid in assets if eid in memberships['challan_assets'][aid])
            source = 'historical_membership'
            if not source_ids:
                source_ids = sorted(aid for aid in assets if any(eid in memberships[r][aid] for r in ('assets', 'staged_assets', 'crosscheck_assets')))
                source = 'current_relation_fallback'
            if source_ids:
                add('legacy_master_requires_snapshot_review', {'conference_id': eid},
                    {'source': source, 'asset_ids': source_ids, 'number': event.get('challan_number'), 'legacy_total': event.get('approximate_value')},
                    'Compare issued PDF/paper with membership, rental tickets and manual rows. Current descriptions/rates/stock cannot recover the issued original. Preserve legacy total until reviewed.')
                for aid in source_ids:
                    asset = assets[aid]
                    tracked = tracked_consumer if asset['type'] == 'Consumables' else tracked_bulk
                    if (asset['quantity'] != 1 or asset.get('quantity_tracking') or asset['type'] == 'Consumables') and (aid, eid) not in tracked:
                        add('legacy_master_quantity_without_source_proof', {'conference_id': eid, 'asset_id': aid},
                            {'source': source, 'stock_now': asset['quantity'], 'type': asset['type']},
                            'Confirm documentary event quantity separately from current stock/custody. Do not initialize an issued legacy line with inventory quantity.')
        data = event['consumable_data']
        if not isinstance(data, dict):
            add('malformed_legacy_consumables', {'conference_id': eid}, {'raw': data}, 'Recover original requests/returns from evidence; do not replace malformed records with empty data.')
            continue
        for key, entry in sorted(data.items()):
            aid = int(key) if str(key).isdigit() else None
            refs = {'conference_id': eid, 'asset_key': key}
            if aid not in assets or assets[aid]['type'] != 'Consumables' or not isinstance(entry, dict):
                add('invalid_legacy_consumable_reference', refs, {'raw': entry}, 'Confirm the original item and quantities; preserve the raw record.')
                continue
            if (aid, eid) in tracked_consumer:
                continue
            requested, returned = entry.get('requested'), entry.get('returned')
            valid_request = type(requested) is int and requested >= 0
            valid_return = returned is None or type(returned) is int and valid_request and 0 <= returned <= requested
            if not valid_request or not valid_return:
                add('invalid_legacy_consumable_quantities', refs, {'raw': entry}, 'Obtain explicit valid request/return counts; unknown is distinct from zero.')
            if not valid_request or requested or entry.get('consumed') or entry.get('status') == 'settled':
                add('legacy_consumable_prior_debit_unknown', refs, {'raw': entry, 'asset_stock_now': assets[aid]['quantity']},
                    'Confirm original requested quantity, explicit returns and whether stock was already deducted. A settled label/current stock cannot prove prior debit. Never settle/debit again by inference.')
    # Master and Truck 1 may share a number within one event; no other alias is assumed.
    owners = collections.defaultdict(list)
    for document in rows('challandocument'):
        if document['number']:
            owners[document['number']].append({'conference_id': document['conference_id'], 'scope': document['scope'], 'document_id': document['id']})
    for eid, event in events.items():
        if event.get('challan_number') and (eid, 'master') not in saved_scopes:
            owners[event['challan_number']].append({'conference_id': eid, 'scope': 'master'})
    trucks = {r['id']: r for r in rows('truckchallan')}
    managed = {r['conference_id'] for r in rows('truckmanifest')}
    for tid, truck in trucks.items():
        scope = 'truck-' + str(tid)
        if truck.get('challan_number') and (truck['conference_id'], scope) not in saved_scopes:
            owners[truck['challan_number']].append({'conference_id': truck['conference_id'], 'scope': scope})
    def permitted_alias(group):
        if len({r['conference_id'] for r in group}) != 1 or len(group) != 2:
            return False
        scopes = {r['scope'] for r in group}
        return 'master' in scopes and any(t['truck_number'] == 1 and 'truck-' + str(tid) in scopes for tid, t in trucks.items() if t['conference_id'] == group[0]['conference_id'])
    for number, group in owners.items():
        if len(group) > 1 and not permitted_alias(group):
            add('challan_number_collision', {'number': number}, {'owners': group},
                'Compare retained issued copies/reservations; correct only a reviewed draft or append an authorized issued correction. Never silently renumber history.')
    ticket_lookup = {r['id']: r for r in rows('subrentalticket')}
    supplier_pairs = {(r['asset_id'], ticket_lookup[r['ticket_id']]['conference_id']) for r in rows('subrentalticketitem') if r['ticket_id'] in ticket_lookup}
    truck_members = collections.defaultdict(set)
    for row in rows('truckchallan_assets'):
        truck_members[row['truckchallan_id']].add(row['asset_id'])
    allocated = collections.defaultdict(list)
    for tid, truck in trucks.items():
        eid = truck['conference_id']
        if eid in managed:
            continue  # New manifests have a different authoritative representation.
        add('legacy_truck_requires_manifest_source_review', {'truck_id': tid, 'conference_id': eid},
            {'truck': truck, 'asset_ids': sorted(truck_members[tid])},
            'Approve a saved master source per owned/rental/manual line before conversion; retain old trucks/numbers. Unknown master/manual history cannot be reconstructed from membership.')
        data = truck['asset_quantities']
        if not isinstance(data, dict):
            add('malformed_truck_quantity_map', {'truck_id': tid}, {'raw': data}, 'Recover explicit allocations; do not infer from stock.')
            continue
        for aid in sorted(truck_members[tid]):
            if str(aid) not in data:
                add('truck_membership_without_explicit_quantity', {'truck_id': tid, 'asset_id': aid}, {'asset': assets.get(aid)},
                    'Confirm truck quantity from signed manifest; membership and stock do not prove it.')
        for key, quantity in sorted(data.items()):
            aid = int(key) if str(key).isdigit() else None
            refs = {'truck_id': tid, 'asset_key': key}
            if aid not in truck_members[tid] or aid not in assets or not positive(quantity):
                add('invalid_or_orphan_truck_quantity', refs, {'quantity': quantity, 'member': aid in truck_members[tid]}, 'Review discrepancy with actual paperwork; neither representation automatically wins.')
            else:
                allocated[(eid, aid)].append({'truck_id': tid, 'quantity': quantity})
                if (aid, eid) in supplier_pairs or assets[aid].get('subrental_company_id'):
                    add('rental_truck_source_identity_ambiguous', refs, {'quantity': quantity, 'conference_id': eid}, 'Identify the exact ticket item/company source; one asset can occur on multiple rental tickets.')
    for (eid, aid), assignments in allocated.items():
        if len(assignments) > 1:
            add('legacy_asset_on_multiple_trucks', {'conference_id': eid, 'asset_id': aid}, {'assignments': assignments, 'total': sum(a['quantity'] for a in assignments)},
                'Confirm master event quantity and source identity. This is a distribution candidate, not proof of duplicate stock.')
    findings.sort(key=lambda f: (f['code'], canonical(f['references'])))
    return {'mode': 'preview_only', 'format': 1, 'snapshot_sha256': digest(snapshot),
            'counts': {'assets': len(assets), 'conferences': len(events), 'trucks': len(trucks),
                       'staff_assigned_assets': sum(bool(a.get('assigned_to_id')) for a in assets.values()),
                       'findings': len(findings)},
            'finding_counts': dict(sorted(collections.Counter(f['code'] for f in findings).items())),
            'schema': schema, 'missing_optional_tables': sorted(t for t in TABLES if t not in REQUIRED and schema.get(t) is None),
            'findings': findings,
            'limitations': ['Review candidates are not automatically proven errors or physical losses.',
                           'No event lifecycle/completed return status is inferred from dates or empty queues.',
                           'Fingerprint covers selected schema/operational fields, not the whole database or immutable historical print metadata.',
                           'Missing ledger/document tables mean evidence unavailable, not zero activity.',
                           'Browser-only manual rows, historical printed rates/headers, clone ancestry and prior stock deductions require external evidence.',
                           'This legacy preview does not certify current ledger/manifest arithmetic or all product behavior.',
                           'No executable apply/rollback implementation is provided.']}
