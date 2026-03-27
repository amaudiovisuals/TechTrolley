import os
import django
import sys
from collections import defaultdict

# Setup django
sys.path.append(os.path.abspath('.'))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from core.models import Asset, Conference
from django.db.models import Count
from django.db import transaction

def fix_duplicates():
    print("--- TechTrolley Asset De-duplication Script ---")
    
    total_before = Asset.objects.count()
    print(f"Total assets before: {total_before}")

    # Find identifying duplicates by serial_number
    # We exclude blank/null serials if they somehow exist, but we checked and almost all are doubled
    serial_dups = Asset.objects.values('serial_number').annotate(c=Count('id')).filter(c__gt=1)
    
    print(f"Found {len(serial_dups)} duplicate serial number groups.")
    
    deleted_count = 0
    
    with transaction.atomic():
        for d in serial_dups:
            sn = d['serial_number']
            if not sn: continue
            
            # Fetch all records for this serial number
            assets = list(Asset.objects.filter(serial_number=sn).order_by('-id')) # Sort by ID desc (prefer newer)
            
            # Retention Logic:
            # 1. If any are linked to a conference (Admin/Incharge assigned), keep THAT one.
            # 2. If no links, keep one that is 'In Use' or 'Crosscheck' over 'Available'.
            # 3. Else keep the most recent one (highest ID).
            
            keep_asset = None
            
            # Search for one with conference links
            for a in assets:
                is_linked = Conference.objects.filter(assets=a).exists() or Conference.objects.filter(crosscheck_assets=a).exists()
                if is_linked:
                    keep_asset = a
                    break
            
            if not keep_asset:
                # Search for 'In Use' or 'Crosscheck'
                for a in assets:
                    if a.status in ['In Use', 'Crosscheck']:
                        keep_asset = a
                        break
            
            if not keep_asset:
                # Default to the first one in list (highest ID due to sort)
                keep_asset = assets[0]
            
            # Delete all others
            for a in assets:
                if a.id != keep_asset.id:
                    a.delete()
                    deleted_count += 1

    total_after = Asset.objects.count()
    print(f"Deleted {deleted_count} redundant records.")
    print(f"Total assets after: {total_after}")
    print("--- Cleanup Complete ---")

if __name__ == "__main__":
    fix_duplicates()
