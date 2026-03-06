import os
import django
import sys

# Add the project directory to sys.path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from django.contrib.auth.models import User

def grant_staff_access():
    # Grant staff access to nihal
    try:
        nihal = User.objects.get(email='nihal@amaudiovisuals.com')
        nihal.is_staff = True
        nihal.is_superuser = True
        nihal.save()
        print(f"Success: Granted staff/superuser access to '{nihal.email}'.")
    except User.DoesNotExist:
        print("Error: User 'nihal@amaudiovisuals.com' not found.")

    # Grant staff access to bhavin
    try:
        bhavin = User.objects.get(email='bhavin@amaudiovisuals.com')
        bhavin.is_staff = True
        bhavin.save()
        print(f"Success: Granted staff access to '{bhavin.email}'.")
    except User.DoesNotExist:
        print("Error: User 'bhavin@amaudiovisuals.com' not found.")

if __name__ == '__main__':
    grant_staff_access()
