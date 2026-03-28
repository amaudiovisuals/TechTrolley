import os
import django

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from core.models import Employee, UserProfile
from django.contrib.auth.models import User

def sync():
    employees = Employee.objects.all()
    count = 0
    for emp in employees:
        user = User.objects.filter(email__iexact=emp.email).first()
        if user and hasattr(user, 'profile'):
            emp.role = user.profile.role
            emp.save()
            count += 1
            print(f"Synced {emp.name} to {emp.role}")
    print(f"Finished syncing {count} employees.")

if __name__ == '__main__':
    sync()
