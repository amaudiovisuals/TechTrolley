
import os
import django
import pandas as pd
from decimal import Decimal
import sys

# Setup Django environment
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from core.models import Asset, Employee

def apply_final_inventory(excel_path):
    print(f"\U0001f680 Starting Final Inventory Migration from: {excel_path}")
    
    if not os.path.exists(excel_path):
        print(f"\u274c Error: File not found at {excel_path}")
        return

    # 1. Clear existing Assets
    # We keep Employees and Conferences, but reset Asset relationships
    print("\u26a0\ufe0f  Wiping old Asset data...")
    Asset.objects.all().delete()
    print("Done clearing assets.")

    # 2. Define Manual Assignments from Screenshot
    assignments = {
        'NHQLTSI006338035C47600': {'name': 'BHAVIN', 'dept': 'USER'},
        'NHQLTSI005336025607600': {'name': 'BHAVIN', 'dept': 'USER'},
        'MNWJK9R63F': {'name': 'JITHIN RAMESH', 'dept': 'USER'},
        'D2507N0000517': {'name': 'JISHNU K P', 'dept': 'USER'},
        '5CD52409KL': {'name': 'NIHAL', 'dept': 'MANAGEMENT'},
        'D2507N0000644': {'name': 'BHAVIN', 'dept': 'USER'},
        'FVFY84UXHV22': {'name': 'RIYAN', 'dept': 'MANAGEMENT'}
    }

    # Helper to get or create employee
    def get_employee(name, dept):
        emp_id = name.replace(" ", "_").upper()
        emp, created = Employee.objects.get_or_create(
            employee_id=emp_id,
            defaults={'name': name, 'department': dept, 'email': f'{emp_id.lower()}@techtrolley.test', 'phone': '0000000000'}
        )
        return emp

    # 3. Read Excel
    df = pd.read_excel(excel_path)
    df.columns = [c.strip() for c in df.columns]

    created_count = 0
    assigned_count = 0
    
    print("\u23f3  Importing Assets...")
    for _, row in df.iterrows():
        sku = str(row['SKU']).strip()
        alias = str(row['Alias Name']).strip() if pd.notna(row['Alias Name']) else ""
        category = str(row['Type']).strip() if pd.notna(row['Type']) else "Other"
        sn = str(row['Serial Number']).strip() if pd.notna(row['Serial Number']) else ""
        desc = str(row['Description']).strip() if pd.notna(row['Description']) else ""
        mac = str(row['MAC Address']).strip() if pd.notna(row['MAC Address']) else ""
        imei1 = str(row['IMEI Number 1']).strip() if pd.notna(row['IMEI Number 1']) else ""
        imei2 = str(row['IMEI Number 2']).strip() if pd.notna(row['IMEI Number 2']) else ""
        
        # New Columns from master
        is_barcode = True if str(row.get('Is barcode added', '')).lower() in ['yes', '1', 'true'] else False
        barcode_type = str(row.get('Barcode type', '')).strip() if pd.notna(row.get('Barcode type')) else ""
        barcode = str(row.get('Barcode', '')).strip() if pd.notna(row.get('Barcode')) else ""
        qr_code_val = str(row.get('QR Code', '')).strip() if pd.notna(row.get('QR Code')) else ""
        available_from = str(row.get('Available from', '')).strip() if pd.notna(row.get('Available from')) else ""
        available_till = str(row.get('Available till', '')).strip() if pd.notna(row.get('Available till')) else ""

        # Clean 'nan' strings
        def c(v): return "" if str(v).lower() == 'nan' else v
        sku, alias, category, sn, desc, mac, imei1, imei2, barcode_type, barcode, qr_code_val, available_from, available_till = map(c, [sku, alias, category, sn, desc, mac, imei1, imei2, barcode_type, barcode, qr_code_val, available_from, available_till])

        price = Decimal('0.00')
        try:
            val = str(row['Item price']).replace(',', '').strip()
            price = Decimal(val) if val and val.lower() != 'nan' else Decimal('0.00')
        except: pass

        depr = Decimal('0.00')
        try:
            val = str(row['Depreciation']).replace('%', '').strip()
            depr = Decimal(val) if val and val.lower() != 'nan' else Decimal('0.00')
        except: pass

        # Create Asset
        asset = Asset(
            sku=sku,
            alias_name=alias,
            type=category,
            serial_number=sn,
            description=desc,
            mac_address=mac,
            imei_number_1=imei1,
            imei_number_2=imei2,
            is_barcode_added=is_barcode,
            barcode_type=barcode_type,
            barcode=barcode,
            qr_code=qr_code_val,
            available_from=available_from,
            available_till=available_till,
            item_price=price,
            depreciation_percentage=depr,
            status='Available' # Default
        )

        # Handle Purchased Date
        if pd.notna(row['Purchased date']):
            try:
                dt_val = row['Purchased date']
                if isinstance(dt_val, str):
                    asset.purchased_date = pd.to_datetime(dt_val).date()
                else:
                    asset.purchased_date = dt_val.date()
            except: pass

        # Apply Assignment logic
        if sn in assignments:
            info = assignments[sn]
            emp = get_employee(info['name'], info['dept'])
            asset.assigned_to = emp
            # Status remains 'Available' as these are personal assets, not logistics in use
            assigned_count += 1
        elif sku in assignments: # Fallback to SKU if SN is missing
            info = assignments[sku]
            emp = get_employee(info['name'], info['dept'])
            asset.assigned_to = emp
            # Status remains 'Available'
            assigned_count += 1

        asset.save()
        created_count += 1

    print(f"\n\u2705  Migration Complete!")
    print(f"   - Created Assets: {created_count}")
    print(f"   - Re-assigned Laptops: {assigned_count}")

if __name__ == "__main__":
    base_dir = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(base_dir, 'Main_Inventory_Master.xlsx')
    apply_final_inventory(path)
