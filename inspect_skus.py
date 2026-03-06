
import sqlite3
import os

db_path = 'backend/db.sqlite3'
if not os.path.exists(db_path):
    print(f"DB not found at {db_path}")
    exit(1)

conn = sqlite3.connect(db_path)
cursor = conn.cursor()

try:
    cursor.execute("SELECT id, name, sku, barcode, serial_number FROM core_asset")
    rows = cursor.fetchall()
    print(f"{'ID':<5} | {'SKU':<30} | {'Barcode':<30} | {'Serial':<20} | {'Name'}")
    print("-" * 120)
    for row in rows:
        print(f"{row[0]:<5} | {str(row[2]):<30} | {str(row[3]):<30} | {str(row[4]):<20} | {row[1]}")
except Exception as e:
    print(f"Error: {e}")
finally:
    conn.close()
