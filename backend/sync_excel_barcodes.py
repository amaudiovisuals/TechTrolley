
import os
import django
import pandas as pd
import sys

# Setup Django environment
project_root = os.path.dirname(os.path.abspath(__file__))
if project_root not in sys.path:
    sys.path.insert(0, project_root)

os.environ['DJANGO_SETTINGS_MODULE'] = 'config.settings'
django.setup()

from core.models import Asset

def sync_barcodes(excel_path):
    print(f"🚀 Starting barcode synchronization from: {excel_path}")
    
    if not os.path.exists(excel_path):
        print(f"❌ Error: File not found at {excel_path}")
        return

    try:
        df = pd.read_excel(excel_path)
    except Exception as e:
        print(f"❌ Error reading Excel: {e}")
        return

    # Normalize column names (sometimes they have leading/trailing spaces)
    df.columns = [c.strip() for c in df.columns]

    required_cols = ['SKU', 'Barcode', 'QR Code']
    for col in required_cols:
        if col not in df.columns:
            print(f"❌ Error: Missing required column '{col}' in Excel.")
            return

    updated_count = 0
    not_found_count = 0
    errors_count = 0

    print("--- Processing Assets ---")
    for _, row in df.iterrows():
        sku = str(row['SKU']).strip()
        barcode = str(row['Barcode']).strip() if pd.notna(row['Barcode']) else ""
        qr_code = str(row['QR Code']).strip() if pd.notna(row['QR Code']) else ""

        # Clean "nan" strings if pandas didn't catch them
        def clean_val(v): return "" if str(v).lower() == 'nan' else v
        barcode = clean_val(barcode)
        qr_code = clean_val(qr_code)

        if not barcode and not qr_code:
            continue

        try:
            # Match by SKU
            assets = Asset.objects.filter(sku=sku)
            if assets.exists():
                for asset in assets:
                    asset.barcode = barcode
                    asset.qr_code = qr_code
                    asset.save()
                updated_count += 1
            else:
                not_found_count += 1
                # Optional: log what SKU was not found
                # print(f"⚠️ SKU not found in DB: {sku}")
        except Exception as e:
            print(f"❌ Error updating SKU {sku}: {e}")
            errors_count += 1

    print("\n--- Sync Complete ---")
    print(f"✅ Success: {updated_count} assets updated.")
    print(f"⚠️ Skipped: {not_found_count} SKUs from Excel not found in database.")
    if errors_count > 0:
        print(f"❌ Errors: {errors_count} issues encountered.")

if __name__ == "__main__":
    # Path to the specific Excel file
    base_dir = os.path.dirname(os.path.abspath(__file__))
    excel_path = os.path.join(base_dir, 'allstockreportforproduction.xlsx')
    sync_barcodes(excel_path)
