
import os
import django
from django.db.models import Count

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from core.models import Asset

# Find duplicates by serial_number
duplicates = Asset.objects.exclude(serial_number__exact='').exclude(serial_number__isnull=True).values('serial_number').annotate(count=Count('id')).filter(count__gt=1)

print(f"Found {duplicates.count()} serial numbers with duplicates.")

total_deleted = 0
for d in duplicates:
    serial = d['serial_number']
    assets = Asset.objects.filter(serial_number=serial).order_by('id') # Keep the oldest one
    
    # keep the first one
    to_keep = assets.first()
    to_delete = assets.exclude(id=to_keep.id)
    
    count = to_delete.count()
    to_delete.delete()
    total_deleted += count

print(f"Deleted {total_deleted} duplicate assets.")
print(f"Total assets remaining: {Asset.objects.count()}")

