from copy import deepcopy
from uuid import uuid4
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest import skipUnless

from django.contrib.auth.models import User
from django.db.models.deletion import ProtectedError
from django.test import TestCase
from django.test import TransactionTestCase
from django.db import connection, close_old_connections
from rest_framework.test import APIClient

from .models import Asset, CompanySettings, Conference, ProgramDelivery, SubrentalCompany, SubrentalTicket, SubrentalTicketItem, TruckChallan, UserProfile


class ProgramDeliveryTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user('warehouse')
        UserProfile.objects.update_or_create(user=self.user, defaults={'role': 'godown_incharge'})
        self.user = User.objects.get(pk=self.user.pk)
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.settings = CompanySettings.objects.create(name='Pvt Ltd original', address='Original address')
        self.company = SubrentalCompany.objects.create(name='AM original', address='Supplier address')
        self.other = SubrentalCompany.objects.create(name='Other supplier')
        self.event = Conference.objects.create(name='Program original', association_name='Customer original', billing_address='Customer address')
        self.own = Asset.objects.create(sku='OWN', alias_name='Owned speaker')
        self.supplier = Asset.objects.create(sku='AM-QR', alias_name='Supplier speaker', serial_number='ORIGINAL-SERIAL', subrental_company=self.company)
        self.event.challan_assets.add(self.own, self.supplier)
        self.url = f'/api/conferences/{self.event.pk}/deliveries/'

    def preview(self, suffix=''):
        return self.client.get(self.url + 'preview/' + suffix)

    def payload(self, preview=None, **updates):
        preview = preview or self.preview().data
        data = {'request_key': str(uuid4()), 'source_hash': preview['source_hash'], 'reference': preview['suggested_reference'],
                'delivery_date': '2026-11-03', 'truck_id': None,
                'rows': [{'key': row['key'], 'quantity': row['quantity'], 'name': row['name']} for row in preview['source']['rows']]}
        data.update(updates)
        return data

    def issue(self, data=None):
        return self.client.post(self.url, data or self.payload(), format='json')

    def test_one_customer_and_each_supplier_document_with_matching_quantities(self):
        unit = Asset.objects.create(sku='OTHER', subrental_company=self.other)
        self.event.challan_assets.add(unit)
        response = self.issue()
        self.assertEqual(response.status_code, 201, response.data)
        snap = response.data['snapshot']
        self.assertEqual(len(snap['customer_document']['rows']), 3)
        self.assertEqual(len(snap['supplier_documents']), 2)
        supplier = next(doc for doc in snap['supplier_documents'] if doc['issuer']['name'] == self.company.name)
        self.assertEqual(supplier['recipient']['name'], self.settings.name)
        self.assertEqual(supplier['rows'][0]['sku'], 'AM-QR')
        self.assertEqual(supplier['rows'][0]['quantity'], 1)
        self.assertNotIn('price', str(supplier).lower())
        self.assertNotIn('rental_price', supplier['rows'][0])
        self.assertEqual(Asset.objects.count(), 3)
        self.assertFalse(self.event.assets.exists())

    def test_retries_reprints_and_renames_reuse_frozen_records(self):
        data = self.payload()
        issued = self.issue(data)
        original = deepcopy(issued.data['snapshot'])
        self.settings.name = 'Renamed Pvt Ltd'; self.settings.save()
        self.company.name = 'Renamed supplier'; self.company.save()
        self.event.name = 'Renamed event'; self.event.save()
        self.supplier.alias_name = 'Changed description'; self.supplier.item_price = 999; self.supplier.save()
        self.event.challan_assets.clear()
        retry = self.issue(data)
        self.assertEqual(retry.status_code, 200, retry.data)
        self.assertEqual(retry.data['snapshot'], original)
        self.assertEqual(self.client.get(self.url).data[0]['snapshot'], original)
        self.assertEqual(ProgramDelivery.objects.count(), 1)

    def test_asset_and_supplier_deletion_cannot_change_a_saved_paper(self):
        issued = self.issue()
        original = deepcopy(issued.data['snapshot'])
        self.supplier.delete()
        self.company.delete()
        self.assertEqual(self.client.get(self.url).data[0]['snapshot'], original)

    def test_next_delivery_has_new_numbers_and_same_request_key_cannot_be_repurposed(self):
        data = self.payload()
        first = self.issue(data)
        altered = {**data, 'reference': 'Altered'}
        self.assertEqual(self.issue(altered).status_code, 409)
        second = self.issue(self.payload(reference='Tomorrow', delivery_date='2026-11-04'))
        self.assertEqual(second.status_code, 201, second.data)
        self.assertNotEqual(first.data['snapshot']['supplier_documents'][0]['number'], second.data['snapshot']['supplier_documents'][0]['number'])
        self.assertEqual(ProgramDelivery.objects.count(), 2)

    def test_accounts_read_both_directions_but_cannot_issue_or_void_even_when_staff(self):
        issued = self.issue()
        self.user.is_staff = True; self.user.save()
        UserProfile.objects.filter(user=self.user).update(role='accounts')
        self.client.force_authenticate(User.objects.get(pk=self.user.pk))
        self.assertEqual(self.client.get(self.url).status_code, 200)
        self.assertEqual(len(self.client.get(self.url).data[0]['snapshot']['supplier_documents']), 1)
        self.assertEqual(self.preview().status_code, 403)
        self.assertEqual(self.issue({'request_key': str(uuid4())}).status_code, 403)
        self.assertEqual(self.client.post(self.url + f"{issued.data['id']}/void/", {'reason': 'No'}, format='json').status_code, 403)

    def test_anonymous_and_technician_access_refused(self):
        self.client.force_authenticate(None)
        self.assertEqual(self.client.get(self.url).status_code, 401)
        UserProfile.objects.filter(user=self.user).update(role='technician')
        self.client.force_authenticate(User.objects.get(pk=self.user.pk))
        self.assertEqual(self.client.get(self.url).status_code, 403)

    def test_stale_source_or_owner_refuses_without_issuing(self):
        data = self.payload()
        self.supplier.subrental_company = self.other; self.supplier.save()
        self.assertEqual(self.issue(data).status_code, 409)
        self.assertEqual(ProgramDelivery.objects.count(), 0)

    def test_quantity_duplicate_row_and_foreign_source_rejected_atomically(self):
        valid = self.payload()
        bad_cases = [
            [{**valid['rows'][0], 'quantity': 2}],
            [{**valid['rows'][0], 'quantity': 0}],
            [{**valid['rows'][0], 'quantity': 1.5}],
            [{**valid['rows'][0], 'quantity': True}],
            [valid['rows'][0], valid['rows'][0]],
            [{'key': 'asset:999999', 'quantity': 1}], [],
        ]
        for rows in bad_cases:
            self.assertEqual(self.issue({**valid, 'rows': rows}).status_code, 400)
        self.assertEqual(ProgramDelivery.objects.count(), 0)

    def test_duplicate_delivery_reference_and_cross_program_key_refused(self):
        data = self.payload()
        self.assertEqual(self.issue(data).status_code, 201)
        self.assertEqual(self.issue(self.payload(reference=data['reference'].lower())).status_code, 409)
        other = Conference.objects.create(name='Different event')
        response = self.client.post(f'/api/conferences/{other.pk}/deliveries/', data, format='json')
        self.assertEqual(response.status_code, 409)

    def test_void_keeps_papers_numbers_and_releases_only_document_selection_default(self):
        issued = self.issue()
        self.assertEqual(self.preview().data['previously_delivered'][f'asset:{self.supplier.pk}'], 1)
        path = self.url + f"{issued.data['id']}/void/"
        response = self.client.post(path, {'reason': 'Wrong vehicle; replacement to follow'}, format='json')
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['snapshot'], issued.data['snapshot'])
        again = self.client.post(path, {'reason': 'Different reason'}, format='json')
        self.assertEqual(again.data['void_reason'], response.data['void_reason'])
        self.assertEqual(self.preview().data['previously_delivered'], {})
        self.assertEqual(self.event.challan_assets.count(), 2)
        self.assertEqual(ProgramDelivery.objects.count(), 1)

    def test_event_deletion_cannot_erase_issued_documents(self):
        self.issue()
        self.event.assets.add(self.own)
        Asset.objects.filter(pk=self.own.pk).update(status='In Use')
        response = self.client.delete(f'/api/conferences/{self.event.pk}/')
        self.assertEqual(response.status_code, 409)
        self.own.refresh_from_db()
        self.assertEqual(self.own.status, 'In Use')
        with self.assertRaises(ProtectedError):
            self.event.delete()

    def test_ticket_and_scan_overlap_refuses_then_ticket_only_gets_supplier_paper(self):
        ticket = SubrentalTicket.objects.create(company=self.company, conference=self.event)
        SubrentalTicketItem.objects.create(ticket=ticket, asset=self.supplier)
        self.assertEqual(self.preview().status_code, 400)
        self.event.challan_assets.remove(self.supplier)
        response = self.issue()
        self.assertEqual(response.status_code, 201, response.data)
        self.assertTrue(response.data['snapshot']['supplier_documents'][0]['rows'][0]['key'].startswith('ticket:'))

    def test_ticket_owner_mismatch_and_duplicate_tickets_refuse(self):
        self.event.challan_assets.remove(self.supplier)
        ticket = SubrentalTicket.objects.create(company=self.other, conference=self.event)
        item = SubrentalTicketItem.objects.create(ticket=ticket, asset=self.supplier)
        self.assertEqual(self.preview().status_code, 400)
        ticket.company = self.company; ticket.save()
        SubrentalTicketItem.objects.create(ticket=ticket, asset=self.supplier)
        self.assertEqual(self.preview().status_code, 400)

    def test_truck_scope_excludes_other_equipment_and_quantities_are_validated(self):
        truck = TruckChallan.objects.create(conference=self.event, truck_number=1)
        truck.assets.add(self.supplier)
        preview = self.preview(f'?truck_id={truck.pk}').data
        response = self.issue(self.payload(preview, truck_id=truck.pk))
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(len(response.data['snapshot']['customer_document']['rows']), 1)
        other = Conference.objects.create(name='Other event')
        foreign_truck = TruckChallan.objects.create(conference=other)
        self.assertEqual(self.preview(f'?truck_id={foreign_truck.pk}').status_code, 404)

    def test_audit_programs_cannot_issue_and_supplier_bulk_stays_blocked(self):
        self.event.is_audit = True; self.event.save()
        self.assertEqual(self.preview().status_code, 400)
        self.event.is_audit = False; self.event.save()
        self.supplier.quantity = 5; self.supplier.save()
        self.assertEqual(self.preview().status_code, 400)

    def test_main_bulk_partial_delivery_and_manual_description_snapshot(self):
        self.own.quantity = 10; self.own.save()
        preview = self.preview().data
        data = self.payload(preview)
        own = next(row for row in data['rows'] if row['key'] == f'asset:{self.own.pk}')
        own.update(quantity=3, name='Description printed for this delivery')
        response = self.issue(data)
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(self.preview().data['previously_delivered'][own['key']], 3)
        self.own.refresh_from_db()
        self.assertEqual(self.own.quantity, 10)


@skipUnless(connection.vendor == 'postgresql', 'PostgreSQL row-lock/concurrency acceptance')
class ProgramDeliveryConcurrencyTests(TransactionTestCase):
    setUp = ProgramDeliveryTests.setUp
    preview = ProgramDeliveryTests.preview
    payload = ProgramDeliveryTests.payload

    def race(self, same_key):
        data = self.payload()
        barrier = Barrier(2)
        def issue(index):
            close_old_connections()
            try:
                client = APIClient()
                client.force_authenticate(User.objects.get(pk=self.user.pk))
                payload = {**data, 'request_key': data['request_key'] if same_key else str(uuid4())}
                barrier.wait(timeout=10)
                return client.post(self.url, payload, format='json').status_code
            finally:
                close_old_connections()
        with ThreadPoolExecutor(max_workers=2) as pool:
            statuses = sorted(pool.map(issue, [0, 1]))
        self.assertEqual(statuses, [200, 201] if same_key else [201, 409])
        self.assertEqual(ProgramDelivery.objects.count(), 1)

    def test_concurrent_retry_issues_once(self):
        self.race(same_key=True)

    def test_concurrent_same_reference_refuses_duplicate(self):
        self.race(same_key=False)
