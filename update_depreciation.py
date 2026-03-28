import os
import django
import sys

# Setup Django environment
sys.path.append(os.path.join(os.getcwd(), 'backend'))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from core.models import Asset

def update_depreciation():
    print("🚀 Starting Depreciation Update...")
    assets = Asset.objects.all()
    count_laptops = 0
    count_others = 0
    
    laptop_keywords = ['LAPTOP', 'MACBOOK', 'SURFACE', 'THINKPAD']
    
    for asset in assets:
        sku_upper = (asset.sku or "").upper()
        type_upper = (asset.type or "").upper()
        
        is_laptop = any(kw in sku_upper for kw in laptop_keywords) or "LAPTOP" in type_upper or "COMPUTERS" in type_upper
        
        if is_laptop:
            asset.depreciation_percentage = 40.0
            count_laptops += 1
        else:
            asset.depreciation_percentage = 15.0
            count_others += 1
        
        asset.save()
        
    print(f"✅ Update Complete!")
    print(f"💻 Laptops (40%): {count_laptops}")
    print(f"📦 Others (15%): {count_others}")

if __name__ == "__main__":
    update_depreciation()
