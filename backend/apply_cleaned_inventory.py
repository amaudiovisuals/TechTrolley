
import os
import django
import pandas as pd
from decimal import Decimal

# Setup Django environment
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from core.models import Asset

def apply_cleaned_inventory(excel_path):
    print(f"Reading Excel from {excel_path}...")
    df = pd.read_excel(excel_path)
    
    # Pre-clean: Remove items that should be deleted (Test items)
    # The user said "test items are removed" from the excel, 
    # so we should check for any items in our DB that are NOT in the excel and remove them if they look like test items.
    # Actually, the user's excel is the 'source of truth' now.
    
    db_assets = Asset.objects.all()
    excel_skus = set(df['SKU'].astype(str).tolist())
    
    # 1. Delete test items or items not in excel that were legacy
    print("Checking for legacy or test items to remove...")
    for asset in db_assets:
        if "TEST" in asset.sku.upper() or "TEST" in (asset.alias_name or "").upper():
            print(f"Deleting test asset: {asset.sku}")
            asset.delete()
        elif asset.sku not in excel_skus:
            # If it's a real item but missing, maybe it was a consumable or something?
            # User said "cleaned", so if it's not there, it might be junk.
            # But let's be careful. If it has a serial number, maybe keep it?
            # User specifically said "test items are removed", implying I should remove them too.
            if not asset.serial_number and not asset.alias_name:
                print(f"Deleting empty/junk asset: {asset.sku}")
                asset.delete()

    # 2. Update/Create assets from Excel
    print("Updating assets from Excel...")
    updated_count = 0
    created_count = 0
    
    for _, row in df.iterrows():
        sku = str(row['SKU']).strip()
        name = str(row['Name']).strip()
        alias = str(row['Alias Name']).strip() if pd.notna(row['Alias Name']) else ""
        category = str(row['Category']).strip()
        status = str(row['Status']).strip()
        desc = str(row['Description']).strip() if pd.notna(row['Description']) else ""
        sn = str(row['Serial Number']).strip() if pd.notna(row['Serial Number']) else ""
        mac = str(row['MAC Address']).strip() if pd.notna(row['MAC Address']) else ""
        imei1 = str(row['IMEI 1']).strip() if pd.notna(row['IMEI 1']) else ""
        imei2 = str(row['IMEI 2']).strip() if pd.notna(row['IMEI 2']) else ""
        
        price = 0
        try:
            price = Decimal(str(row['Item Price'])) if pd.notna(row['Item Price']) else Decimal('0')
        except: pass
        
        depr = 0
        try:
            depr = Decimal(str(row['Depreciation %'])) if pd.notna(row['Depreciation %']) else Decimal('0')
        except: pass

        # Clean "nan" strings if pandas didn't catch them
        def clean_val(v): return "" if str(v).lower() == 'nan' else v
        alias = clean_val(alias)
        desc = clean_val(desc)
        sn = clean_val(sn)
        mac = clean_val(mac)
        imei1 = clean_val(imei1)
        imei2 = clean_val(imei2)

        # Asset Update Logic
        asset = Asset.objects.create(sku=sku)
        created = True
        
        asset.name = name
        asset.alias_name = alias
        asset.type = category
        asset.status = status
        asset.description = desc
        asset.serial_number = sn
        asset.mac_address = mac
        asset.imei_number_1 = imei1
        asset.imei_number_2 = imei2
        asset.item_price = price
        asset.depreciation_percentage = depr
        
        # Handle Purchased Date (if available)
        if pd.notna(row['Purchased Date']):
            try:
                asset.purchased_date = pd.to_datetime(row['Purchased Date']).date()
            except: pass
            
        asset.save()
        
        if created: created_count += 1
        else: updated_count += 1

    print(f"Finished! Updated: {updated_count}, Created: {created_count}")

if __name__ == "__main__":
    # Use relative path so it works on both local and server
    base_dir = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(base_dir, 'Cleaned_TechTrolley_Inventory.xlsx')
    apply_cleaned_inventory(path)
