
import os
import django

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from core.models import Asset, Conference

adhoc_assets = Asset.objects.filter(sku__startswith='ADHOC-')
print(f"Found {adhoc_assets.count()} assets with SKU starting with 'ADHOC-'")
for a in adhoc_assets:
    print(f"ID: {a.id}, SKU: {a.sku}, Alias: {a.alias_name}, Serial: {a.serial_number}")

# Also check for assets that are ONLY in challan_assets and not in assets (MANY TO MANY)
# Actually, assets in 'assets' field are "In Use".
# Assets in 'challan_assets' are the ones appearing on the challan.

print("\nAssets in challan_assets but NOT in assets field of any conference (potential ad-hoc):")
all_challan_assets = set(Conference.objects.values_list('challan_assets', flat=True))
all_assigned_assets = set(Conference.objects.values_list('assets', flat=True))
all_staged_assets = set(Conference.objects.values_list('staged_assets', flat=True))

potential_adhoc = Asset.objects.filter(id__in=all_challan_assets).exclude(id__in=all_assigned_assets).exclude(id__in=all_staged_assets)
print(f"Found {potential_adhoc.count()} potential ad-hoc assets (only in challans)")
for a in potential_adhoc:
    print(f"ID: {a.id}, SKU: {a.sku}, Alias: {a.alias_name}, Serial: {a.serial_number}")
