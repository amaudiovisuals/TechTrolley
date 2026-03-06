import os
import sqlite3
import json

db_path = r'c:\Users\amoff\Desktop\tech-trolley-asset-tracker\backend\db.sqlite3'

def simulate_frontend():
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    # 1. Fetch Assets
    cursor.execute("SELECT id, status FROM core_asset")
    assets = [dict(row) for row in cursor.fetchall()]
    print(f"Total Assets in DB: {len(assets)}")

    # 2. Fetch Conferences
    cursor.execute("SELECT id FROM core_conference")
    conferences = [dict(row) for row in cursor.fetchall()]
    print(f"Total Conferences in DB: {len(conferences)}")

    # 3. Build bookedElsewhere (simulating flatMap)
    booked_elsewhere = set()
    for conf in conferences:
        cursor.execute("SELECT asset_id FROM core_conference_assets WHERE conference_id = ?", (conf['id'],))
        assets_in_conf = [str(row['asset_id']) for row in cursor.fetchall()]
        print(f"Conf {conf['id']} has {len(assets_in_conf)} assets")
        for aid in assets_in_conf:
            booked_elsewhere.add(aid)
    
    print(f"Total unique assets booked elsewhere: {len(booked_elsewhere)}")

    # 4. Simulate filtering for NEW conference (currentConferenceId = undefined)
    # availableAssets = assets.filter(a => !bookedElsewhereStr.has(String(a.id)))
    available_assets = [a for a in assets if str(a['id']) not in booked_elsewhere]
    print(f"Available Assets (before search): {len(available_assets)}")

    # 5. Check first few Available Assets
    if available_assets:
        print("Sample Available Assets:")
        print(json.dumps(available_assets[:5], indent=2))

    conn.close()

simulate_frontend()
