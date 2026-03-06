import os
import django
import sys

# Add the project directory to sys.path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from django.contrib.auth.models import User

print(f"{'ID':<5} {'USERNAME/EMAIL':<30} {'IS_SUPERUSER':<15} {'PASSWORD (HASHED)':<50}")
print("-" * 100)

for user in User.objects.all():
    # Truncate hash for display if too long
    pwd_display = user.password[:40] + "..." if len(user.password) > 40 else user.password
    print(f"{user.id:<5} {user.username:<30} {str(user.is_superuser):<15} {pwd_display}")
