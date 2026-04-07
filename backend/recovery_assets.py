
import os
import django
from decimal import Decimal

# Setup Django
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from core.models import Asset, Employee

def recover_assigned_assets():
    print("🚀 Starting Recovery of Employee Assets...")
    
    # 1. Define the targets (based on original assignment logic)
    assignments = {
        'NHQLTSI006338035C47600': {'name': 'BHAVIN', 'dept': 'USER', 'sku': 'LAPTOP-BH-1'},
        'NHQLTSI005336025607600': {'name': 'BHAVIN', 'dept': 'USER', 'sku': 'LAPTOP-BH-2'},
        'MNWJK9R63F': {'name': 'JITHIN RAMESH', 'dept': 'USER', 'sku': 'LAPTOP-JR-1'},
        'D2507N0000517': {'name': 'JISHNU K P', 'dept': 'USER', 'sku': 'LAPTOP-JKP-1'},
        '5CD52409KL': {'name': 'NIHAL', 'dept': 'MANAGEMENT', 'sku': 'LAPTOP-NIHAL-1'},
        'D2507N0000644': {'name': 'BHAVIN', 'dept': 'USER', 'sku': 'LAPTOP-BH-3'},
        'FVFY84UXHV22': {'name': 'RIYAN', 'dept': 'MANAGEMENT', 'sku': 'LAPTOP-RIYAN-1'}
    }

    recovered_count = 0
    assigned_count = 0

    for sn, info in assignments.items():
        # Get or create employee
        emp_id = info['name'].replace(" ", "_").upper()
        emp, created = Employee.objects.get_or_create(
            employee_id=emp_id,
            defaults={
                'name': info['name'], 
                'department': info['dept'], 
                'email': f"{emp_id.lower()}@techtrolley.amaudiovisuals.com",
                'phone': '0000000000'
            }
        )
        if created:
            print(f"✅ Created Employee: {info['name']}")

        # Check if asset exists by SN or SKU
        asset = Asset.objects.filter(serial_number=sn).first()
        if not asset:
            asset = Asset.objects.filter(sku=info['sku']).first()

        if not asset:
            # Re-create missing asset
            asset = Asset.objects.create(
                sku=info['sku'],
                serial_number=sn,
                alias_name=f"Laptop - {info['name']}",
                type='Laptops',
                description=f"Recovered laptop for {info['name']}",
                status='Available', # Status for assigned personal assets is generally 'Available' or 'In Use'
                item_price=Decimal('0.00'),
                assigned_to=emp
            )
            print(f"📦 Recovered Missing Asset: {sn} ({info['name']})")
            recovered_count += 1
        else:
            # Update assignment if missing
            if asset.assigned_to != emp:
                asset.assigned_to = emp
                asset.save()
                print(f"🔗 Re-linked Asset: {sn} -> {info['name']}")
                assigned_count += 1
            else:
                print(f"🆗 Asset already linked: {sn} -> {info['name']}")

    print(f"\n✅ Recovery Complete!")
    print(f"   - Re-created Assets: {recovered_count}")
    print(f"   - Re-assigned Assets: {assigned_count}")
    print(f"   - Final Total Assets: {Asset.objects.count()}")

if __name__ == "__main__":
    recover_assigned_assets()
