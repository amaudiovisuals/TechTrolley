from io import BytesIO
from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth.models import User
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from openpyxl import Workbook, load_workbook
from rest_framework.test import APIClient

from .models import Asset, Conference, SubrentalCompany, UserProfile
from .serializers import SimpleAssetSerializer


class InventoryHotfixTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user('inventory-admin', is_staff=True)
        UserProfile.objects.update_or_create(user=self.admin, defaults={'role': 'admin'})
        self.supplier = SubrentalCompany.objects.create(name='AM test supplier')
        self.other = SubrentalCompany.objects.create(name='Other test supplier')
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def upload(self, rows, owner=None, headers=None):
        book = Workbook()
        book.active.append(headers or ['SKU', 'Serial Number', 'Alias Name', 'Quantity', 'Type', 'Barcode', 'QR Code', 'Item Price'])
        for row in rows:
            book.active.append(row)
        output = BytesIO()
        book.save(output)
        data = {'file': SimpleUploadedFile('inventory.xlsx', output.getvalue())}
        if owner is not None:
            data['subrental_company_id'] = str(owner)
        return self.client.post('/api/upload-assets/', data, format='multipart')

    def test_idle_supplier_inventory_complete_beyond_first_page(self):
        Asset.objects.bulk_create([Asset(sku=f'SUP-{i}', serial_number=f'SN-{i}', subrental_company=self.supplier) for i in range(57)])
        main = Asset.objects.create(sku='MAIN')
        Asset.objects.create(sku='OTHER', subrental_company=self.other)
        Asset.objects.create(sku='TEMP', is_temporary=True, subrental_company=self.supplier)
        default = self.client.get('/api/assets/')
        self.assertEqual([row['id'] for row in default.data['results']], [main.id])
        response = self.client.get('/api/assets/', {'all': 'true', 'subrental_company_id': self.supplier.id})
        self.assertEqual(len(response.data), 57)
        self.assertTrue(all(row['subrental_company'] == self.supplier.id and row['subrental_company_name'] == self.supplier.name for row in response.data))
        lookup = self.client.get('/api/assets/', {'all': 'true'})
        self.assertEqual(len(lookup.data), 59)

    def test_attached_temporary_lookup_is_preserved(self):
        asset = Asset.objects.create(sku='TEMP', is_temporary=True, subrental_company=self.supplier)
        event = Conference.objects.create(name='Synthetic event')
        event.challan_assets.add(asset)
        self.assertIn(asset.id, [row['id'] for row in self.client.get('/api/assets/?all=true').data])

    def test_embedded_document_asset_preserves_owner(self):
        asset = Asset.objects.create(sku='PAPER', subrental_company=self.supplier)
        self.assertEqual(SimpleAssetSerializer(asset).data['subrental_company_name'], self.supplier.name)

    def test_new_supplier_import(self):
        response = self.upload([['NEW', 'SERIAL', 'New unit', 1, 'Laptops', 'BAR', 'QR', 100]], self.supplier.id)
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(response.data['created'], 1)
        asset = Asset.objects.get(sku='NEW')
        self.assertEqual((asset.quantity, asset.subrental_company_id, asset.status), (1, self.supplier.id, 'Available'))

    def test_batch_skips_occupied_identifiers_and_reuses_exact_result(self):
        Asset.objects.create(sku='HDMI_013')
        Asset.objects.create(sku='OTHER', barcode='hdmi_015')
        packet = {'request_id': str(uuid4()), 'count': 5, 'asset': {
            'sku': 'HDMI_013', 'alias_name': 'HDMI Short', 'type': 'Cable',
            'serial_number': 'REAL-SERIAL', 'mac_address': 'REAL-MAC',
            'purchased_date': '2026-11-13', 'item_price': '500.00',
        }}
        preview = self.client.post('/api/assets/batch-preview/', {'sku': 'HDMI_013', 'count': 5}, format='json')
        self.assertEqual(preview.data['skus'], ['HDMI_014', 'HDMI_016', 'HDMI_017', 'HDMI_018', 'HDMI_019'])
        Asset.objects.create(sku='LONG-8')
        prefix_preview = self.client.post('/api/assets/batch-preview/', {'sku': 'LONG', 'count': 2}, format='json')
        self.assertEqual(prefix_preview.data['skus'], ['LONG-9', 'LONG-10'])
        self.assertEqual(Asset.objects.count(), 3)
        first = self.client.post('/api/assets/', packet, format='json')
        self.assertEqual(first.status_code, 201, first.data)
        self.assertEqual([row['sku'] for row in first.data], preview.data['skus'])
        self.assertEqual([row['serial_number'] for row in first.data], ['REAL-SERIAL', '', '', '', ''])
        self.assertEqual([row['mac_address'] for row in first.data], ['REAL-MAC', '', '', '', ''])
        for row in first.data:
            self.assertEqual((row['quantity'], row['qr_code'], row['alias_name'], row['purchased_date'], row['item_price']),
                             (1, row['sku'], 'HDMI Short', '2026-11-13', '500.00'))
        replay = self.client.post('/api/assets/', packet, format='json')
        self.assertEqual(replay.data, first.data)
        self.assertEqual(Asset.objects.count(), 8)
        self.assertEqual(self.client.post('/api/assets/', {**packet, 'count': 4}, format='json').status_code, 400)

    def test_unfilled_serials_stay_blank_and_duplicate_legacy_tokens_can_still_be_edited(self):
        Asset.objects.create(sku='DUP-A', barcode='LEGACY-TAG')
        legacy = Asset.objects.create(sku='DUP-B', barcode='LEGACY-TAG')
        packet = {'request_id': str(uuid4()), 'count': 2, 'asset': {'sku': 'CABLE_1', 'type': 'Cable'}}
        response = self.client.post('/api/assets/', packet, format='json')
        self.assertEqual(response.status_code, 201, response.data)
        self.assertTrue(all(row['serial_number'] == '' for row in response.data))
        self.assertEqual(self.client.patch(f'/api/assets/{legacy.pk}/', {'barcode': 'LEGACY-TAG', 'description': 'Normal edit'}, format='json').status_code, 200)
        self.assertEqual(self.client.patch(f'/api/assets/{legacy.pk}/', {'barcode': ' cable_1 '}, format='json').status_code, 400)

    def test_import_and_inventory_saves_block_new_bulk_warehouse_records(self):
        self.assertEqual(self.client.post('/api/assets/', {'sku': 'BULK', 'quantity': 5}, format='json').status_code, 400)
        response = self.upload([['GOOD', '', 'Good row', 1, 'Cable'], ['BULK', '', 'Bulk row', 5, 'Cable']])
        self.assertEqual(response.status_code, 400)
        self.assertIn('one row per item', response.data['errors'][0])
        self.assertFalse(Asset.objects.exists())
        legacy = Asset.objects.create(sku='OLD', quantity=5)
        self.assertEqual(self.client.patch(f'/api/assets/{legacy.pk}/', {'description': 'Metadata'}, format='json').status_code, 200)
        self.assertEqual(self.client.patch(f'/api/assets/{legacy.pk}/', {'quantity': 1}, format='json').status_code, 400)
        legacy.refresh_from_db()
        self.assertEqual((legacy.quantity, legacy.description), (5, 'Metadata'))

    def test_consumables_and_external_catalogue_keep_stock_counts(self):
        self.supplier.inventory_mode = 'external_supplier'
        self.supplier.save(update_fields=['inventory_mode'])
        self.assertEqual(self.upload([['EXTERNAL', '', 'Supplier catalogue', 5]], self.supplier.id).status_code, 201)
        self.assertEqual(self.upload([['TAPE', '', 'Tape', 10, 'Consumables']]).status_code, 201)
        self.assertEqual(Asset.objects.get(sku='EXTERNAL').quantity, 5)
        self.assertEqual(Asset.objects.get(sku='TAPE').quantity, 10)

    def test_export_keeps_one_row_per_record_and_the_recorded_quantity(self):
        Asset.objects.create(sku='OLD-MULTI', quantity=12)
        response = self.client.get('/api/export-inventory/?type=master')
        headers, *rows = list(load_workbook(BytesIO(response.content)).active.values)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][headers.index('Quantity')], 12)

    def test_supplier_bulk_cannot_lose_owner_through_legacy_split(self):
        asset = Asset.objects.create(sku='SHARED-BULK', quantity=10, subrental_company=self.supplier)
        event = Conference.objects.create(name='Synthetic bulk event')
        response = self.client.post(f'/api/assets/{asset.pk}/assign-quantity/', {'quantity': 3, 'conference_id': event.pk}, format='json')
        self.assertEqual(response.status_code, 409)
        asset.refresh_from_db()
        self.assertEqual((asset.quantity, asset.subrental_company_id, Asset.objects.count()), (10, self.supplier.pk, 1))
        self.assertFalse(event.assets.exists())

    def test_existing_asset_is_not_overwritten_or_transferred(self):
        original = Asset.objects.create(sku='M17', serial_number='REAL-SERIAL', alias_name='Original', quantity=1, status='Crosscheck')
        event = Conference.objects.create(name='Original history')
        event.challan_assets.add(original)
        response = self.upload([['REPLACEMENT', 'REAL-SERIAL', 'Changed', 9]], self.supplier.id)
        self.assertEqual(response.status_code, 400)
        original.refresh_from_db()
        self.assertEqual((original.alias_name, original.quantity, original.status, original.subrental_company_id), ('Original', 1, 'Crosscheck', None))
        self.assertTrue(event.challan_assets.filter(pk=original.pk).exists())

    def test_cross_field_and_case_insensitive_conflicts(self):
        Asset.objects.create(sku='OLD', barcode='Mixed-QR', subrental_company=self.other)
        response = self.upload([['NEW', 'mixed-qr', 'Conflict', 1]], self.supplier.id)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(Asset.objects.count(), 1)

    def test_invalid_row_keeps_entire_upload_unchanged(self):
        response = self.upload([['VALID', 'VALID-SERIAL', 'Valid', 1], ['INVALID', 'INVALID-SERIAL', 'Invalid', 1.5]])
        self.assertEqual(response.status_code, 400)
        self.assertEqual((response.data['created'], Asset.objects.count()), (0, 0))
        self.assertIn('Row 3', response.data['errors'][0])

    def test_duplicate_rows_do_not_create_stock(self):
        response = self.upload([['DUP', 'SERIAL', 'First', 1], ['DUP', 'SERIAL', 'Second', 1]])
        self.assertEqual(response.status_code, 400)
        self.assertEqual(Asset.objects.count(), 0)

    def test_repeated_import_does_not_duplicate(self):
        row = ['ONCE', 'ONCE-SERIAL', 'One', 1]
        self.assertEqual(self.upload([row]).status_code, 201)
        self.assertEqual(self.upload([row], self.supplier.id).status_code, 400)
        self.assertEqual(Asset.objects.count(), 1)
        self.assertIsNone(Asset.objects.get().subrental_company_id)

    def test_formula_and_missing_supplier_are_rejected(self):
        self.assertEqual(self.upload([['FORMULA', 'SERIAL', '=1+1', 1]]).status_code, 400)
        self.assertEqual(self.upload([['NEW', 'SERIAL', 'Name', 1]], 999999).status_code, 400)
        self.assertEqual(Asset.objects.count(), 0)

    def test_failure_during_save_rolls_back_previous_rows(self):
        original_save = Asset.save
        def fail_second(asset, *args, **kwargs):
            if asset.sku == 'SECOND':
                raise RuntimeError('synthetic failure')
            return original_save(asset, *args, **kwargs)
        with patch.object(Asset, 'save', fail_second), self.assertLogs('core.views', level='ERROR'):
            response = self.upload([['FIRST', 'FIRST-SERIAL', 'First', 1], ['SECOND', 'SECOND-SERIAL', 'Second', 1]])
        self.assertEqual(response.status_code, 500)
        self.assertEqual(Asset.objects.count(), 0)

    def test_accounts_and_anonymous_cannot_import(self):
        accounts = User.objects.create_user('accounts')
        UserProfile.objects.update_or_create(user=accounts, defaults={'role': 'accounts'})
        self.client.force_authenticate(accounts)
        self.assertEqual(self.upload([['NEW', 'SERIAL', 'Name', 1]]).status_code, 403)
        self.client.force_authenticate(None)
        self.assertEqual(self.upload([['NEW', 'SERIAL', 'Name', 1]]).status_code, 401)

    def test_template_routes_contain_no_existing_inventory(self):
        Asset.objects.create(sku='PRIVATE-EXISTING-STOCK', alias_name='PRIVATE-EXISTING-NAME')
        for path in ['/api/download-template/', '/api/export-inventory/?type=template']:
            response = self.client.get(path)
            self.assertEqual(response.status_code, 200)
            sheet = load_workbook(BytesIO(response.content)).active
            values = list(sheet.values)
            self.assertEqual(len(values), 2)
            self.assertNotIn('PRIVATE-EXISTING-STOCK', str(values))
            self.assertNotIn('PRIVATE-EXISTING-NAME', str(values))

    def test_master_exports_are_owner_scoped(self):
        Asset.objects.create(sku='MAIN', alias_name='Main')
        Asset.objects.create(sku='SUPPLIER', alias_name='Supplier', subrental_company=self.supplier)
        Asset.objects.create(sku='OTHER', alias_name='Other', subrental_company=self.other)
        for suffix, expected, excluded in [('', 'MAIN', 'SUPPLIER'), (f'&subrental_company_id={self.supplier.id}', 'SUPPLIER', 'MAIN')]:
            response = self.client.get('/api/export-inventory/?type=master' + suffix)
            values = list(load_workbook(BytesIO(response.content)).active.values)
            self.assertIn(expected, str(values))
            self.assertNotIn(excluded, str(values))
            self.assertNotIn('OTHER', str(values))
