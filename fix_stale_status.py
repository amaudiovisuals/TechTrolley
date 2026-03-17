"""
One-time DB cleanup script: fixes assets that are stuck in 'In Use' or 'Crosscheck'
status even though they are not assigned to any conference.

Run from the project root:
  python fix_stale_status.py
"""
import os
import django

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')

# Adjust path so Django can find the backend
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'backend'))

django.setup()

from core.models import Asset, Conference

print("=== Stale Status Cleanup ===\n")

# Find all assets marked 'In Use' that are not in ANY conference's assets
in_use_assets = Asset.objects.filter(status='In Use')
fixed_in_use = 0
for asset in in_use_assets:
    is_in_conf = Conference.objects.filter(assets=asset).exists()
    if not is_in_conf:
        print(f"  [FIX] '{asset.alias_name or asset.sku}' (ID={asset.id}) was In Use but not in any conference. → Available")
        asset.status = 'Available'
        asset.save()
        fixed_in_use += 1

# Find all assets marked 'Crosscheck' that are not in ANY conference's crosscheck_assets
crosscheck_assets = Asset.objects.filter(status='Crosscheck')
fixed_crosscheck = 0
for asset in crosscheck_assets:
    is_in_crosscheck = Conference.objects.filter(crosscheck_assets=asset).exists()
    if not is_in_crosscheck:
        print(f"  [FIX] '{asset.alias_name or asset.sku}' (ID={asset.id}) was Crosscheck but not in any conference crosscheck. → Available")
        asset.status = 'Available'
        asset.save()
        fixed_crosscheck += 1

print(f"\nDone. Fixed {fixed_in_use} stale 'In Use' asset(s) and {fixed_crosscheck} stale 'Crosscheck' asset(s).")
if fixed_in_use == 0 and fixed_crosscheck == 0:
    print("No stale assets found — database is clean.")
