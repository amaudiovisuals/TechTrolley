
import os
import django
from django.db.models import Count

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from core.models import Asset

stats = Asset.objects.values('status').annotate(count=Count('id'))
for s in stats:
    print(f"{s['status']}: {s['count']}")
