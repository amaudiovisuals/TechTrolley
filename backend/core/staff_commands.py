"""Recorded staff custody; never resolve a synthetic user ID as an employee FK."""
import hashlib
import json
import uuid
from django.db import transaction, IntegrityError
from django.db.models import Q
from django.contrib.auth.models import User
from django.utils import timezone
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from .models import Asset, Employee, Conference, MovementReceipt, StaffAllocation, EmployeeIdentityHistory
from .permissions import get_business_role, WAREHOUSE_ROLES, ADMIN_ROLES, assigned_employee_id
from .asset_commands import CommandError
from .custody import synchronize_statuses, RESTRICTED_STATUSES


def request_uuid(payload):
    try:
        return str(uuid.UUID(str(payload.get('request_id'))))
    except (TypeError, ValueError, AttributeError):
        raise CommandError('invalid_request_id', 400)


def require_reason(payload):
    reason = payload.get('reason')
    if not isinstance(reason, str) or not 1 <= len(reason.strip()) <= 1000:
        raise CommandError('reason_required', 400)
    return reason.strip()


def receipt_for(user, operation, command, roles):
    fingerprint = hashlib.sha256(json.dumps({'operation':operation, **command}, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    previous = MovementReceipt.objects.filter(actor=user, request_id=command['request_id']).first()
    if previous:
        if previous.payload_hash != fingerprint:
            raise CommandError('request_id_reused')
        return previous, {**previous.result, 'replayed':True}
    if get_business_role(user) not in roles:
        raise CommandError('not_authorized', 403)
    receipt, created = MovementReceipt.objects.get_or_create(actor=user, request_id=command['request_id'], defaults={'payload_hash':fingerprint})
    if not created:
        if receipt.payload_hash != fingerprint:
            raise CommandError('request_id_reused')
        return receipt, {**receipt.result, 'replayed':True}
    return receipt, None


def snapshot(asset, employee, user):
    return {'asset_id':asset.pk, 'sku':asset.sku, 'serial_number':asset.serial_number,
            'barcode':asset.barcode, 'alias_name':asset.alias_name,
            'supplier_id':asset.subrental_company_id, 'status':asset.status,
            'flag':asset.flag, 'condition':asset.condition,
            'employee_id':employee.pk, 'employee_code':employee.employee_id,
            'employee_name':employee.name, 'operator_id':user.pk}


def allocation_data(row):
    return {'id':str(row.pk), 'asset_id':row.asset_id, 'employee_id':row.employee_id,
            'issued_at':row.issued_at.isoformat() if row.issued_at else None, 'issued_by':row.issued_by_id,
            'issue_reason':row.issue_reason, 'issue_snapshot':row.issue_snapshot, 'provenance':row.provenance,
            'returned_at':row.returned_at.isoformat() if row.returned_at else None, 'returned_by':row.returned_by_id,
            'return_reason':row.return_reason, 'return_snapshot':row.return_snapshot}


def normalize_staff(payload):
    if not isinstance(payload, dict) or set(payload) != {'request_id','action','employee_id','items','reason'}:
        raise CommandError('invalid_staff_payload', 400)
    action, eid, items = payload['action'], payload['employee_id'], payload['items']
    if action not in {'issue','return'} or type(eid) is not int or eid <= 0 or not isinstance(items,list) or not 1 <= len(items) <= 100:
        raise CommandError('invalid_staff_action_or_batch', 400)
    for item in items:
        if (not isinstance(item,dict) or set(item) != {'asset_id','expected_revision','expected_employee_id'}
            or type(item['asset_id']) is not int or item['asset_id'] <= 0
            or type(item['expected_revision']) is not int or item['expected_revision'] < 0
            or item['expected_employee_id'] is not None and (type(item['expected_employee_id']) is not int or item['expected_employee_id'] <= 0)):
            raise CommandError('invalid_staff_item', 400)
    if len({i['asset_id'] for i in items}) != len(items):
        raise CommandError('duplicate_asset_ids', 400)
    return {'request_id':request_uuid(payload), 'action':action, 'employee_id':eid,
            'items':sorted(items,key=lambda i:i['asset_id']), 'reason':require_reason(payload)}


@transaction.atomic
def execute_staff_command(user, payload):
    command = normalize_staff(payload)
    receipt, replay = receipt_for(user, 'staff_allocation', command, WAREHOUSE_ROLES)
    if replay:
        return replay
    ids = [item['asset_id'] for item in command['items']]
    assets = {a.pk:a for a in Asset.objects.select_for_update().filter(pk__in=ids).order_by('pk')}
    if len(assets) != len(ids):
        raise CommandError('unknown_assets', 404)
    if any(asset.stock_kind == 'led_case' for asset in assets.values()):
        raise CommandError('select_led_case_panels_not_historical_box', 400)
    employee = Employee.objects.select_for_update().filter(pk=command['employee_id']).first()
    if employee is None:
        raise CommandError('unknown_employee', 404)
    active = {r.asset_id:r for r in StaffAllocation.objects.select_for_update().filter(asset_id__in=ids,returned_at__isnull=True).order_by('asset_id')}
    conflicts = []
    for item in command['items']:
        asset, row = assets[item['asset_id']], active.get(item['asset_id'])
        if asset.staff_revision != item['expected_revision'] or asset.assigned_to_id != item['expected_employee_id']:
            conflicts.append({'asset_id':asset.pk,'reason':'staff_assignment_changed','revision':asset.staff_revision,'employee_id':asset.assigned_to_id})
            continue
        if row and row.employee_id != asset.assigned_to_id:
            conflicts.append({'asset_id':asset.pk,'reason':'staff_history_disagrees_with_custodian'})
        if command['action']=='return' and (asset.quantity!=1 or asset.quantity_tracking or asset.type=='Consumables' or asset.is_temporary or asset.parent_asset_id or asset.sub_assets.exists()):
            conflicts.append({'asset_id':asset.pk,'reason':'legacy_staff_return_requires_review'})
        if command['action'] == 'issue':
            if asset.assigned_to_id or row:
                conflicts.append({'asset_id':asset.pk,'reason':'already_staff_allocated'})
            if asset.is_temporary or asset.quantity != 1 or asset.quantity_tracking or asset.type == 'Consumables':
                conflicts.append({'asset_id':asset.pk,'reason':'individual_permanent_equipment_required'})
            if asset.parent_asset_id or asset.sub_assets.exists():
                conflicts.append({'asset_id':asset.pk,'reason':'kit_staff_issue_requires_review'})
            if asset.flag or asset.condition == 'Damaged' or asset.status in RESTRICTED_STATUSES | {'In Use','Crosscheck'}:
                conflicts.append({'asset_id':asset.pk,'reason':'asset_requires_custody_or_health_review'})
            if Conference.objects.filter(is_audit=False).filter(Q(assets=asset)|Q(crosscheck_assets=asset)|Q(staged_assets=asset)).exists():
                conflicts.append({'asset_id':asset.pk,'reason':'event_holds_or_reserves_equipment'})
            if asset.quantity_allocations.exists() or asset.consumable_allocations.exists():
                conflicts.append({'asset_id':asset.pk,'reason':'quantity_history_requires_review'})
        elif asset.assigned_to_id != employee.pk:
            conflicts.append({'asset_id':asset.pk,'reason':'not_issued_to_this_employee'})
    if conflicts:
        raise CommandError('staff_allocation_conflict', details=conflicts)
    changed = []
    now = timezone.now()
    for aid in ids:
        asset, row = assets[aid], active.get(aid)
        before = snapshot(asset, employee, user)
        if command['action'] == 'issue':
            row = StaffAllocation.objects.create(asset=asset,employee=employee,issued_at=now,issued_by=user,
                issue_receipt=receipt,issue_reason=command['reason'],issue_snapshot=before)
            asset.assigned_to_id = employee.pk
        else:
            if row is None:
                row = StaffAllocation.objects.create(asset=asset,employee=employee,provenance='legacy_assignment_at_return',
                    issue_snapshot={'asset_id':aid,'employee_id':employee.pk,'original_issue_not_recorded':True})
            row.returned_at, row.returned_by, row.return_receipt = now, user, receipt
            row.return_reason, row.return_snapshot = command['reason'], before
            row.save()
            asset.assigned_to_id = None
        asset.staff_revision += 1
        asset.save(update_fields=['assigned_to','staff_revision'])
        changed.append(allocation_data(row))
    synchronize_statuses(ids)
    from .serializers import AssetSerializer
    result = {'operation':'staff_allocation','request_id':command['request_id'],'action':command['action'],
              'allocations':changed,'asset_states':AssetSerializer(Asset.objects.filter(pk__in=ids).order_by('pk'),many=True).data,'replayed':False}
    receipt.result=result;receipt.save(update_fields=['result'])
    return result


def normalize_link(payload):
    allowed = {'request_id','action','user_id','employee_id','expected_revision','expected_user_id','profile','reason'}
    if not isinstance(payload,dict) or set(payload)-allowed:
        raise CommandError('invalid_link_payload',400)
    result={'request_id':request_uuid(payload),'reason':require_reason(payload),'action':payload.get('action'),'user_id':payload.get('user_id')}
    if result['action'] not in {'link','create_link'} or type(result['user_id']) is not int or result['user_id'] <= 0:
        raise CommandError('invalid_link_action_or_user',400)
    if result['action']=='link':
        if set(payload) != allowed-{'profile'} or type(payload['employee_id']) is not int or payload['employee_id']<=0 or type(payload['expected_revision']) is not int or payload['expected_revision']<0 or payload['expected_user_id'] is not None and (type(payload['expected_user_id']) is not int or payload['expected_user_id']<=0):
            raise CommandError('invalid_link_comparison',400)
        result.update({k:payload[k] for k in ('employee_id','expected_revision','expected_user_id')})
    else:
        profile=payload.get('profile')
        if set(payload) != allowed-{'employee_id','expected_revision','expected_user_id'} or not isinstance(profile,dict) or set(profile) != {'name','employee_id','department','phone'}:
            raise CommandError('explicit_employee_profile_required',400)
        for key,limit in [('name',100),('employee_id',50),('department',100),('phone',20)]:
            if not isinstance(profile[key],str) or not 1<=len(profile[key].strip())<=limit:
                raise CommandError('invalid_employee_profile',400)
        result['profile']={k:v.strip() for k,v in profile.items()}
    return result


@transaction.atomic
def execute_link_command(actor,payload):
    command=normalize_link(payload)
    receipt,replay=receipt_for(actor,'employee_link',command,ADMIN_ROLES)
    if replay:return replay
    target=User.objects.select_for_update().filter(pk=command['user_id'],is_active=True).first()
    if target is None:raise CommandError('unknown_or_inactive_user',404)
    if Employee.objects.filter(user=target).exists():raise CommandError('user_already_linked')
    if command['action']=='link':
        employee=Employee.objects.select_for_update().filter(pk=command['employee_id']).first()
        if employee is None:raise CommandError('unknown_employee',404)
        if employee.identity_revision!=command['expected_revision'] or employee.user_id!=command['expected_user_id']:
            raise CommandError('employee_identity_changed')
        if employee.user_id is not None:raise CommandError('employee_already_linked')
    else:
        if not target.email.strip():raise CommandError('user_email_required')
        if User.objects.filter(email__iexact=target.email.strip()).count()!=1:raise CommandError('ambiguous_user_email_requires_review')
        if Employee.objects.filter(Q(email__iexact=target.email.strip())|Q(employee_id=command['profile']['employee_id'])).exists():
            raise CommandError('review_existing_employee_before_creating_profile')
        try:employee=Employee.objects.create(**command['profile'],email=target.email.strip(),role=get_business_role(target) or 'technician')
        except IntegrityError:raise CommandError('employee_identity_conflict')
    employee.user=target;employee.identity_revision+=1;employee.save(update_fields=['user','identity_revision'])
    EmployeeIdentityHistory.objects.create(employee=employee,user=target,actor=actor,receipt=receipt,reason=command['reason'],
        snapshot={'employee_id':employee.pk,'employee_code':employee.employee_id,'user_id':target.pk,'email':target.email,'identity_revision':employee.identity_revision})
    from .serializers import EmployeeSerializer
    result={'operation':'employee_link','request_id':command['request_id'],'employee':EmployeeSerializer(employee).data,'replayed':False}
    receipt.result=result;receipt.save(update_fields=['result'])
    return result


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def staff_commands(request):
    try:return Response(execute_staff_command(request.user,request.data))
    except CommandError as error:return Response({'error':error.code,'conflicts':error.details},status=error.status)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def employee_link_commands(request):
    try:return Response(execute_link_command(request.user,request.data))
    except CommandError as error:return Response({'error':error.code,'conflicts':error.details},status=error.status)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def staff_history(request,pk):
    if not Asset.objects.filter(pk=pk).exists():return Response({'error':'unknown_asset'},status=404)
    rows=StaffAllocation.objects.filter(asset_id=pk).order_by('issued_at','pk')
    if get_business_role(request.user) not in WAREHOUSE_ROLES|{'accounts'}:
        eid=assigned_employee_id(request.user)
        if not eid or not (rows.filter(employee_id=eid).exists() or Asset.objects.filter(pk=pk,assigned_to_id=eid).exists()):return Response({'error':'not_authorized'},status=403)
        rows=rows.filter(employee_id=eid)
    return Response({'asset_id':pk,'records':[allocation_data(row) for row in rows],
        'legacy_assignment_without_issue_record':Asset.objects.filter(pk=pk,assigned_to__isnull=False).exists() and not rows.filter(returned_at__isnull=True).exists()})


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def employee_link_context(request):
    if get_business_role(request.user) not in ADMIN_ROLES:return Response({'error':'not_authorized'},status=403)
    from .serializers import EmployeeSerializer
    employees=list(Employee.objects.order_by('pk'));linked={e.user_id:e.pk for e in employees if e.user_id}
    return Response({'users':[{'id':u.pk,'name':u.get_full_name() or u.username,'email':u.email,'active':u.is_active,'employee_id':linked.get(u.pk)} for u in User.objects.order_by('pk')],
                     'employees':EmployeeSerializer(employees,many=True).data})
