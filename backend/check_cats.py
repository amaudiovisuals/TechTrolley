
import os
import django
from django.db.models import Count

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from core.models import Asset

cats = Asset.objects.values('type').annotate(count=Count('id')).order_by('-count')
for c in cats:
    print(f"{c['type']}: {c['count']}")
