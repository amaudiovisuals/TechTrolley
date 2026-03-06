
import os
import sqlite3

db_path = r'c:\Users\amoff\Desktop\tech-trolley-asset-tracker\backend\db.sqlite3'

if not os.path.exists(db_path):
    print(f"Error: Database file not found at {db_path}")
    exit(1)

conn = sqlite3.connect(db_path)
cursor = conn.cursor()

print("--- Conference Asset Assignments ---")
try:
    cursor.execute("SELECT id, name FROM core_conference")
    conferences = cursor.fetchall()
    for conf_id, name in conferences:
        cursor.execute("SELECT count(*) FROM core_conference_assets WHERE conference_id = ?", (conf_id,))
        count = cursor.fetchone()[0]
        print(f"Conference '{name}' (ID: {conf_id}): {count} assets assigned")
except sqlite3.OperationalError as e:
    print(f"Error: {e}")

print("\n--- Asset Status Summary ---")
try:
    cursor.execute("SELECT status, count(*) FROM core_asset GROUP BY status")
    statuses = cursor.fetchall()
    for status, count in statuses:
        print(f"Status '{status}': {count}")
except sqlite3.OperationalError as e:
    print(f"Error: {e}")

conn.close()
