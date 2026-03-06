import os
import django
import sys

# Add the project directory to sys.path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from django.contrib.auth import authenticate
from django.contrib.auth.models import User

def debug_login():
    email = 'nihal@amaudiovisuals.com'
    password = 'Nihal123@'
    
    print(f"DEBUG: Attempting to find user with email '{email}'")
    try:
        user = User.objects.get(email=email)
        print(f"FOUND USER ID: {user.id}")
        print(f"  username: '{user.username}'")
        print(f"  email:    '{user.email}'")
        print(f"  is_staff: {user.is_staff}")
        print(f"  is_super: {user.is_superuser}")
        print(f"  is_active: {user.is_active}")
        
        # Test authentication with USERNAME
        print(f"\nTest 1: authenticate(username='{user.username}', password='{password}')")
        auth_user = authenticate(username=user.username, password=password)
        if auth_user:
            print("  -> SUCCESS: Authentication worked!")
        else:
            print("  -> FAILED: Authentication returned None.")
            
        # Check if username differs from email
        if user.username != email:
            print(f"\nWARNING: Username '{user.username}' does not match email '{email}'!")
            print("If you are typing the email in the 'Username' field, and they don't match, login will fail.")

    except User.DoesNotExist:
        print(f"ERROR: User with email '{email}' does not exist.")

if __name__ == '__main__':
    debug_login()
