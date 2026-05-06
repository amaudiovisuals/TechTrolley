
from django.shortcuts import render, redirect, get_object_or_404
from django.http import HttpResponse
from .models import Asset, Conference, DeliveryChallan, Employee, CompanySettings
from django.core.files.uploadedfile import UploadedFile
from .forms import AssetForm, ConferenceForm
from reportlab.pdfgen import canvas
import io
import pandas as pd

def dashboard(request):
    total_assets = Asset.objects.count()
    assets_in_use = Asset.objects.filter(status='In Use').count()
    assets_available = Asset.objects.filter(status='Available').count()
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

@api_view(['GET', 'POST'])
def asset_list(request):
    if request.method == 'GET':
        from django.db.models import OuterRef, Subquery
        from django.db.models.functions import Coalesce
        from .models import Conference
        from django.db.models import Value

        # Optimized subqueries to get the current conference name without N+1 hits
        assigned_qs = Conference.objects.filter(assets=OuterRef('pk')).values('name')[:1]
        crosscheck_qs = Conference.objects.filter(crosscheck_assets=OuterRef('pk')).values('name')[:1]

        # Filter by subrental company if provided
        subrental_company_id = request.query_params.get('subrental_company_id')
        
        assets_query = Asset.objects.annotate(
            annotated_conference=Coalesce(Subquery(assigned_qs), Subquery(crosscheck_qs), Value(None))
        ).select_related('assigned_to', 'parent_asset').prefetch_related(
            'sub_assets',
            'sub_assets__assigned_to',
            'assigned_conferences',
            'ticket_items__ticket__conference'
        )

        # Exclude temporary items created inside subrental tickets from all inventory views
        assets_query = assets_query.filter(is_temporary=False)

        if subrental_company_id:
            if subrental_company_id == 'null':
                assets_query = assets_query.filter(subrental_company__isnull=True)
            else:
                assets_query = assets_query.filter(subrental_company_id=subrental_company_id)
        else:
            # By default, show ONLY our main inventory
            assets_query = assets_query.filter(subrental_company__isnull=True)

        from django.db.models.functions import Coalesce, Lower
        assets = assets_query.annotate(
            sort_name=Lower(Coalesce('alias_name', 'sku'))
        ).order_by('sort_name')
        
        serializer = AssetSerializer(assets, many=True)
        return Response(serializer.data)
    elif request.method == 'POST':
        serializer = AssetSerializer(data=request.data)
        if serializer.is_valid():
            serializer.save()
            return Response(serializer.data, status=201)
        return Response(serializer.errors, status=400)

@api_view(['GET', 'PUT', 'PATCH', 'DELETE'])
def asset_detail(request, pk):
    asset = get_object_or_404(Asset, pk=pk)

    if request.method == 'GET':
        serializer = AssetSerializer(asset)
        return Response(serializer.data)

    elif request.method in ['PUT', 'PATCH']:
        partial = (request.method == 'PATCH')
        
        # Handle system user assignment (bridging to Employee record)
        assigned_to = request.data.get('assigned_to')
        if assigned_to and isinstance(assigned_to, str) and assigned_to.startswith('u-'):
            user_id = assigned_to.split('-')[1]
            from django.contrib.auth.models import User
            from .models import Employee
            u = get_object_or_404(User, pk=user_id)
            # Find or create matching employee
            emp, created = Employee.objects.get_or_create(
                email=u.email,
                defaults={
                    'name': u.email.split('@')[0].upper(),
                    'employee_id': f"SYS-{u.id}",
                    'department': 'Management',
                    'phone': '-',
                    'role': u.profile.role if hasattr(u, 'profile') else 'admin'
                }
            )
            # Update the request data to use the actual Employee ID
            data = request.data.copy()
            data['assigned_to'] = emp.id
            serializer = AssetSerializer(asset, data=data, partial=partial)
        else:
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
        asset.delete()
        return Response(status=204)

@api_view(['GET', 'POST'])
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
        if child.pk == parent.pk:
            return Response({'error': 'An asset cannot be its own sub-asset'}, status=400)
        child.parent_asset = parent
        child.save()
        serializer = AssetSerializer(parent)
        return Response(serializer.data)

@api_view(['DELETE'])
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
    p.drawString(100, 760, f"Date: {conference.start_date}")
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
@permission_classes([AllowAny])
def download_conference_pdf(request, conference_id):
    """
    Forces the download of an uploaded logistics PDF instead of opening it in a tab.
    """
    conference = get_object_or_404(Conference, id=conference_id)
    if not conference.pdf_document:
        return Response({'detail': 'No document attached to this conference'}, status=404)
        
    path = conference.pdf_document.path
    if not os.path.exists(path):
        return Response({'detail': 'File not found on server'}, status=404)
        
    filename = os.path.basename(path)
    with open(path, 'rb') as f:
        response = HttpResponse(f.read(), content_type='application/pdf')
        response['Content-Disposition'] = f'attachment; filename=\"{filename}\"'
        return response

from rest_framework.decorators import api_view

@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
def employee_list(request):
    if request.method == 'GET':
        employees = Employee.objects.all()
        serializer = EmployeeSerializer(employees, many=True)
        return Response(serializer.data)
    elif request.method == 'POST':
        serializer = EmployeeSerializer(data=request.data)
        if serializer.is_valid():
            employee = serializer.save()
            
            # Check if an auth.User needs to be provisioned for this Employee
            password = request.data.get('password')
            if password and employee.email:
                from django.contrib.auth.models import User
                if not User.objects.filter(username=employee.email).exists():
                    User.objects.create_user(username=employee.email, email=employee.email, password=password, is_staff=False)
                    
            return Response(serializer.data, status=201)
        return Response(serializer.errors, status=400)

@api_view(['GET', 'PUT', 'DELETE'])
@permission_classes([IsAuthenticated])
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
        employee.delete()
        return Response(status=204)



@api_view(['GET', 'POST'])
@permission_classes([AllowAny])
def company_settings(request):
    from .serializers import CompanySettingsSerializer
    try:
        # Ensure there's at least one settings object
        settings_obj, created = CompanySettings.objects.get_or_create(pk=1)

        if request.method == 'GET':
            serializer = CompanySettingsSerializer(settings_obj, context={'request': request})
            return Response(serializer.data)
        
        elif request.method == 'POST':
            # ONLY Authenticated users can change settings
            if not request.user or not request.user.is_authenticated:
                 return Response({"detail": "Authentication credentials were not provided."}, status=401)
            
            # Convert QueryDict to a regular dict to allow injecting parsed objects
            if hasattr(request.data, 'dict'):
                data = request.data.dict()
            else:
                data = request.data.copy()
            
            # Logo management
            if 'logo' in data:
                logo_val = data.get('logo')
                if not isinstance(logo_val, UploadedFile):
                    # If it's a string (URL) or empty, we handle it
                    if not logo_val:
                         # Explicitly clearing the logo
                         if settings_obj.logo:
                             settings_obj.logo.delete(save=False)
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

    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        print(f"ERROR IN COMPANY_SETTINGS: {tb}")
        return Response({"error": str(e), "detail": tb if settings.DEBUG else "Check server logs"}, status=500)


import pandas as pd
from rest_framework.parsers import MultiPartParser, FormParser

@api_view(['POST'])
def bulk_upload_assets(request):
    """
    Handle bulk upload of assets via CSV or Excel.
    Re-uploading the same file skips existing records (matched by Serial Number) — no errors on duplicates.
    """
    if 'file' not in request.FILES:
        return Response({'error': 'No file provided'}, status=400)

    file = request.FILES['file']

    try:
        if file.name.endswith(('.xls', '.xlsx')):
            df = pd.read_excel(file)
        else:
            return Response({'error': 'Unsupported file format. Please upload ONLY Excel Workbook (.xlsx) files.'}, status=400)

        import math, traceback

        # ── Helpers (defined ONCE outside the row loop) ────────────────────
        def col(candidates, fallback):
            """Find the first matching column name from candidates list."""
            for c in df.columns:
                if str(c).strip().lower() in candidates:
                    return c
            return fallback

        from decimal import Decimal, InvalidOperation as DecimalInvalidOperation, ROUND_HALF_UP

        def safe_decimal(val, default=Decimal('0.00')):
            """Return a Decimal object. Django 6 DecimalField on SQLite needs Decimal, not float.
            Float values get stored as REAL and cause InvalidOperation on read-back."""
            try:
                v = float(val)
                if math.isnan(v) or math.isinf(v):
                    return default
                # Quantize to 2dp — matches DecimalField(decimal_places=2)
                return Decimal(str(round(v, 2))).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
            except (TypeError, ValueError, DecimalInvalidOperation):
                return default


        def safe_str(val):
            """Convert to string, returning '' for nan/None."""
            s = str(val).strip()
            return '' if s.lower() in ('nan', 'none', 'nat') else s

        def parse_date(val):
            if not val or str(val).lower() in ('nan', 'none', 'nat', ''):
                return None
            try:
                return pd.to_datetime(val).date()
            except Exception:
                return None

        # ── Resolve column names ONCE ───────────────────────────────────────
        sku_col        = col(['sku'], 'SKU')
        alias_col      = col(['alias name', 'alias_name'], 'Alias Name')
        mac_col        = col(['mac address', 'mac_address'], 'MAC Address')
        imei1_col      = col(['imei number 1', 'imei1'], 'IMEI Number 1')
        imei2_col      = col(['imei number 2', 'imei2'], 'IMEI Number 2')
        serial_col     = col(['serial number', 'serial'], 'Serial Number')
        desc_col       = col(['description'], 'Description')
        bc_added_col   = col(['is barcode added', 'barcode_added'], 'Is Barcode added')
        type_col       = col(['type', 'category'], 'Type')
        purchase_col   = col(['purchased date', 'purchased_date'], 'Purchased Date')
        price_col      = col(['item price', 'price'], 'Item Price')
        deprec_col     = col(['depreciation percentage', 'depreciation'], 'Depreciation Percentage')
        avail_from_col = col(['available from', 'available_from'], 'Available from')
        avail_till_col = col(['available till', 'available_till'], 'Available till')
        bc_type_col    = col(['barcode type'], 'Barcode Type')
        barcode_col    = col(['barcode'], 'Barcode')
        qr_code_col    = col(['qr code'], 'QR Code')
        qty_col        = col(['quantity', 'qty'], 'Quantity')

        # ── Category Mapping Logic ──────────────────────────────────────────
        # Standardize incoming values to the new 6-7 categories
        base_map = {c[1].lower(): c[0] for c in Asset.CATEGORY_CHOICES}
        
        # Legacy/Fuzzy overrides (Mapping to valid DB types)
        fuzzy_overrides = {
            'speakers & audio': 'Speakers & Audio', 'audio mixers': 'Audio Mixers', 'microphones': 'Microphones',
            'laptops': 'Laptops', 'smartphones': 'Smartphones', 'computers & servers': 'Computers & Servers',
            'peripherals': 'IT & Networking', 'ups & power': 'UPS & Power', 'printers': 'Printers',
            'monitors': 'Monitors', 'tvs': 'TVs', 'projectors': 'Projectors',
            'video switchers': 'Video Switchers', 'capture cards': 'Capture Cards', 'cameras': 'Cameras',
            'splitters & converters': 'Splitters & Converters', 'consumables': 'Consumables', 'cable': 'Cable',
            'lighting & led': 'Lighting & LED', 'lighting & effects': 'Lighting & LED'
        }

        def normalize_type(raw):
            low = str(raw).lower().strip()
            if low in base_map: return base_map[low]
            if low in fuzzy_overrides: return fuzzy_overrides[low]
            # Partial matches
            for key, val in fuzzy_overrides.items():
                if key in low or low in key: return val
            return 'Other'


        # ── Process rows ─────────────────────────────────────────────────────
        created_count = 0
        updated_count = 0
        errors = []

        for index, row in df.iterrows():
            try:
                # Skip completely empty rows
                if row.isnull().all():
                    continue

                serial = safe_str(row.get(serial_col, ''))
                sku_val = safe_str(row.get(sku_col, ''))
                
                if not serial:
                    if sku_val:
                        serial = sku_val
                    else:
                        # Only report error if the row is not completely empty (redundant check but safe)
                        if not all(safe_str(v) == '' for v in row.values):
                            errors.append(f"Row {index+2}: Missing both Serial Number and SKU — skipped")
                        continue

                # Normalize type
                raw_type = safe_str(row.get(type_col, 'Other'))
                normalized_type = normalize_type(raw_type)

                barcode_type_val = safe_str(row.get(bc_type_col, ''))
                barcode_val      = safe_str(row.get(barcode_col, ''))
                qr_code_val      = safe_str(row.get(qr_code_col, ''))
                barcode_added    = bool(qr_code_val or barcode_val) or \
                                   safe_str(row.get(bc_added_col, '')).lower() in ['yes', 'true', '1', 'y']
                desc             = safe_str(row.get(desc_col, ''))
                
                # Check for subrental company context
                subrental_company_id = request.data.get('subrental_company_id')

                # Depreciation — handle "%" strings and Excel 0-1 float representation
                raw_deprec = row.get(deprec_col, 0)
                if isinstance(raw_deprec, str):
                    deprec_val = safe_decimal(raw_deprec.replace('%', '').strip() or 0)
                elif isinstance(raw_deprec, (int, float)):
                    deprec_val = safe_decimal(raw_deprec * 100) if 0 < raw_deprec <= 1.0 else safe_decimal(raw_deprec)
                else:
                    deprec_val = 0.0

                defaults = {
                    'sku':                    safe_str(row.get(sku_col, serial)) or serial,
                    'alias_name':             safe_str(row.get(alias_col, '')),
                    'mac_address':            safe_str(row.get(mac_col, '')),
                    'imei_number_1':          safe_str(row.get(imei1_col, '')),
                    'imei_number_2':          safe_str(row.get(imei2_col, '')),
                    'serial_number':          serial,
                    'description':            desc,
                    'is_barcode_added':       barcode_added,
                    'barcode':                barcode_val,
                    'barcode_type':           barcode_type_val,
                    'qr_code':                qr_code_val,
                    'type':                   normalized_type,
                    'item_price':             safe_decimal(row.get(price_col, 0)),
                    'depreciation_percentage': deprec_val,
                    'purchased_date':         parse_date(row.get(purchase_col)),
                    'available_from':         parse_date(row.get(avail_from_col)),
                    'available_till':         parse_date(row.get(avail_till_col)),
                    'condition':              'Good',
                    'quantity':               int(row.get(qty_col, 1)) if not math.isnan(float(row.get(qty_col, 1))) else 1,
                    'subrental_company_id':   subrental_company_id
                }

                # UPDATE OR CREATE asset based on serial number
                asset, created = Asset.objects.update_or_create(
                    serial_number=serial,
                    defaults=defaults
                )
                if created:
                    created_count += 1
                else:
                    updated_count += 1


            except Exception as e:
                tb = traceback.format_exc()
                print(f"[bulk_upload] Row {index+2} error: {tb}")
                errors.append(f"Row {index+2}: {str(e)}")

        return Response({
            'created': created_count,
            'updated': updated_count,
            'skipped': 0,
            'errors': errors,
            'message': f'{created_count} asset(s) created, {updated_count} updated.'
        }, status=200)

    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        print(f"[bulk_upload] Top-level error: {tb}")
        return Response({'error': str(e), 'detail': tb}, status=500)


# from rest_framework.permissions import AllowAny
# from rest_framework.decorators import permission_classes
from rest_framework.authtoken.models import Token as AuthToken

@api_view(['POST'])
@permission_classes([IsAuthenticated])
def asset_assign_quantity(request, pk):
    asset = get_object_or_404(Asset, pk=pk)
    quantity_to_assign = int(request.data.get('quantity', 0))
    conference_id = request.data.get('conference_id')
    
    if quantity_to_assign <= 0:
        return Response({'error': 'Quantity must be greater than 0'}, status=400)
    
    if quantity_to_assign > asset.quantity:
        return Response({'error': 'Not enough quantity available'}, status=400)
    
    conference = get_object_or_404(Conference, pk=conference_id)
    
    # If it's a full assignment of an available item, just update status
    # BUT if it's already "In Use" or "Crosscheck" (somehow scanned again), we might want to split or add.
    # To keep it simple: always split or create a new "In Use" record if it's coming from "Available".
    
    if quantity_to_assign == asset.quantity and asset.status == 'Available':
        # Full assignment of an Available asset
        asset.status = 'In Use'
        asset.save()
        conference.assets.add(asset)
        return Response(AssetSerializer(asset).data)
    else:
        # Partial assignment: split the record
        # 1. Create a new record for the assigned portion
        new_asset = Asset(
            sku=asset.sku,
            alias_name=asset.alias_name,
            mac_address=asset.mac_address,
            imei_number_1=asset.imei_number_1,
            imei_number_2=asset.imei_number_2,
            serial_number=asset.serial_number,
            description=asset.description,
            is_barcode_added=asset.is_barcode_added,
            barcode=asset.barcode,
            barcode_type=asset.barcode_type,
            qr_code=asset.qr_code,
            type=asset.type,
            quantity=quantity_to_assign,
            item_price=asset.item_price,
            depreciation_percentage=asset.depreciation_percentage,
            status='In Use',
            condition=asset.condition,
            parent_asset=asset.parent_asset
        )
        new_asset.save()
        
        # 2. Update the original record
        asset.quantity -= quantity_to_assign
        if asset.quantity == 0:
            # If we took all from a record that wasn't "Available" initially (unlikely in current flow)
            # or if we want to delete empty records. Let's keep it for now.
            pass
        asset.save()
        
        # 3. Add to conference
        conference.assets.add(new_asset)
        
        return Response(AssetSerializer(new_asset).data)

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
    assets = Asset.objects.all().select_related('assigned_to', 'parent_asset')
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
    """
    One-click database repair: runs migrations and restores key assignments.
    """
    if not request.user.is_staff:
        return Response({"error": "Unauthorized"}, status=403)
    
    # Run migrations to fix missing columns/tables on live site
    from django.core.management import call_command
    try:
        call_command('migrate', interactive=False)
        migration_error = None
    except Exception as e:
        migration_error = str(e)
        
    assignments = {
        'NHQLTSI006338035C47600': {'name': 'BHAVIN', 'dept': 'USER', 'sku': 'LAPTOP-BH-1'},
        'NHQLTSI005336025607600': {'name': 'BHAVIN', 'dept': 'USER', 'sku': 'LAPTOP-BH-2'},
        'MNWJK9R63F': {'name': 'JITHIN RAMESH', 'dept': 'USER', 'sku': 'LAPTOP-JR-1'},
        'D2507N0000517': {'name': 'JISHNU K P', 'dept': 'USER', 'sku': 'LAPTOP-JKP-1'},
        '5CD52409KL': {'name': 'NIHAL', 'dept': 'MANAGEMENT', 'sku': 'LAPTOP-NIHAL-1'},
        'D2507N0000644': {'name': 'BHAVIN', 'dept': 'USER', 'sku': 'LAPTOP-BH-3'},
        'FVFY84UXHV22': {'name': 'RIYAN', 'dept': 'MANAGEMENT', 'sku': 'LAPTOP-RIYAN-1'}
    }

    recovered_count = 0
    assigned_count = 0

    for sn, info in assignments.items():
        # Get or create employee
        emp_id = info['name'].replace(" ", "_").upper()
        emp, created = Employee.objects.get_or_create(
            employee_id=emp_id,
            defaults={
                'name': info['name'], 
                'department': info['dept'], 
                'email': f"{emp_id.lower()}@techtrolley.amaudiovisuals.com",
                'phone': '0000000000'
            }
        )

        # Check if asset exists by SN or SKU
        asset = Asset.objects.filter(serial_number=sn).first()
        if not asset:
            asset = Asset.objects.filter(sku=info['sku']).first()

        if not asset:
            # Re-create missing asset
            Asset.objects.create(
                sku=info['sku'],
                serial_number=sn,
                alias_name=f"Laptop - {info['name']}",
                type='Laptops',
                description=f"Recovered laptop for {info['name']}",
                status='Available',
                item_price=Decimal('0.00'),
                assigned_to=emp
            )
            recovered_count += 1
        else:
            # Update assignment if missing
            if asset.assigned_to != emp:
                asset.assigned_to = emp
                asset.save()
                assigned_count += 1

    return Response({
        "message": "Recovery complete!" if not migration_error else f"Recovery partial: {migration_error}",
        "migrations_applied": not bool(migration_error),
        "recovered": recovered_count,
        "assigned": assigned_count,
        "total_assets": Asset.objects.count()
    })

@api_view(['POST', 'GET'])
@permission_classes([AllowAny]) # Allow easy triggering via browser for now
def ad_hoc_cleanup(request):
    """
    Cleans up the 775 'In Use' items and marks ad-hoc items as temporary on the live DB.
    """
    from django.db.models import Count
    from .models import Asset, Conference

    # 1. Reset 'In Use' status for assets not currently assigned to any conference
    assigned_ids = set(Conference.objects.values_list('assets', flat=True))
    in_use_but_not_assigned = Asset.objects.filter(status='In Use').exclude(id__in=assigned_ids)
    count_reset = in_use_but_not_assigned.update(status='Available')

    # 2. Mark Ad-hoc items as temporary
    adhoc_by_sku = Asset.objects.filter(sku__startswith='ADHOC-')
    count_adhoc = adhoc_by_sku.update(is_temporary=True)

    # 3. Handle the '775' issue: Force reset all remaining 'In Use' assets per user request
    all_in_use = Asset.objects.filter(status='In Use')
    remaining_reset = all_in_use.count()
    if remaining_reset > 0:
        all_in_use.update(status='Available')

    total_now = Asset.objects.count()
    inventory_assets = Asset.objects.filter(is_temporary=False).count()

    return Response({
        "message": "Cleanup complete!",
        "reset_unassigned": count_reset,
        "marked_temporary": count_adhoc,
        "force_reset_remaining_in_use": remaining_reset,
        "total_assets_in_db": total_now,
        "visible_inventory_assets": inventory_assets
    })
