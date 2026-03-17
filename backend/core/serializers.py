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
            'status', 'condition', 'barcode_type', 'barcode', 'qr_code', 'assigned_to', 'assigned_to_name',
            'parent_asset', 'current_conference_name',
        ]

    def get_current_conference_name(self, obj):
        # Check if asset is in assigned_conferences (status = In Use)
        # or crosscheck_conferences (status = Crosscheck)
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
            'barcode_type', 'barcode', 'qr_code', 'status', 'condition', 'last_maintained', 
            'current_venue', 'return_date', 'assigned_to', 'assigned_to_name',
            'parent_asset', 'sub_assets', 'current_conference_name',
        ]

    def get_current_conference_name(self, obj):
        conf = obj.assigned_conferences.first() or obj.crosscheck_conferences.first()
        return conf.name if conf else None

from .models import Conference

class ConferenceSerializer(serializers.ModelSerializer):
    class Meta:
        model = Conference
        fields = '__all__'

    def create(self, validated_data):
        assets_data = validated_data.pop('assets', [])
        crosscheck_data = validated_data.pop('crosscheck_assets', [])
        employees_data = validated_data.pop('assigned_employees', [])
        conference = Conference.objects.create(**validated_data)
        conference.assets.set(assets_data)
        conference.crosscheck_assets.set(crosscheck_data)
        conference.assigned_employees.set(employees_data)
        
        # Update status of assigned assets
        for asset in assets_data:
            asset.status = 'In Use'
            asset.save()

        # Update status of crosscheck assets
        for asset in crosscheck_data:
            asset.status = 'Crosscheck'
            asset.save()
            
        return conference

    def update(self, instance, validated_data):
        assets_data = validated_data.pop('assets', None)
        crosscheck_data = validated_data.pop('crosscheck_assets', None)
        employees_data = validated_data.pop('assigned_employees', None)
        old_assets = list(instance.assets.all())
        old_crosscheck = list(instance.crosscheck_assets.all())
        instance = super().update(instance, validated_data)

        if assets_data is not None:
            # Detect assets removed from this conference
            new_asset_ids = set(a.pk for a in assets_data)
            removed_assets = [a for a in old_assets if a.pk not in new_asset_ids]

            instance.assets.set(assets_data)

            # Reset removed assets to Available — only if they are not in ANY other conference
            for asset in removed_assets:
                still_in_use = Conference.objects.filter(assets=asset).exclude(pk=instance.pk).exists()
                in_crosscheck = Conference.objects.filter(crosscheck_assets=asset).exists()
                if not still_in_use and not in_crosscheck:
                    asset.status = 'Available'
                    asset.save()

            # Mark newly confirmed In Use assets
            for asset in assets_data:
                if asset.status != 'In Use':
                    asset.status = 'In Use'
                    asset.save()

        if crosscheck_data is not None:
            instance.crosscheck_assets.set(crosscheck_data)

            # Restore Available status for assets verified (removed) from crosscheck
            removed_crosscheck = [a for a in old_crosscheck if a not in crosscheck_data]
            for asset in removed_crosscheck:
                still_in_use = Conference.objects.filter(assets=asset).exists()
                still_in_crosscheck = Conference.objects.filter(crosscheck_assets=asset).exclude(pk=instance.pk).exists()
                if not still_in_use and not still_in_crosscheck and asset.status == 'Crosscheck':
                    asset.status = 'Available'
                    asset.save()

            # Set Crosscheck status for newly added crosscheck assets
            for asset in crosscheck_data:
                if asset.status != 'Crosscheck':
                    asset.status = 'Crosscheck'
                    asset.save()

        if employees_data is not None:
            instance.assigned_employees.set(employees_data)

        return instance


from django.contrib.auth.models import User

class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ['id', 'email', 'date_joined', 'is_staff']
from .models import CompanySettings

class CompanySettingsSerializer(serializers.ModelSerializer):
    class Meta:
        model = CompanySettings
        fields = '__all__'
