import os
import django
import sys

# Setup django
sys.path.append(os.path.abspath('backend'))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from core.models import Conference, Asset

print("--- Database Integrity Check ---")
print(f"Total Conferences: {Conference.objects.count()}")
print(f"Total Assets: {Asset.objects.count()}")

for c in Conference.objects.all():
    assets_count = c.assets.count()
    crosscheck_count = c.crosscheck_assets.count()
    print(f"Conference ID {c.id}: {c.name} (Assets: {assets_count}, Crosscheck: {crosscheck_count})")

print("--- Check Complete ---")
