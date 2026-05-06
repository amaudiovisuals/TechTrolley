
import os
import django
from django.db.models import Count

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from core.models import Asset

duplicates = Asset.objects.values('serial_number').annotate(count=Count('id')).filter(count__gt=1).order_by('-count')
print(f"Found {duplicates.count()} serial numbers with duplicates.")
for d in duplicates[:10]:
    print(f"Serial: {d['serial_number']}, Count: {d['count']}")

total_assets = Asset.objects.count()
print(f"\nTotal assets in database: {total_assets}")

unique_serials = Asset.objects.values('serial_number').distinct().count()
print(f"Unique serial numbers: {unique_serials}")

adhoc_assets = Asset.objects.filter(sku__startswith='ADHOC-').count()
print(f"Ad-hoc assets (ADHOC- prefix): {adhoc_assets}")
