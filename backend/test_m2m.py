import os
import sys
import django

backend_path = r"c:\Users\amoff\OneDrive\Desktop\tech-trolley-asset-tracker NEW\backend"
sys.path.insert(0, backend_path)
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from core.models import Asset, Conference

print("creating test asset and conference...")
asset = Asset.objects.create(sku='TEST_REMOVE_123', status='Available')
conf = Conference.objects.create(name='Test Dermacon')

# Default state
print(f"Asset initial status: {asset.status}")

# Add to conference
print("Adding asset to conference...")
conf.assets.add(asset)
asset.refresh_from_db()
print(f"Asset status after adding: {asset.status}")

# Remove from conference
print("Removing asset from conference...")
conf.assets.remove(asset)
asset.refresh_from_db()
print(f"Asset status after removing: {asset.status}")

# Cleanup
asset.delete()
conf.delete()
