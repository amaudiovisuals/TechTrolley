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
            'id', 'sku', 'alias_name', 'serial_number', 'type',
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
            'serial_number', 'description', 'is_barcode_added', 'type', 
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
        conference = Conference.objects.create(**validated_data)
        conference.assets.set(assets_data)
        conference.crosscheck_assets.set(crosscheck_data)
        
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
        instance = super().update(instance, validated_data)

        if assets_data is not None:
            old_asset_ids = set(instance.assets.values_list('id', flat=True))
            new_asset_ids = set(a.id for a in assets_data)

            # Assets removed from Assigned → should move to Crosscheck (manual or backend)
            # However, if they are NOT in the new crosscheck_assets either, they are truly Available
            # But the logic usually is: Assigned -> Remove -> Crosscheck -> Verify -> Available
            
            # Since frontend handles the lists, we just update statuses based on current membership
            instance.assets.set(assets_data)
            for asset in assets_data:
                if asset.status != 'In Use':
                    asset.status = 'In Use'
                    asset.save()

        if crosscheck_data is not None:
            instance.crosscheck_assets.set(crosscheck_data)
            for asset in crosscheck_data:
                if asset.status != 'Crosscheck':
                    asset.status = 'Crosscheck'
                    asset.save()

        # Cleanup: Assets that are neither in assets nor crosscheck_assets of this conference
        # and were previously in either should be 'Available' if not used elsewhere
        # This is a bit complex for a serializer. Typically frontend will dictate the final state.
        # Simple rule: if asset id not in assets_data and not in crosscheck_data, and we moved it
        # we can set it to Available here if we know it belongs to this conference.
        
        return instance


from django.contrib.auth.models import User

class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ['id', 'email', 'date_joined']
from .models import CompanySettings

class CompanySettingsSerializer(serializers.ModelSerializer):
    class Meta:
        model = CompanySettings
        fields = '__all__'
