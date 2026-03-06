
import os
import sqlite3

db_path = r'c:\Users\amoff\Desktop\tech-trolley-asset-tracker\backend\db.sqlite3'

if not os.path.exists(db_path):
    print(f"Error: Database file not found at {db_path}")
    exit(1)

conn = sqlite3.connect(db_path)
cursor = conn.cursor()

tables = ['core_asset', 'core_employee', 'core_conference', 'core_deliverychallan', 'core_companysettings']

print("--- Database Diagnostics ---")
for table in tables:
    try:
        cursor.execute(f"SELECT COUNT(*) FROM {table}")
        count = cursor.fetchone()[0]
        print(f"Table {table}: {count} records")
    except sqlite3.OperationalError as e:
        print(f"Table {table}: Error (might not exist yet) - {e}")

conn.close()
