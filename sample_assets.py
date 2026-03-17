import os
import django
import sys
import json

# Set up Django environment
sys.path.append(os.path.join(os.getcwd(), 'backend'))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from core.models import Asset
from core.serializers import AssetSerializer

def sample_assets():
    assets = Asset.objects.all()[:5]
    serializer = AssetSerializer(assets, many=True)
    with open('assets_sample.json', 'w') as f:
        json.dump(serializer.data, f, indent=2)
    print("Sample assets written to assets_sample.json")

if __name__ == "__main__":
    sample_assets()
