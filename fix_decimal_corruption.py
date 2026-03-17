"""
Fixes assets with invalid decimal values in item_price or depreciation_percentage.
Run from project root: python fix_decimal_corruption.py
"""
import os, sys, django
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'backend'))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

import math
from decimal import Decimal, InvalidOperation
from django.db import connection

fixed = 0

with connection.cursor() as cursor:
    cursor.execute("SELECT id, item_price, depreciation_percentage FROM core_asset")
    rows = cursor.fetchall()

for row_id, item_price, depreciation_percentage in rows:
    needs_fix = False
    new_price = item_price
    new_dep = depreciation_percentage

    # Check item_price
    try:
        v = Decimal(str(item_price)) if item_price is not None else Decimal('0')
        if not v.is_finite():
            raise InvalidOperation
        new_price = float(v)
    except (InvalidOperation, ValueError, TypeError):
        print(f"  [FIX] Asset ID={row_id}: bad item_price={item_price!r} → 0")
        new_price = 0.0
        needs_fix = True

    # Check depreciation_percentage
    try:
        v = Decimal(str(depreciation_percentage)) if depreciation_percentage is not None else Decimal('0')
        if not v.is_finite():
            raise InvalidOperation
        new_dep = float(v)
    except (InvalidOperation, ValueError, TypeError):
        print(f"  [FIX] Asset ID={row_id}: bad depreciation={depreciation_percentage!r} → 0")
        new_dep = 0.0
        needs_fix = True

    if needs_fix:
        with connection.cursor() as cursor:
            cursor.execute(
                "UPDATE core_asset SET item_price=?, depreciation_percentage=? WHERE id=?",
                [new_price, new_dep, row_id]
            )
        fixed += 1

print(f"\nDone. Fixed {fixed} asset record(s) with invalid decimal values.")
if fixed == 0:
    print("No corrupt decimal values found.")
