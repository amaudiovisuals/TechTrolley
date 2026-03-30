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
        assets_data = validated_data.pop('assets', [])
        requirements_data = validated_data.pop('requirements', [])
        crosscheck_data = validated_data.pop('crosscheck_assets', [])
        employees_data = validated_data.pop('assigned_employees', [])
        conference = Conference.objects.create(**validated_data)
        
        if assets_data:
            conference.assets.set(assets_data)
            # Use bulk update for efficiency
            Asset.objects.filter(id__in=[a.id for a in assets_data]).update(status='In Use')

        if crosscheck_data:
            conference.crosscheck_assets.set(crosscheck_data)
            Asset.objects.filter(id__in=[a.id for a in crosscheck_data]).update(status='Crosscheck')

        if requirements_data:
            conference.requirements.set(requirements_data)

        if employees_data:
            conference.assigned_employees.set(employees_data)
            
        return conference

    def update(self, instance, validated_data):
        assets_data = validated_data.pop('assets', None)
        requirements_data = validated_data.pop('requirements', None)
        crosscheck_data = validated_data.pop('crosscheck_assets', None)
        employees_data = validated_data.pop('assigned_employees', None)
        
        old_assets_ids = set(instance.assets.values_list('id', flat=True))
        old_crosscheck_ids = set(instance.crosscheck_assets.values_list('id', flat=True))
        
        instance = super().update(instance, validated_data)

        if assets_data is not None:
            new_asset_ids = set(a.id for a in assets_data)
            removed_ids = old_assets_ids - new_asset_ids
            
            instance.assets.set(assets_data)
            
            # Update status for NEWLY added assets
            added_ids = new_asset_ids - old_assets_ids
            if added_ids:
                Asset.objects.filter(id__in=added_ids).update(status='In Use')

            # Handle REMOVED assets: mark Available ONLY if not in any other active conference or crosscheck
            for aid in removed_ids:
                asset = Asset.objects.get(id=aid)
                # Check if still assigned to OTHER conferences
                in_other_conf = Conference.objects.exclude(pk=instance.pk).filter(assets=asset).exists()
                in_any_crosscheck = Conference.objects.filter(crosscheck_assets=asset).exists()
                
                if not in_other_conf and not in_any_crosscheck:
                    asset.status = 'Available'
                    asset.save()

        if crosscheck_data is not None:
            new_cc_ids = set(a.id for a in crosscheck_data)
            removed_cc_ids = old_crosscheck_ids - new_cc_ids
            
            instance.crosscheck_assets.set(crosscheck_data)
            
            # Update status for NEWLY added crosscheck
            added_cc_ids = new_cc_ids - old_crosscheck_ids
            if added_cc_ids:
                Asset.objects.filter(id__in=added_cc_ids).update(status='Crosscheck')

            # Handle REMOVED crosscheck assets (verified)
            for aid in removed_cc_ids:
                asset = Asset.objects.get(id=aid)
                in_any_conf = Conference.objects.filter(assets=asset).exists()
                in_other_cc = Conference.objects.exclude(pk=instance.pk).filter(crosscheck_assets=asset).exists()
                
                if not in_any_conf and not in_other_cc:
                    asset.status = 'Available'
                    asset.save()

        if requirements_data is not None:
            instance.requirements.set(requirements_data)

        if employees_data is not None:
            instance.assigned_employees.set(employees_data)

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
