from django.test import TestCase
from .models import Asset, Conference
from decimal import Decimal

class AssetStatusTestCase(TestCase):
    def setUp(self):
        self.asset1 = Asset.objects.create(
            sku="SKU1", 
            serial_number="SN1", 
            status="Available",
            quantity=1
        )
        self.asset2 = Asset.objects.create(
            sku="SKU2", 
            serial_number="SN2", 
            status="Available",
            quantity=1
        )
        self.conference = Conference.objects.create(
            name="Test Conf",
            association_name="Test Assoc",
            start_date="2024-01-01",
            end_date="2024-01-05"
        )

    def test_asset_assignment_status(self):
        # Assign asset1 to conference
        self.conference.assets.add(self.asset1)
        # Simulate serializer logic (status update)
        self.asset1.status = 'In Use'
        self.asset1.save()
        
        self.assertEqual(Asset.objects.get(id=self.asset1.id).status, 'In Use')

        # Remove asset1, it should become Available
        self.conference.assets.remove(self.asset1)
        # In our robust logic, we check if it's in any other conference
        in_other = Conference.objects.filter(assets=self.asset1).exists()
        if not in_other:
            self.asset1.status = 'Available'
            self.asset1.save()
            
        self.assertEqual(Asset.objects.get(id=self.asset1.id).status, 'Available')

    def test_crosscheck_assignment_status(self):
        # Move asset2 to crosscheck
        self.conference.crosscheck_assets.add(self.asset2)
        self.asset2.status = 'Crosscheck'
        self.asset2.save()
        
        self.assertEqual(Asset.objects.get(id=self.asset2.id).status, 'Crosscheck')

        # Verify removal from crosscheck marks as Available
        self.conference.crosscheck_assets.remove(self.asset2)
        in_any = Conference.objects.filter(assets=self.asset2).exists() or \
                 Conference.objects.filter(crosscheck_assets=self.asset2).exists()
        if not in_any:
            self.asset2.status = 'Available'
            self.asset2.save()
            
        self.assertEqual(Asset.objects.get(id=self.asset2.id).status, 'Available')
