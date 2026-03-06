
import os
import django
import json

# Setup Django
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from rest_framework.request import Request
from rest_framework.test import APIRequestFactory, APIClient
from core.models import Conference, Asset
from core.conference_views import conference_list
from core.serializers import ConferenceSerializer
from django.contrib.auth.models import User
from rest_framework.authtoken.models import Token

factory = APIRequestFactory()

# Create a dummy asset if none exists
asset = Asset.objects.first()
if not asset:
    asset = Asset.objects.create(name="Test Asset", serial_number="TEST001", item_price=100)

data = {
    "name": "Test Conference",
    "association_name": "Test Association",
    "billing_address": "123 Test St",
    "transport_address": "456 Deliver Ln",
    "gst_number": "GST123",
    "contact_person": "John Doe",
    "contact_phone": "1234567890",
    "contact_email": "john@example.com",
    "conference_type": "Medical Conference",
    "start_date": "2026-10-01",
    "end_date": "2026-10-05",
    "assets": [str(asset.id)]
}

# Simulate POST
request = factory.post('/api/conferences/', data, format='json')
# Need to process request through DRF view manually or use APIClient
# Using APIClient is better
from rest_framework.test import APIClient
from django.contrib.auth.models import User
from rest_framework.authtoken.models import Token

# Create User and Token
user, created = User.objects.get_or_create(username='debug_user')
if created:
    user.set_password('password')
    user.save()
    
token, _ = Token.objects.get_or_create(user=user)

client = APIClient()
client.credentials(HTTP_AUTHORIZATION='Token ' + token.key)

response = client.post('/api/conferences/', data, format='json')

print(f"Status Code: {response.status_code}")
print(f"Data: {response.data}")
