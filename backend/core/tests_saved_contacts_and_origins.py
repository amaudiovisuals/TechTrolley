from copy import deepcopy
from uuid import uuid4

from django.contrib.auth.models import User
from django.test import TestCase
from rest_framework.test import APIClient

from .asset_commands import execute_command
from .challan_documents import capture_header
from .dispatch_origins import event_origins
from .models import Asset, ChallanDocument, ChallanLine, CompanySettings, Conference, SavedCustomer, SavedVenue, SubrentalCompany


class SavedContactsTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user('contacts', is_staff=False)
        self.user.profile.role = 'admin'; self.user.profile.save()
        self.client = APIClient(); self.client.force_authenticate(self.user)
        self.customer = {'name': 'Example customer', 'billing_address': 'Original billing address', 'gst_number': 'GST-EXAMPLE',
                         'contact_person': 'Contact person', 'contact_phone': '0000000000', 'contact_email': 'contact@example.test'}

    def create_customer(self):
        response = self.client.post('/api/saved-customers/', self.customer, format='json')
        self.assertEqual(response.status_code, 201, response.data)
        return response.data

    def test_save_search_and_repeated_save_do_not_duplicate_contacts(self):
        first = self.create_customer()
        repeated = self.client.post('/api/saved-customers/', self.customer, format='json')
        self.assertEqual(repeated.status_code, 200); self.assertEqual(first['id'], repeated.data['id'])
        self.assertEqual(SavedCustomer.objects.count(), 1)
        for query in ['example', 'GST-EXAMPLE', 'billing address']:
            self.assertEqual(len(self.client.get('/api/saved-customers/', {'search': query}).data), 1)

    def test_venue_is_named_and_reusable_with_optimistic_updates(self):
        response = self.client.post('/api/saved-venues/', {'name': 'Hotel main hall', 'address': 'Venue road'}, format='json')
        self.assertEqual(response.status_code, 201, response.data)
        url = f"/api/saved-venues/{response.data['id']}/"
        self.assertEqual(self.client.patch(url, {'address': 'Changed'}, format='json').status_code, 428)
        updated = self.client.patch(url, {'address': 'Changed', 'expected_revision': 1}, format='json')
        self.assertEqual(updated.status_code, 200, updated.data)
        self.assertEqual(self.client.patch(url, {'address': 'Lost edit', 'expected_revision': 1}, format='json').status_code, 409)
        self.assertEqual(self.client.get('/api/saved-venues/', {'search': 'changed'}).data[0]['address'], 'Changed')

    def test_library_edit_and_archive_do_not_rewrite_program_or_issued_paper(self):
        customer = self.create_customer()
        event = Conference.objects.create(name='Program', association_name=customer['name'], billing_address=customer['billing_address'], gst_number=customer['gst_number'])
        document = ChallanDocument.objects.create(conference=event, scope='master', state='issued', number='CONTACT-SNAPSHOT', header=capture_header(event))
        original = deepcopy(document.header)
        url = f"/api/saved-customers/{customer['id']}/"
        response = self.client.patch(url, {'billing_address': 'New billing address', 'is_active': False, 'expected_revision': 1}, format='json')
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(self.client.get('/api/saved-customers/').data, [])
        event.refresh_from_db(); document.refresh_from_db()
        self.assertEqual(event.billing_address, 'Original billing address'); self.assertEqual(document.header, original)

    def test_role_rules_ignore_editable_staff_flag(self):
        self.user.is_staff = True; self.user.save()
        for role in ['technician', 'godown_incharge', 'accounts']:
            self.user.profile.role = role; self.user.profile.save()
            read = self.client.get('/api/saved-customers/')
            self.assertEqual(read.status_code, 403 if role == 'technician' else 200)
            write = self.client.post('/api/saved-customers/', self.customer, format='json')
            self.assertEqual(write.status_code, 201 if role == 'accounts' else 403)

    def test_invalid_inputs_and_attempted_delete_do_not_mutate_records(self):
        for value in [{}, {'name': 'Only name'}, {**self.customer, 'billing_address': 'x' * 4001}, {**self.customer, 'contact_email': 'invalid'}, {**self.customer, 'revision': 5}]:
            self.assertEqual(self.client.post('/api/saved-customers/', value, format='json').status_code, 400)
        self.assertEqual(SavedCustomer.objects.count(), 0)
        saved = self.create_customer()
        self.assertEqual(self.client.delete(f"/api/saved-customers/{saved['id']}/").status_code, 405)
        self.assertEqual(SavedCustomer.objects.count(), 1)


class DispatchOriginTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user('warehouse-origin')
        self.user.profile.role = 'admin'; self.user.profile.save()
        self.client = APIClient(); self.client.force_authenticate(self.user)
        self.company = CompanySettings.objects.create(name='Pvt Ltd', address='Godown address')
        self.owner = SubrentalCompany.objects.create(name='AM supplier', inventory_mode='shared_warehouse')
        self.asset = Asset.objects.create(sku='ORIGIN-SUPPLIER', quantity=1, subrental_company=self.owner)
        self.other = Asset.objects.create(sku='ORIGIN-OWNED', quantity=1)
        self.source = Conference.objects.create(name='Venue A program', transport_address='Venue A\n' + 'Full address ' * 25)
        self.target = Conference.objects.create(name='Venue B program', transport_address='Venue B address', association_name='Customer B')

    def move(self, event, action, assets, **extra):
        return execute_command(self.user, event.pk, {'request_id': str(uuid4()), 'action': action, 'asset_ids': [a.pk for a in assets], 'source': 'qr', **extra})

    def dispatch(self, event, assets):
        self.move(event, 'stage', assets); return self.move(event, 'dispatch', assets)

    def document(self, event, assets):
        event.refresh_from_db()
        doc = ChallanDocument.objects.create(conference=event, scope='master', state='issued', number=f'ORIGIN-{event.pk}', header=capture_header(event))
        for i, asset in enumerate(assets):
            ChallanLine.objects.create(document=doc, asset=asset, supplier=asset.subrental_company, source_kind='supplier' if asset.subrental_company_id else 'owned', quantity=1, unit_value=0, position=i,
                                      snapshot={'sku': asset.sku, 'alias_name': asset.sku, 'supplier_name': asset.subrental_company.name if asset.subrental_company_id else ''})
        return doc

    def test_transfer_removes_source_return_membership_but_preserves_original_dispatch(self):
        self.dispatch(self.source, [self.asset, self.other])
        original = self.document(self.source, [self.asset, self.other])
        result = self.move(self.source, 'transfer', [self.asset], target_conference_id=self.target.pk)
        self.assertEqual(result['conference']['assets'], [self.other.pk])
        self.assertIn(self.asset.pk, result['conference']['challan_assets'])
        self.assertIn(self.asset.pk, result['target_conference']['assets'])
        self.assertEqual(original.lines.count(), 2)
        self.assertEqual(result['target_conference']['dispatch_origins'][0]['address'], self.source.transport_address)
        self.source.refresh_from_db()
        self.assertEqual(self.source.transfer_log[0]['from_address'], self.source.transport_address)

    def test_saved_target_and_both_delivery_directions_freeze_the_full_venue_origin(self):
        self.dispatch(self.source, [self.asset]); self.move(self.source, 'transfer', [self.asset], target_conference_id=self.target.pk)
        doc = self.document(self.target, [self.asset]); expected = self.source.transport_address
        self.source.transport_address = 'Changed source address'; self.source.save()
        url = f'/api/conferences/{self.target.pk}/deliveries/'
        preview = self.client.get(url + 'preview/'); self.assertEqual(preview.status_code, 200, preview.data)
        rows = preview.data['source']['rows']
        body = {'request_key': str(uuid4()), 'source_hash': preview.data['source_hash'], 'reference': 'Transfer delivery', 'delivery_date': '2026-11-06', 'truck_id': None,
                'rows': [{'key': r['key'], 'name': r['name'], 'quantity': 1} for r in rows]}
        saved = self.client.post(url, body, format='json'); self.assertEqual(saved.status_code, 201, saved.data)
        snapshot = saved.data['snapshot']
        for paper in [snapshot['customer_document'], *snapshot['supplier_documents']]:
            self.assertEqual(paper['dispatch_origins'][0]['address'], expected)
            self.assertEqual(paper['dispatch_origins'][0]['asset_ids'], [self.asset.pk])
        self.assertEqual(self.client.post(url, body, format='json').data['snapshot'], snapshot)
        doc.refresh_from_db(); self.assertEqual(doc.header['dispatch_origins'][0]['address'], expected)

    def test_mixed_arrivals_and_further_transfer_keep_distinct_recorded_origins(self):
        self.dispatch(self.source, [self.asset]); self.move(self.source, 'transfer', [self.asset], target_conference_id=self.target.pk)
        self.dispatch(self.target, [self.other])
        origins = event_origins(self.target)
        self.assertEqual({o['kind'] for o in origins}, {'venue', 'warehouse'})
        third = Conference.objects.create(name='Venue C', transport_address='Venue C address')
        self.move(self.target, 'transfer', [self.asset], target_conference_id=third.pk)
        self.assertEqual(event_origins(third)[0]['address'], 'Venue B address')
        self.assertEqual(event_origins(self.target)[0]['address'], self.source.transport_address)

    def test_retry_does_not_recreate_origin_or_follow_later_address_edits(self):
        self.dispatch(self.source, [self.asset])
        body = {'request_id': str(uuid4()), 'action': 'transfer', 'asset_ids': [self.asset.pk], 'target_conference_id': self.target.pk, 'source': 'untrusted short override'}
        first = execute_command(self.user, self.source.pk, body)
        self.source.transport_address = 'Later address'; self.source.save()
        replay = execute_command(self.user, self.source.pk, body)
        self.assertTrue(replay['replayed'])
        self.assertEqual(first['target_conference']['dispatch_origins'], replay['target_conference']['dispatch_origins'])
