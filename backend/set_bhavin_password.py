import os
import django

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from django.contrib.auth.models import User

def set_password():
    email = 'bhavin@amaudiovisuals.com'
    password = 'Bhavin123@'
    
    try:
        # Try finding by username first (since we use email as username)
        user = User.objects.get(username=email)
        user.set_password(password)
        user.save()
        print(f"Success: Password for '{email}' has been set to '{password}'.")
    except User.DoesNotExist:
        try:
            # Fallback: try finding by email field if username is different
            user = User.objects.get(email=email)
            user.set_password(password)
            user.save()
            print(f"Success: Password for '{email}' has been set to '{password}'.")
        except User.DoesNotExist:
            print(f"Error: User '{email}' not found.")
            # Verify if user exists with a slightly different email or just username
            print("Listing all users to help debug:")
            for u in User.objects.all():
                print(f"- {u.username} ({u.email})")

if __name__ == '__main__':
    set_password()
