from django.core.exceptions import SuspiciousOperation
from rest_framework.exceptions import APIException, ValidationError as APIValidationError
from .permissions import AssetWritePermission, QuantityAssignmentPermission, WarehouseWriteAuthenticatedRead
from .permissions import AdministratorWriteAuthenticatedRead, PublicSettingsReadAdministratorWrite

from django.shortcuts import render, redirect, get_object_or_404
from django.http import HttpResponse
from django.db.models import Q
from django.db import transaction, DatabaseError
from .models import Asset, Conference, DeliveryChallan, Employee, CompanySettings
from django.core.files.uploadedfile import UploadedFile
from .forms import AssetForm, ConferenceForm
from reportlab.pdfgen import canvas
import io
import pandas as pd

def dashboard(request):
    total_assets = Asset.objects.filter(is_temporary=False).exclude(stock_kind='led_case').count()
    assets_in_use = Asset.objects.exclude(stock_kind='led_case').filter(is_temporary=False, status='In Use').count()
    assets_available = Asset.objects.exclude(stock_kind='led_case').filter(is_temporary=False, status='Available').count()
    conferences = Conference.objects.all().order_by('-start_date')[:5]
    
    context = {
        'total_assets': total_assets,
        'assets_in_use': assets_in_use,
        'assets_available': assets_available,
        'conferences': conferences,
    }
    return render(request, 'dashboard.html', context)

from rest_framework.decorators import api_view
from rest_framework.response import Response
from .serializers import AssetSerializer, EmployeeSerializer

@api_view(['GET'])
def asset_stats(request):
    total = Asset.objects.filter(is_temporary=False).exclude(stock_kind='led_case').count()
    ready = Asset.objects.exclude(stock_kind='led_case').filter(is_temporary=False, status='Available').count()
    in_use = Asset.objects.exclude(stock_kind='led_case').filter(is_temporary=False, status__in=['In Use', 'Dispatched']).count()
    maintenance = Asset.objects.filter(is_temporary=False).exclude(stock_kind='led_case').filter(Q(status__in=['Maintenance', 'Damaged', 'On Service', 'Expired']) | Q(condition='Damaged') | Q(flag__in=['Required Service', 'On Service', 'Expired'])).count()
    
    return Response({
        "total": total,
        "ready": ready,
        "in_use": in_use,
        "maintenance": maintenance
    })


@api_view(['GET'])
@transaction.atomic
def employee_allocations(request):
    # Allocation summaries are independent of inventory pagination/search.
    from django.db import connection
    from .models import StaffAllocation
    from django.db.models import Exists, OuterRef
    if connection.vendor == 'postgresql':
        with connection.cursor() as cursor:
            cursor.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    assets = list(Asset.objects.annotate(annotated_staff_open=Exists(StaffAllocation.objects.filter(asset=OuterRef('pk'),returned_at__isnull=True))).filter(Q(assigned_to__isnull=False)|Q(annotated_staff_open=True)).select_related('assigned_to', 'subrental_company').order_by('pk'))
    active = {row.asset_id:row for row in StaffAllocation.objects.filter(asset_id__in=[a.pk for a in assets],returned_at__isnull=True).select_related('employee')}
    data = AssetSerializer(assets, many=True).data
    for asset, item in zip(assets, data):
        row = active.get(asset.pk)
        item['allocation_employee_id'] = row.employee_id if row else asset.assigned_to_id
        item['allocation_employee_name'] = row.employee.name if row else asset.assigned_to.name
        item['subrental_company_name'] = asset.subrental_company.name if asset.subrental_company else None
        item['staff_issue'] = {'id':str(row.pk) if row else None,'issued_at':row.issued_at.isoformat() if row and row.issued_at else None,
                               'issued_by':row.issued_by_id if row else None,'provenance':row.provenance if row else 'legacy_assignment_unrecorded',
                               'history_matches_current_custodian':row is None or row.employee_id==asset.assigned_to_id}
    return Response(data)


@api_view(['GET'])
def staff_issue_candidates(request):
    from .permissions import get_business_role, WAREHOUSE_ROLES
    if get_business_role(request.user) not in WAREHOUSE_ROLES:
        return Response({'error':'not_authorized'},status=403)
    from django.db.models import Exists, OuterRef, Value, CharField
    from .models import StaffAllocation
    held=Conference.objects.filter(is_audit=False).filter(Q(assets=OuterRef('pk'))|Q(crosscheck_assets=OuterRef('pk'))|Q(staged_assets=OuterRef('pk')))
    rows=Asset.objects.exclude(stock_kind='led_case').filter(assigned_to__isnull=True,is_temporary=False,quantity=1,quantity_tracking=False,flag='',status='Available',parent_asset__isnull=True,sub_assets__isnull=True).exclude(type='Consumables').exclude(condition='Damaged').exclude(quantity_allocations__isnull=False).exclude(consumable_allocations__isnull=False)
    rows=rows.annotate(event_held=Exists(held),annotated_staff_open=Exists(StaffAllocation.objects.filter(asset=OuterRef('pk'),returned_at__isnull=True)),annotated_conference=Value(None,output_field=CharField())).filter(event_held=False,annotated_staff_open=False).select_related('subrental_company').order_by('pk')
    search=request.query_params.get('search','').strip()[:200]
    if search:rows=rows.filter(Q(sku__icontains=search)|Q(alias_name__icontains=search)|Q(serial_number__icontains=search)|Q(barcode__icontains=search))
    from rest_framework.pagination import PageNumberPagination
    pager=PageNumberPagination();pager.page_size=25
    selected=pager.paginate_queryset(rows,request)
    data=AssetSerializer(selected,many=True).data
    for asset,item in zip(selected,data):item['subrental_company_name']=asset.subrental_company.name if asset.subrental_company else None
    return pager.get_paginated_response(data)

@api_view(['GET'])
def unique_aliases(request):
    data = Asset.objects.exclude(stock_kind='led_case').values('alias_name', 'type').distinct()
    return Response(list(data))

from datetime import date
from django.db import connection, utils, transaction
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny




@api_view(['GET', 'POST'])
@permission_classes([WarehouseWriteAuthenticatedRead])
@transaction.atomic
def asset_list(request):
    if request.method == 'GET':
        from django.db.models import OuterRef, Subquery
        from django.db.models.functions import Coalesce
        from .models import Conference
        from django.db.models import Value

        # Optimized subqueries to get the current conference name without N+1 hits
        assigned_qs = Conference.objects.filter(assets=OuterRef('pk'), is_audit=False).order_by('pk').values('name')[:1]
        crosscheck_qs = Conference.objects.filter(crosscheck_assets=OuterRef('pk'), is_audit=False).order_by('pk').values('name')[:1]

        # Filter by subrental company if provided
        subrental_company_id = request.query_params.get('subrental_company_id')
        
        assets_query = Asset.objects.annotate(
            annotated_conference=Coalesce(Subquery(assigned_qs), Subquery(crosscheck_qs), Value(None))
        ).select_related('assigned_to', 'parent_asset', 'subrental_company', 'led_panel_record__case__source_asset', 'led_case_conversion').prefetch_related(
            'sub_assets',
            'sub_assets__assigned_to',
            'assigned_conferences',
            'ticket_items__ticket__conference'
        )
        from .models import StaffAllocation
        from django.db.models import Exists
        assets_query = assets_query.annotate(annotated_staff_open=Exists(StaffAllocation.objects.filter(asset=OuterRef('pk'),returned_at__isnull=True)))

        # Exclude temporary items created inside subrental tickets from all inventory views,
        # but keep temporary/ad-hoc items that were attached to a conference, challan, or truck challan
        assets_query = assets_query.filter(
            Q(is_temporary=False) | Q(assigned_conferences__isnull=False) | Q(challan_conferences__isnull=False) | Q(truck_challans__isnull=False)
        ).distinct()

        is_all_query = request.GET.get('all') == 'true'
        if not is_all_query:
            assets_query = assets_query.exclude(stock_kind='led_case')
        if subrental_company_id:
            if subrental_company_id == 'null':
                assets_query = assets_query.filter(subrental_company__isnull=True)
            else:
                assets_query = assets_query.filter(subrental_company_id=subrental_company_id)
        elif is_all_query:
            # Permanent supplier-owned stock shares the warehouse scan index.
            # Ticket-only temporary rows still follow the attachment filter above.
            pass
        else:
            # By default, show ONLY our main inventory in paginated inventory view
            assets_query = assets_query.filter(subrental_company__isnull=True)

        from django.db.models.functions import Coalesce, Lower
        
        assets = assets_query.annotate(
            sort_name=Lower(Coalesce('alias_name', 'sku'))
        ).order_by('sort_name')
        
        search_query = request.GET.get('search', '').strip()
        if search_query:
            assets = assets.filter(
                Q(alias_name__icontains=search_query) | 
                Q(sku__icontains=search_query) | 
                Q(type__icontains=search_query) |
                Q(description__icontains=search_query)
            )
        
        purchase_from = request.GET.get('purchase_from', '').strip()
        if purchase_from:
            assets = assets.filter(purchased_date__gte=purchase_from)
        purchase_to = request.GET.get('purchase_to', '').strip()
        if purchase_to:
            assets = assets.filter(purchased_date__lte=purchase_to)
        
        from rest_framework.pagination import PageNumberPagination

        if request.GET.get('all') == 'true':
            serializer = AssetSerializer(assets, many=True)
            return Response(serializer.data)

        paginator = PageNumberPagination()
        paginator.page_size = 50
        paginated_assets = paginator.paginate_queryset(assets, request)
        serializer = AssetSerializer(paginated_assets, many=True)
        return paginator.get_paginated_response(serializer.data)
    elif request.method == 'POST':
        is_many = isinstance(request.data, list)
        # Ownership reviews lock kit assets before owner companies. Registration
        # uses the same order, including bulk imports, so it cannot slip a new
        # member into a classification/kit review while that review commits.
        rows = request.data if is_many else [request.data]
        parents, owners = set(), set()
        for row in rows:
            if not isinstance(row, dict):
                continue
            for field, target in (('parent_asset', parents), ('subrental_company', owners)):
                value = row.get(field)
                if str(value).isdigit():
                    target.add(int(value))
        list(Asset.objects.select_for_update().filter(pk__in=parents).order_by('pk'))
        from .models import SubrentalCompany
        list(SubrentalCompany.objects.select_for_update().filter(pk__in=owners).order_by('pk'))
        serializer = AssetSerializer(data=request.data, many=is_many)
        if serializer.is_valid():
            serializer.save()
            return Response(serializer.data, status=201)
        return Response(serializer.errors, status=400)

@api_view(['GET', 'PUT', 'PATCH', 'DELETE'])
@permission_classes([AssetWritePermission])
@transaction.atomic
def asset_detail(request, pk):
    if request.method != 'GET':
        parent = Asset.objects.filter(pk=pk).values_list('parent_asset_id', flat=True).first()
        ids = {pk} | ({parent} if parent else set())
        proposed_parent = request.data.get('parent_asset') if isinstance(request.data, dict) else None
        if str(proposed_parent).isdigit():
            ids.add(int(proposed_parent))
        list(Asset.objects.select_for_update().filter(pk__in=ids).order_by('pk'))
        current_parent = Asset.objects.filter(pk=pk).values_list('parent_asset_id', flat=True).first()
        if current_parent and current_parent not in ids:
            return Response({'error': 'inventory_kit_links_changed_retry'}, status=409)
    asset = get_object_or_404(Asset.objects.select_for_update() if request.method != 'GET' else Asset.objects.all(), pk=pk)

    if request.method == 'GET':
        serializer = AssetSerializer(asset)
        return Response(serializer.data)

    elif request.method in ['PUT', 'PATCH']:
        partial = (request.method == 'PATCH')
        
        context = request.data.get('conference_id')
        if context is not None:
            if isinstance(context, bool) or not str(context).isdigit():
                return Response({'error': 'invalid_conference_context'}, status=400)
            from .models import Conference
            context_event = Conference.objects.select_for_update().filter(pk=int(context)).first()
            if context_event is None:
                return Response({'error': 'unknown_conference'}, status=404)
            if context_event.lifecycle_state != 'open':
                return Response({'error': 'event_is_sealed'}, status=409)
        serializer = AssetSerializer(asset, data=request.data, partial=partial)

        if serializer.is_valid():
            serializer.save()
            
            # Contextual Logging for Conferences
            conference_id = request.data.get('conference_id')
            flag = request.data.get('flag')
            if conference_id and flag:
                from .models import Conference
                from django.utils import timezone
                try:
                    conf = Conference.objects.get(pk=conference_id)
                    stage = request.data.get('stage', 'Unknown')
                    
                    # Update flag_log
                    log_entry = {
                        'asset_id': asset.id,
                        'sku': asset.sku,
                        'alias_name': asset.alias_name,
                        'flag': flag,
                        'stage': stage,
                        'timestamp': timezone.now().isoformat()
                    }
                    
                    if not isinstance(conf.flag_log, list):
                        conf.flag_log = []
                    
                    conf.flag_log.append(log_entry)
                    conf.save(update_fields=['flag_log'])
                except Conference.DoesNotExist:
                    pass

            return Response(serializer.data)
        return Response(serializer.errors, status=400)

    elif request.method == 'DELETE':
        if asset.stock_kind != 'equipment':
            return Response({'error': 'LED_case_and_panel_history_is_protected'}, status=409)
        from django.db.models.deletion import ProtectedError
        if asset.ownership_targets.exists():
            return Response({'error': 'inventory_item_has_ownership_history'}, status=409)
        if asset.assigned_to_id or any(getattr(asset, relation).exists() for relation in
                ('assigned_conferences', 'crosscheck_conferences', 'staged_conferences', 'requirement_conferences', 'challan_conferences', 'truck_challans', 'ticket_items')):
            return Response({'error': 'inventory_item_has_custody_or_legacy_history'}, status=409)
        try:
            asset.delete()
        except ProtectedError:
            return Response({'error': 'inventory_item_has_challan_history'}, status=409)
        return Response(status=204)

@api_view(['GET', 'POST'])
@permission_classes([WarehouseWriteAuthenticatedRead])
@transaction.atomic
def asset_sub_assets(request, pk):
    """
    GET  /api/assets/<pk>/sub-assets/  → list all sub-assets of this asset
    POST /api/assets/<pk>/sub-assets/  → link a child asset { "child_id": <id> }
    """
    parent = get_object_or_404(Asset, pk=pk)

    if request.method == 'GET':
        serializer = AssetSerializer(parent.sub_assets.all(), many=True)
        return Response(serializer.data)

    elif request.method == 'POST':
        child_id = request.data.get('child_id')
        if not child_id:
            return Response({'error': 'child_id is required'}, status=400)
        child = get_object_or_404(Asset, pk=child_id)
        locked = {a.pk: a for a in Asset.objects.select_for_update().filter(pk__in=[parent.pk, child.pk]).order_by('pk')}
        parent, child = locked[parent.pk], locked[child.pk]
        if parent.stock_kind != 'equipment' or child.stock_kind != 'equipment':
            return Response({'error': 'LED_case_mapping_is_separate_from_kit_links'}, status=409)
        if child.pk == parent.pk:
            return Response({'error': 'An asset cannot be its own sub-asset'}, status=400)
        child.parent_asset = parent
        child.save()
        serializer = AssetSerializer(parent)
        return Response(serializer.data)

@api_view(['DELETE'])
@permission_classes([WarehouseWriteAuthenticatedRead])
def asset_sub_asset_remove(request, pk, child_pk):
    """
    DELETE /api/assets/<pk>/sub-assets/<child_pk>/  → unlink a child asset
    """
    get_object_or_404(Asset, pk=pk)  # validate parent exists
    child = get_object_or_404(Asset, pk=child_pk, parent_asset_id=pk)
    child.parent_asset = None
    child.save()
    return Response(status=204)


def generate_pdf_challan(request, conference_id):
    conference = get_object_or_404(Conference, id=conference_id)
    
    # Create PDF in memory
    buffer = io.BytesIO()
    p = canvas.Canvas(buffer)
    
    p.drawString(100, 800, f"DELIVERY CHALLAN - {conference.name}")
    p.drawString(100, 780, f"Client: {conference.association_name}")
    p.drawString(100, 760, f"Date: {conference.challan_date or conference.start_date}")
    p.drawString(100, 740, "--------------------------------------------------")
    
    y = 720
    p.drawString(100, y, "Assets Shipped:")
    y -= 20
    from django.db.models.functions import Coalesce, Lower
    sorted_assets = conference.assets.annotate(
        sort_name=Lower(Coalesce('alias_name', 'sku'))
    ).order_by('sort_name')
    
    for asset in sorted_assets:
        display_name = asset.alias_name or asset.sku
        p.drawString(120, y, f"- {display_name} (SN: {asset.serial_number})")
        y -= 20
        
    p.showPage()
    p.save()
    
    buffer.seek(0)
    response = HttpResponse(buffer, content_type='application/pdf')
    response['Content-Disposition'] = f'attachment; filename="Challan_Conf_{conference_id}.pdf"'
    return response

from rest_framework.permissions import IsAuthenticated, AllowAny
from rest_framework.decorators import permission_classes, api_view
from django.conf import settings
import os

@api_view(['GET'])
@permission_classes([IsAuthenticated])
def download_conference_pdf(request, conference_id):
    from .permissions import get_business_role, WAREHOUSE_ROLES, technician_has_event
    from .private_media import open_media, MAX_PDF_BYTES
    from django.http import FileResponse, Http404
    role = get_business_role(request.user)
    if role not in WAREHOUSE_ROLES | {'accounts'} and not (
        role == 'technician' and technician_has_event(request.user, conference_id)
    ):
        return Response({'detail': 'You are not assigned to this event document.'}, status=403)
    conference = get_object_or_404(Conference, id=conference_id)
    stream = open_media(conference.pdf_document, 'conference_pdfs', MAX_PDF_BYTES)
    if stream.read(5) != b'%PDF-':
        stream.close()
        raise Http404
    stream.seek(0)
    response = FileResponse(stream, as_attachment=True,
        filename=f'Conference_{conference.pk}.pdf', content_type='application/pdf')
    response['Cache-Control'] = 'private, no-store'
    response['X-Content-Type-Options'] = 'nosniff'
    response['Content-Security-Policy'] = "sandbox; default-src 'none'"
    return response

from rest_framework.decorators import api_view

@api_view(['GET', 'POST'])
@permission_classes([AdministratorWriteAuthenticatedRead])
@transaction.atomic
def employee_list(request):
    if request.method == 'GET':
        employees = Employee.objects.all()
        serializer = EmployeeSerializer(employees, many=True)
        return Response(serializer.data)
    elif request.method == 'POST':
        data = request.data.copy() if hasattr(request.data, 'copy') else dict(request.data)
        
        email = (data.get('email') or '').strip().casefold()
        data['email'] = email
        if not email:
            return Response({'email': ['Login ID / Email is required.']}, status=400)

        from django.contrib.auth.models import User
        password = data.get('password') or None
        if password is not None:
            if not isinstance(password,str) or len(password)<10:
                return Response({'password':['Use at least 10 characters, or leave blank until a password is set.']},status=400)
            from django.contrib.auth.password_validation import validate_password
            from django.core.exceptions import ValidationError
            try:
                validate_password(password,user=User(username=email,email=email))
            except ValidationError as error:
                return Response({'password':error.messages},status=400)
        if User.objects.filter(username__iexact=email).exists() or User.objects.filter(email__iexact=email).exists():
            return Response({'email': ['A user with this login ID / email already exists.']}, status=400)
        if Employee.objects.filter(email__iexact=email).exists():
            return Response({'email': ['An employee record with this email already exists.']}, status=400)

        # Ensure required fields have valid defaults
        role = data.get('role', 'technician')
        if not data.get('employee_id'):
            import time
            data['employee_id'] = f"EMP-{int(time.time() * 1000)}"
        if not data.get('department'):
            dept_map = {
                'admin': 'Management',
                'godown_incharge': 'Warehouse',
                'accounts': 'Accounts',
                'technician': 'Operations'
            }
            data['department'] = dept_map.get(role, 'User')
        if not data.get('phone'):
            data['phone'] = 'N/A'

        serializer = EmployeeSerializer(data=data)
        if serializer.is_valid():
            employee = serializer.save()
            
            # Check if an auth.User needs to be provisioned for this Employee
            password = data.get('password') or None
            if employee.email:
                from .models import UserProfile
                is_admin = (employee.role in ('admin', 'boss'))
                user_obj = User.objects.create_user(username=employee.email, email=employee.email,
                    password=password, is_staff=is_admin, is_superuser=is_admin)
                employee.user = user_obj
                employee.identity_revision += 1
                employee.save(update_fields=['user', 'identity_revision'])
                from .models import MovementReceipt, EmployeeIdentityHistory
                import uuid, hashlib, json
                request_id = uuid.uuid4()
                result = {'operation':'employee_provision','request_id':str(request_id),'employee_id':employee.pk,'user_id':user_obj.pk}
                receipt = MovementReceipt.objects.create(actor=request.user, request_id=request_id,
                    payload_hash=hashlib.sha256(json.dumps(result,sort_keys=True).encode()).hexdigest(),result=result)
                EmployeeIdentityHistory.objects.create(employee=employee,user=user_obj,actor=request.user,receipt=receipt,
                    reason='Employee and login created together',snapshot={'employee_id':employee.pk,'employee_code':employee.employee_id,'user_id':user_obj.pk})

                # Sync UserProfile role
                profile, _ = UserProfile.objects.get_or_create(user=user_obj)
                profile.role = employee.role or 'technician'
                profile.save()
                    
            return Response({**serializer.data,'login_password_set':bool(password)}, status=201)
        return Response(serializer.errors, status=400)

@api_view(['GET', 'PUT', 'DELETE'])
@permission_classes([AdministratorWriteAuthenticatedRead])
@transaction.atomic
def employee_detail(request, pk):
    employee = get_object_or_404(Employee, pk=pk)

    if request.method == 'GET':
        serializer = EmployeeSerializer(employee)
        return Response(serializer.data)

    elif request.method == 'PUT':
        serializer = EmployeeSerializer(employee, data=request.data)
        if serializer.is_valid():
            serializer.save()
            return Response(serializer.data)
        return Response(serializer.errors, status=400)

    elif request.method == 'DELETE':
        if employee.assets.exists() or employee.staff_allocations.exists() or employee.user_id or employee.identity_history.exists():
            return Response({'error':'employee_has_custody_or_identity_history'},status=409)
        employee.delete()
        return Response(status=204)



@api_view(['GET', 'POST'])
@permission_classes([PublicSettingsReadAdministratorWrite])
@transaction.atomic
def company_settings(request):
    from .serializers import CompanySettingsSerializer
    try:
        if request.method == 'GET':
            settings_obj = CompanySettings.objects.order_by('pk').first() or CompanySettings()
            serializer = CompanySettingsSerializer(settings_obj, context={'request': request})
            data = serializer.data
            if not request.user.is_authenticated:
                public_fields = {'name', 'logo', 'powered_by_name', 'theme_template', 'website'}
                data = {key: value for key, value in data.items() if key in public_fields}
            return Response(data)
        
        elif request.method == 'POST':
            # ONLY Authenticated users can change settings
            if not request.user or not request.user.is_authenticated:
                 return Response({"detail": "Authentication credentials were not provided."}, status=401)
            
            # Convert QueryDict to a regular dict to allow injecting parsed objects
            if hasattr(request.data, 'dict'):
                data = request.data.dict()
            else:
                data = request.data.copy()
            
            # Parse the bounded request before taking the shared numbering lock.
            from .challan_documents import number_mutex
            number_mutex()
            settings_obj = CompanySettings.objects.select_for_update().order_by('pk').first() or CompanySettings()

            # Logo management
            if 'logo' in data:
                logo_val = data.get('logo')
                if not isinstance(logo_val, UploadedFile):
                    # If it's a string (URL) or empty, we handle it
                    if not logo_val:
                         # Explicitly clearing the logo
                         # Retain the prior private file; validation failure or a
                         # DB rollback must not destroy the branding image.
                         settings_obj.logo = None
                    # Remove from data so serializer doesn't try to save a string to ImageField
                    del data['logo']

            # Fix for dashboard_config being sent as string in FormData (QueryDict)
            import json
            if 'dashboard_config' in data and isinstance(data['dashboard_config'], str):
                try:
                    data['dashboard_config'] = json.loads(data['dashboard_config'])
                except (ValueError, TypeError):
                    pass

            serializer = CompanySettingsSerializer(settings_obj, data=data, partial=True, context={'request': request})
            if serializer.is_valid():
                serializer.save()
                return Response(serializer.data)
            return Response(serializer.errors, status=400)

    except (APIException, SuspiciousOperation):
        raise
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        print(f"ERROR IN COMPANY_SETTINGS: {tb}")
        return Response({"error": str(e), "detail": tb if settings.DEBUG else "Check server logs"}, status=500)


import pandas as pd
from rest_framework.parsers import MultiPartParser, FormParser

@api_view(['POST'])
@permission_classes([IsAuthenticated])
def bulk_upload_assets(request):
    """Create new inventory atomically; imports never overwrite existing stock."""
    from .inventory_import import import_assets, InventoryImportError
    role = getattr(getattr(request.user, 'profile', None), 'role', None)
    allowed = request.user.is_superuser or role in {'admin', 'boss', 'godown_incharge'} or (request.user.is_staff and role not in {'accounts', 'technician'})
    if not allowed:
        return Response({'error': 'Only an inventory administrator or godown incharge can import stock.'}, status=403)
    if 'file' not in request.FILES:
        return Response({'error': 'No file provided'}, status=400)
    try:
        result, status = import_assets(request.FILES['file'], request.data.get('subrental_company_id'))
        return Response(result, status=status)
    except InventoryImportError as exc:
        return Response({'created': 0, 'updated': 0, 'skipped': 0, 'errors': [str(exc)], 'error': str(exc)}, status=400)
    except Exception:
        import logging
        logging.getLogger(__name__).exception('Inventory import failed; transaction rolled back')
        return Response({'created': 0, 'updated': 0, 'skipped': 0, 'error': 'Import failed. No inventory changes saved.'}, status=500)


# from rest_framework.permissions import AllowAny
# from rest_framework.decorators import permission_classes
from rest_framework.authtoken.models import Token as AuthToken

@api_view(['POST'])
@permission_classes([QuantityAssignmentPermission])
def asset_assign_quantity(request, pk):
    # Retired non-atomic splitter: a stale browser must never clone an identity.
    asset = get_object_or_404(Asset, pk=pk)
    from .quantity_commands import is_quantity_stock
    return Response({'error': 'use_quantity_commands' if is_quantity_stock(asset) else 'use_asset_commands'}, status=409)

def download_asset_template(request):
    """
    Generates an Excel (.xlsx) file containing the template structure for bulk uploading.
    Provides headers and one example row. Does not export existing data.
    """
    # Simply ignore tokens/auth for a generic template download
    headers = [
        'SKU', 'Alias Name', 'MAC Address', 'IMEI Number 1', 'IMEI Number 2', 
        'Serial Number', 'Description', 'Is Barcode added', 'Type', 'Quantity', 'Purchased Date', 
        'Item Price', 'Depreciation Percentage', 'Available from', 'Available till', 
        'Barcode Type', 'Barcode', 'QR Code'
    ]
    
    data = [
        [
            'SKU-EXAMPLE', 'Demo Asset', '00:1A:2B:3C:4D:5E', '123456789012345', '987654321098765', 
            'SN-EXAMPLE-1', 'Example description for upload', 'Yes', 'IT & Networking', 10, '2024-01-15', 
            75000, '10%', '2024-01-15', '2026-01-15', 'Code128', '1234567890', 'http://example.com/asset/1'
        ]
    ]
        
    df = pd.DataFrame(data, columns=headers)
    
    # Write to BytesIO and return as an Excel file attachment
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine='openpyxl') as writer:
        df.to_excel(writer, index=False, sheet_name='Template')
    
    output.seek(0)
    response = HttpResponse(output, content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    response['Content-Disposition'] = 'attachment; filename="asset_inventory_template.xlsx"'
    
    return response

@api_view(['GET'])
def export_inventory(request):
    """
    Generates a master Excel file from the current database state.
    Support two modes via query parameter: type=template or type=master
    """
    export_type = request.query_params.get('type', 'template')
    if export_type == 'template':
        return download_asset_template(request)
    if export_type != 'master':
        return Response({'error': 'Choose template or master export.'}, status=400)
    assets = Asset.objects.filter(is_temporary=False).exclude(stock_kind='led_case').select_related('assigned_to', 'parent_asset')  # BUG J-13: Exclude temp assets from export
    owner = request.query_params.get('subrental_company_id')
    if owner and owner != 'null':
        if not owner.isdigit():
            return Response({'error': 'Choose a valid supplier company.'}, status=400)
        assets = assets.filter(subrental_company_id=owner)
    else:
        assets = assets.filter(subrental_company__isnull=True)
    query = request.query_params.get('search', '').strip()
    if query:
        assets = assets.filter(Q(alias_name__icontains=query) | Q(sku__icontains=query) |
                               Q(serial_number__icontains=query) | Q(description__icontains=query))
    data = []
    
    for a in assets:
        row = {
            'SKU': a.sku or "",
            'Alias Name': a.alias_name or "",
            'MAC Address': a.mac_address or "",
            'IMEI Number 1': a.imei_number_1 or "",
            'IMEI Number 2': a.imei_number_2 or "",
            'Serial Number': a.serial_number or "",
            'Description': a.description or "",
            'Is Barcode added': 'Yes' if a.is_barcode_added else 'No',
            'Type': a.type or "",
            'Status': a.status or "Available",
            'Quantity': 1, # When exploding, each row represents 1 physical unit
            'Purchased Date': a.purchased_date.strftime('%Y-%m-%d') if a.purchased_date else "",
            'Item Price': float(a.item_price) if a.item_price else 0,
            'Depreciation Percentage': float(a.depreciation_percentage) if a.depreciation_percentage else 0,
            'Available from': a.available_from.strftime('%Y-%m-%d') if a.available_from else "",
            'Available till': a.available_till.strftime('%Y-%m-%d') if a.available_till else "",
            'Barcode Type': a.barcode_type or "",
            'Barcode': a.barcode or "",
            'QR Code': a.qr_code or a.sku or ""
        }
        
        # Explode row based on quantity so that each physical unit has its own row in the Excel
        qty = int(a.quantity or 1)
        for _ in range(qty):
            data.append(row)

    df = pd.DataFrame(data)
    
    output = io.BytesIO()
    filename = "Asset_Inventory_Template.xlsx" if export_type == 'template' else "Master_Inventory_Log.xlsx"
    sheet_nm = "Inventory Template" if export_type == 'template' else "Master Log"

    with pd.ExcelWriter(output, engine='openpyxl') as writer:
        df.to_excel(writer, index=False, sheet_name=sheet_nm)
    
    output.seek(0)
    
    response = HttpResponse(
        output.read(),
        content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    response['Content-Disposition'] = f'attachment; filename="{filename}"'
    return response

from decimal import Decimal

@api_view(['POST'])
def system_recovery(request):
    if not request.user.is_superuser:
        return Response({'error': 'Unauthorized'}, status=403)
    return Response({'error': 'controlled_release_required',
                     'message': 'Database schema changes require the controlled release workflow. No migration was run.'}, status=409)


# ---------- New endpoint: permanently delete ad‑hoc assets ----------
