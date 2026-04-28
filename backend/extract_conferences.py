import json
import os

backup_path = 'backend/production_data.json'
if not os.path.exists(backup_path):
    print("Backup file not found")
    exit(1)

with open(backup_path, 'r') as f:
    data = json.load(f)

conferences = [obj for obj in data if obj['model'] == 'core.conference']
assets = {obj['pk']: obj['fields'] for obj in data if obj['model'] == 'core.asset'}

print(f"Found {len(conferences)} conferences in backup.")

for c in conferences:
    f = c['fields']
    a_ids = f.get('assets', [])
    c_ids = f.get('challan_assets', [])
    
    if len(a_ids) > 0 or len(c_ids) > 0:
        print(f"ID: {c['pk']}, Name: {f['name']}, Assets: {len(a_ids)}, Challan Assets: {len(c_ids)}")
