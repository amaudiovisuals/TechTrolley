
import sqlite3
import json

try:
    conn = sqlite3.connect('backend/db.sqlite3')
    cur = conn.cursor()
    cur.execute("SELECT id, name, sku, barcode, serial_number, brand, model_number FROM core_asset WHERE name LIKE '%Bose%' OR brand LIKE '%Bose%'")
    rows = cur.fetchall()
    columns = [description[0] for description in cur.description]
    results = []
    for row in rows:
        results.append(dict(zip(columns, row)))
    
    with open('bose_assets.json', 'w') as f:
        json.dump(results, f, indent=2)
    print(f"Written {len(results)} Bose assets to bose_assets.json")
except Exception as e:
    print(f"Error: {e}")
finally:
    if 'conn' in locals():
        conn.close()
