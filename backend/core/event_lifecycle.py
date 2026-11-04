"""Explicit verified event closure. GET never certifies returns or changes stock.

Lock order: referenced assets -> event -> its dependent records. Every operational
writer must hold the event lock and refuse a sealed event. No inferred backfill.
"""
import hashlib
import json
import re
import uuid
from django.db import connection, transaction
from django.shortcuts import get_object_or_404
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from .asset_commands import CommandError, canonical_conference
from .models import (Asset, Conference, MovementReceipt, PhysicalMovement,
                     EventLifecycleHistory, SubrentalTicketItem, ChallanLine, ReconciliationHistory)
from .permissions import WAREHOUSE_ROLES, ADMIN_ROLES, get_business_role


def require_open_event(event):
    if event.lifecycle_state != 'open':
        raise CommandError('event_is_sealed', details=[{'conference_id': event.pk, 'state': event.lifecycle_state}])


def referenced_asset_ids(event_id):
    event = Conference.objects.filter(pk=event_id).first()
    if not event:
        return set()
    ids = set()
    for field in ('assets', 'crosscheck_assets', 'staged_assets', 'requirements', 'challan_assets'):
        ids.update(getattr(event, field).values_list('pk', flat=True))
    for related in ('quantity_allocations', 'consumable_allocations', 'physical_movements', 'preserved_audit_observations'):
        ids.update(getattr(event, related).values_list('asset_id', flat=True))
    ids.update(event.truck_challans.values_list('assets__pk', flat=True))
    ids.update(SubrentalTicketItem.objects.filter(ticket__conference_id=event_id).values_list('asset_id', flat=True))
    ids.update(ChallanLine.objects.filter(document__conference_id=event_id).values_list('asset_id', flat=True))
    return ids - {None}


def movement_data(row):
    return {'id': row.pk, 'asset_id': row.asset_id, 'action': row.action,
            'target_conference_id': row.target_conference_id, 'receipt_id': row.receipt_id,
            'request_id': str(row.receipt.request_id), 'operator_id': row.receipt.actor_id,
            'recorded_at': row.created_at.isoformat(), 'snapshot': row.snapshot}


def history_data(row):
    return {'id': row.pk, 'action': row.action, 'before_state': row.before_state,
            'after_state': row.after_state, 'reason': row.reason, 'operator_id': row.actor_id,
            'recorded_at': row.created_at.isoformat(), 'evidence_sha256': row.evidence_sha256,
            'request_id': str(row.receipt.request_id)}


def build_review(event):
    """Called in a read snapshot or while referenced asset/event locks are held."""
    from .custody import review_assets
    from .challan_documents import document_data
    from .quantity_commands import allocation_data
    from .consumable_commands import allocation_data as consumer_data
    queues = {field: sorted(getattr(event, field).values_list('pk', flat=True))
              for field in ('assets', 'crosscheck_assets', 'staged_assets', 'requirements')}
    blockers = []
    def block(code, **values):
        blockers.append({'reason': code, **values})
    if event.is_audit:
        block('audit_lifecycle_requires_reviewed_conversion')
    for field, ids in queues.items():
        if ids:
            block('pending_' + field, asset_ids=ids)
    quantities = list(event.quantity_allocations.order_by('asset_id'))
    consumers = list(event.consumable_allocations.order_by('asset_id'))
    quantity_ids, consumer_ids = {row.asset_id for row in quantities}, {row.asset_id for row in consumers}
    quantities_data, consumer_rows = [], []
    for row in quantities:
        quantities_data.append(allocation_data(row))
        if row.reserved or row.dispatched or row.awaiting_verification:
            block('quantity_balance_outstanding', asset_id=row.asset_id)
        verified = sum(m.quantity for m in row.movements.filter(action='verify_return'))
        dispatched = sum(m.quantity for m in row.movements.filter(action='dispatch'))
        if row.dispatched_total != row.verified_total or verified != row.verified_total or dispatched != row.dispatched_total:
            block('quantity_return_evidence_inconsistent', asset_id=row.asset_id)
    for row in consumers:
        consumer_rows.append({'asset_id': row.asset_id, **consumer_data(row)})
        if row.requested == 0 and row.state == 'reserved':
            continue
        if row.state != 'settled' or row.returned is None:
            block('consumable_return_not_settled', asset_id=row.asset_id)
        elif row.returned + row.consumed != row.requested or not row.movements.filter(action='settle', after__status='settled', after__returned=row.returned, after__consumed=row.consumed).exists():
            block('consumable_settlement_evidence_inconsistent', asset_id=row.asset_id)
    legacy = event.consumable_data
    if not isinstance(legacy, dict):
        if legacy:
            block('legacy_consumables_require_reconciliation')
    else:
        for key, value in legacy.items():
            if str(key) not in {str(aid) for aid in consumer_ids} and value:
                if not isinstance(value, dict) or value.get('requested') != 0:
                    block('legacy_consumables_require_reconciliation', asset_id=str(key))
    movements = list(event.physical_movements.select_related('receipt').order_by('pk'))
    latest = {row.asset_id: row for row in movements}
    legacy_historical = set(event.challan_assets.values_list('pk', flat=True))
    historical = set(legacy_historical)
    historical.update(event.truck_challans.values_list('assets__pk', flat=True))
    # Managed truck memberships can be documentary ticket references. A proven
    # external balance plus ticket-only saved lines is not a warehouse dispatch.
    rental_documents = set()
    if hasattr(event, 'truck_manifest'):
        for aid in historical - {None}:
            lines = ChallanLine.objects.filter(document__conference=event, asset_id=aid)
            unmanaged_truck = any(
                not lines.filter(document__truck=truck, document__provenance='coordinated_manifest', ticket_item__isnull=False).exists()
                for truck in event.truck_challans.filter(assets__pk=aid)
            )
            if aid not in legacy_historical and not unmanaged_truck and lines.filter(ticket_item__isnull=False).exists() and not lines.filter(ticket_item__isnull=True).exists() and aid not in latest:
                rental_documents.add(aid)
    physical_ids = (historical | set(latest)) - quantity_ids - consumer_ids - rental_documents - {None}
    physical_rows = []
    for asset in Asset.objects.filter(pk__in=physical_ids).order_by('pk'):
        last = latest.get(asset.pk)
        physical_rows.append({'asset_id': asset.pk, 'label': asset.alias_name or asset.sku,
                              'terminal_movement': movement_data(last) if last else None})
        if asset.quantity_tracking or asset.quantity != 1 or asset.type == 'Consumables':
            block('legacy_quantity_requires_reconciliation', asset_id=asset.pk)
        if last is None:
            block('physical_return_evidence_missing', asset_id=asset.pk)
        elif last.action not in {'verify_return', 'transfer_out', 'legacy_return_review'}:
            block('physical_return_not_verified', asset_id=asset.pk)
        elif last.action == 'legacy_return_review' and not ReconciliationHistory.objects.filter(receipt=last.receipt, action='legacy_return').exists():
            block('legacy_return_review_evidence_inconsistent', asset_id=asset.pk)
        elif last.action == 'transfer_out' and not PhysicalMovement.objects.filter(
                conference_id=last.target_conference_id, asset_id=asset.pk, receipt=last.receipt, action='transfer_in').exists():
            block('transfer_acceptance_evidence_missing', asset_id=asset.pk)
        if asset.flag == 'Missing' or asset.status == 'Missing':
            block('unresolved_missing_item', asset_id=asset.pk)
    tickets = list(SubrentalTicketItem.objects.filter(ticket__conference=event).order_by('pk').values(
        'id', 'ticket_id', 'asset_id', 'quantity', 'rental_price', 'ticket__company_id'))
    for row in tickets:
        row['rental_price'] = str(row['rental_price'])
        from .supplier_balances import balance_data
        item = SubrentalTicketItem.objects.get(pk=row['id'])
        row['balance'] = balance_data(item)
        if row['balance']['state'] != 'recorded':
            block('legacy_supplier_obligation_requires_review', ticket_item_id=row['id'], asset_id=row['asset_id'])
        elif not row['balance']['closed']:
            block('supplier_balance_outstanding', ticket_item_id=row['id'], asset_id=row['asset_id'])
    assets_review = review_assets(referenced_asset_ids(event.pk))
    # New use elsewhere is valid; inconsistent custody is still an unresolved review.
    for row in assets_review:
        for code in row['blockers']:
            block('asset_custody_requires_review', asset_id=row['asset_id'], detail=code)
    histories = [history_data(row) for row in event.lifecycle_history.select_related('receipt').order_by('pk')]
    if event.lifecycle_state in {'completed', 'archived'} and (not event.completed_at or not event.completed_by_id or
            not histories or histories[-1]['after_state'] != event.lifecycle_state):
        block('lifecycle_record_inconsistent')
    if event.lifecycle_state == 'archived' and (not event.archived_at or not event.archived_by_id):
        block('lifecycle_record_inconsistent')
    review_notes = []
    if event.lifecycle_state != 'open':
        # Archive preserves an already signed completion. Later health/custody
        # elsewhere does not undo a recorded return, and is not cleared here.
        review_notes = [row for row in blockers if row['reason'] in {'unresolved_missing_item', 'asset_custody_requires_review'}]
        blockers = [row for row in blockers if row not in review_notes]
    result = {'mode': 'lifecycle_review', 'conference_id': event.pk, 'name': event.name,
              'revision': event.revision, 'state': event.lifecycle_state, 'is_audit': event.is_audit,
              'completed_at': event.completed_at.isoformat() if event.completed_at else None,
              'completed_by_id': event.completed_by_id, 'archived_at': event.archived_at.isoformat() if event.archived_at else None,
              'archived_by_id': event.archived_by_id, 'queues': queues, 'physical_returns': physical_rows,
              'quantity_allocations': quantities_data, 'consumable_allocations': consumer_rows,
              'legacy_consumable_data': legacy, 'supplier_items': tickets,
              'supplier_tickets': list(event.subrental_tickets.order_by('pk').values('id', 'company_id', 'available_from', 'available_till')),
              'trucks': list(event.truck_challans.order_by('pk').values('id', 'truck_number', 'label', 'vehicle_number', 'driver_phone', 'challan_number', 'asset_quantities')),
              'flag_log': event.flag_log, 'transfer_log': event.transfer_log,
              'documents': [document_data(doc) for doc in event.challan_documents.order_by('scope')],
              'legacy_challan': {'asset_ids': sorted(historical - {None}), 'number': event.challan_number,
                                 'pdf': event.pdf_document.name or '', 'value': str(event.approximate_value)},
              'assets_review': assets_review, 'history': histories, 'blockers': blockers, 'review_notes': review_notes,
              'can_complete': event.lifecycle_state == 'open' and not blockers,
              'can_archive': event.lifecycle_state == 'completed' and not blockers,
              'limitations': ['Event dates and printed/manual lines do not prove physical returns.',
                              'Transfer acceptance closes this event obligation; it is not a warehouse return.',
                              'Historical returns without recorded evidence need reviewed reconciliation.',
                              'Supplier balances require recorded receipt/return/cancellation; legacy openings require review.']}
    for ticket in result['supplier_tickets']:
        for key in ('available_from', 'available_till'):
            ticket[key] = ticket[key].isoformat() if ticket[key] else None
    result['snapshot_sha256'] = hashlib.sha256(json.dumps(result, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return result


def normalize(payload):
    fields = {'request_id', 'action', 'expected_revision', 'expected_snapshot_sha256', 'reason', 'confirmed'}
    if not isinstance(payload, dict) or set(payload) != fields:
        raise CommandError('invalid_lifecycle_payload', 400)
    try:
        request_id = str(uuid.UUID(str(payload['request_id'])))
    except (ValueError, TypeError, AttributeError):
        raise CommandError('invalid_request_id', 400)
    if not isinstance(payload['action'], str) or payload['action'] not in {'complete', 'archive', 'reopen'}:
        raise CommandError('invalid_lifecycle_action', 400)
    if type(payload['expected_revision']) is not int or payload['expected_revision'] < 0:
        raise CommandError('expected_revision_required', 428)
    if not isinstance(payload['expected_snapshot_sha256'], str) or not re.fullmatch('[a-f0-9]{64}', payload['expected_snapshot_sha256']):
        raise CommandError('invalid_snapshot_sha256', 400)
    if not isinstance(payload['reason'], str) or not 1 <= len(payload['reason'].strip()) <= 1000:
        raise CommandError('lifecycle_reason_required', 400)
    if payload['confirmed'] is not True:
        raise CommandError('explicit_lifecycle_confirmation_required', 400)
    return {**payload, 'request_id': request_id, 'reason': payload['reason'].strip()}


@transaction.atomic
def execute_lifecycle_command(user, event_id, payload):
    command = normalize(payload)
    fingerprint = hashlib.sha256(json.dumps({'operation': 'event_lifecycle', 'conference_id': event_id, **command}, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    previous = MovementReceipt.objects.filter(actor=user, request_id=command['request_id']).first()
    if previous:
        if previous.payload_hash != fingerprint:
            raise CommandError('request_id_reused')
        return {**previous.result, 'replayed': True}
    role = get_business_role(user)
    if role not in (ADMIN_ROLES if command['action'] == 'reopen' else WAREHOUSE_ROLES):
        raise CommandError('not_authorized', 403)
    receipt, created = MovementReceipt.objects.get_or_create(actor=user, request_id=command['request_id'], defaults={'payload_hash': fingerprint})
    if not created:
        if receipt.payload_hash != fingerprint:
            raise CommandError('request_id_reused')
        return {**receipt.result, 'replayed': True}
    ids = referenced_asset_ids(event_id)
    list(Asset.objects.select_for_update().filter(pk__in=ids).order_by('pk'))
    event = Conference.objects.select_for_update().filter(pk=event_id).first()
    if not event:
        raise CommandError('unknown_conference', 404)
    if event.revision != command['expected_revision']:
        raise CommandError('event_changed')
    review = build_review(event)
    if review['snapshot_sha256'] != command['expected_snapshot_sha256']:
        raise CommandError('lifecycle_evidence_changed')
    before, action = event.lifecycle_state, command['action']
    if event.is_audit:
        raise CommandError('audit_lifecycle_requires_reviewed_conversion')
    if action == 'complete' and before != 'open' or action == 'archive' and before != 'completed' or action == 'reopen' and before == 'open':
        raise CommandError('invalid_lifecycle_transition')
    if action != 'reopen' and review['blockers']:
        raise CommandError('lifecycle_blocked', details=review['blockers'])
    from django.utils import timezone
    if action == 'complete':
        event.lifecycle_state = 'completed'; event.completed_at = timezone.now(); event.completed_by = user
    elif action == 'archive':
        event.lifecycle_state = 'archived'; event.archived_at = timezone.now(); event.archived_by = user
    else:
        event.lifecycle_state = 'open'; event.completed_at = event.completed_by = event.archived_at = event.archived_by = None
    event.save(update_fields=['lifecycle_state', 'completed_at', 'completed_by', 'archived_at', 'archived_by'])
    history = EventLifecycleHistory.objects.create(conference=event, actor=user, receipt=receipt, action=action,
        before_state=before, after_state=event.lifecycle_state, reason=command['reason'],
        evidence_sha256=review['snapshot_sha256'], snapshot=review)
    result = {'operation': 'event_lifecycle', 'request_id': command['request_id'], 'action': action,
              'history': history_data(history), 'conference': canonical_conference(event), 'replayed': False}
    receipt.result = result; receipt.save(update_fields=['result'])
    return result


@api_view(['GET'])
@permission_classes([IsAuthenticated])
@transaction.atomic
def lifecycle_review(request, pk):
    if connection.vendor == 'postgresql':
        with connection.cursor() as cursor:
            cursor.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    role = get_business_role(request.user)
    if role not in WAREHOUSE_ROLES:
        return Response({'error': 'warehouse_review_role_required'}, status=403)
    return Response(build_review(get_object_or_404(Conference, pk=pk)))


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def lifecycle_commands(request, pk):
    try:
        return Response(execute_lifecycle_command(request.user, pk, request.data))
    except CommandError as error:
        return Response({'error': error.code, 'conflicts': error.details}, status=error.status)
