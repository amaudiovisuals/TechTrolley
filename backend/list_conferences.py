import os
import django

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from core.models import Conference
for c in Conference.objects.all():
    print(f"ID: {c.id}, Name: {c.name}, Assets: {c.assets.count()}, Challan Assets: {c.challan_assets.count()}, Staged: {c.staged_assets.count()}")
