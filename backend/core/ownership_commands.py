"""Reviewed owner metadata changes; never clone stock or alter physical custody.

Pure preview, independent disabled-by-default gate, exact actor receipts and a
bounded inverse. Asset locks precede event, company and issuer locks.
"""
import hashlib
import re
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from django.conf import settings
from django.db import connection, transaction
from django.db.models import F, Q
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .asset_commands import CommandError
from .custody import custody_state
from .models import (Asset, CompanySettings, Conference, MovementReceipt,
                     OwnershipHistory, OwnershipTarget, SubrentalCompany)
from .permissions import ADMIN_ROLES, WAREHOUSE_ROLES, get_business_role
from .reconciliation_commands import (canonical, database_identity, dependency_snapshot,
                                      digest, read_snapshot, related_events)

PROTOCOL = 'reviewed-ownership-1'
SOURCE_SHA256 = hashlib.sha256(b''.join((Path(__file__).parent / name).read_bytes()
    for name in ('ownership_commands.py', 'inventory_ownership.py', 'models.py',
                 'views.py', 'serializers.py', 'subrental_views.py', 'staff_commands.py',
                 'permissions.py', 'migrations/0064_reviewed_inventory_ownership.py'))).hexdigest()
MODES = {'unreviewed', 'shared_warehouse', 'external_supplier'}


def identity():
    base = database_identity()
    return {**base, 'protocol': PROTOCOL,
            'instance_id': getattr(settings, 'OWNERSHIP_INSTANCE_ID', ''),
            'runtime_source_sha256': digest([base['runtime_source_sha256'], SOURCE_SHA256])}


def write_gate(database):
    if getattr(settings, 'REVIEWED_OWNERSHIP_WRITES_ENABLED', False) is not True:
        return 'ownership_writes_disabled'
    instance = database['instance_id']
    if not isinstance(instance, str) or not 1 <= len(instance.strip()) <= 128:
        return 'ownership_database_identity_required'
    if database['vendor'] == 'postgresql':
        return None
    return None if database['vendor'] == 'sqlite' and memory_database(database['name']) else 'business_sqlite_ownership_refused'


def memory_database(name):
    return name == ':memory:' or name.startswith('file:memorydb_') and parse_qs(urlparse(name).query).get('mode') == ['memory']


def identifiers(value, maximum=100):
    if not isinstance(value, list) or len(value) > maximum or any(type(v) is not int or v <= 0 for v in value) or len(set(value)) != len(value):
        raise CommandError('invalid_ownership_selection', 400)
    return sorted(value)


def owner_id(value, nullable=True):
    if value is None and nullable:
        return None
    if type(value) is not int or value <= 0:
        raise CommandError('invalid_ownership_company', 400)
    return value


def normalize_target(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get('action'), str):
        raise CommandError('invalid_ownership_target', 400)
    action = payload['action']
    fields = {'classify_company': {'action', 'company_id', 'inventory_mode'},
              'change_owner': {'action', 'asset_ids', 'source_owner_id', 'target_owner_id'},
              'inverse': {'action', 'original_id'}}
    if action not in fields or set(payload) != fields[action]:
        raise CommandError('invalid_ownership_target', 400)
    if action == 'classify_company':
        if not isinstance(payload['inventory_mode'], str) or payload['inventory_mode'] not in MODES:
            raise CommandError('invalid_inventory_classification', 400)
        return {**payload, 'company_id': owner_id(payload['company_id'], False)}
    if action == 'change_owner':
        selected = identifiers(payload['asset_ids'])
        if not selected:
            raise CommandError('select_original_asset_ids', 400)
        return {**payload, 'asset_ids': selected, 'source_owner_id': owner_id(payload['source_owner_id']),
                'target_owner_id': owner_id(payload['target_owner_id'])}
    try:
        original_id = str(uuid.UUID(str(payload['original_id'])))
    except (ValueError, TypeError, AttributeError):
        raise CommandError('invalid_original_ownership_operation', 400)
    return {'action': action, 'original_id': original_id}


def roots(target):
    original = None
    companies = set()
    if target['action'] == 'inverse':
        original = OwnershipHistory.objects.filter(pk=target['original_id']).first()
        if original is None:
            raise CommandError('unknown_ownership_history', 404)
        return original.after_snapshot['asset_ids'], original.after_snapshot['company_ids'], original
    if target['action'] == 'classify_company':
        companies.add(target['company_id'])
        selected = set(Asset.objects.filter(subrental_company_id=target['company_id']).values_list('pk', flat=True))
    else:
        companies.update(v for v in (target['source_owner_id'], target['target_owner_id']) if v is not None)
        selected = set(target['asset_ids'])
    # Lock and review the complete connected kit; only explicitly selected rows
    # may be changed. Never automatically move an unselected child or parent.
    while True:
        if len(selected) > 500:
            raise CommandError('ownership_review_requires_smaller_plan', 400)
        parents = set(Asset.objects.filter(pk__in=selected).exclude(parent_asset=None).values_list('parent_asset_id', flat=True))
        children = set(Asset.objects.filter(parent_asset_id__in=selected).values_list('pk', flat=True))
        expanded = selected | parents | children
        if expanded == selected:
            break
        selected = expanded
    if Asset.objects.filter(pk__in=selected).count() != len(selected):
        raise CommandError('unknown_ownership_assets', 404)
    companies.update(Asset.objects.filter(pk__in=selected).exclude(subrental_company=None).values_list('subrental_company_id', flat=True))
    if SubrentalCompany.objects.filter(pk__in=companies).count() != len(companies):
        raise CommandError('unknown_ownership_company', 404)
    return sorted(selected), sorted(companies), original


def snapshot(asset_ids, company_ids):
    dependencies = dependency_snapshot(asset_ids, [])
    return {**dependencies, 'ownership_format': 1, 'company_ids': company_ids,
            'inventory_records': canonical(list(Asset.objects.filter(pk__in=asset_ids).order_by('pk').values())),
            'companies': [{**canonical(row), 'inventory_ids': list(Asset.objects.filter(subrental_company_id=row['id']).order_by('pk').values_list('pk', flat=True))}
                          for row in SubrentalCompany.objects.filter(pk__in=company_ids).order_by('pk').values()],
            'issuer': canonical(list(CompanySettings.objects.order_by('pk').values()))}


def item_blockers(asset):
    reasons = []
    state = custody_state(asset)
    if asset.is_temporary:
        reasons.append('temporary_rental_is_not_permanent_stock')
    if asset.status != 'Available' or asset.flag or asset.condition == 'Damaged':
        reasons.append('health_or_unproved_status_requires_review')
    if any(state[key] for key in ('active_event_ids', 'unchecked_event_ids', 'staged_event_ids', 'audit_event_ids', 'held_quantity', 'legacy_quantity_unknown', 'staff_issue_employee_ids')) or asset.assigned_to_id:
        reasons.append('current_custody_or_quantity_requires_closure')
    if asset.requirement_conferences.exists():
        reasons.append('planned_event_requires_review')
    if asset.ticket_items.exists():
        reasons.append('supplier_obligation_requires_separate_review')
    seen, node = {asset.pk}, asset
    while node.parent_asset_id:
        if node.parent_asset_id in seen:
            reasons.append('kit_cycle_requires_review')
            break
        seen.add(node.parent_asset_id)
        node = node.parent_asset
    latest = {}
    for row in asset.physical_movements.order_by('pk'):
        latest[row.conference_id] = row.action
    if any(action not in {'verify_return', 'transfer_out', 'legacy_return_review'} for action in latest.values()):
        reasons.append('unresolved_movement_history')
    tokens = {str(getattr(asset, key) or '').strip() for key in ('sku', 'serial_number', 'barcode', 'qr_code')} - {''}
    for token in tokens:
        query = Q(sku__iexact=token) | Q(serial_number__iexact=token) | Q(barcode__iexact=token) | Q(qr_code__iexact=token)
        if Asset.objects.filter(query).exclude(pk=asset.pk).exists():
            reasons.append('ambiguous_inventory_identifier')
            break
    return reasons


def plan(target, before, original):
    changes, blockers, warehouse_ids = [], [], []
    def block(reason, **references):
        blockers.append({'reason': reason, **references})
    companies = {row['id']: row for row in before['companies']}
    if len(before['issuer']) != 1:
        block('one_reviewed_issuing_company_required')
    if target['action'] == 'inverse':
        if original.action == 'inverse':
            block('inverse_of_inverse_requires_new_plan')
        if OwnershipHistory.objects.filter(reverses=original).exists():
            block('ownership_operation_already_reversed')
        if original.database_identity != identity():
            block('original_database_or_runtime_changed')
        if digest(before) != original.after_sha256:
            block('later_activity_prevents_ownership_inverse')
        changes.append({'original_id': str(original.pk), 'restore_effects': original.effects, 'revisions': 'advance', 'history': 'preserve'})
        warehouse_ids = sorted(change['asset_id'] for change in original.effects['owners'])
    elif target['action'] == 'classify_company':
        company = companies[target['company_id']]
        if company['inventory_mode'] == target['inventory_mode']:
            block('classification_already_matches', company_id=company['id'])
        for asset in Asset.objects.filter(pk__in=before['asset_ids']).order_by('pk'):
            if asset.subrental_company_id != company['id']:
                block('kit_crosses_company_classifications', asset_id=asset.pk)
            if asset.is_temporary:
                continue  # Remains ticket-only; shared mode never makes it warehouse stock.
            for reason in item_blockers(asset):
                if reason == 'supplier_obligation_requires_separate_review' and target['inventory_mode'] == 'external_supplier':
                    continue  # Classification identifies a catalogue; it settles no order.
                block(reason, asset_id=asset.pk)
            if target['inventory_mode'] == 'shared_warehouse':
                warehouse_ids.append(asset.pk)
        changes.append({'company_id': company['id'], 'company_name': company['name'],
                        'before_mode': company['inventory_mode'], 'after_mode': target['inventory_mode'],
                        'permanent_asset_ids': warehouse_ids if target['inventory_mode'] == 'shared_warehouse' else [row['id'] for row in before['inventory_records'] if not row['is_temporary']],
                        'temporary_stock': 'unchanged, excluded from warehouse policy'})
    else:
        source, destination = target['source_owner_id'], target['target_owner_id']
        if source == destination:
            block('owner_already_matches')
        for cid in (source, destination):
            if cid is not None and companies[cid]['inventory_mode'] != 'shared_warehouse':
                block('ownership_transfer_requires_shared_godown_owner', company_id=cid)
        if set(target['asset_ids']) != set(before['asset_ids']):
            block('select_complete_kit', required_asset_ids=before['asset_ids'])
        for asset in Asset.objects.filter(pk__in=target['asset_ids']).order_by('pk'):
            if asset.subrental_company_id != source:
                block('selected_source_owner_changed', asset_id=asset.pk)
            for reason in item_blockers(asset):
                block(reason, asset_id=asset.pk)
            changes.append({'asset_id': asset.pk, 'sku': asset.sku, 'label': asset.alias_name,
                            'quantity': asset.quantity, 'before_owner_id': asset.subrental_company_id,
                            'after_owner_id': destination, 'preserved': ['id', 'identifiers', 'quantity', 'custody', 'kit', 'staff_history', 'event_history', 'saved_paperwork']})
        warehouse_ids = target['asset_ids']
    return {'changes': changes, 'blockers': blockers, 'warehouse_asset_ids': sorted(warehouse_ids),
            'confirmation': 'Review ownership documents/classification evidence and the selected physical stock; no returns or quantity corrections are inferred.'}


def prepare_preview(payload):
    target = normalize_target(payload)
    asset_ids, company_ids, original = roots(target)
    before = snapshot(asset_ids, company_ids)
    database = identity()
    result = plan(target, before, original)
    gate = write_gate(database)
    return {'mode': 'reviewed_ownership_preview', 'target': target, 'database': database,
            'snapshot_sha256': digest(before), 'plan': result, 'write_gate': gate,
            'can_apply': not result['blockers'] and gate is None}, before


def normalize_command(payload):
    fields = {'request_id', 'target', 'database', 'expected_snapshot_sha256', 'reason', 'evidence_reference', 'confirmed', 'warehouse_asset_ids'}
    if not isinstance(payload, dict) or set(payload) != fields:
        raise CommandError('invalid_ownership_command', 400)
    try:
        request_id = str(uuid.UUID(str(payload['request_id'])))
    except (ValueError, TypeError, AttributeError):
        raise CommandError('invalid_request_id', 400)
    if not isinstance(payload['database'], dict) or not isinstance(payload['expected_snapshot_sha256'], str) or not re.fullmatch('[a-f0-9]{64}', payload['expected_snapshot_sha256']):
        raise CommandError('ownership_identity_and_snapshot_required', 400)
    if payload['confirmed'] is not True:
        raise CommandError('explicit_ownership_confirmation_required', 400)
    for field in ('reason', 'evidence_reference'):
        if not isinstance(payload[field], str) or not 1 <= len(payload[field].strip()) <= 1000:
            raise CommandError('ownership_reason_and_evidence_required', 400)
    return {**payload, 'request_id': request_id, 'target': normalize_target(payload['target']),
            'reason': payload['reason'].strip(), 'evidence_reference': payload['evidence_reference'].strip(),
            'warehouse_asset_ids': identifiers(payload['warehouse_asset_ids'], 500)}


def history_data(row):
    return {'id': str(row.pk), 'action': row.action, 'operator_id': row.actor_id,
            'reason': row.reason, 'evidence_reference': row.evidence_reference,
            'recorded_at': row.created_at.isoformat(), 'before_sha256': row.before_sha256,
            'after_sha256': row.after_sha256, 'effects': row.effects,
            'reverses': str(row.reverses_id) if row.reverses_id else None}


@transaction.atomic
def execute_ownership(user, payload):
    command = normalize_command(payload)
    fingerprint = digest({'operation': 'reviewed_ownership', **command})
    previous = MovementReceipt.objects.filter(actor=user, request_id=command['request_id']).first()
    if previous:
        if previous.payload_hash != fingerprint:
            raise CommandError('request_id_reused')
        return {**previous.result, 'replayed': True}
    if get_business_role(user) not in ADMIN_ROLES:
        raise CommandError('administrator_ownership_review_required', 403)
    database = identity()
    if command['database'] != database:
        raise CommandError('ownership_database_or_runtime_changed')
    gate = write_gate(database)
    if gate:
        raise CommandError(gate, 403)
    receipt, created = MovementReceipt.objects.get_or_create(actor=user, request_id=command['request_id'], defaults={'payload_hash': fingerprint})
    if not created:
        if receipt.payload_hash != fingerprint:
            raise CommandError('request_id_reused')
        return {**receipt.result, 'replayed': True}
    target = command['target']
    asset_ids, company_ids, original = roots(target)
    list(Asset.objects.select_for_update().filter(pk__in=asset_ids).order_by('pk'))
    events = sorted(related_events(asset_ids))
    list(Conference.objects.select_for_update().filter(pk__in=events).order_by('pk'))
    list(SubrentalCompany.objects.select_for_update().filter(pk__in=company_ids).order_by('pk'))
    list(CompanySettings.objects.select_for_update().order_by('pk'))
    current_assets, current_companies, _ = roots(target)
    if (current_assets, current_companies) != (asset_ids, company_ids):
        raise CommandError('ownership_dependencies_changed')
    before = snapshot(asset_ids, company_ids)
    if digest(before) != command['expected_snapshot_sha256']:
        raise CommandError('ownership_evidence_changed')
    proposal = plan(target, before, original)
    if proposal['blockers']:
        raise CommandError('ownership_blocked', details=proposal['blockers'])
    if command['warehouse_asset_ids'] != proposal['warehouse_asset_ids']:
        raise CommandError('selected_warehouse_confirmation_required', 400)
    history = OwnershipHistory.objects.create(actor=user, receipt=receipt, action=target['action'],
        reason=command['reason'], evidence_reference=command['evidence_reference'], database_identity=database,
        before_snapshot=before, before_sha256=digest(before), reverses=original if target['action'] == 'inverse' else None)
    for aid in asset_ids:
        OwnershipTarget.objects.create(history=history, asset_id=aid)
    for cid in company_ids:
        OwnershipTarget.objects.create(history=history, company_id=cid)
    effects = {'owners': [], 'classification': None}
    if target['action'] == 'classify_company':
        company = SubrentalCompany.objects.get(pk=target['company_id'])
        effects['classification'] = {'company_id': company.pk, 'before': company.inventory_mode, 'after': target['inventory_mode']}
        SubrentalCompany.objects.filter(pk=company.pk).update(inventory_mode=target['inventory_mode'])
    elif target['action'] == 'change_owner':
        effects['owners'] = [{'asset_id': aid, 'before': target['source_owner_id'], 'after': target['target_owner_id']} for aid in target['asset_ids']]
        Asset.objects.filter(pk__in=target['asset_ids']).update(subrental_company_id=target['target_owner_id'])
    else:
        effects['inverse_of'] = str(original.pk)
        for change in original.effects['owners']:
            effects['owners'].append({'asset_id': change['asset_id'], 'before': change['after'], 'after': change['before']})
            Asset.objects.filter(pk=change['asset_id']).update(subrental_company_id=change['before'])
        classification = original.effects['classification']
        if classification:
            effects['classification'] = {'company_id': classification['company_id'], 'before': classification['after'], 'after': classification['before']}
            SubrentalCompany.objects.filter(pk=classification['company_id']).update(inventory_mode=classification['before'])
    # Advance dependency epochs; inverses never rewind a revision or delete proof.
    Asset.objects.filter(pk__in=asset_ids).update(ownership_revision=F('ownership_revision') + 1)
    SubrentalCompany.objects.filter(pk__in=company_ids).update(ownership_revision=F('ownership_revision') + 1)
    after = snapshot(asset_ids, company_ids)
    history.effects = effects
    history.after_snapshot = after
    history.after_sha256 = digest(after)
    history.save(update_fields=['effects', 'after_snapshot', 'after_sha256'])
    result = {'operation': 'reviewed_ownership', 'request_id': command['request_id'],
              'history': history_data(history), 'asset_ids': asset_ids, 'company_ids': company_ids, 'replayed': False}
    receipt.result = result  # Acknowledgement only; current projections need fresh reads.
    receipt.save(update_fields=['result'])
    return result


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@transaction.atomic
def ownership_preview(request):
    read_snapshot()
    if get_business_role(request.user) not in WAREHOUSE_ROLES:
        return Response({'error': 'warehouse_ownership_review_required'}, status=403)
    try:
        return Response(prepare_preview(request.data)[0])
    except CommandError as error:
        return Response({'error': error.code, 'blockers': error.details}, status=error.status)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def ownership_commands(request):
    try:
        return Response(execute_ownership(request.user, request.data))
    except CommandError as error:
        return Response({'error': error.code, 'blockers': error.details}, status=error.status)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
@transaction.atomic
def ownership_history(request, history_id):
    read_snapshot()
    if get_business_role(request.user) not in WAREHOUSE_ROLES:
        return Response({'error': 'warehouse_ownership_review_required'}, status=403)
    row = OwnershipHistory.objects.filter(pk=history_id).first()
    if row is None:
        return Response({'error': 'unknown_ownership_history'}, status=404)
    return Response({**history_data(row), 'database': row.database_identity,
                     'before_snapshot': row.before_snapshot, 'after_snapshot': row.after_snapshot})
