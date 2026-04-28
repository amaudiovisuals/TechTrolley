import os
import sys
import django

# Add the backend directory to sys.path
sys.path.append(os.path.join(os.path.dirname(__file__), '.'))

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from core.models import Asset

print("Searching for 'TFT' in all assets:")
count = 0
for a in Asset.objects.all():
    if "TFT" in str(a.name) or "TFT" in str(a.alias_name) or "TFT" in str(a.sku):
        print(f"ID: {a.id}, Name: {a.name}, Alias: {a.alias_name}, SKU: {a.sku}")
        count += 1
print(f"Total found: {count}")
