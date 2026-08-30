"""
Serializers for the TechTrolley core application.
Handles data transformation for Assets, Employees, Conferences, Users, and Company Settings.
"""
from django.contrib.auth.models import User
from django.db import OperationalError
from rest_framework import serializers

from .models import Asset, Employee, Conference, CompanySettings, SubrentalCompany, SubrentalTicket, SubrentalTicketItem, TruckChallan

class SubrentalCompanySerializer(serializers.ModelSerializer):
    class Meta:
        model = SubrentalCompany
        fields = '__all__'

class EmployeeSerializer(serializers.ModelSerializer):
    class Meta:
        model = Employee
        fields = '__all__'

class TruckChallanSerializer(serializers.ModelSerializer):
    assets = serializers.PrimaryKeyRelatedField(
        many=True, queryset=Asset.objects.all()
    )
    class Meta:
        model = TruckChallan
        fields = ['id', 'conference', 'truck_number', 'label', 'vehicle_number', 'driver_phone', 'assets', 'created_at']

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
        if hasattr(obj, 'annotated_conference'):
            return obj.annotated_conference
        conf = obj.assigned_conferences.first() or obj.crosscheck_conferences.first()
        return conf.name if conf else None

class AssetSerializer(serializers.ModelSerializer):
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
        fields = [
            'id', 'sku', 'alias_name', 'mac_address', 'imei_number_1', 'imei_number_2', 
            'serial_number', 'description', 'is_barcode_added', 'type', 'quantity',
            'purchased_date', 'item_price', 'depreciation_percentage', 
            'available_from', 'available_till', 'created_at',
            'barcode_type', 'barcode', 'qr_code', 'status', 'flag', 'condition', 'last_maintained', 
            'current_venue', 'return_date', 'assigned_to', 'assigned_to_name',
            'parent_asset', 'sub_assets', 'current_conference_name', 'subrental_company', 'deployment_history',
            'is_temporary',
        ]

    def get_current_conference_name(self, obj):
        if hasattr(obj, 'annotated_conference'):
            return obj.annotated_conference
        conf = obj.assigned_conferences.first() or obj.crosscheck_conferences.first()
        if conf: return conf.name
        
        try:
            ticket_item = obj.ticket_items.select_related('ticket__conference').first()
            if ticket_item: return ticket_item.ticket.conference.name
        except: pass
        return None

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
    class Meta:
        model = Conference
        fields = '__all__'

    def to_representation(self, instance):
        # Professional Database Shield: If new tables are missing from the DB (e.g. after a git pull 
        # but before running migrations), we dynamically strip those fields to prevent an API crash.
        data = None
        try:
            data = super().to_representation(instance)
        except OperationalError as e:
            error_str = str(e)
            missing_fields = []
            if 'core_conference_requirements' in error_str: missing_fields.append('requirements')
            if 'core_conference_challan_assets' in error_str: missing_fields.append('challan_assets')
            
            if missing_fields:
                original_fields = self.fields
                # Dynamically rebuild the field list excluding only the ones causing the crash
                self.fields = {k: v for k, v in self.fields.items() if k not in missing_fields}
                try:
                    data = super().to_representation(instance)
                    for f in missing_fields: data[f] = [] # Return empty arrays instead of error
                finally:
                    self.fields = original_fields
            else:
                raise e

        # Inject truck challans data gracefully
        if data is not None:
            try:
                trucks = instance.truck_challans.prefetch_related('assets').order_by('truck_number')
                data['truck_challans_data'] = [
                    {
                        'id': t.pk,
                        'conference': instance.pk,
                        'truck_number': t.truck_number,
                        'label': t.label or f"Truck {t.truck_number}",
                        'vehicle_number': t.vehicle_number or '',
                        'driver_phone': t.driver_phone or '',
                        'assets': list(t.assets.values_list('pk', flat=True)),
                        'created_at': t.created_at.isoformat() if t.created_at else '',
                    }
                    for t in trucks
                ]
            except Exception:
                data['truck_challans_data'] = []

        return data

    def create(self, validated_data):
        assets_data = validated_data.pop('assets', [])
        requirements_data = validated_data.pop('requirements', [])
        crosscheck_data = validated_data.pop('crosscheck_assets', [])
        challan_data = validated_data.pop('challan_assets', [])
        staged_data = validated_data.pop('staged_assets', [])
        employees_data = validated_data.pop('assigned_employees', [])
        
        pdf_doc = validated_data.get('pdf_document')
        if isinstance(pdf_doc, str): validated_data.pop('pdf_document')

        # Auto-assign next_challan_number if not specified or blank
        if not validated_data.get('challan_number'):
            settings_obj = CompanySettings.objects.first()
            if settings_obj:
                validated_data['challan_number'] = str(settings_obj.next_challan_number)
                settings_obj.next_challan_number += 1
                settings_obj.save(update_fields=['next_challan_number'])
            
        conference = Conference.objects.create(**validated_data)
        
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

    def update(self, instance, validated_data):
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


class CompanySettingsSerializer(serializers.ModelSerializer):
    class Meta:
        model = CompanySettings
        fields = '__all__'
class SubrentalTicketItemSerializer(serializers.ModelSerializer):
    asset_details = AssetSerializer(source='asset', read_only=True)
    asset_name = serializers.SerializerMethodField()

    class Meta:
        model = SubrentalTicketItem
        fields = ['id', 'ticket', 'asset', 'asset_details', 'asset_name', 'rental_price', 'quantity']

    def get_asset_name(self, obj):
        if obj.asset:
            return obj.asset.alias_name or obj.asset.name or obj.asset.sku or "Unnamed Subrental Item"
        return "Unknown Asset"

class SubrentalTicketSerializer(serializers.ModelSerializer):
    items = SubrentalTicketItemSerializer(many=True, read_only=True)
    company_name = serializers.ReadOnlyField(source='company.name')
    conference_name = serializers.ReadOnlyField(source='conference.name')
    class Meta:
        model = SubrentalTicket
        fields = ['id', 'company', 'company_name', 'conference', 'conference_name', 'created_at', 'available_from', 'available_till', 'items']
