"""
Re-casts all DecimalField columns stored as SQLite REAL back to TEXT format.
Django 6 DecimalField converter requires TEXT/NUMERIC storage, not REAL (float).
Run: python recast_decimals.py
"""
import sys, os
sys.path.insert(0, 'backend')
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
import django; django.setup()
from django.db import connection

with connection.cursor() as c:
    # Check before
    c.execute("SELECT COUNT(*) FROM core_asset WHERE typeof(item_price)='real' OR typeof(depreciation_percentage)='real'")
    before = c.fetchone()[0]
    print(f"REAL-type decimal rows before fix: {before}")

    # Re-cast: convert REAL floats to proper TEXT so Django 6 can read them back
    c.execute("""
        UPDATE core_asset SET
            item_price = CAST(ROUND(CAST(item_price AS REAL), 2) AS TEXT),
            depreciation_percentage = CAST(ROUND(CAST(depreciation_percentage AS REAL), 2) AS TEXT)
    """)
    print(f"Updated {c.rowcount} rows.")

    # Check after
    c.execute("SELECT COUNT(*) FROM core_asset WHERE typeof(item_price)='real' OR typeof(depreciation_percentage)='real'")
    after = c.fetchone()[0]
    c.execute("SELECT COUNT(*) FROM core_asset")
    total = c.fetchone()[0]

print(f"Remaining REAL-type rows: {after}")
print(f"Total assets: {total}")
print("Done. Reload admin page now.")
