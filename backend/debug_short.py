import os
import django
import sys

# Add the project directory to sys.path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from django.contrib.auth import authenticate
from django.contrib.auth.models import User

email = 'nihal@amaudiovisuals.com'
pwd = 'Nihal123@'

try:
    u = User.objects.get(email=email)
    print(f"ID:{u.id}")
    print(f"U:{u.username}")
    print(f"E:{u.email}")
    print(f"SAME:{u.username == u.email}")
    print(f"STAFF:{u.is_staff}")
    print(f"SUPER:{u.is_superuser}")
    
    auth = authenticate(username=u.username, password=pwd)
    print(f"AUTH:{bool(auth)}")

except User.DoesNotExist:
    print("NO USER")
