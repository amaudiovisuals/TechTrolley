import os
import django

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from core.models import Conference, Asset
c = Conference.objects.get(id=32)
a = Asset.objects.get(id=6230)
c.staged_assets.add(a)
print(f"Added {a.sku} to staged_assets of {c.name}")
print(f"Staged assets: {list(c.staged_assets.values_list('id', flat=True))}")
