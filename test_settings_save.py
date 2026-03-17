import os
import sys
import django

# Set up Django environment BEFORE importing anything from Django/DRF
sys.path.append(os.path.join(os.getcwd(), 'backend'))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

import json
from rest_framework.test import APIRequestFactory, force_authenticate
from django.contrib.auth.models import User
from core.views import company_settings
from core.models import CompanySettings

def test_save_settings():
    factory = APIRequestFactory()
    user = User.objects.filter(is_staff=True).first()
    if not user:
        print("No staff user found!")
        return

    # Check current state
    s = CompanySettings.objects.first()
    if not s:
        s = CompanySettings.objects.create(pk=1)
    print(f"Current Name: {s.name}")
    print(f"Current Config: {s.dashboard_config}")

    new_name = f"Test Company {os.urandom(2).hex()}"
    new_config = {"total_assets": False, "test_key": True}
    
    payload = {
        'name': new_name,
        'dashboard_config': json.dumps(new_config),
        'theme_template': 'green'
    }
    
    request = factory.post('/api/company-settings/', data=payload, format='multipart')
    force_authenticate(request, user=user)
    
    response = company_settings(request)
    print(f"POST Status: {response.status_code}")
    print("Response Data:", response.data)
    
    if response.status_code == 200:
        
        s.refresh_from_db()
        print(f"Verified Name in DB: {s.name}")
        print(f"Verified Config in DB: {s.dashboard_config}")
        print(f"Config Type: {type(s.dashboard_config)}")
        
        if s.name == new_name:
            print("SUCCESS: Name persisted.")
        else:
            print("FAILURE: Name did not persist.")
            
        if s.dashboard_config == new_config:
            print("SUCCESS: Config persisted.")
        else:
            print("FAILURE: Config did not persist as dict.")
    else:
        print("POST Failed.")

if __name__ == "__main__":
    test_save_settings()
