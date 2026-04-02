from rest_framework import serializers
from .models import Asset, Employee

class EmployeeSerializer(serializers.ModelSerializer):
    class Meta:
        model = Employee
        fields = '__all__'

class SubAssetSerializer(serializers.ModelSerializer):
    """Lightweight serializer used for nested sub_assets — avoids recursion."""
    assigned_to_name = serializers.ReadOnlyField(source='assigned_to.name')
    current_conference_name = serializers.SerializerMethodField()

    class Meta:
        model = Asset
        fields = [
            'id', 'sku', 'alias_name', 'serial_number', 'type', 'quantity',
            'status', 'flag', 'condition', 'barcode_type', 'barcode', 'qr_code', 'assigned_to', 'assigned_to_name',
            'parent_asset', 'current_conference_name',
        ]

    def get_current_conference_name(self, obj):
        # Prefer the efficient annotation if provided by the view
        if hasattr(obj, 'annotated_conference'):
            return obj.annotated_conference
        # Fallback to the original (slower) logic for compatibility with other views
        conf = obj.assigned_conferences.first() or obj.crosscheck_conferences.first()
        return conf.name if conf else None

class AssetSerializer(serializers.ModelSerializer):
    assigned_to_name = serializers.ReadOnlyField(source='assigned_to.name')
    sub_assets = SubAssetSerializer(many=True, read_only=True)
    current_conference_name = serializers.SerializerMethodField()
    parent_asset = serializers.PrimaryKeyRelatedField(
        queryset=Asset.objects.all(), allow_null=True, required=False
    )

    class Meta:
        model = Asset
        fields = [
            'id', 'sku', 'alias_name', 'mac_address', 'imei_number_1', 'imei_number_2', 
            'serial_number', 'description', 'is_barcode_added', 'type', 'quantity',
            'purchased_date', 'item_price', 'depreciation_percentage', 
            'available_from', 'available_till', 'created_at',
            'barcode_type', 'barcode', 'qr_code', 'status', 'flag', 'condition', 'last_maintained', 
            'current_venue', 'return_date', 'assigned_to', 'assigned_to_name',
            'parent_asset', 'sub_assets', 'current_conference_name',
        ]

    def get_current_conference_name(self, obj):
        if hasattr(obj, 'annotated_conference'):
            return obj.annotated_conference
        conf = obj.assigned_conferences.first() or obj.crosscheck_conferences.first()
        return conf.name if conf else None

from .models import Conference

class ConferenceSerializer(serializers.ModelSerializer):
    class Meta:
        model = Conference
        fields = '__all__'

    def create(self, validated_data):
        # Defensive: Pop all M2M fields before create
        assets_data = validated_data.pop('assets', [])
        requirements_data = validated_data.pop('requirements', [])
        crosscheck_data = validated_data.pop('crosscheck_assets', [])
        employees_data = validated_data.pop('assigned_employees', [])
        
        # Defensive: Remove pdf_document if it's a string (URL) rather than a file
        pdf_doc = validated_data.get('pdf_document')
        if isinstance(pdf_doc, str):
            validated_data.pop('pdf_document')
            
        conference = Conference.objects.create(**validated_data)
        
        # Add M2M after creation
        if assets_data: conference.assets.set(assets_data)
        if crosscheck_data: conference.crosscheck_assets.set(crosscheck_data)
        if requirements_data: conference.requirements.set(requirements_data)
        if employees_data: conference.assigned_employees.set(employees_data)
            
        return conference

    def update(self, instance, validated_data):
        # Defensive: Pop all M2M fields before update
        assets_data = validated_data.pop('assets', None)
        requirements_data = validated_data.pop('requirements', None)
        crosscheck_data = validated_data.pop('crosscheck_assets', None)
        employees_data = validated_data.pop('assigned_employees', None)
        
        # Defensive: Handle pdf_document if it's a string (URL)
        pdf_doc = validated_data.get('pdf_document')
        if isinstance(pdf_doc, str):
            validated_data.pop('pdf_document')
        
        # Update main fields
        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        instance.save()

        # Update M2M
        if assets_data is not None: instance.assets.set(assets_data)
        if crosscheck_data is not None: instance.crosscheck_assets.set(crosscheck_data)
        if requirements_data is not None: instance.requirements.set(requirements_data)
        if employees_data is not None: instance.assigned_employees.set(employees_data)

        return instance


from django.contrib.auth.models import User

class UserSerializer(serializers.ModelSerializer):
    role = serializers.CharField(source='profile.role', read_only=True)
    class Meta:
        model = User
        fields = ['id', 'email', 'date_joined', 'is_staff', 'role']
from .models import CompanySettings

class CompanySettingsSerializer(serializers.ModelSerializer):
    class Meta:
        model = CompanySettings
        fields = '__all__'
