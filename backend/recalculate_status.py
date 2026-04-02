import os
import sys
import django

# Setup Django environment
backend_path = r"c:\Users\amoff\OneDrive\Desktop\tech-trolley-asset-tracker NEW\backend"
sys.path.insert(0, backend_path)
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from core.models import Asset, Conference

print("=== Starting Asset Status Remap ===")

assets = Asset.objects.all()
in_use_count = 0
available_count = 0
crosscheck_count = 0
damaged_count = 0

for asset in assets:
    status_changed = False
    old_status = asset.status
    
    # Check current relations
    is_in_crosscheck = Conference.objects.filter(crosscheck_assets=asset).exists()
    is_in_active = Conference.objects.filter(assets=asset).exists()
    
    # Determine correct status
    if is_in_crosscheck:
        correct_status = 'Crosscheck'
    elif is_in_active:
        correct_status = 'In Use'
    else:
        # If not assigned and not damaged, it should be Available
        if asset.status != 'Damaged':
            correct_status = 'Available'
        else:
            correct_status = 'Damaged'
            
    # Apply change if needed
    if asset.status != correct_status:
        print(f"[REMAP] {asset.sku}: {old_status} -> {correct_status}")
        asset.status = correct_status
        asset.save()
        
    # Tally
    if asset.status == 'In Use':
        in_use_count += 1
    elif asset.status == 'Available':
        available_count += 1
    elif asset.status == 'Crosscheck':
        crosscheck_count += 1
    elif asset.status == 'Damaged':
        damaged_count += 1

print("\n=== Summary ===")
print(f"Total Assets: {assets.count()}")
print(f"In Use: {in_use_count}")
print(f"Crosscheck: {crosscheck_count}")
print(f"Available: {available_count}")
print(f"Damaged: {damaged_count}")
