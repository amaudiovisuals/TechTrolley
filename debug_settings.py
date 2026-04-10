
import os
import django
import json
from django.conf import settings
from django.test import RequestFactory
from django.contrib.auth.models import User

# Setup Django environment
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'backend.settings')
django.setup()

from backend.core.views import company_settings
from backend.core.models import CompanySettings

def test_company_settings_post():
    # Ensure a user exists
    user, _ = User.objects.get_or_create(username='admin', is_staff=True, is_superuser=True)
    
    # Ensure settings exist
    CompanySettings.objects.get_or_create(pk=1)
    
    factory = RequestFactory()
    
    # Simulate the request data
    data = {
        'name': 'Test Company',
        'address': '123 Test St',
        'phone': '1234567890',
        'email': 'test@example.com',
        'gst_number': 'GST123',
        'website': 'www.test.com',
        'powered_by_name': 'Tester',
        'dashboard_config': json.dumps({'total_assets': True}),
        'print_label_width': '50',
        'print_label_height': '25'
    }
    
    request = factory.post('/api/company-settings/', data=data)
    request.user = user
    
    try:
        response = company_settings(request)
        print(f"Response status: {response.status_code}")
        print(f"Response data: {response.data}")
    except Exception:
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    test_company_settings_post()
