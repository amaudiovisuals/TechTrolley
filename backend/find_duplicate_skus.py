"""
=============================================================
  DIAGNOSTIC: Identify Duplicate SKUs in Asset inventory
  READ-ONLY — No data is modified, deleted, or written.
  Run via: python manage.py shell < find_duplicate_skus.py
=============================================================
"""

from django.db.models import Count
from core.models import Asset

# ── 1. Query ──────────────────────────────────────────────
#
# Group all Asset rows by their `sku` value, count how many
# rows share each SKU, then keep only those with count > 1.
#
# Exclusions:
#   - sku=None  (NULL in DB — field is nullable)
#   - sku=''    (blank string — field allows blank=True)
# These are intentionally excluded because multiple assets
# with a NULL/blank SKU are a *separate* data-quality issue
# and should NOT be reported as phantom duplicates here.

duplicate_skus = (
    Asset.objects
    .exclude(sku__isnull=True)   # exclude NULL SKUs
    .exclude(sku__exact='')      # exclude blank SKUs
    .values('sku')
    .annotate(copies=Count('id'))
    .filter(copies__gt=1)
    .order_by('sku')             # alphabetical sort for easy review
)

# ── 2. Summary header ─────────────────────────────────────
total_assets     = Asset.objects.count()
duplicate_count  = duplicate_skus.count()
affected_records = sum(d['copies'] for d in duplicate_skus)  # total rows implicated

print("=" * 55)
print("  DUPLICATE SKU DIAGNOSTIC REPORT")
print("=" * 55)
print(f"  Total assets in database : {total_assets}")
print(f"  Distinct SKUs duplicated : {duplicate_count}")
print(f"  Total affected records   : {affected_records}")
print("=" * 55)

# ── 3. Per-SKU detail ─────────────────────────────────────
if duplicate_count == 0:
    print("\n  ✅  No duplicate SKUs found. Database is clean.")
else:
    print(f"\n  {'SKU':<35} {'COPIES':>6}")
    print(f"  {'-'*35} {'------':>6}")
    for entry in duplicate_skus:
        print(f"  {entry['sku']:<35} {entry['copies']:>6} copies found")

print("\n" + "=" * 55)
print("  END OF REPORT — NO data was modified.")
print("=" * 55)
