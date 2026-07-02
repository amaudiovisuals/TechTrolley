"""
=============================================================
  SCRIPT J-121: Automated Duplicate SKU Cleanup
  Asset model — production-safe, dry-run-first deduplication.

  SAFETY SWITCH (change to False only after dry-run review):
=============================================================
"""

DRY_RUN = False  # ← Approved for live execution (Phase 6)

# SKUs explicitly excluded from deletion — do NOT touch these groups.
# Approved exception list per user instruction before Phase 6.
SKUS_TO_SKIP = {
    "AHUJA PODIUM MIC STAND M9",
    "JTS PODIUM MIC STAND A1",
    "ELECTRO VOICE WIRELESS MIC A1",
}

# ─────────────────────────────────────────────────────────────
#  RETENTION PRIORITY (which copy to KEEP per duplicated SKU)
#
#  Priority 1 — Asset linked to any Conference (assets / crosscheck_assets)
#               These are operationally "live" records.
#  Priority 2 — Asset whose status is 'In Use' or 'Crosscheck'
#               Actively deployed in the warehouse.
#  Priority 3 — Asset with the lowest `id` (original / oldest row)
#               Safe default: first-inserted record wins.
#
#  All other copies are treated as phantoms and scheduled for deletion.
# ─────────────────────────────────────────────────────────────

from django.db.models import Count, Min
from django.db import transaction
from core.models import Asset, Conference

# ── Helpers ──────────────────────────────────────────────────

def pick_keeper(assets: list) -> Asset:
    """
    Given a list of Asset objects sharing the same SKU,
    return the single record we should KEEP.
    """
    # Priority 1: conference-linked record
    for asset in assets:
        linked = (
            Conference.objects.filter(assets=asset).exists()
            or Conference.objects.filter(crosscheck_assets=asset).exists()
            or Conference.objects.filter(challan_assets=asset).exists()
            or Conference.objects.filter(staged_assets=asset).exists()
        )
        if linked:
            return asset

    # Priority 2: actively deployed status
    for asset in assets:
        if asset.status in ('In Use', 'Crosscheck'):
            return asset

    # Priority 3: oldest record (lowest id)
    return min(assets, key=lambda a: a.id)


def format_asset_row(asset: Asset) -> str:
    return (
        f"    id={asset.id:<6}  "
        f"status={asset.status:<12}  "
        f"serial={asset.serial_number or '—':<20}  "
        f"alias={asset.alias_name or '—'}"
    )


# ── Main ─────────────────────────────────────────────────────

def run():
    mode_label = "DRY RUN — no data will be modified" if DRY_RUN else "⚠️  LIVE MODE — deletions will be committed"

    print("=" * 65)
    print("  SCRIPT J-121: Duplicate SKU Cleanup")
    print(f"  Mode : {mode_label}")
    print("=" * 65)

    # ── Step 1: Find all duplicated SKU groups ────────────────
    duplicated_skus = (
        Asset.objects
        .exclude(sku__isnull=True)
        .exclude(sku__exact='')
        .values('sku')
        .annotate(copies=Count('id'))
        .filter(copies__gt=1)
        .order_by('sku')
    )

    total_sku_groups = duplicated_skus.count()
    if total_sku_groups == 0:
        print("\n  ✅  No duplicate SKUs found. Database is already clean.\n")
        return

    total_phantom_count = sum(g['copies'] - 1 for g in duplicated_skus)
    print(f"\n  Duplicated SKU groups found : {total_sku_groups}")
    print(f"  Phantom records to remove   : {total_phantom_count}")
    print("-" * 65)

    # ── Step 2: Process each group ───────────────────────────
    all_phantom_ids = []

    for group in duplicated_skus:
        if group['sku'] in SKUS_TO_SKIP:
            print(f"\n  ⏭  SKIPPED (excluded) : {group['sku']}  ({group['copies']} copies — untouched by user request)")
            continue
        sku = group['sku']
        copies = group['copies']

        # Fetch all records for this SKU, oldest-first for consistent ordering
        assets = list(
            Asset.objects.filter(sku=sku).order_by('id')
        )

        keeper = pick_keeper(assets)
        phantoms = [a for a in assets if a.id != keeper.id]
        phantom_ids = [a.id for a in phantoms]
        all_phantom_ids.extend(phantom_ids)

        # Determine why we kept this specific record
        priority_reason = "oldest id (default)"
        if Conference.objects.filter(
            assets=keeper
        ).exists() or Conference.objects.filter(
            crosscheck_assets=keeper
        ).exists():
            priority_reason = "conference-linked (Priority 1)"
        elif keeper.status in ('In Use', 'Crosscheck'):
            priority_reason = f"status='{keeper.status}' (Priority 2)"

        print(f"\n  SKU : {sku}  ({copies} copies → keeping 1, deleting {len(phantoms)})")
        print(f"  ✔  KEEP   {format_asset_row(keeper)}")
        print(f"       └─ Reason: {priority_reason}")
        for phantom in phantoms:
            print(f"  ✖  DELETE {format_asset_row(phantom)}")

    # ── Step 3: Execute or simulate ──────────────────────────
    print("\n" + "=" * 65)

    if DRY_RUN:
        print(f"  [DRY RUN] Would delete {len(all_phantom_ids)} phantom record(s).")
        print(f"  [DRY RUN] Phantom IDs : {all_phantom_ids}")
        print("\n  To execute: set  DRY_RUN = False  at the top of this script.")
    else:
        print(f"  Executing bulk delete of {len(all_phantom_ids)} phantom record(s)...")
        with transaction.atomic():
            deleted_count, breakdown = (
                Asset.objects
                .filter(id__in=all_phantom_ids)
                .delete()
            )
        print(f"  ✅  Deleted {deleted_count} record(s). Breakdown: {breakdown}")
        remaining = Asset.objects.exclude(sku__isnull=True).exclude(sku__exact='') \
                        .values('sku').annotate(c=Count('id')).filter(c__gt=1).count()
        print(f"  ✅  Residual duplicated SKU groups after cleanup: {remaining}")

    print("=" * 65)
    print("  END OF SCRIPT J-121")
    print("=" * 65)


run()
