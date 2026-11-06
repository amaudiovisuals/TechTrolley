"""Reviewed, bounded repairs. No automatic quantity/import/health inference.

Preview is pure. Apply is separately enabled for an identified migrated database.
All dependencies are locked asset-first then event-first in sorted ID order.
"""
import hashlib
import json
import re
import uuid
import sys
import django
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from django.conf import settings
from django.db import connection, transaction
from django.db.models import F, Q
from django.db.migrations.recorder import MigrationRecorder
from django.shortcuts import get_object_or_404
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from .asset_commands import CommandError, canonical_conference
from .models import (Asset, Conference, MovementReceipt, ReconciliationHistory,
    ReconciliationTarget, PreservedAuditObservation, PhysicalMovement, ChallanLine,
    SubrentalTicketItem)
from .custody import asset_fields, custody_state, review_assets
from .custody_policy import derive_status, RESTRICTED_STATUSES
from .event_lifecycle import referenced_asset_ids, require_open_event
from .permissions import ADMIN_ROLES, WAREHOUSE_ROLES, get_business_role

PROTOCOL = 'reviewed-reconciliation-1'
_SOURCE_FILES = ['reconciliation_commands.py','models.py','custody.py','custody_policy.py',
                 'asset_commands.py','event_lifecycle.py','revisions.py','serializers.py','inventory_ownership.py','quantity_commands.py','consumable_commands.py','challan_documents.py','truck_manifests.py','supplier_commands.py','ownership_commands.py','supplier_balances.py','views.py','subrental_views.py']
RUNTIME_SOURCE_SHA256 = hashlib.sha256(b''.join((Path(__file__).parent/name).read_bytes() for name in _SOURCE_FILES) + repr((sys.version_info[:3], django.VERSION)).encode()).hexdigest()
PHASES = ('assets','crosscheck_assets','staged_assets','requirements')


def canonical(value):
    return json.loads(json.dumps(value, sort_keys=True, default=str))


def digest(value):
    return hashlib.sha256(json.dumps(canonical(value), sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def database_identity():
    name = str(connection.settings_dict['NAME'])
    if connection.vendor == 'postgresql':
        with connection.cursor() as cursor:
            cursor.execute('SELECT current_database()'); name = cursor.fetchone()[0]
    migrations = sorted(MigrationRecorder(connection).applied_migrations())
    return {'vendor':connection.vendor,'name':name,
            'instance_id':getattr(settings,'RECONCILIATION_INSTANCE_ID',''),
            'schema_sha256':digest(migrations),'protocol':PROTOCOL,'runtime_source_sha256':RUNTIME_SOURCE_SHA256}


def write_gate(identity):
    if getattr(settings,'REVIEWED_RECONCILIATION_WRITES_ENABLED',False) is not True:
        return 'reviewed_writes_disabled'
    if not isinstance(identity['instance_id'],str) or not identity['instance_id'].strip() or len(identity['instance_id'])>128:
        return 'database_identity_not_configured'
    if identity['vendor'] == 'postgresql':
        return None
    name=identity['name']; memory=name==':memory:' or name.startswith('file:memorydb_') and parse_qs(urlparse(name).query).get('mode')==['memory']
    return None if identity['vendor']=='sqlite' and memory else 'business_sqlite_repairs_refused'


def ids(value):
    if not isinstance(value,list) or len(value)>100 or any(type(v) is not int or v<=0 for v in value) or len(value)!=len(set(value)):
        raise CommandError('invalid_reconciliation_targets',400)
    return sorted(value)


def normalize_target(payload):
    if not isinstance(payload,dict) or not isinstance(payload.get('action'),str):
        raise CommandError('invalid_reconciliation_target',400)
    action=payload['action']
    extras={'repair_status':set(),'legacy_return':set(),'audit_mode':{'target_is_audit'},'inverse':{'original_id'}}
    if action not in extras or set(payload)!= {'action','asset_ids','conference_ids'}|extras[action]:
        raise CommandError('invalid_reconciliation_target',400)
    target={'action':action,'asset_ids':ids(payload['asset_ids']),'conference_ids':ids(payload['conference_ids'])}
    if action=='repair_status' and (not target['asset_ids'] or target['conference_ids']):
        raise CommandError('status_repair_requires_selected_assets',400)
    if action=='legacy_return' and (not target['asset_ids'] or len(target['conference_ids'])!=1):
        raise CommandError('legacy_return_requires_one_source_event',400)
    if action=='audit_mode':
        if target['asset_ids'] or len(target['conference_ids'])!=1 or type(payload['target_is_audit']) is not bool:
            raise CommandError('audit_conversion_requires_one_event',400)
        target['target_is_audit']=payload['target_is_audit']
    if action=='inverse':
        if target['asset_ids'] or target['conference_ids']:
            raise CommandError('inverse_targets_come_from_history',400)
        try:target['original_id']=str(uuid.UUID(str(payload['original_id'])))
        except (ValueError,TypeError,AttributeError):raise CommandError('invalid_original_operation',400)
    return target


def resolve_roots(target):
    assets=set(target['asset_ids']);events=set(target['conference_ids'])
    original=None
    if target['action']=='inverse':
        original=ReconciliationHistory.objects.filter(pk=target['original_id']).first()
        if original is None:raise CommandError('unknown_reconciliation_history',404)
        assets.update(original.after_snapshot['asset_ids']);events.update(original.after_snapshot['event_ids'])
    for event_id in list(events):
        if not Conference.objects.filter(pk=event_id).exists():raise CommandError('unknown_conference',404)
        if target['action'] != 'inverse':
            assets.update(referenced_asset_ids(event_id))
    if Asset.objects.filter(pk__in=assets).count()!=len(assets):raise CommandError('unknown_assets',400)
    if len(assets)>500:raise CommandError('review_too_large_requires_batch_plan',400)
    return sorted(assets),sorted(events),original


def related_events(asset_ids):
    if not asset_ids:return set()
    result=set(Conference.objects.filter(Q(assets__in=asset_ids)|Q(crosscheck_assets__in=asset_ids)|Q(staged_assets__in=asset_ids)|Q(requirements__in=asset_ids)|Q(challan_assets__in=asset_ids)|Q(truck_challans__assets__in=asset_ids)).values_list('pk',flat=True))
    for name in ('quantity_allocations','consumable_allocations','physical_movements','preserved_audit_observations'):
        result.update(Conference.objects.filter(**{name+'__asset_id__in':asset_ids}).values_list('pk',flat=True))
    result.update(ChallanLine.objects.filter(asset_id__in=asset_ids).values_list('document__conference_id',flat=True))
    result.update(SubrentalTicketItem.objects.filter(asset_id__in=asset_ids).values_list('ticket__conference_id',flat=True))
    return result


def dependency_snapshot(asset_ids,event_ids):
    events=sorted(set(event_ids)|related_events(asset_ids)); rows=[]
    for asset in Asset.objects.filter(pk__in=asset_ids).order_by('pk'):
        rows.append({'asset':canonical({**asset_fields(asset),'custody_revision':asset.custody_revision,'ownership_revision':asset.ownership_revision,
            'parent_asset_id':asset.parent_asset_id,'children':list(asset.sub_assets.order_by('pk').values_list('pk',flat=True)),
            'is_temporary':asset.is_temporary,'supplier_id':asset.subrental_company_id,'sku':asset.sku,'alias_name':asset.alias_name,'serial_number':asset.serial_number,'barcode':asset.barcode,'qr_code':asset.qr_code}),
            'custody':custody_state(asset),
            'inventory_owner':{'id':asset.subrental_company_id,'name':asset.subrental_company.name,'inventory_mode':asset.subrental_company.inventory_mode} if asset.subrental_company_id else None,
            'quantity_allocations':canonical(list(asset.quantity_allocations.order_by('pk').values())),
            'consumable_allocations':canonical(list(asset.consumable_allocations.order_by('pk').values())),
            'staff_history':canonical(list(asset.staff_allocations.order_by('pk').values())),
            'physical_movements':canonical(list(asset.physical_movements.order_by('pk').values())),
            'observations':canonical(list(asset.preserved_audit_observations.order_by('pk').values()))})
    event_rows=[]
    for event in Conference.objects.filter(pk__in=events).order_by('pk'):
        record=canonical(Conference.objects.filter(pk=event.pk).values().get())
        record['memberships']={field:sorted(getattr(event,field).values_list('pk',flat=True)) for field in (*PHASES,'challan_assets','assigned_employees')}
        record['quantity_allocations']=canonical(list(event.quantity_allocations.order_by('pk').values()))
        record['consumable_allocations']=canonical(list(event.consumable_allocations.order_by('pk').values()))
        record['documents']=canonical(list(event.challan_documents.order_by('pk').values()))
        record['lines']=canonical(list(ChallanLine.objects.filter(document__conference=event).order_by('pk').values()))
        record['trucks']=canonical(list(event.truck_challans.order_by('pk').values()))
        record['tickets']=canonical(list(event.subrental_tickets.order_by('pk').values()))
        record['ticket_items']=canonical(list(SubrentalTicketItem.objects.filter(ticket__conference=event).order_by('pk').values()))
        from .models import SupplierBalance, SupplierMovement
        record['supplier_balances']=canonical(list(SupplierBalance.objects.filter(item__ticket__conference=event).order_by('pk').values()))
        record['supplier_movements']=canonical(list(SupplierMovement.objects.filter(balance__item__ticket__conference=event).order_by('pk').values()))
        event_rows.append(record)
    return {'format':1,'asset_ids':sorted(asset_ids),'event_ids':events,'assets':rows,'events':event_rows}


def healthy_unit(asset):
    return not (asset.flag or asset.condition=='Damaged' or asset.status in RESTRICTED_STATUSES or
                asset.quantity!=1 or asset.quantity_tracking or asset.type=='Consumables' or
                asset.parent_asset_id or asset.sub_assets.exists() or asset.is_temporary or asset.quantity_allocations.exists() or asset.consumable_allocations.exists())


def plan_for(target,snapshot,original):
    action=target['action'];changes=[];blockers=[]
    def block(reason,**refs):blockers.append({'reason':reason,**refs})
    if action in {'repair_status','legacy_return'}:
        source=Conference.objects.get(pk=target['conference_ids'][0]) if action=='legacy_return' else None
        if source and (source.is_audit or source.lifecycle_state!='open'):block('legacy_return_requires_open_real_event')
        for asset in Asset.objects.filter(pk__in=target['asset_ids']).order_by('pk'):
            state=custody_state(asset);expected=derive_status(asset_fields(asset),state)
            if not healthy_unit(asset):block('restricted_or_unsupported_item',asset_id=asset.pk)
            errors=review_assets([asset.pk])[0]['blockers']
            for error in errors:
                if error!='physical_custody_confirmation_required':block(error,asset_id=asset.pk)
            custody='event' if state['active_event_ids'] else 'crosscheck' if state['unchecked_event_ids'] else 'staff' if asset.assigned_to_id or state['staff_issue_employee_ids'] else 'warehouse'
            if action=='repair_status':
                if asset.status==expected:block('status_already_matches',asset_id=asset.pk)
                if expected=='Available' and state['staged_event_ids']:block('packing_requires_review',asset_id=asset.pk)
                changes.append({'asset_id':asset.pk,'label':asset.alias_name or asset.sku,'before_status':asset.status,'after_status':expected,'identity':{'sku':asset.sku,'serial_number':asset.serial_number,'barcode':asset.barcode,'qr_code':asset.qr_code},'required_custody_confirmation':custody})
            else:
                if state['active_event_ids'] or state['unchecked_event_ids'] or state['staged_event_ids'] or asset.assigned_to_id or state['staff_issue_employee_ids']:
                    block('legacy_return_has_current_custody',asset_id=asset.pk)
                if expected!='Available':block('legacy_return_not_available_in_warehouse',asset_id=asset.pk)
                historical=source.challan_assets.filter(pk=asset.pk).exists() or source.truck_challans.filter(assets=asset).exists()
                if not historical:block('legacy_return_requires_preserved_source',asset_id=asset.pk)
                if source.subrental_tickets.filter(items__asset=asset).exists():block('supplier_return_requires_separate_workflow',asset_id=asset.pk)
                last=source.physical_movements.filter(asset=asset).order_by('pk').last()
                if last and last.action!='legacy_return_review_revoked':block('use_recorded_physical_return_workflow',asset_id=asset.pk)
                changes.append({'asset_id':asset.pk,'label':asset.alias_name or asset.sku,'before_status':asset.status,'after_status':'Available','identity':{'sku':asset.sku,'serial_number':asset.serial_number,'barcode':asset.barcode,'qr_code':asset.qr_code},'required_custody_confirmation':'warehouse','record':'legacy_return_review','original_dispatch_at':None,'original_return_at':None})
    elif action=='audit_mode':
        event=Conference.objects.get(pk=target['conference_ids'][0]);desired=target['target_is_audit']
        if event.lifecycle_state!='open':block('event_is_sealed')
        if desired==event.is_audit:block('audit_mode_already_matches')
        if desired:
            for field in PHASES:
                if getattr(event,field).exists():block('operational_queue_prevents_audit_conversion',phase=field)
        if event.quantity_allocations.filter(Q(reserved__gt=0)|Q(dispatched__gt=0)|Q(awaiting_verification__gt=0)).exists():block('outstanding_bulk_prevents_conversion')
        if event.consumable_allocations.exclude(state='settled').filter(requested__gt=0).exists():block('outstanding_consumables_prevent_conversion')
        data=event.consumable_data
        known={str(v) for v in event.consumable_allocations.values_list('asset_id',flat=True)}
        if not isinstance(data,dict) and data or isinstance(data,dict) and any(str(k) not in known and bool(v) for k,v in data.items()):block('legacy_consumables_require_review')
        latest={row.asset_id:row.action for row in event.physical_movements.order_by('pk')}
        if any(action not in {'verify_return','transfer_out','legacy_return_review'} for action in latest.values()):block('unresolved_physical_history_prevents_conversion')
        changes.append({'conference_id':event.pk,'before_is_audit':event.is_audit,'after_is_audit':desired,
            'preserve_observations':{field:sorted(getattr(event,field).values_list('pk',flat=True)) for field in PHASES} if event.is_audit and not desired else {},
            'new_allocations':0,'history_and_documents':'retained','inventory_statuses':'unchanged'})
    else:
        if original.action=='inverse':block('inverse_of_inverse_requires_new_review')
        if ReconciliationHistory.objects.filter(reverses=original).exists():block('operation_already_reversed')
        if digest(snapshot)!=original.after_sha256:block('later_activity_prevents_inverse')
        changes.append({'original_id':str(original.pk),'original_action':original.action,'restore_effects':original.effects,'history':'append_only','restore_old_revisions':False})
    return {'changes':changes,'blockers':blockers}


def prepare_preview(payload):
    target=normalize_target(payload);assets,events,original=resolve_roots(target)
    snapshot=dependency_snapshot(assets,events);identity=database_identity();plan=plan_for(target,snapshot,original)
    return {'mode':'reviewed_reconciliation_preview','target':target,'database':identity,
            'snapshot_sha256':digest(snapshot),'plan':plan,'write_gate':write_gate(identity),
            'can_apply':not plan['blockers'] and write_gate(identity) is None},snapshot,original


def normalize_command(payload):
    fields={'request_id','target','database','expected_snapshot_sha256','reason','evidence_reference','confirmed','custody_confirmations'}
    if not isinstance(payload,dict) or set(payload)!=fields:raise CommandError('invalid_reconciliation_command',400)
    try:request_id=str(uuid.UUID(str(payload['request_id'])))
    except (ValueError,TypeError,AttributeError):raise CommandError('invalid_request_id',400)
    target=normalize_target(payload['target'])
    if not isinstance(payload['database'],dict):raise CommandError('invalid_database_identity',400)
    if not isinstance(payload['expected_snapshot_sha256'],str) or not re.fullmatch('[a-f0-9]{64}',payload['expected_snapshot_sha256']):raise CommandError('invalid_snapshot_sha256',400)
    for field in ('reason','evidence_reference'):
        if not isinstance(payload[field],str) or not 1<=len(payload[field].strip())<=1000:raise CommandError('review_reason_and_evidence_required',400)
    if payload['confirmed'] is not True:raise CommandError('explicit_review_confirmation_required',400)
    confirms=payload['custody_confirmations']
    if not isinstance(confirms,dict) or any(not str(k).isdigit() or v not in ('warehouse','event','crosscheck','staff') for k,v in confirms.items()):raise CommandError('invalid_custody_confirmations',400)
    return {**payload,'target':target,'request_id':request_id,'reason':payload['reason'].strip(),'evidence_reference':payload['evidence_reference'].strip()}


def history_data(row):
    return {'id':str(row.pk),'action':row.action,'operator_id':row.actor_id,'reason':row.reason,
            'evidence_reference':row.evidence_reference,'recorded_at':row.created_at.isoformat(),
            'before_sha256':row.before_sha256,'after_sha256':row.after_sha256,
            'reverses':str(row.reverses_id) if row.reverses_id else None}


@transaction.atomic
def execute_reconciliation(user,payload):
    command=normalize_command(payload);fingerprint=digest({'operation':'reviewed_reconciliation',**command})
    previous=MovementReceipt.objects.filter(actor=user,request_id=command['request_id']).first()
    if previous:
        if previous.payload_hash!=fingerprint:raise CommandError('request_id_reused')
        return {**previous.result,'replayed':True}
    if get_business_role(user) not in ADMIN_ROLES:raise CommandError('administrator_review_required',403)
    identity=database_identity()
    if command['database']!=identity:raise CommandError('database_or_runtime_identity_changed')
    gate=write_gate(identity)
    if gate:raise CommandError(gate,403)
    receipt,created=MovementReceipt.objects.get_or_create(actor=user,request_id=command['request_id'],defaults={'payload_hash':fingerprint})
    if not created:
        if receipt.payload_hash!=fingerprint:raise CommandError('request_id_reused')
        return {**receipt.result,'replayed':True}
    target=command['target'];asset_ids,event_ids,original=resolve_roots(target)
    list(Asset.objects.select_for_update().filter(pk__in=asset_ids).order_by('pk'))
    event_ids=sorted(set(event_ids)|related_events(asset_ids))
    list(Conference.objects.select_for_update().filter(pk__in=event_ids).order_by('pk'))
    if any(not referenced_asset_ids(eid)<=set(asset_ids) for eid in target['conference_ids']):raise CommandError('reconciliation_dependencies_changed')
    before=dependency_snapshot(asset_ids,event_ids)
    if digest(before)!=command['expected_snapshot_sha256']:raise CommandError('reconciliation_evidence_changed')
    plan=plan_for(target,before,original)
    if plan['blockers']:raise CommandError('reconciliation_blocked',details=plan['blockers'])
    required={str(change['asset_id']):change['required_custody_confirmation'] for change in plan['changes'] if 'required_custody_confirmation' in change}
    if command['custody_confirmations']!=required:raise CommandError('physical_custody_confirmation_required',400)
    history=ReconciliationHistory.objects.create(actor=user,receipt=receipt,action=target['action'],reason=command['reason'],
        evidence_reference=command['evidence_reference'],database_identity=identity,before_snapshot=before,
        before_sha256=digest(before),reverses=original if target['action']=='inverse' else None)
    for aid in asset_ids:ReconciliationTarget.objects.create(history=history,asset_id=aid)
    for eid in event_ids:ReconciliationTarget.objects.create(history=history,conference_id=eid)
    effects={'statuses':[],'mode':None,'legacy_movements':[]}
    if target['action'] in {'repair_status','legacy_return'}:
        for change in plan['changes']:
            aid=change['asset_id'];effects['statuses'].append({'asset_id':aid,'before':change['before_status'],'after':change['after_status']})
            Asset.objects.filter(pk=aid).update(status=change['after_status'],custody_revision=F('custody_revision')+1)
            if target['action']=='legacy_return':
                event=Conference.objects.get(pk=target['conference_ids'][0])
                row=PhysicalMovement.objects.create(asset_id=aid,conference=event,receipt=receipt,action='legacy_return_review',snapshot={
                    'provenance':'reviewed_legacy_return','original_dispatch_at':None,'original_return_at':None,
                    'reason':command['reason'],'evidence_reference':command['evidence_reference'],'review_history_id':str(history.pk)})
                effects['legacy_movements'].append({'id':row.pk,'asset_id':aid,'conference_id':event.pk})
        if target['action']=='legacy_return':event.save(update_fields=['revision'])
    elif target['action']=='audit_mode':
        event=Conference.objects.get(pk=target['conference_ids'][0]);require_open_event(event)
        mode={'conference_id':event.pk,'before':event.is_audit,'after':target['target_is_audit'],
              'memberships':{field:sorted(getattr(event,field).values_list('pk',flat=True)) for field in PHASES}}
        effects['mode']=mode
        if event.is_audit:
            for field,values in mode['memberships'].items():
                for aid in values:
                    asset=Asset.objects.get(pk=aid)
                    PreservedAuditObservation.objects.create(conference=event,asset=asset,history=history,phase=field,snapshot={
                        'asset_id':aid,'sku':asset.sku,'label':asset.alias_name,'source':'legacy_audit_observation','original_observed_at':None})
                getattr(event,field).clear()
        event.is_audit=target['target_is_audit'];event.save(update_fields=['is_audit'])
    else:
        effects['inverse_of']=str(original.pk)
        for change in original.effects['statuses']:
            Asset.objects.filter(pk=change['asset_id']).update(status=change['before'],custody_revision=F('custody_revision')+1)
        mode=original.effects['mode']
        if mode:
            event=Conference.objects.get(pk=mode['conference_id']);event.is_audit=mode['before'];event.save(update_fields=['is_audit'])
            if mode['before']:
                for field,values in mode['memberships'].items():getattr(event,field).set(values)
        for movement in original.effects['legacy_movements']:
            PhysicalMovement.objects.create(asset_id=movement['asset_id'],conference_id=movement['conference_id'],receipt=receipt,action='legacy_return_review_revoked',snapshot={'revoked_movement_id':movement['id'],'review_history_id':str(history.pk),'reason':command['reason'],'evidence_reference':command['evidence_reference']})
        if original.effects['legacy_movements']:
            event=Conference.objects.get(pk=original.effects['legacy_movements'][0]['conference_id']);event.save(update_fields=['revision'])
    after=dependency_snapshot(asset_ids,event_ids);history.effects=effects;history.after_snapshot=after;history.after_sha256=digest(after)
    history.save(update_fields=['effects','after_snapshot','after_sha256'])
    from .serializers import AssetSerializer
    result={'operation':'reviewed_reconciliation','request_id':command['request_id'],'history':history_data(history),
        'asset_states':AssetSerializer(Asset.objects.filter(pk__in=asset_ids).order_by('pk'),many=True).data,
        'conferences':[canonical_conference(event) for event in Conference.objects.filter(pk__in=event_ids).order_by('pk')],
        'replayed':False}
    receipt.result=result;receipt.save(update_fields=['result']);return result


def read_snapshot():
    if connection.vendor=='postgresql':
        with connection.cursor() as cursor:cursor.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@transaction.atomic
def reconciliation_preview(request):
    read_snapshot()
    if get_business_role(request.user) not in WAREHOUSE_ROLES:return Response({'error':'warehouse_review_role_required'},status=403)
    try:return Response(prepare_preview(request.data)[0])
    except CommandError as error:return Response({'error':error.code,'blockers':error.details},status=error.status)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def reconciliation_commands(request):
    try:return Response(execute_reconciliation(request.user,request.data))
    except CommandError as error:return Response({'error':error.code,'blockers':error.details},status=error.status)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
@transaction.atomic
def event_reconciliation_review(request,pk):
    read_snapshot()
    if get_business_role(request.user) not in WAREHOUSE_ROLES:return Response({'error':'warehouse_review_role_required'},status=403)
    event=get_object_or_404(Conference,pk=pk);identity=database_identity();asset_ids=referenced_asset_ids(pk)
    histories=ReconciliationHistory.objects.filter(targets__conference=event).distinct().order_by('-created_at')
    return Response({'mode':'reconciliation_discovery','conference_id':pk,'name':event.name,'is_audit':event.is_audit,
        'database':identity,'write_gate':write_gate(identity),'rows':review_assets(asset_ids),
        'preserved_observations':canonical(list(event.preserved_audit_observations.order_by('pk').values())),
        'history':[history_data(row) for row in histories],
        'limitations':['No guessed quantities, deductions, return dates or original printed values.','Conversion preserves observations; it creates no live allocation.','Fresh production writes stay disabled until an identified, tested release.']})


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@transaction.atomic
def reconciliation_current_state(request):
    """Same authenticated read authority as existing asset/event GETs; recovery can
    read current projections after a role downgrade without granting new writes."""
    read_snapshot()
    try:
        if not isinstance(request.data,dict) or set(request.data)!={'asset_ids','conference_ids'}:raise CommandError('invalid_current_projection',400)
        asset_ids=request.data['asset_ids'];event_ids=request.data['conference_ids']
        if not isinstance(asset_ids,list) or len(asset_ids)>500 or any(type(v)is not int or v<=0 for v in asset_ids) or len(set(asset_ids))!=len(asset_ids):raise CommandError('invalid_current_projection',400)
        event_ids=ids(event_ids)
        assets=Asset.objects.filter(pk__in=asset_ids).order_by('pk');events=Conference.objects.filter(pk__in=event_ids).order_by('pk')
        if assets.count()!=len(asset_ids) or events.count()!=len(event_ids):raise CommandError('current_projection_missing_records',409)
        from .serializers import AssetSerializer,ConferenceSerializer
        return Response({'operation':'reconciliation_current_state','asset_states':AssetSerializer(assets,many=True).data,'conferences':ConferenceSerializer(events,many=True).data})
    except CommandError as error:return Response({'error':error.code},status=error.status)
