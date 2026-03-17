import os
import django
import sys

# Set up Django environment
sys.path.append(os.path.join(os.getcwd(), 'backend'))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from core.models import Asset
from core.serializers import AssetSerializer
from rest_framework.renderers import JSONRenderer

def diagnose():
    print("Fetching all assets...")
    assets = Asset.objects.all()
    print(f"Found {assets.count()} assets.")
    
    try:
        serializer = AssetSerializer(assets, many=True)
        print("Serializing assets...")
        data = serializer.data
        print("Rendering to JSON...")
        json_data = JSONRenderer().render(data)
        print("Success!")
    except Exception as e:
        print(f"FAILED during serialization/rendering: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    diagnose()
