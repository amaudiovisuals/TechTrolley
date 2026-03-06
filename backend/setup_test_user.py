import os
import sys
import django

# Add the project directory to sys.path
sys.path.append(os.getcwd())

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from django.contrib.auth import get_user_model
from rest_framework.authtoken.models import Token

User = get_user_model()
username = 'test_verifier'
email = 'test@example.com'
password = 'testpass123'

try:
    user = User.objects.get(username=username)
except User.DoesNotExist:
    user = User.objects.create_user(username=username, email=email, password=password)
    print(f"Created user: {username}")

token, created = Token.objects.get_or_create(user=user)
print(f"TOKEN:{token.key}")
with open("token.txt", "w") as f:
    f.write(token.key)
