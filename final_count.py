
import sqlite3
db_path = r'c:\Users\amoff\Desktop\tech-trolley-asset-tracker\backend\db.sqlite3'
conn = sqlite3.connect(db_path)
cursor = conn.cursor()
for table in ['core_asset', 'core_employee', 'core_conference']:
    try:
        cursor.execute(f"SELECT COUNT(*) FROM {table}")
        print(f"{table}: {cursor.fetchone()[0]}")
    except:
        print(f"{table}: ERR")
conn.close()
