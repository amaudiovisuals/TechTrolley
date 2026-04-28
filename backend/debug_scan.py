import os
import sys
import django

# Add the backend directory to sys.path
sys.path.append(os.path.join(os.path.dirname(__file__), '.'))

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from core.models import Conference

c = Conference.objects.filter(challan_number="1081").first()
if c:
    print(f"Conference ID: {c.id}, Name: {c.name}")
    print(f"Assets: {list(c.assets.values('id', 'sku'))}")
    print(f"Staged: {list(c.staged_assets.values('id', 'sku'))}")
else:
    print("Conference with Challan 1081 not found")

# Search by association name ABCD
c2 = Conference.objects.filter(association_name="ABCD").first()
if c2:
    print(f"\nConference by ABCD ID: {c2.id}, Name: {c2.name}")
    print(f"Assets: {list(c2.assets.values('id', 'sku'))}")
