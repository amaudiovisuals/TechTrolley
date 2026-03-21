import os
import django
import sys
import json

sys.path.append(os.path.join(os.path.dirname(__file__), 'backend'))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from core.models import Asset, Conference
from core.serializers import ConferenceSerializer

# 1. Create a dummy asset
asset = Asset.objects.create(
    sku='TEST-CROSS-1',
    alias_name='Test Asset',
    status='Available'
)

# 2. Create a conference
conf = Conference.objects.create(
    name='Test Conf'
)

# 3. Add to crosscheck (simulating the first phase)
conf.crosscheck_assets.add(asset)
asset.status = 'Crosscheck'
asset.save()

print(f"Asset Initial Status: {Asset.objects.get(id=asset.id).status}")
print(f"Is in conf.crosscheck_assets? {conf.crosscheck_assets.filter(id=asset.id).exists()}")

# 4. Update conference using serializer, removing the asset
data = {
    'name': 'Test Conf Updated',
    'assets': [],
    'crosscheck_assets': [],
    'assigned_employees': []
}

serializer = ConferenceSerializer(conf, data=data, partial=True)
if serializer.is_valid():
    serializer.save()
    print("Serializer saved successfully.")
else:
    print("Errors:", serializer.errors)

# 5. Check asset status
final_asset = Asset.objects.get(id=asset.id)
print(f"Asset Final Status: {final_asset.status}")

# Cleanup
asset.delete()
conf.delete()
