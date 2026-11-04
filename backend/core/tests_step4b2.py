import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest import skipUnless
from unittest.mock import patch

from django.contrib.auth.models import User
from django.db import connection, close_old_connections
from django.test import TestCase, TransactionTestCase
from rest_framework.test import APIClient

from .asset_commands import CommandError
from .consumable_commands import execute_consumable_command
from .models import Asset, Conference, ConsumableAllocation, ConsumableMovement, Employee, MovementReceipt
from .serializers import AssetSerializer, ConferenceSerializer


class ConsumableTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user('consume-admin'); self.admin.profile.role = 'admin'; self.admin.profile.save()
        self.event = Conference.objects.create(name='Consumable A')
        self.other = Conference.objects.create(name='Consumable B')
        self.stock = Asset.objects.create(sku='CONSUMABLE-10', type='Consumables', quantity=10)
        self.client = APIClient(); self.client.force_authenticate(self.admin)

    def item(self, requested=6, returned=None, confirmed=False, asset=None):
        return {'asset_id': (asset or self.stock).pk, 'requested': requested, 'returned': returned, 'confirmed': confirmed}

    def payload(self, action='save', items=None, event=None, **fields):
        event = event or self.event; event.refresh_from_db()
        return {'request_id': str(uuid.uuid4()), 'action': action, 'items': [self.item()] if items is None else items,
                'expected_revision': event.revision, **fields}

    def move(self, action='save', items=None, event=None, **fields):
        return execute_consumable_command(self.admin, (event or self.event).pk, self.payload(action, items, event, **fields))

    def test_requests_reserve_across_events_without_deducting_stock(self):
        self.move(); self.move(items=[self.item(4)], event=self.other)
        self.assertEqual(AssetSerializer(self.stock).data['quantity_available'], 0)
        self.stock.refresh_from_db(); self.assertEqual(self.stock.quantity, 10)
        with self.assertRaises(CommandError): self.move(items=[self.item(5)], event=self.other)
        self.assertEqual(ConsumableAllocation.objects.count(), 2)

    def test_dispatch_has_unconfirmed_returns_and_does_not_deduct_stock(self):
        result = self.move('dispatch')
        entry = result['conference']['consumable_data'][str(self.stock.pk)]
        self.assertIsNone(entry['returned']); self.assertFalse(entry['return_confirmed']); self.assertEqual(entry['status'], 'dispatched')
        self.stock.refresh_from_db(); self.assertEqual(self.stock.quantity, 10)

    def test_return_report_does_not_free_stock_or_deduct_consumption(self):
        self.move('dispatch'); self.move(items=[self.item(returned=2)])
        self.assertEqual(AssetSerializer(self.stock).data['quantity_available'], 4)
        row = self.event.consumable_allocations.get(); self.assertEqual(row.returned, 2); self.assertEqual(row.consumed, 0)

    def test_settlement_deducts_only_consumption_and_releases_returns(self):
        self.move('dispatch'); self.move('settle', [self.item(returned=2, confirmed=True)])
        self.stock.refresh_from_db(); self.assertEqual(self.stock.quantity, 6)
        self.assertEqual(AssetSerializer(self.stock).data['quantity_available'], 6)
        row = self.event.consumable_allocations.get(); self.assertEqual(row.state, 'settled'); self.assertEqual(row.consumed, 4)
        movement = ConsumableMovement.objects.last(); self.assertEqual((movement.stock_before, movement.stock_after), (10, 6))

    def test_zero_returns_are_explicit_and_all_returned_deducts_zero(self):
        self.move('dispatch'); self.move('settle', [self.item(returned=0, confirmed=True)])
        self.stock.refresh_from_db(); self.assertEqual(self.stock.quantity, 4)
        self.move('dispatch', [self.item(4)], self.other); self.move('settle', [self.item(4, returned=4, confirmed=True)], self.other)
        self.stock.refresh_from_db(); self.assertEqual(self.stock.quantity, 4)

    def test_settlement_requires_every_return_count_and_confirmation(self):
        self.move('dispatch')
        for item in (self.item(), self.item(returned=2), self.item(returned=None, confirmed=True)):
            with self.assertRaises(CommandError): self.move('settle', [item])
        self.stock.refresh_from_db(); self.assertEqual(self.stock.quantity, 10)
        self.assertEqual(self.event.consumable_allocations.get().state, 'dispatched')

    def test_exact_retry_after_lost_response_does_not_deduct_twice_even_after_role_change(self):
        self.move('dispatch'); payload = self.payload('settle', [self.item(returned=1, confirmed=True)])
        first = execute_consumable_command(self.admin, self.event.pk, payload)
        self.admin.profile.role = 'accounts'; self.admin.profile.save()
        replay = execute_consumable_command(self.admin, self.event.pk, payload)
        self.assertTrue(replay['replayed']); self.assertEqual(first['conference'], replay['conference'])
        self.stock.refresh_from_db(); self.assertEqual(self.stock.quantity, 5)
        self.assertEqual(ConsumableMovement.objects.filter(action='settle').count(), 1)
        with self.assertRaises(CommandError): execute_consumable_command(self.admin, self.event.pk, {**payload, 'items': [self.item(returned=0, confirmed=True)]})

    def test_new_settle_uuid_cannot_resettle_or_edit_settled_quantities(self):
        self.move('dispatch'); self.move('settle', [self.item(returned=1, confirmed=True)])
        for action, item in [('settle', self.item(returned=1, confirmed=True)), ('save', self.item(returned=2)), ('save', self.item(7))]:
            with self.assertRaises(CommandError): self.move(action, [item])
        self.stock.refresh_from_db(); self.assertEqual(self.stock.quantity, 5)

    def test_cancelling_reservations_releases_only_reserved_units_and_retains_history(self):
        self.move(); self.move(items=[])
        self.assertEqual(self.event.consumable_allocations.get().requested, 0)
        self.assertEqual(AssetSerializer(self.stock).data['quantity_available'], 10)
        self.assertEqual(ConsumableMovement.objects.count(), 2)

    def test_dispatched_requests_cannot_be_deleted_or_resized(self):
        self.move('dispatch')
        for items in ([], [self.item(5)]):
            with self.assertRaises(CommandError): self.move(items=items)
        self.assertEqual(self.event.consumable_allocations.get().requested, 6)

    def test_invalid_metadata_or_late_batch_failure_rolls_back_stock_and_all_history(self):
        second = Asset.objects.create(sku='CONSUMABLE-2', type='Consumables', quantity=10)
        self.move('dispatch', [self.item(), self.item(asset=second)])
        before = MovementReceipt.objects.count()
        with self.assertRaises(CommandError): self.move('settle', [self.item(returned=0, confirmed=True), self.item(returned=None, confirmed=False, asset=second)], metadata={'name': 'Must roll back'})
        self.stock.refresh_from_db(); self.event.refresh_from_db()
        self.assertEqual(self.stock.quantity, 10); self.assertEqual(self.event.name, 'Consumable A')
        self.assertEqual(MovementReceipt.objects.count(), before)
        with self.assertRaises(CommandError): self.move('settle', [self.item(returned=0, confirmed=True), self.item(returned=0, confirmed=True, asset=second)], metadata={'start_date': 'invalid date'})
        self.assertFalse(ConsumableMovement.objects.filter(action='settle').exists())

    def test_failure_during_metadata_save_rolls_back_an_already_calculated_deduction(self):
        self.move('dispatch')
        with patch.object(ConferenceSerializer, 'update', side_effect=RuntimeError('synthetic save failure')):
            with self.assertRaises(RuntimeError): self.move('settle', [self.item(returned=0, confirmed=True)], metadata={'name': 'Failure'})
        self.stock.refresh_from_db(); self.assertEqual(self.stock.quantity, 10)
        self.assertFalse(ConsumableMovement.objects.filter(action='settle').exists())

    def test_event_metadata_and_settlement_commit_together(self):
        self.move('dispatch'); result = self.move('settle', [self.item(returned=3, confirmed=True)], metadata={'vehicle_number': 'SYNTHETIC-VEHICLE'})
        self.assertEqual(result['conference']['vehicle_number'], 'SYNTHETIC-VEHICLE'); self.stock.refresh_from_db(); self.assertEqual(self.stock.quantity, 7)

    def test_legacy_requested_and_settled_data_require_review_without_second_deduction(self):
        for status in ('requested', 'settled'):
            self.other.consumable_data = {str(self.stock.pk): {'requested': 6, 'returned': 2, 'consumed': 4, 'status': status}}; self.other.save()
            with self.assertRaises(CommandError): self.move('dispatch')
            with self.assertRaises(CommandError): self.move('settle', [self.item(returned=2, confirmed=True)], self.other)
            self.assertEqual(AssetSerializer(self.stock).data['quantity_available'], 0)
        self.stock.refresh_from_db(); self.assertEqual(self.stock.quantity, 10); self.assertEqual(ConsumableAllocation.objects.count(), 0)

    def test_legacy_json_and_direct_stock_debit_routes_are_closed(self):
        self.event.refresh_from_db()
        response = self.client.patch(f'/api/conferences/{self.event.pk}/', {'expected_revision': self.event.revision, 'consumable_data': {str(self.stock.pk): {'requested': 6}}}, format='json')
        self.assertEqual(response.status_code, 409)
        response = self.client.patch(f'/api/assets/{self.stock.pk}/', {'quantity': 4}, format='json'); self.assertEqual(response.status_code, 400)
        self.stock.refresh_from_db(); self.assertEqual(self.stock.quantity, 10)

    def test_stale_revision_and_invalid_integer_batches_have_no_receipt(self):
        payload = self.payload(); self.event.name = 'Changed'; self.event.save()
        with self.assertRaises(CommandError): execute_consumable_command(self.admin, self.event.pk, payload)
        for value in (True, -1, 1.2, '6', None):
            with self.assertRaises(CommandError): self.move(items=[self.item(value)])
        payload = self.payload(); payload['items'] *= 2
        with self.assertRaises(CommandError): execute_consumable_command(self.admin, self.event.pk, payload)
        self.assertEqual(MovementReceipt.objects.count(), 0)

    def test_technician_may_reserve_and_report_but_cannot_dispatch_settle_or_edit_metadata(self):
        tech = User.objects.create_user('consume-tech', email='consume-tech@example.test')
        employee = Employee.objects.create(name='Consume tech', employee_id='CONSUME-T', email=tech.email); self.event.assigned_employees.add(employee)
        execute_consumable_command(tech, self.event.pk, self.payload())
        self.move('dispatch')
        execute_consumable_command(tech, self.event.pk, self.payload(items=[self.item(returned=2)]))
        for action, fields in [('dispatch', {}), ('settle', {}), ('save', {'metadata': {'name': 'No'}})]:
            with self.assertRaises(CommandError): execute_consumable_command(tech, self.event.pk, self.payload(action, **fields))
        self.event.assigned_employees.clear()
        with self.assertRaises(CommandError): execute_consumable_command(tech, self.event.pk, self.payload())

    def test_flagged_dispatch_and_audit_conversion_or_deletion_do_not_destroy_history(self):
        self.move(); Asset.objects.filter(pk=self.stock.pk).update(flag='Missing')
        with self.assertRaises(CommandError): self.move('dispatch')
        self.event.refresh_from_db()
        for method, fields in [('patch', {'is_audit': True}), ('delete', {})]:
            response = getattr(self.client, method)(f'/api/conferences/{self.event.pk}/', {'expected_revision': self.event.revision, **fields}, format='json')
            self.assertEqual(response.status_code, 409)
        response = self.client.delete(f'/api/assets/{self.stock.pk}/'); self.assertEqual(response.status_code, 409)

    def test_settlement_preserves_other_events_reservations(self):
        self.move('dispatch'); self.move(items=[self.item(4)], event=self.other)
        self.move('settle', [self.item(returned=2, confirmed=True)])
        self.stock.refresh_from_db(); self.assertEqual(self.stock.quantity, 6)
        self.assertEqual(AssetSerializer(self.stock).data['quantity_available'], 2)
        self.assertEqual(self.other.consumable_allocations.get().requested, 4)


@skipUnless(connection.vendor == 'postgresql', 'Requires isolated PostgreSQL row locks')
class ConsumableConcurrencyTests(TransactionTestCase):
    def test_competing_events_cannot_reserve_more_consumables_than_stock(self):
        user = User.objects.create_user('consume-race'); user.profile.role = 'admin'; user.profile.save()
        stock = Asset.objects.create(sku='CONSUME-RACE', type='Consumables', quantity=10)
        events = [Conference.objects.create(name=f'Consume race {i}') for i in range(2)]; barrier = Barrier(2)
        def reserve(event_id):
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                execute_consumable_command(User.objects.get(pk=user.pk), event_id, {'request_id': str(uuid.uuid4()), 'action': 'save', 'expected_revision': 0,
                    'items': [{'asset_id': stock.pk, 'requested': 7, 'returned': None, 'confirmed': False}]})
                return 'saved'
            except CommandError as error: return error.code
            finally: close_old_connections()
        with ThreadPoolExecutor(max_workers=2) as pool: results = list(pool.map(reserve, [event.pk for event in events]))
        self.assertCountEqual(results, ['saved', 'insufficient_available_consumables'])
