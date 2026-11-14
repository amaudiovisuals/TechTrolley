from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from threading import Barrier
from unittest import skipUnless
from uuid import uuid4

from django.contrib.auth.models import User
from django.db import close_old_connections, connection
from django.test import TestCase, TransactionTestCase
from rest_framework.test import APIClient

from .asset_commands import CommandError, execute_command
from .challan_documents import reserve_number
from .models import Asset, CompanySettings, Conference, ReturnDelivery, ReturnDeliveryLine, SubrentalCompany
from .quantity_commands import execute_quantity_command
from .return_deliveries import issue_return
from .tests_program_deliveries import reviewed


class ReturnDeliveryTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_superuser('returns')
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.company = CompanySettings.objects.create(name='Original company', address='Godown road')
        self.event = Conference.objects.create(name='First venue', transport_address='First venue road')
        self.target = Conference.objects.create(name='Second venue', transport_address='Second venue road')
        self.unit = Asset.objects.create(sku='RETURN-UNIT', alias_name='Unit', item_price=300)
        self.forward = Asset.objects.create(sku='FORWARDED', alias_name='Forwarded item')
        self.owner = SubrentalCompany.objects.create(name='Shared owner', inventory_mode='shared_warehouse')
        self.bulk = Asset.objects.create(sku='BULK', alias_name='Bulk item', quantity=10, subrental_company=self.owner)
        self.url = f'/api/conferences/{self.event.pk}/return-deliveries/'

    def physical(self, action, *assets, **extra):
        return execute_command(self.user, self.event.pk, {
            'request_id': str(uuid4()), 'action': action, 'asset_ids': [asset.pk for asset in assets], **extra,
        })

    def bulk_move(self, action, quantity):
        self.event.refresh_from_db()
        execute_quantity_command(self.user, self.event.pk, {
            'request_id': str(uuid4()), 'action': action, 'expected_revision': self.event.revision,
            'items': [{'asset_id': self.bulk.pk, 'quantity': quantity}],
        })

    def preview(self):
        response = self.client.get(self.url + 'preview/')
        self.assertEqual(response.status_code, 200, response.data)
        return response.data

    def payload(self, preview):
        return {
            'request_key': str(uuid4()), 'source_hash': preview['source_hash'],
            'rows': [row['key'] for row in preview['source']['rows']],
            'reference': preview['source']['reference'], 'return_date': preview['source']['return_date'],
            'origin': preview['source']['origin'], 'destination': preview['source']['destination'],
            'vehicle_number': 'TEST-RETURN', 'driver_phone': '',
        }

    def issue(self, body):
        return self.client.post(self.url, body, format='json')

    def test_return_snapshot_uses_transitions_and_survives_verification_and_renames(self):
        self.physical('stage', self.unit, self.forward)
        self.physical('dispatch', self.unit, self.forward)
        self.bulk_move('stage', 10)
        self.bulk_move('dispatch', 10)
        outward = reviewed(self.event, [self.unit, self.forward, self.bulk])
        outward.lines.filter(asset=self.unit).update(unit_value='220.50')
        outward.lines.filter(asset=self.bulk).update(quantity=10, unit_value='10.25')
        original = deepcopy(list(outward.lines.values()))
        self.physical('transfer', self.forward, target_conference_id=self.target.pk)
        self.physical('return', self.unit)
        self.physical('return', self.unit)  # Repeat scan is not a second transition.
        self.bulk_move('return', 3)
        self.physical('verify_return', self.unit)
        self.bulk_move('verify_return', 3)
        preview = self.preview()
        self.assertEqual([(row['sku'], row['quantity']) for row in preview['source']['rows']],
                         [('RETURN-UNIT', 1), ('BULK', 3)])
        body = self.payload(preview)
        issued = self.issue(body)
        self.assertEqual(issued.status_code, 201, issued.data)
        saved = issued.data
        self.assertEqual(saved['snapshot']['total'], '251.25')
        self.assertEqual(saved['snapshot']['rows'][1]['owner']['name'], 'Shared owner')
        self.assertEqual(saved['snapshot']['origin'], 'First venue road')
        self.assertEqual(self.event.quantity_allocations.get().dispatched, 7)
        self.assertTrue(self.target.assets.filter(pk=self.forward.pk).exists())
        self.assertEqual(list(outward.lines.values()), original)
        with self.assertRaises(CommandError):
            reserve_number(saved['number'], self.event, None)

        CompanySettings.objects.filter(pk=self.company.pk).update(name='Renamed')
        Conference.objects.filter(pk=self.event.pk).update(transport_address='Changed venue')
        Asset.objects.filter(pk=self.unit.pk).update(alias_name='Changed asset', item_price=999)
        SubrentalCompany.objects.filter(pk=self.owner.pk).update(name='Changed owner')
        self.assertEqual(self.issue(body).data, saved)
        self.assertEqual(self.client.get(self.url).data, [saved])
        self.assertEqual(ReturnDelivery.objects.count(), 1)
        self.assertEqual(self.preview()['source']['rows'], [])
        self.assertEqual(self.issue({**body, 'request_key': str(uuid4())}).status_code, 409)

        # A subsequent real return of the same physical unit can be recorded.
        self.physical('stage', self.unit)
        self.physical('dispatch', self.unit)
        self.physical('return', self.unit)
        self.assertEqual([row['sku'] for row in self.preview()['source']['rows']], ['RETURN-UNIT'])

    def test_no_claim_for_legacy_preview_or_cross_event_selection(self):
        self.event.assets.add(self.unit)
        self.assertEqual(self.preview()['source']['rows'], [])
        self.physical('return', self.unit)
        self.assertEqual(len(self.preview()['source']['rows']), 1)
        body = self.payload(self.preview())
        response = self.client.post(f'/api/conferences/{self.target.pk}/return-deliveries/', body, format='json')
        self.assertEqual(response.status_code, 409)
        self.assertFalse(ReturnDelivery.objects.exists())

    def test_split_bulk_return_across_trucks_is_atomic_and_keeps_crosscheck_balances(self):
        self.physical('stage', self.unit)
        self.physical('dispatch', self.unit)
        self.physical('return', self.unit)
        self.bulk_move('stage', 6)
        self.bulk_move('dispatch', 6)
        self.bulk_move('return', 6)
        body = self.payload(self.preview())
        physical, bulk = body.pop('rows')
        truck = {name: body.pop(name) for name in ('reference', 'vehicle_number', 'driver_phone')}
        body['loads'] = [
            {**truck, 'reference': 'Truck A', 'rows': [{'key': bulk, 'quantity': 2}]},
            {**truck, 'reference': 'Truck B', 'vehicle_number': 'TRUCK-B',
             'rows': [{'key': physical, 'quantity': 1}, {'key': bulk, 'quantity': 5}]},
        ]
        self.assertEqual(self.issue(body).status_code, 409)
        self.assertFalse(ReturnDelivery.objects.exists())
        body['loads'][1]['rows'][1]['quantity'] = 4
        result = self.issue(body)
        self.assertEqual(result.status_code, 201, result.data)
        first, second = result.data['deliveries']
        self.assertNotEqual(first['number'], second['number'])
        self.assertEqual([row['quantity'] for row in first['snapshot']['rows']], [2])
        self.assertEqual([row['quantity'] for row in second['snapshot']['rows']], [1, 4])
        self.assertEqual(ReturnDeliveryLine.objects.filter(quantity_movement__isnull=False).count(), 2)
        self.assertEqual(self.preview()['source']['rows'], [])
        self.assertEqual(self.event.quantity_allocations.get().awaiting_verification, 6)
        self.bulk_move('verify_return', 2)
        balance = self.event.quantity_allocations.get()
        self.assertEqual((balance.verified_total, balance.awaiting_verification), (2, 4))
        self.assertEqual(self.issue(body).data, result.data)

    def test_single_truck_can_leave_bulk_remainder_and_find_legacy_claims(self):
        self.bulk_move('stage', 10)
        self.bulk_move('dispatch', 10)
        self.bulk_move('return', 10)
        body = self.payload(self.preview())
        key, = body.pop('rows')
        truck = {name: body.pop(name) for name in ('reference', 'vehicle_number', 'driver_phone')}
        body['loads'] = [{**truck, 'rows': [{'key': key, 'quantity': 3}]}]
        self.assertEqual(self.issue(body).status_code, 201)
        preview = self.preview()
        self.assertEqual(preview['source']['rows'][0]['quantity'], 7)
        self.assertEqual(self.issue(self.payload(preview)).status_code, 201)
        self.assertEqual(self.preview()['source']['rows'], [])

        # Prior releases used NULL as an implicit claim of the entire movement.
        ReturnDeliveryLine.objects.filter(quantity=7).update(quantity=None)
        self.assertEqual(self.preview()['source']['rows'], [])

    def test_accounts_can_read_but_cannot_issue(self):
        account = User.objects.create_user('accounts-return')
        account.profile.role = 'accounts'
        account.profile.save()
        self.client.force_authenticate(account)
        self.assertEqual(self.client.get(self.url).status_code, 200)
        self.assertEqual(self.client.get(self.url + 'preview/').status_code, 403)
        self.assertEqual(self.issue({}).status_code, 403)


@skipUnless(connection.vendor == 'postgresql', 'PostgreSQL row locking acceptance')
class ReturnDeliveryConcurrencyTests(TransactionTestCase):
    setUp = ReturnDeliveryTests.setUp
    physical = ReturnDeliveryTests.physical
    preview = ReturnDeliveryTests.preview
    payload = ReturnDeliveryTests.payload

    def test_concurrent_issue_claims_packup_once(self):
        self.physical('stage', self.unit)
        self.physical('dispatch', self.unit)
        self.physical('return', self.unit)
        body = self.payload(self.preview())
        barrier = Barrier(2)

        def issue():
            close_old_connections()
            try:
                user = User.objects.get(pk=self.user.pk)
                barrier.wait(timeout=10)
                try:
                    return issue_return(user, self.event.pk, {**body, 'request_key': str(uuid4())})[1]
                except CommandError as error:
                    return error.status
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = [pool.submit(issue), pool.submit(issue)]
            self.assertEqual(sorted(result.result(timeout=15) for result in results), [201, 409])
        self.assertEqual(ReturnDelivery.objects.count(), 1)
