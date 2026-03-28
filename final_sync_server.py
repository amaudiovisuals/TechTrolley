import os
import django
import sys

# Setup Django environment
# Assuming this runs from /home/ubuntu/TechTrolley/
sys.path.append(os.path.join(os.getcwd(), 'backend'))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
os.environ.setdefault('DJANGO_ENV', 'production') # Ensure it hits Postgres
django.setup()

from core.models import Asset

def final_sync():
    print("🚀 Starting Final Server Sync (Production)...")
    
    # 1. Update Depreciation
    assets = Asset.objects.all()
    count_laptops = 0
    count_others = 0
    
    laptop_keywords = ['LAPTOP', 'MACBOOK', 'SURFACE', 'THINKPAD', 'NOTEBOOK', 'ELITEBOOK', 'LATITUDE', 'PRECISION', 'YOGA', 'VIVOBOOK', 'ZENBOOK']
    description_keywords = ['I3', 'I5', 'I7', 'I9', 'RYZEN', 'INCH', 'GB RAM', 'SSD', 'PROCESSOR']
    
    # Categories Mapping (Matches the taxonomy we defined)
    # This is a simplified version of the logic used in apply_cleaned_inventory
    for asset in assets:
        sku_upper = (asset.sku or "").upper()
        type_upper = (asset.type or "").upper()
        desc_upper = (asset.description or "").upper()
        
        # Determine Laptop
        is_laptop = any(kw in sku_upper for kw in laptop_keywords) or \
                    "LAPTOP" in type_upper or "COMPUTERS" in type_upper or \
                    (any(kw in desc_upper for kw in description_keywords) and asset.item_price > 10000)
        
        if is_laptop:
            asset.depreciation_percentage = 40.0
            count_laptops += 1
            if asset.type == 'Other': asset.type = 'Laptops'
        else:
            asset.depreciation_percentage = 15.0
            count_others += 1
            # If still 'Other', try to reclassify based on common keywords
            if asset.type == 'Other':
                if any(k in sku_upper for k in ['BOSE', 'JBL', 'SPEAKER', 'MIC']): asset.type = 'Speakers & Audio'
                elif any(k in sku_upper for k in ['SMARTPHONE', 'IPHONE', 'GALAXY']): asset.type = 'Smartphones'
                elif any(k in sku_upper for k in ['LED', 'SCREEN', 'TV']): asset.type = 'LED & Displays'
        
        asset.save()
        
    print(f"✅ Sync Complete!")
    print(f"💻 Laptops (40%): {count_laptops}")
    print(f"📦 Others (15%): {count_others}")

if __name__ == "__main__":
    final_sync()
