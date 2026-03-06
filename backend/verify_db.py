import os
import django
import sys

# Add backend directory to path so config can be imported
sys.path.append(os.path.join(os.path.dirname(__file__)))

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from core.models import Asset

# Clear existing to avoid unique constraint errors on re-run
Asset.objects.filter(serial_number="SN123").delete()
Asset.objects.filter(sku="SKU123").delete()

# Create
try:
    a = Asset.objects.create(
        name="Test Asset",
        brand="TestBrand",
        model_number="M123",
        serial_number="SN123",
        sku="SKU123",
        unit_price=100.00,
        barcode="123456"
    )
    print(f"Created: {a}")

    # Retrieve
    b = Asset.objects.get(serial_number="SN123")
    print(f"Retrieved: {b}")
    
    print("Verification Successful!")
except Exception as e:
    print(f"Verification Failed: {e}")
