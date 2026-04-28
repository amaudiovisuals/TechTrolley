import os
import django

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from core.models import Asset
ids = [6230, 6714]
for a in Asset.objects.filter(id__in=ids):
    print(f"ID: {a.id}, SKU: {a.sku}")
