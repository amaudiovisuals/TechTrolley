import os
import django
import sys
import json
from rest_framework.test import APIRequestFactory, force_authenticate
from django.contrib.auth.models import User

# Set up Django
sys.path.append(os.path.join(os.getcwd(), 'backend'))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from core.views import asset_list

def test_api():
    factory = APIRequestFactory()
    user = User.objects.filter(is_staff=True).first()
    if not user:
        print("No staff user found!")
        return
    
    print(f"Testing API as user: {user.username} (is_staff={user.is_staff})")
    request = factory.get('/api/assets/')
    force_authenticate(request, user=user)
    
    response = asset_list(request)
    print(f"Status: {response.status_code}")
    
    data = response.data
    print(f"Count: {len(data)}")
    
    if len(data) > 0:
        sample = data[0]
        # Check for NaN or other weirdness
        print("Sample Asset Data:")
        for k, v in sample.items():
            if v == "nan" or (isinstance(v, float) and str(v) == "nan"):
                print(f"  !!! {k}: {v}")
            else:
                pass
        
        # Check specific suspect fields
        suspects = ['quantity', 'item_price', 'depreciation_percentage']
        for s in suspects:
            print(f"  {s}: {sample.get(s)} (type: {type(sample.get(s))})")

if __name__ == "__main__":
    test_api()
