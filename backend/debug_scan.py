import os
import sys
import django

# Add the backend directory to sys.path
sys.path.append(os.path.join(os.path.dirname(__file__), '.'))

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from core.models import Asset

term = "BT6B4PA#ACJ"
print(f"Searching for: {term}")

matches = Asset.objects.filter(qr_code__icontains=term) | Asset.objects.filter(sku__icontains=term) | Asset.objects.filter(serial_number__icontains=term)

for a in matches:
    print(f"ID: {a.id}, Alias: {a.alias_name}, SKU: {a.sku}, QR: {a.qr_code}")
