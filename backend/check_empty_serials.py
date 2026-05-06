
import os
import django

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from core.models import Asset

no_serial = Asset.objects.filter(serial_number__in=[None, '', 'nan', 'None'])
print(f"Found {no_serial.count()} assets with no serial number.")
for a in no_serial[:20]:
    print(f"ID: {a.id}, SKU: {a.sku}, Alias: {a.alias_name}")

total = Asset.objects.count()
print(f"\nTotal assets: {total}")
