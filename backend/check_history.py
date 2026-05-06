
import os
import django
from django.db.models.functions import TruncDate
from django.db.models import Count

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from core.models import Asset

history = Asset.objects.annotate(date=TruncDate('created_at')).values('date').annotate(count=Count('id')).order_by('date')
print("Asset creation history:")
for h in history:
    print(f"Date: {h['date']}, Count: {h['count']}")
