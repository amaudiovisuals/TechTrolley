
import os
import django
import pandas as pd

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from core.models import Asset

# Load master list
master_path = 'Main_Inventory_Master.xlsx'
if os.path.exists(master_path):
    df_master = pd.read_excel(master_path)
    # Find serial number column
    serial_col = None
    for c in df_master.columns:
        if 'serial' in str(c).lower():
            serial_col = c
            break
    
    if serial_col:
        master_serials = set(df_master[serial_col].astype(str).str.strip().str.lower().unique())
        print(f"Master file has {len(master_serials)} unique serials.")
        
        # Find assets in DB that are NOT in master serials
        db_assets = Asset.objects.all()
        not_in_master = []
        for a in db_assets:
            sn = str(a.serial_number or '').strip().lower()
            if sn not in master_serials and not a.sku.startswith('ADHOC-'):
                not_in_master.append(a)
        
        print(f"Found {len(not_in_master)} assets in DB that are NOT in the Master Excel file.")
        for a in not_in_master[:20]:
            print(f"ID: {a.id}, SKU: {a.sku}, Serial: {a.serial_number}, Alias: {a.alias_name}")
            
        # These are candidates for removal or marking as temporary
    else:
        print("Could not find serial number column in Master file.")
else:
    print(f"Master file {master_path} not found.")
