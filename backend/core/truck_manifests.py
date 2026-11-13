"""Atomic documentary distributions. Never reserve, consume, clone or release stock."""
import hashlib
import json
import uuid
from datetime import date

from django.db import transaction
from django.db.models import Sum
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .asset_commands import CommandError, canonical_conference
from .models import (Asset, Conference, TruckChallan, TruckManifest, TruckManifestEntry,
                     ChallanDocument, ChallanLine, ChallanNumberReservation, ChallanRevision,
                     MovementReceipt, SubrentalTicketItem)
from .permissions import WAREHOUSE_ROLES, get_business_role
from .challan_documents import document_data, capture_saved_header, allocate_number, number_mutex, reserve_number, save_document, replace_lines
from .challan_lock import challans_locked, require_challan_edit


def manifest_data(manifest):
    return {'master_document_id': str(manifest.master_id), 'entries': [
        {'master_line_id': str(row.master_line_id), 'truck_id': row.truck_id, 'quantity': row.quantity,
         'document_line_id': str(row.document_line_id)} for row in manifest.entries.order_by('truck_id', 'master_line_id')]}


def normalize(payload):
    common = {'request_id', 'action', 'expected_event_revision', 'expected_document_revisions', 'reason'}
    extras = {'start': set(), 'add': set(), 'cancel': set(), 'move': {'from_truck_id', 'to_truck_id', 'items'},
              'issue': {'truck_id', 'document_date'}, 'save_master': {'document'}, 'metadata': {'truck_id', 'vehicle_number', 'driver_phone', 'label'}}
    if not isinstance(payload, dict) or payload.get('action') not in extras or set(payload) - common - extras[payload['action']]:
        raise CommandError('invalid_manifest_payload', 400)
    try: request_id = str(uuid.UUID(str(payload.get('request_id'))))
    except (ValueError, TypeError, AttributeError): raise CommandError('invalid_request_id', 400)
    revision, revisions = payload.get('expected_event_revision'), payload.get('expected_document_revisions')
    if type(revision) is not int or revision < 0: raise CommandError('expected_event_revision_required', 428)
    if not isinstance(revisions, dict) or any(not isinstance(key, str) or type(value) is not int or value < 0 for key, value in revisions.items()):
        raise CommandError('expected_document_revisions_required', 428)
    reason = payload.get('reason', '')
    if not isinstance(reason, str) or len(reason) > 2000: raise CommandError('invalid_correction_reason', 400)
    command = {**payload, 'request_id': request_id, 'reason': reason.strip()}
    if command['action'] == 'move':
        for key in ('from_truck_id', 'to_truck_id'):
            value = command.get(key)
            if value is not None and (type(value) is not int or value <= 0): raise CommandError('invalid_truck', 400)
        if command.get('from_truck_id') == command.get('to_truck_id'): raise CommandError('same_manifest_destination', 400)
        items = command.get('items')
        if not isinstance(items, list) or not 1 <= len(items) <= 500: raise CommandError('invalid_batch', 400)
        seen = set()
        for item in items:
            if not isinstance(item, dict) or set(item) != {'master_line_id', 'quantity'} or type(item['quantity']) is not int or not 1 <= item['quantity'] <= 1000000:
                raise CommandError('invalid_quantity', 400)
            try: source_id = str(uuid.UUID(str(item['master_line_id'])))
            except (ValueError, TypeError, AttributeError): raise CommandError('invalid_source', 400)
            if source_id in seen: raise CommandError('duplicate_sources', 400)
            seen.add(source_id); item['master_line_id'] = source_id
        command['items'] = sorted(items, key=lambda item: item['master_line_id'])
    elif command['action'] == 'issue':
        if type(command.get('truck_id')) is not int or command['truck_id'] <= 0: raise CommandError('invalid_truck', 400)
        try: date.fromisoformat(command['document_date'])
        except (ValueError, TypeError, KeyError): raise CommandError('document_date_required', 400)
    elif command['action'] == 'save_master':
        from .challan_documents import normalize as normalize_document
        command['document'] = normalize_document(command.get('document'))
        if command['document']['expected_event_revision'] != revision: raise CommandError('event_revision_mismatch', 400)
    elif command['action'] == 'metadata':
        if type(command.get('truck_id')) is not int or command['truck_id'] <= 0: raise CommandError('invalid_truck', 400)
        for key, limit in (('vehicle_number', 50), ('driver_phone', 20), ('label', 50)):
            if key in command and (not isinstance(command[key], str) or len(command[key]) > limit): raise CommandError('invalid_truck_metadata', 400)
    return command


def validate_sources(event, lines):
    """Proof for preparing NEW truck distributions, not historical document edits."""
    quantities = {row.asset_id: row for row in event.quantity_allocations.all()}
    consumables = {row.asset_id: row for row in event.consumable_allocations.all()}
    tickets = {item.pk: item for item in SubrentalTicketItem.objects.select_for_update().select_related('ticket').filter(
        pk__in=[line.ticket_item_id for line in lines if line.ticket_item_id]).order_by('pk')}
    membership = set(event.assets.values_list('pk', flat=True)) | set(event.staged_assets.values_list('pk', flat=True)) | set(event.challan_assets.values_list('pk', flat=True)) | set(event.crosscheck_assets.values_list('pk', flat=True))
    asset_sources = {}
    for line in lines:
        if line.source_kind == 'manual': continue
        kind = 'ticket' if line.ticket_item_id else 'inventory'
        if line.asset_id in asset_sources and asset_sources[line.asset_id] != kind: raise CommandError('overlapping_inventory_and_supplier_ticket')
        asset_sources[line.asset_id] = kind
        asset = line.asset
        if asset.stock_kind == 'led_case': raise CommandError('historical_LED_box_cannot_enter_new_truck_manifest')
        if line.ticket_item_id:
            item = tickets.get(line.ticket_item_id)
            if not item or item.ticket.conference_id != event.pk or item.asset_id != line.asset_id or item.ticket.company_id != line.supplier_id:
                raise CommandError('manifest_ticket_source_changed')
            if asset.subrental_company_id and asset.subrental_company.inventory_mode == 'shared_warehouse': raise CommandError('shared_stock_ticket_requires_review')
            capacity = item.quantity
            from .models import SupplierBalance
            from .supplier_balances import balance_data
            if SupplierBalance.objects.filter(item=item).exists():
                balance = balance_data(item)
                if balance['state'] != 'recorded': raise CommandError('supplier_balance_requires_review')
                capacity = balance['received']
        elif asset.type == 'Consumables':
            row = consumables.get(asset.pk)
            if not row: raise CommandError('legacy_consumables_require_reconciliation')
            capacity = row.requested
        elif asset.quantity_tracking or asset.quantity != 1:
            row = quantities.get(asset.pk)
            if not row: raise CommandError('legacy_quantity_requires_reconciliation')
            capacity = row.dispatched_total + row.reserved
        else:
            if asset.pk not in membership: raise CommandError('manifest_physical_source_requires_review')
            capacity = 1
        if line.quantity > capacity: raise CommandError('manifest_source_exceeds_recorded_capacity')


def validate_total(master):
    if master.total_override is not None and master.total_override != sum(line.quantity * line.unit_value for line in master.lines.all()):
        raise CommandError('master_total_override_requires_review')


def write_truck(document, entries, actor, reason, issue_date=None):
    # Preserve actual/unknown warehouse history. Ticket-only paper references
    # must not become warehouse dispatch history when a truck is edited.
    old_ticket_ids = set(document.lines.filter(ticket_item__isnull=False).values_list('asset_id', flat=True))
    old_inventory_ids = set(document.lines.filter(ticket_item__isnull=True).values_list('asset_id', flat=True))
    positive = [entry for entry in entries if entry.quantity > 0]
    was_issued = document.state == 'issued'
    if was_issued and not reason: raise CommandError('issued_manifest_requires_correction_reason')
    if not was_issued and not challans_locked(document.conference):
        master = document.conference.truck_manifest.master
        document.header = capture_saved_header(document.conference, document.truck, master.header.get('owner_sections_version'))
        if document.header.get('owner_sections_version') == 1:
            document.header['alias_grouping_version'] = 1
        if master.header.get('company'):
            document.header['company'] = dict(master.header['company'])
    if issue_date:
        if document.state == 'issued': raise CommandError('manifest_already_issued')
        if not positive: raise CommandError('empty_manifest_cannot_issue', 400)
        document.state = 'issued'; document.document_date = date.fromisoformat(issue_date)
    document.total_override = None  # source-line sums, no stale delivery total on a split
    document.revision += 1; document.save()
    lines, aggregate = [], {}
    for position, entry in enumerate(sorted(positive, key=lambda entry: (entry.master_line.position, str(entry.master_line_id)))):
        source = entry.master_line
        lines.append({'id': str(entry.document_line_id), 'asset_id': source.asset_id, 'ticket_item_id': source.ticket_item_id,
            'supplier_id': source.supplier_id, 'source_kind': source.source_kind, 'snapshot': source.snapshot,
            'quantity': entry.quantity, 'unit_value': str(source.unit_value), 'position': position})
        if source.asset_id: aggregate[str(source.asset_id)] = aggregate.get(str(source.asset_id), 0) + entry.quantity
    replace_lines(document, lines)
    truck = document.truck
    historical_ids = (set(truck.assets.values_list('pk', flat=True)) - old_ticket_ids) | (old_inventory_ids - {None})
    document.conference.challan_assets.add(*sorted(historical_ids))
    truck.asset_quantities = aggregate; truck.save(update_fields=['asset_quantities'])
    truck.assets.set([int(key) for key in aggregate])
    ChallanRevision.objects.create(document=document, revision=document.revision, actor=actor, reason=reason, snapshot=document_data(document))


def cancel_draft_split(event, master, manifest, trucks, documents):
    truck_docs = [document for document in documents.values() if document.truck_id]
    histories = ChallanRevision.objects.filter(document__in=truck_docs)
    if (any(document.state != 'draft' or document.provenance != 'coordinated_manifest' for document in truck_docs)
            or histories.filter(snapshot__state='issued').exists()):
        raise CommandError('issued_truck_split_cannot_cancel')
    truck_ids = {str(pk) for pk in trucks}
    for delivery in event.issued_deliveries.all():
        truck_id = delivery.snapshot.get('customer_document', {}).get('truck_id')
        if str(truck_id) in truck_ids:
            raise CommandError('issued_truck_split_cannot_cancel')
    archive = {
        'documents': [document_data(document) for document in truck_docs],
        'revisions': [
            {'document_id': str(row.document_id), 'revision': row.revision, 'reason': row.reason,
             'actor_id': row.actor_id, 'created_at': row.created_at.isoformat(), 'snapshot': row.snapshot}
            for row in histories.order_by('document_id', 'revision')
        ],
    }
    number_mutex()
    for number in {document.number for document in truck_docs} - {master.number, ''}:
        reservation, _ = ChallanNumberReservation.objects.get_or_create(number=number)
        if reservation.conference_id is not None:
            if reservation.conference_id != event.pk:
                raise CommandError('number_already_used')
            reservation.conference_id = None
            reservation.save(update_fields=['conference'])
    manifest.entries.all().delete()
    manifest.delete()
    histories.delete()
    ChallanDocument.objects.filter(pk__in=[document.pk for document in truck_docs]).delete()
    TruckChallan.objects.filter(pk__in=trucks).delete()
    return archive


@transaction.atomic
def execute_manifest_command(user, event_id, payload):
    command = normalize(json.loads(json.dumps(payload)))
    fingerprint = hashlib.sha256(json.dumps({'operation': 'truck_manifest', 'event_id': event_id, **command}, sort_keys=True).encode()).hexdigest()
    previous = MovementReceipt.objects.filter(actor=user, request_id=command['request_id']).first()
    if previous:
        if previous.payload_hash != fingerprint: raise CommandError('request_id_reused')
        return {**{key: value for key, value in previous.result.items() if key != 'cancelled_draft_archive'}, 'replayed': True}
    if get_business_role(user) not in WAREHOUSE_ROLES: raise CommandError('not_authorized', 403)
    receipt, created = MovementReceipt.objects.get_or_create(actor=user, request_id=command['request_id'], defaults={'payload_hash': fingerprint})
    if not created:
        if receipt.payload_hash != fingerprint: raise CommandError('request_id_reused')
        return {**{key: value for key, value in receipt.result.items() if key != 'cancelled_draft_archive'}, 'replayed': True}
    ids = set(ChallanLine.objects.filter(document__conference_id=event_id).exclude(asset=None).values_list('asset_id', flat=True))
    if command['action'] == 'save_master': ids.update(line['asset_id'] for line in command['document']['lines'] if line['asset_id'])
    from .event_lifecycle import referenced_asset_ids
    ids.update(referenced_asset_ids(event_id))
    list(Asset.objects.select_for_update().filter(pk__in=ids).order_by('pk'))
    event = Conference.objects.select_for_update().filter(pk=event_id).first()
    if not event: raise CommandError('unknown_conference', 404)
    require_challan_edit(
        event, user, correction=command['action'] == 'save_master' and command['document']['state'] == 'issued',
        reason=command['reason'] or (command['document']['correction_reason'] if command['action'] == 'save_master' else ''),
        require_open=True,
    )
    if event.is_audit: raise CommandError('audit_is_not_manifest_dispatch', 400)
    if event.revision != command['expected_event_revision']: raise CommandError('event_changed')
    trucks = {row.pk: row for row in TruckChallan.objects.select_for_update().filter(conference=event).order_by('pk')}
    docs = {row.scope: row for row in ChallanDocument.objects.select_for_update().filter(conference=event).order_by('pk')}
    if command['expected_document_revisions'] != {scope: row.revision for scope, row in docs.items()}:
        raise CommandError('manifest_documents_changed')
    master = docs.get('master')
    if not master: raise CommandError('save_master_challan_first', 428)
    manifest = TruckManifest.objects.select_for_update().filter(conference=event).first()
    before = manifest_data(manifest) if manifest else None
    cancelled = None
    if command['action'] == 'start':
        if manifest or trucks or any(scope != 'master' for scope in docs): raise CommandError('existing_trucks_require_review')
        sources = list(master.lines.select_related('asset').all())
        if not sources: raise CommandError('empty_master_cannot_start', 400)
        validate_sources(event, sources)
        validate_total(master)
        manifest = TruckManifest.objects.create(conference=event, master=master)
        for number in (1, 2):
            value = reserve_number(master.number, event, None, master) if number == 1 else allocate_number()
            truck = TruckChallan.objects.create(conference=event, truck_number=number, label=f'Truck {number}',
                vehicle_number=event.vehicle_number if number == 1 else '', driver_phone=event.driver_phone if number == 1 else '', challan_number=value)
            doc = ChallanDocument.objects.create(conference=event, truck=truck, scope=f'truck-{truck.pk}', number=value,
                document_date=master.document_date, provenance='coordinated_manifest')
            entries = [TruckManifestEntry.objects.create(manifest=manifest, master_line=source, truck=truck, quantity=source.quantity) for source in sources] if number == 1 else []
            write_truck(doc, entries, user, 'Initial recorded distribution')
    else:
        if not manifest: raise CommandError('start_truck_manifest_first', 428)
        if manifest.master_id != master.pk or set(docs) != {'master'} | {f'truck-{pk}' for pk in trucks}:
            raise CommandError('manifest_history_requires_review')
        if any(docs[f'truck-{pk}'].truck_id != pk for pk in trucks):
            raise CommandError('manifest_history_requires_review')
        entries = list(manifest.entries.select_for_update().select_related('master_line').order_by('truck_id', 'master_line_id'))
        for row in entries:
            if row.truck_id not in trucks or row.master_line.document_id != master.pk or sum(e.quantity for e in entries if e.master_line_id == row.master_line_id) > row.master_line.quantity:
                raise CommandError('manifest_totals_require_review')
        if command['action'] == 'cancel':
            cancelled = cancel_draft_split(event, master, manifest, trucks, docs)
        elif command['action'] == 'add':
            number = max(row.truck_number for row in trucks.values()) + 1
            truck = TruckChallan.objects.create(conference=event, truck_number=number, label=f'Truck {number}', challan_number=allocate_number())
            doc = ChallanDocument.objects.create(conference=event, truck=truck, scope=f'truck-{truck.pk}', number=truck.challan_number,
                document_date=master.document_date, provenance='coordinated_manifest')
            write_truck(doc, [], user, 'Added empty truck')
        elif command['action'] == 'move':
            source_id, destination_id = command.get('from_truck_id'), command.get('to_truck_id')
            if any(pk is not None and pk not in trucks for pk in (source_id, destination_id)): raise CommandError('truck_not_in_event', 400)
            sources = {str(line.pk): line for line in master.lines.select_related('asset').all()}
            requested = [sources[item['master_line_id']] for item in command['items'] if item['master_line_id'] in sources]
            if len(requested) != len(command['items']): raise CommandError('source_not_in_master', 400)
            if destination_id is not None: validate_sources(event, requested)
            lookup = {(str(row.master_line_id), row.truck_id): row for row in entries}
            for item in command['items']:
                key, amount = item['master_line_id'], item['quantity']
                total = sum(row.quantity for row in entries if str(row.master_line_id) == key)
                if total > sources[key].quantity: raise CommandError('manifest_totals_require_review')
                current = lookup.get((key, source_id))
                available = current.quantity if source_id is not None and current else sources[key].quantity - total if source_id is None else 0
                if amount > available: raise CommandError('insufficient_manifest_quantity')
                if source_id is not None: current.quantity -= amount; current.save(update_fields=['quantity'])
                if destination_id is not None:
                    target = lookup.get((key, destination_id))
                    if not target:
                        target = TruckManifestEntry.objects.create(manifest=manifest, master_line=sources[key], truck=trucks[destination_id], quantity=0)
                        entries.append(target); lookup[(key, destination_id)] = target
                    target.quantity += amount; target.save(update_fields=['quantity'])
            for pk in sorted({source_id, destination_id} - {None}):
                write_truck(docs[f'truck-{pk}'], [row for row in entries if row.truck_id == pk], user, command['reason'])
        elif command['action'] == 'issue':
            pk = command['truck_id']
            if pk not in trucks: raise CommandError('truck_not_in_event', 400)
            write_truck(docs[f'truck-{pk}'], [row for row in entries if row.truck_id == pk], user, command['reason'], command['document_date'])
        elif command['action'] == 'metadata':
            pk = command['truck_id']
            if pk not in trucks: raise CommandError('truck_not_in_event', 400)
            truck = trucks[pk]
            for key in ('vehicle_number', 'driver_phone', 'label'):
                if key in command: setattr(truck, key, command[key].strip())
            truck.save()
            doc = docs[f'truck-{pk}']
            if doc.state == 'draft':
                doc.truck = truck
                write_truck(doc, [row for row in entries if row.truck_id == pk], user, 'Truck details updated')
        else:  # save_master: preserve source UUIDs and forbid removal below distribution
            draft = command['document']
            if draft['number'] != master.number: raise CommandError('manifest_number_is_permanent')
            submitted = {line['id']: line for line in draft['lines']}
            for row in entries:
                if row.quantity and (str(row.master_line_id) not in submitted or sum(e.quantity for e in entries if e.master_line_id == row.master_line_id) > submitted[str(row.master_line_id)]['quantity']):
                    raise CommandError('deallocate_before_reducing_master_line')
            # Zero allocations can be removed; receipts and document revisions retain their history.
            manifest.entries.filter(quantity=0).exclude(master_line_id__in=submitted).delete()
            draft['request_id'] = str(uuid.uuid5(uuid.UUID(command['request_id']), 'manifest-master-save'))
            save_document(user, event_id, 'master', draft, coordinated=True)
            master.refresh_from_db(); validate_total(master)
            validate_sources(event, list(master.lines.select_related('asset').all()))
            for pk in sorted(trucks):
                rows = list(manifest.entries.filter(truck_id=pk).select_related('master_line'))
                write_truck(docs[f'truck-{pk}'], rows, user, command['reason'] or draft['correction_reason'])
    event.refresh_from_db(); event.save(update_fields=['revision'])
    result = {'operation': 'manifest', 'request_id': command['request_id'], 'replayed': False,
              'manifest_before': before, 'conference': canonical_conference(event), 'document': document_data(ChallanDocument.objects.get(pk=master.pk))}
    if cancelled is not None:
        result['cancelled_draft_split'] = True
    receipt.result = {**result, 'cancelled_draft_archive': cancelled} if cancelled is not None else result
    receipt.save(update_fields=['result'])
    return result


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def manifest_commands(request, pk):
    try: return Response(execute_manifest_command(request.user, pk, request.data))
    except CommandError as error: return Response({'error': error.code, 'conflicts': error.details}, status=error.status)
