import os
import django
import sys

# Setup Django environment
project_root = os.path.dirname(os.path.abspath(__file__))
if project_root not in sys.path:
    sys.path.insert(0, project_root)

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from core.models import Asset

def migrate():
    mapping = {
        'Sound System': [
            'Speakers & Audio', 'Audio Mixers', 'Microphones'
        ],
        'IT & Networking': [
            'Laptops', 'Smartphones', 'Computers & Servers', 
            'Peripherals', 'UPS & Power', 'Printers'
        ],
        'Display System': [
            'Monitors', 'TVs', 'Projectors'
        ],
        'AV Equipment': [
            'Video Switchers', 'Capture Cards', 'Cameras'
        ],
        'Cable and consumables': [
            'Splitters & Converters', 'Consumables'
        ],
        'Lighting & Effects': [
            'Lighting & LED'
        ]
    }

    updated_count = 0
    
    # Reverse the mapping for easy lookup
    reverse_map = {}
    for new_cat, old_cats in mapping.items():
        for old_cat in old_cats:
            reverse_map[old_cat.lower()] = new_cat

    print("🚀 Starting category migration...")
    
    all_assets = Asset.objects.all()
    for asset in all_assets:
        current_type = asset.type.strip()
        new_type = reverse_map.get(current_type.lower())
        
        if new_type and current_type != new_type:
            asset.type = new_type
            asset.save()
            updated_count += 1
            # print(f"✅ Updated {asset.sku}: {current_type} -> {new_type}")

    print(f"\n✅ Migration complete! {updated_count} assets updated.")

if __name__ == "__main__":
    migrate()
