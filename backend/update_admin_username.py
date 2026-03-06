import os
import django
import sys

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from django.contrib.auth.models import User

try:
    u = User.objects.get(id=1)
    print(f"Old Username: {u.username}")
    u.username = "nihal@amaudiovisuals.com"
    u.save()
    print(f"New Username: {u.username}")
    print("SUCCESS: Username updated to match email.")
except Exception as e:
    print(f"ERROR: {e}")
