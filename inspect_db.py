import os
import sqlite3
import json

db_path = os.path.join(os.path.dirname(__file__), 'backend', 'db.sqlite3')

if not os.path.exists(db_path):
    print(f"Error: Database file not found at {db_path}")
    exit(1)

conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
cursor = conn.cursor()

print("--- Asset Sample (First 5) ---")
cursor.execute("SELECT id, sku, alias_name, status, is_barcode_added FROM core_asset LIMIT 5")
assets = [dict(row) for row in cursor.fetchall()]
print(json.dumps(assets, indent=2))

print("\n--- Conference Sample ---")
cursor.execute("SELECT id, name, start_date, end_date FROM core_conference")
conferences = [dict(row) for row in cursor.fetchall()]
print(json.dumps(conferences, indent=2))

# Check M2M table for assets in conferences
print("\n--- Assets in Conferences (Sample) ---")
try:
    cursor.execute("SELECT * FROM core_conference_assets LIMIT 10")
    m2m = [dict(row) for row in cursor.fetchall()]
    print(json.dumps(m2m, indent=2))
except sqlite3.OperationalError:
    print("Table core_conference_assets does not exist or has a different name.")

conn.close()
