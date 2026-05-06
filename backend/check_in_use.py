
import os
import django
from django.db.models import Count

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from core.models import Asset, Conference

in_use = Asset.objects.filter(status='In Use')
print(f"Found {in_use.count()} assets with status 'In Use'")

# Check which conferences have these assets
conf_counts = Conference.objects.annotate(asset_count=Count('assets')).filter(asset_count__gt=0)
print(f"\nConferences with assigned assets:")
for c in conf_counts:
    print(f"ID: {c.id}, Name: {c.name}, Assets: {c.asset_count}, Start: {c.start_date}, End: {c.end_date}")

# Check assets in challan_assets but not in assets
adhoc_like = Asset.objects.filter(challan_conferences__isnull=False).exclude(id__in=Asset.objects.filter(assigned_conferences__isnull=False))
print(f"\nAssets only in Challans (likely ad-hoc): {adhoc_like.count()}")
for a in adhoc_like[:10]:
    print(f"ID: {a.id}, SKU: {a.sku}, Alias: {a.alias_name}")
