"""
Diagnoses which assets have bad decimal values by reading raw SQLite data.
Run from project root: python diagnose_decimals.py
"""
import os, sys
sys.path.insert(0, 'backend')
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
import django; django.setup()
from django.db import connection

print("=== Checking for bad decimal values ===\n")

with connection.cursor() as c:
    c.execute("SELECT id, item_price, depreciation_percentage FROM core_asset")
    all_rows = c.fetchall()

bad = []
for r in all_rows:
    try:
        float(str(r[1]))
        float(str(r[2]))
    except Exception:
        bad.append(r)

print(f"Total assets: {len(all_rows)}")
print(f"Bad decimal rows: {len(bad)}")
for r in bad:
    print(f"  ID={r[0]}  item_price={r[1]!r}  depreciation={r[2]!r}")

# Also check for empty strings
with connection.cursor() as c:
    c.execute("SELECT id, item_price, depreciation_percentage FROM core_asset WHERE CAST(item_price AS TEXT) IN ('', 'nan', 'NaN', 'inf', 'None') OR CAST(depreciation_percentage AS TEXT) IN ('', 'nan', 'NaN', 'inf', 'None')")
    empty_rows = c.fetchall()

print(f"\nRows with empty/nan/None string values: {len(empty_rows)}")
for r in empty_rows:
    print(f"  ID={r[0]}  item_price={r[1]!r}  depreciation={r[2]!r}")

if not bad and not empty_rows:
    print("\nAll decimal values look fine at the raw SQLite level.")
    print("The crash may be from a quantity field — checking...")
    with connection.cursor() as c:
        c.execute("SELECT id, quantity FROM core_asset WHERE CAST(quantity AS TEXT) NOT GLOB '[0-9]*'")
        qty_rows = c.fetchall()
    print(f"Bad quantity rows: {len(qty_rows)}")
    for r in qty_rows:
        print(f"  ID={r[0]}  quantity={r[1]!r}")
