import os
import django
import sys

# Add the project directory to sys.path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from django.contrib.auth.models import User

def fix_nihal():
    email = 'nihal@amaudiovisuals.com'
    password = 'Nihal123@'
    
    print(f"Checking user '{email}'...")
    
    try:
        user = User.objects.get(email=email)
        print(f"Found user. Current Status:")
        print(f"  - Active: {user.is_active}")
        print(f"  - Staff: {user.is_staff}")
        print(f"  - Superuser: {user.is_superuser}")
        
        # FIX: Ensure all flags are True
        user.is_active = True
        user.is_staff = True
        user.is_superuser = True
        user.set_password(password)
        user.save()
        
        print("-" * 30)
        print(f"SUCCESS: Reset password to '{password}' and ensured Superuser/Staff/Active permissions.")
        
    except User.DoesNotExist:
        print(f"ERROR: User '{email}' NOT FOUND.")
        print("Creating user now...")
        User.objects.create_superuser(username=email, email=email, password=password)
        print(f"SUCCESS: Created new superuser '{email}' with password '{password}'.")

if __name__ == '__main__':
    fix_nihal()
