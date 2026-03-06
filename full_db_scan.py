
import sqlite3
db_path = r'c:\Users\amoff\Desktop\tech-trolley-asset-tracker\backend\db.sqlite3'
conn = sqlite3.connect(db_path)
cursor = conn.cursor()
cursor.execute("SELECT name FROM sqlite_master WHERE type='table';")
tables = [t[0] for t in cursor.fetchall()]
print("--- Full Database Scan ---")
for table in tables:
    try:
        cursor.execute(f"SELECT COUNT(*) FROM {table}")
        count = cursor.fetchone()[0]
        print(f"{table}: {count} records")
    except Exception as e:
        print(f"{table}: Error - {e}")
conn.close()
