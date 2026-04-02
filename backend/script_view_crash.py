import os
import django
import traceback

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from core.views import asset_list
from rest_framework.test import APIRequestFactory

factory = APIRequestFactory()
request = factory.get('/api/assets/')

try:
    response = asset_list(request)
    if response.status_code != 200:
        print(f"STATUS: {response.status_code}")
        print(f"DATA: {response.data}")
    else:
        print("SUCCESS")
except Exception:
    print(traceback.format_exc())
