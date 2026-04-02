import os
import django
import traceback
import sys

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from django.contrib.auth.models import User
from core.views import asset_list
from rest_framework.test import APIRequestFactory

factory = APIRequestFactory()
request = factory.get('/api/assets/')
# Bypass authentication by manually setting a user
test_user = User.objects.first()
if not test_user:
    # Just mock it if no users exist
    from unittest.mock import MagicMock
    test_user = MagicMock()
request.user = test_user

print("DEBUG: Calling asset_list view with mock user...")
try:
    response = asset_list(request)
    print(f"DEBUG: Status code: {response.status_code}")
    if response.status_code != 200:
        print(f"DEBUG: Error Data: {response.data}")
    else:
        print(f"DEBUG: Success! Count: {len(response.data) if isinstance(response.data, list) else 'N/A'}")
except Exception:
    print("DEBUG: CRASH DETECTED IN VIEW")
    print(traceback.format_exc())
sys.exit(0)
