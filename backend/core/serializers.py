"""
Serializers for the TechTrolley core application.
Handles data transformation for Assets, Employees, Conferences, Users, and Company Settings.
"""
from django.contrib.auth.models import User
from django.db import OperationalError, transaction
from rest_framework import serializers

from .models import Asset, Employee, Conference, CompanySettings, SubrentalCompany, SubrentalTicket, SubrentalTicketItem, TruckChallan

class SubrentalCompanySerializer(serializers.ModelSerializer):
    def validate(self, data):
        if 'inventory_mode' in self.initial_data:
            raise serializers.ValidationError({'inventory_mode': 'Use reviewed inventory classification; it does not change ownership or stock.'})
        return data

    class Meta:
        model = SubrentalCompany
        fields = '__all__'
        read_only_fields = ['inventory_mode', 'ownership_revision']

class EmployeeSerializer(serializers.ModelSerializer):
    employee_id = serializers.CharField(required=False, allow_blank=True)
    department = serializers.CharField(required=False, allow_blank=True)
    phone = serializers.CharField(required=False, allow_blank=True)
    role = serializers.CharField(required=False, allow_blank=True)

    class Meta:
        model = Employee
        fields = '__all__'
        read_only_fields = ['user', 'identity_revision']

    def validate(self, data):
        for field, current in [('user', self.instance.user_id if self.instance else None), ('identity_revision', self.instance.identity_revision if self.instance else 0)]:
            if field in self.initial_data and self.initial_data[field] != current:
                raise serializers.ValidationError({field:'Use the reviewed employee-link command.'})
        return data

    def create(self, validated_data):
        import time
        if not validated_data.get('employee_id'):
            validated_data['employee_id'] = f"EMP-{int(time.time() * 1000)}"
        if not validated_data.get('role'):
            validated_data['role'] = 'technician'
        if not validated_data.get('department'):
            role = validated_data.get('role', 'technician')
            dept_map = {
                'admin': 'Management',
                'boss': 'Executive',
                'godown_incharge': 'Warehouse',
                'accounts': 'Accounts',
                'technician': 'Operations'
            }
            validated_data['department'] = dept_map.get(role, 'User')
        if not validated_data.get('phone'):
            validated_data['phone'] = 'N/A'
        return super().create(validated_data)

class TruckChallanSerializer(serializers.ModelSerializer):
    assets = serializers.PrimaryKeyRelatedField(
        many=True, queryset=Asset.objects.all()
    )
    class Meta:
        model = TruckChallan
        fields = ['id', 'conference', 'truck_number', 'label', 'vehicle_number', 'driver_phone', 'assets', 'asset_quantities', 'created_at']

class SimpleAssetSerializer(serializers.ModelSerializer):
    warehouse_managed = serializers.SerializerMethodField()
    subrental_inventory_mode = serializers.ReadOnlyField(source='subrental_company.inventory_mode')
    def get_warehouse_managed(self, obj):
        from .inventory_ownership import warehouse_managed
        return warehouse_managed(obj)

    subrental_company_name = serializers.ReadOnlyField(source='subrental_company.name')
    """
    Ultra-lightweight Asset Serializer for embedded challan & truck asset representations.
    Excludes expensive relations (deployment_history, sub_assets, current_conference_name)
    to eliminate N+1 query storms and ensure lightning-fast response times.
    """
    class Meta:
        model = Asset
        read_only_fields = ['staff_revision', 'custody_revision', 'ownership_revision']
        fields = [
            'id', 'sku', 'alias_name', 'serial_number', 'type', 'quantity',
            'item_price', 'barcode_type', 'barcode', 'qr_code', 'description', 'status',
            'subrental_company', 'subrental_company_name', 'warehouse_managed', 'subrental_inventory_mode', 'mac_address', 'imei_number_1', 'imei_number_2',
            'purchased_date', 'depreciation_percentage', 'current_value'
        ]

class SubAssetSerializer(serializers.ModelSerializer):
    assigned_to_name = serializers.ReadOnlyField(source='assigned_to.name')
    current_conference_name = serializers.SerializerMethodField()

    class Meta:
        model = Asset
        fields = [
            'id', 'sku', 'alias_name', 'serial_number', 'type', 'quantity',
            'status', 'flag', 'condition', 'barcode_type', 'barcode', 'qr_code', 'assigned_to', 'assigned_to_name',
            'parent_asset', 'current_conference_name', 'subrental_company',
        ]

    def get_current_conference_name(self, obj):
        from .custody import current_conference_name
        return current_conference_name(obj)

class AssetSerializer(serializers.ModelSerializer):
    warehouse_managed = serializers.SerializerMethodField()
    subrental_inventory_mode = serializers.ReadOnlyField(source='subrental_company.inventory_mode')
    def get_warehouse_managed(self, obj):
        from .inventory_ownership import warehouse_managed
        return warehouse_managed(obj)

    subrental_company_name = serializers.ReadOnlyField(source='subrental_company.name')
    quantity_available = serializers.SerializerMethodField()
    quantity_tracking = serializers.SerializerMethodField()
    assigned_to_name = serializers.ReadOnlyField(source='assigned_to.name')
    sub_assets = SubAssetSerializer(many=True, read_only=True)
    current_conference_name = serializers.SerializerMethodField()
    parent_asset = serializers.PrimaryKeyRelatedField(
        queryset=Asset.objects.all(), allow_null=True, required=False
    )
    deployment_history = serializers.SerializerMethodField()
    # Serial number is optional — not every asset has one at registration time
    serial_number = serializers.CharField(required=False, allow_blank=True, allow_null=True, default='')

    class Meta:
        model = Asset
        read_only_fields = ['staff_revision', 'custody_revision']
        fields = [
            'id', 'sku', 'alias_name', 'mac_address', 'imei_number_1', 'imei_number_2', 
            'serial_number', 'description', 'is_barcode_added', 'type', 'quantity',
            'purchased_date', 'item_price', 'depreciation_percentage', 
            'available_from', 'available_till', 'created_at',
            'barcode_type', 'barcode', 'qr_code', 'status', 'flag', 'condition', 'last_maintained', 
            'current_venue', 'return_date', 'assigned_to', 'assigned_to_name',
            'parent_asset', 'sub_assets', 'current_conference_name', 'subrental_company', 'subrental_company_name', 'warehouse_managed', 'subrental_inventory_mode', 'deployment_history',
            'is_temporary', 'quantity_tracking', 'quantity_available', 'staff_revision', 'custody_revision', 'ownership_revision',
        ]

    def get_quantity_tracking(self, obj):
        from .quantity_commands import is_quantity_stock
        return is_quantity_stock(obj)

    def get_quantity_available(self, obj):
        from .custody import available_quantity
        return available_quantity(obj)

    def validate(self, data):
        parent = data.get('parent_asset', self.instance.parent_asset if self.instance else None)
        owner = data.get('subrental_company', self.instance.subrental_company if self.instance else None)
        if parent and (not self.instance or 'parent_asset' in data or 'subrental_company' in data) and parent.subrental_company_id != (owner.pk if owner else None):
            raise serializers.ValidationError({'parent_asset': 'A kit and its components must have the same inventory owner. Use a reviewed complete-kit ownership change.'})
        if parent and self.instance and parent.pk == self.instance.pk:
            raise serializers.ValidationError({'parent_asset': 'An asset cannot be its own kit parent.'})
        if self.instance and 'subrental_company' in data and data['subrental_company'] != self.instance.subrental_company:
            raise serializers.ValidationError({'subrental_company': 'Use a reviewed ownership change; ticket edits cannot move inventory ownership.'})
        if 'assigned_to' in data and data['assigned_to'] != (self.instance.assigned_to if self.instance else None):
            raise serializers.ValidationError({'assigned_to':'Use the recorded staff issue/return command.'})
        if self.instance and self.instance.status in {'In Use', 'Crosscheck'} and data.get('status') == 'Available' and not self.instance.flag and self.instance.condition != 'Damaged':
            from .custody import derived_status
            if derived_status(self.instance) == 'Available':
                raise serializers.ValidationError({'status': 'Use reviewed custody reconciliation to clear an unproved custody lock.'})
        if self.instance and self.instance.staff_allocations.filter(returned_at__isnull=True).exists():
            for field in ('quantity', 'type', 'parent_asset'):
                if field in data and data[field] != getattr(self.instance, field):
                    raise serializers.ValidationError({field:'Return issued equipment before changing its inventory identity.'})
        if self.instance and self.instance.type == 'Consumables' and data.get('quantity', self.instance.quantity) < self.instance.quantity:
            raise serializers.ValidationError({'quantity': 'Use verified consumable settlement or a reviewed stock adjustment.'})
        if self.instance and 'quantity' in data and self.instance.ticket_items.exists():
            from .supplier_balances import order_capacity
            from .asset_commands import CommandError
            try:
                committed_orders = order_capacity(self.instance)
            except CommandError:
                raise serializers.ValidationError({'quantity': 'Legacy supplier orders need review before changing declared capacity.'})
            if data['quantity'] < committed_orders:
                raise serializers.ValidationError({'quantity': 'Declared supplier capacity cannot be below unresolved orders.'})
        if self.instance and self.instance.quantity != 1 and self.instance.type != 'Consumables':
            self.instance.quantity_tracking = True
        if self.instance and (self.instance.quantity_allocations.exists() or self.instance.consumable_allocations.exists()):
            from .quantity_commands import outstanding
            if data.get('quantity', self.instance.quantity) < outstanding(self.instance):
                raise serializers.ValidationError({'quantity': 'Stock cannot be below reserved, dispatched and unchecked units.'})
            for field in ('type', 'parent_asset', 'subrental_company', 'assigned_to'):
                current = getattr(self.instance, field)
                if field in data and data[field] != current:
                    raise serializers.ValidationError({field: 'Quantity history requires a reviewed stock change.'})
        return data

    def update(self, instance, validated_data):
        staff_return = instance.assigned_to_id is not None and 'assigned_to' in validated_data and validated_data['assigned_to'] is None
        result = super().update(instance, validated_data)
        if staff_return:
            from .custody import synchronize_statuses
            synchronize_statuses([result.pk])
            result.refresh_from_db(fields=['status'])
        return result

    def get_current_conference_name(self, obj):
        from .custody import current_conference_name
        return current_conference_name(obj)

    def get_deployment_history(self, obj):
        history = []
        try:
            for conf in obj.assigned_conferences.all():
                history.append({'name': conf.name, 'date': conf.start_date.isoformat() if conf.start_date else None})
            if hasattr(obj, 'ticket_items'):
                for item in obj.ticket_items.select_related('ticket__conference').all():
                    history.append({'name': item.ticket.conference.name, 'date': item.ticket.created_at.isoformat()})
        except: pass
        return sorted(history, key=lambda x: (x['date'] or ''), reverse=True)

    def validate_sku(self, value):
        """
        Enforce SKU uniqueness at the serializer layer (no migration required).
        Allows the same SKU on update (PUT) only if it belongs to the asset being edited.
        If an ad-hoc or temporary asset SKU collides (e.g. ADHOC-106, is_temporary=True),
        automatically resolve the collision by finding a unique SKU so that challan creation
        and editing never crashes on ad-hoc items.
        """
        if not value:
            return value
        qs = Asset.objects.filter(sku__iexact=value)
        # On update, exclude the current instance from the clash check
        if self.instance is not None:
            qs = qs.exclude(pk=self.instance.pk)
        if qs.exists():
            is_temp = False
            if hasattr(self, 'initial_data') and isinstance(self.initial_data, dict):
                is_temp = bool(self.initial_data.get('is_temporary', False))
            if str(value).upper().startswith('ADHOC-') or is_temp:
                import time, random
                candidate = value
                while Asset.objects.filter(sku__iexact=candidate).exists():
                    candidate = f"ADHOC-{int(time.time()) % 1000000}{random.randint(10, 99)}"
                return candidate
            raise serializers.ValidationError("This SKU already exists. Please use a unique SKU.")
        return value


class ConferenceSerializer(serializers.ModelSerializer):
    def validate_pdf_document(self, value):
        if value is None:
            return value
        from .private_media import MAX_PDF_BYTES
        if value.size > MAX_PDF_BYTES or value.size == 0:
            raise serializers.ValidationError('Use a PDF no larger than 20 MB.')
        header = value.read(5)
        value.seek(0)
        if header != b'%PDF-':
            raise serializers.ValidationError('The document must be a PDF.')
        return value

    expected_revision = serializers.IntegerField(required=False, write_only=True, min_value=0)
    class Meta:
        model = Conference
        read_only_fields = ['revision', 'lifecycle_state', 'completed_at', 'completed_by', 'archived_at', 'archived_by']
        fields = '__all__'

    def validate(self, data):
        protected = {'lifecycle_state', 'completed_at', 'completed_by', 'archived_at', 'archived_by'}
        supplied = protected & set(self.initial_data)
        if supplied:
            previous = super().to_representation(self.instance) if self.instance else {}
            for field in supplied:
                if not self.instance or self.initial_data[field] != previous[field]:
                    raise serializers.ValidationError({field: 'Use the verified event lifecycle command.'})
        return data

    def to_representation(self, instance):
        # A failed/missing table is a failed read, never a fabricated empty list.
        data = super().to_representation(instance)
        data['pdf_document'] = f'/api/conferences/{instance.pk}/download-pdf/' if instance.pdf_document else None
        from .challan_documents import document_data
        from .quantity_commands import allocation_data
        data['quantity_allocations'] = {str(a.asset_id): allocation_data(a) for a in instance.quantity_allocations.all()}
        data['quantity_assets_details'] = SimpleAssetSerializer(Asset.objects.filter(
            pk__in=data['quantity_allocations']).select_related('subrental_company').order_by('pk'), many=True).data
        from .consumable_commands import allocation_data as consumable_data
        data['consumable_ledger'] = {str(a.asset_id): consumable_data(a) for a in instance.consumable_allocations.all()}
        consumable_ids = set(data['consumable_ledger'])
        if isinstance(instance.consumable_data, dict):
            consumable_ids.update(instance.consumable_data)
        data['consumable_assets_details'] = SimpleAssetSerializer(Asset.objects.filter(
            pk__in=[int(key) for key in consumable_ids if str(key).isdigit()]).select_related('subrental_company').order_by('pk'), many=True).data
        data['challan_documents'] = [document_data(document) for document in instance.challan_documents.all()]
        from .models import TruckManifest
        from .truck_manifests import manifest_data
        manifest = TruckManifest.objects.filter(conference=instance).first()
        data['truck_manifest'] = manifest_data(manifest) if manifest else None
        data['challan_assets_details'] = SimpleAssetSerializer(instance.challan_assets.select_related('subrental_company'), many=True).data
        data['truck_challans_data'] = [{
            'id': truck.pk, 'conference': instance.pk, 'truck_number': truck.truck_number,
            'label': truck.label or f'Truck {truck.truck_number}',
            'vehicle_number': truck.vehicle_number or '', 'driver_phone': truck.driver_phone or '',
            'challan_number': truck.challan_number or '',
            'assets': list(truck.assets.values_list('pk', flat=True)),
            'asset_quantities': truck.asset_quantities or {},
            'assets_details': SimpleAssetSerializer(truck.assets.select_related('subrental_company'), many=True).data,
            'created_at': truck.created_at.isoformat() if truck.created_at else '',
        } for truck in instance.truck_challans.all().order_by('truck_number')]
        return data

    @transaction.atomic
    def create(self, validated_data):
        validated_data.pop('expected_revision', None)
        assets_data = validated_data.pop('assets', [])
        requirements_data = validated_data.pop('requirements', [])
        crosscheck_data = validated_data.pop('crosscheck_assets', [])
        challan_data = validated_data.pop('challan_assets', [])
        staged_data = validated_data.pop('staged_assets', [])
        employees_data = validated_data.pop('assigned_employees', [])
        
        pdf_doc = validated_data.get('pdf_document')
        if isinstance(pdf_doc, str): validated_data.pop('pdf_document')

        # J-112: Auto-assign challan number in structured format e.g. "26-27/AMDL-00122"
        # generate_challan_number() handles FY detection, per-FY reset, and counter increment atomically.
        from .challan_documents import allocate_number, reserve_number
        if not validated_data.get('challan_number'):
            validated_data['challan_number'] = allocate_number()
            
        conference = Conference.objects.create(**validated_data)
        from .asset_commands import CommandError
        try:
            reserve_number(conference.challan_number, conference, None)
        except CommandError as error:
            raise serializers.ValidationError({'challan_number': error.code})
        
        if assets_data: conference.assets.set(assets_data)
        if crosscheck_data: conference.crosscheck_assets.set(crosscheck_data)
        if challan_data: conference.challan_assets.set(challan_data)
        if staged_data: conference.staged_assets.set(staged_data)
        if requirements_data:
            try:
                conference.requirements.set(requirements_data)
            except Exception:
                pass 
        if employees_data: conference.assigned_employees.set(employees_data)
            
        return conference

    @transaction.atomic
    def update(self, instance, validated_data):
        validated_data.pop('expected_revision', None)
        if 'challan_number' in validated_data and validated_data['challan_number'] != instance.challan_number:
            from .challan_documents import reserve_number
            from .asset_commands import CommandError
            try:
                validated_data['challan_number'] = reserve_number(validated_data['challan_number'], instance, None)
            except CommandError as error:
                raise serializers.ValidationError({'challan_number': error.code})
        assets_data = validated_data.pop('assets', None)
        requirements_data = validated_data.pop('requirements', None)
        crosscheck_data = validated_data.pop('crosscheck_assets', None)
        challan_data = validated_data.pop('challan_assets', None)
        staged_data = validated_data.pop('staged_assets', None)
        employees_data = validated_data.pop('assigned_employees', None)
        
        pdf_doc = validated_data.get('pdf_document')
        if isinstance(pdf_doc, str): validated_data.pop('pdf_document')
        
        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        instance.save()

        if assets_data is not None: instance.assets.set(assets_data)
        if crosscheck_data is not None: instance.crosscheck_assets.set(crosscheck_data)
        if challan_data is not None: instance.challan_assets.set(challan_data)
        if staged_data is not None: instance.staged_assets.set(staged_data)
        if requirements_data is not None:
            try:
                instance.requirements.set(requirements_data)
            except Exception:
                pass 
        if employees_data is not None: instance.assigned_employees.set(employees_data)

        return instance


class UserSerializer(serializers.ModelSerializer):
    role = serializers.CharField(source='profile.role', read_only=True)
    class Meta:
        model = User
        fields = ['id', 'email', 'date_joined', 'is_staff', 'role']


class RasterLogoField(serializers.ImageField):
    def to_internal_value(self, data):
        from .upload_safety import raster_logo
        raster_logo(data)
        return super().to_internal_value(data)


class CompanySettingsSerializer(serializers.ModelSerializer):
    logo = RasterLogoField(required=False, allow_null=True)
    def to_representation(self, instance):
        data = super().to_representation(instance)
        data['logo'] = '/api/public-logo/' if instance.logo else None
        return data

    class Meta:
        model = CompanySettings
        fields = '__all__'
class SubrentalTicketItemSerializer(serializers.ModelSerializer):
    supplier_balance = serializers.SerializerMethodField()
    def get_supplier_balance(self, obj):
        from .supplier_balances import balance_data
        return balance_data(obj)
    asset_details = AssetSerializer(source='asset', read_only=True)
    asset_name = serializers.SerializerMethodField()

    class Meta:
        model = SubrentalTicketItem
        fields = ['id', 'ticket', 'asset', 'asset_details', 'asset_name', 'rental_price', 'quantity', 'supplier_balance']

    def get_asset_name(self, obj):
        if obj.asset:
            return obj.asset.alias_name or obj.asset.name or obj.asset.sku or "Unnamed Subrental Item"
        return "Unknown Asset"

class SubrentalTicketSerializer(serializers.ModelSerializer):
    items = SubrentalTicketItemSerializer(many=True, read_only=True)
    company_name = serializers.ReadOnlyField(source='company.name')
    conference_name = serializers.ReadOnlyField(source='conference.name')
    conference_revision = serializers.ReadOnlyField(source='conference.revision')
    class Meta:
        model = SubrentalTicket
        fields = ['id', 'company', 'company_name', 'conference', 'conference_name', 'conference_revision', 'created_at', 'available_from', 'available_till', 'items']
