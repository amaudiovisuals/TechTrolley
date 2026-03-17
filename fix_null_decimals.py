"""
Patches NULL decimal values in core_asset that crash Django admin's DecimalField converter.
Run from project root: python fix_null_decimals.py
"""
import os, sys
sys.path.insert(0, 'backend')
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
import django; django.setup()
from django.db import connection

print("=== Patching NULL decimals ===\n")

with connection.cursor() as c:
    # Fix NULL item_price
    c.execute("UPDATE core_asset SET item_price=0.00 WHERE item_price IS NULL")
    fixed_price = c.rowcount
    # Fix NULL depreciation_percentage
    c.execute("UPDATE core_asset SET depreciation_percentage=0.00 WHERE depreciation_percentage IS NULL")
    fixed_dep = c.rowcount

print(f"Fixed {fixed_price} NULL item_price row(s)")
print(f"Fixed {fixed_dep} NULL depreciation_percentage row(s)")
print("\nDone.")
