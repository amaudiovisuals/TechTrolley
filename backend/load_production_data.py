"""
load_production_data.py
Run this script on the production server to sync local data into PostgreSQL.
Usage: python load_production_data.py
"""
import os
import sys
import django

# Setup Django with production settings
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
os.environ.setdefault('DJANGO_ENV', 'production')
django.setup()

from django.core.management import call_command
from core.models import Asset, Conference, UserProfile
from django.contrib.auth.models import User

print("=== TechTrolley Production Data Sync ===")

# Step 1: Clear out app-level data (M2M first, then models)
print("Clearing existing conference-asset links...")
for conf in Conference.objects.all():
    conf.assets.clear()
    conf.crosscheck_assets.clear()
    conf.assigned_employees.clear()

print(f"Deleting {Conference.objects.count()} conferences...")
Conference.objects.all().delete()

print(f"Deleting {Asset.objects.count()} assets...")
Asset.objects.all().delete()

print(f"Deleting {UserProfile.objects.count()} user profiles...")
UserProfile.objects.all().delete()

print(f"Deleting {User.objects.count()} users...")
User.objects.all().delete()

# Step 2: Load fresh data from fixture
print("Loading production_data.json into PostgreSQL...")
fixture_path = os.path.join(os.path.dirname(__file__), 'production_data.json')
call_command('loaddata', fixture_path, verbosity=1)

print("=== Sync Complete ===")
print(f"Users: {User.objects.count()}")
print(f"Assets: {Asset.objects.count()}")
print(f"Conferences: {Conference.objects.count()}")
