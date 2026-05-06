
import os
import django
from django.db.models import Count

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from core.models import Asset, Conference

# 1. Reset 'In Use' status for assets not currently assigned to any conference
assigned_ids = set(Conference.objects.values_list('assets', flat=True))
in_use_but_not_assigned = Asset.objects.filter(status='In Use').exclude(id__in=assigned_ids)
count_reset = in_use_but_not_assigned.update(status='Available')
print(f"Reset {count_reset} 'In Use' assets to 'Available' (were not assigned to any conference)")

# 2. Mark Ad-hoc items as temporary
# Ad-hoc items are typically those created manually. We can identify them by:
# - SKU starting with ADHOC-
# - Or they were created but are NOT in the 'Main Inventory' (not assigned to conferences, not in staged, not in requirements)
adhoc_by_sku = Asset.objects.filter(sku__startswith='ADHOC-')
count_adhoc = adhoc_by_sku.update(is_temporary=True)
print(f"Marked {count_adhoc} assets with 'ADHOC-' prefix as temporary.")

# 3. Handle the '775' issue
# If there are 775 items in use but 'there is no such items', we force reset them
all_in_use = Asset.objects.filter(status='In Use')
if all_in_use.count() > 0:
    print(f"Force resetting remaining {all_in_use.count()} 'In Use' assets to 'Available' per user request.")
    all_in_use.update(status='Available')

# 4. Identification of extra assets
total_now = Asset.objects.count()
print(f"Total assets in database now: {total_now}")
print(f"Inventory assets (is_temporary=False): {Asset.objects.filter(is_temporary=False).count()}")
