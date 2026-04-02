import os
import django
import traceback
import sys

print("DEBUG: Setting up Django...")
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()
print("DEBUG: Django setup complete.")

from core.views import asset_list
from rest_framework.test import APIRequestFactory

factory = APIRequestFactory()
request = factory.get('/api/assets/')

print("DEBUG: Calling asset_list view...")
try:
    response = asset_list(request)
    print(f"DEBUG: Status code: {response.status_code}")
    if response.status_code != 200:
        print(f"DEBUG: Error Data: {response.data}")
    else:
        print(f"DEBUG: Success! Count: {len(response.data) if isinstance(response.data, list) else 'N/A'}")
except Exception:
    print("DEBUG: CRASH DETECTED")
    print(traceback.format_exc())
sys.exit(0)
