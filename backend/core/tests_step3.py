import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest import skipUnless
from unittest.mock import patch

from django.contrib.auth.models import User
from django.db import connection, close_old_connections
from django.test import TransactionTestCase
from .test_support import SnapshotTestCase
from rest_framework.test import APIClient

from .asset_commands import CommandError, execute_command
from .models import Asset, Conference, Employee, MovementReceipt, TruckChallan


class MovementTests(SnapshotTestCase):
    def setUp(self):
        self.admin = User.objects.create_user('movement-admin')
        self.admin.profile.role = 'admin'; self.admin.profile.save()
        self.event = Conference.objects.create(name='Movement event')
        self.other = Conference.objects.create(name='Other event')
        self.asset = Asset.objects.create(sku='PHYSICAL-1', quantity=1)
        self.client = APIClient(); self.client.force_authenticate(self.admin)

    def move(self, action, ids=None, event=None, request_id=None, **fields):
        return execute_command(self.admin, (event or self.event).pk, {'request_id': str(request_id or uuid.uuid4()),
            'action': action, 'asset_ids': ids or [self.asset.pk], **fields})

    def test_100_distinct_scans_and_duplicates_preserve_every_item(self):
        assets = [Asset.objects.create(sku=f'RAPID-{i}', quantity=1) for i in range(100)]
        for asset in assets:
            self.move('stage', [asset.pk])
        ids = [asset.pk for asset in assets]
        self.assertEqual(set(self.event.staged_assets.values_list('pk', flat=True)), set(ids))
        self.move('stage', [ids[0]])
        self.move('dispatch', ids)
        self.assertEqual(self.event.assets.count(), 100)
        self.assertEqual(self.event.staged_assets.count(), 0)

    def test_exact_retry_returns_original_receipt_once(self):
        request_id = uuid.uuid4()
        first = self.move('stage', request_id=request_id)
        second = self.move('stage', request_id=request_id)
        self.assertTrue(second['replayed'])
        self.assertEqual(first['conference'], second['conference'])
        self.assertEqual(MovementReceipt.objects.count(), 1)
        with self.assertRaises(CommandError) as error:
            self.move('dispatch', request_id=request_id)
        self.assertEqual(error.exception.code, 'request_id_reused')

    def test_receipt_can_confirm_uncertain_write_after_assignment_changes(self):
        request_id = uuid.uuid4()
        self.move('stage', request_id=request_id)
        self.admin.profile.role = 'accounts'; self.admin.profile.save()
        self.assertTrue(self.move('stage', request_id=request_id)['replayed'])

    def test_return_requires_verification_and_preserves_challan_history(self):
        self.move('stage'); self.move('dispatch'); self.move('return')
        self.asset.refresh_from_db(); self.assertEqual(self.asset.status, 'Crosscheck')
        self.assertFalse(self.event.assets.exists())
        self.assertTrue(self.event.challan_assets.filter(pk=self.asset.pk).exists())
        self.move('verify_return')
        self.asset.refresh_from_db(); self.assertEqual(self.asset.status, 'Available')
        self.assertTrue(self.event.challan_assets.filter(pk=self.asset.pk).exists())

    def test_conflicting_batch_rolls_back_every_item_and_receipt(self):
        free = Asset.objects.create(sku='FREE')
        self.other.assets.add(self.asset)
        with self.assertRaises(CommandError) as error:
            self.move('stage', [free.pk, self.asset.pk])
        self.assertEqual(error.exception.code, 'asset_conflict')
        self.assertFalse(self.event.staged_assets.exists())
        self.assertEqual(MovementReceipt.objects.count(), 0)

    def test_unstaged_dispatch_and_direct_return_are_rejected(self):
        for action in ('dispatch', 'return', 'verify_return'):
            with self.assertRaises(CommandError): self.move(action)
        self.assertFalse(self.event.assets.exists())

    def test_audit_observation_never_changes_real_custody(self):
        audit = Conference.objects.create(name='Audit', is_audit=True)
        self.other.assets.add(self.asset)
        self.move('audit_observe', event=audit)
        self.asset.refresh_from_db(); self.assertEqual(self.asset.status, 'In Use')
        self.assertTrue(audit.staged_assets.filter(pk=self.asset.pk).exists())
        self.move('audit_remove', event=audit)
        self.asset.refresh_from_db(); self.assertEqual(self.asset.status, 'In Use')
        with self.assertRaises(CommandError): self.move('dispatch', event=audit)

    def test_component_set_is_required_and_commits_together(self):
        child = Asset.objects.create(sku='CHILD', parent_asset=self.asset)
        with self.assertRaises(CommandError): self.move('stage')
        self.move('stage', [self.asset.pk, child.pk]); self.move('dispatch', [self.asset.pk, child.pk])
        self.assertEqual(self.event.assets.count(), 2)

    def test_missing_flag_is_preserved_on_verification(self):
        self.move('stage'); self.move('dispatch'); self.move('return')
        Asset.objects.filter(pk=self.asset.pk).update(flag='Missing')
        self.move('verify_return')
        self.asset.refresh_from_db(); self.assertEqual(self.asset.status, 'Missing')

    def test_transfer_conserves_membership_and_retries_once(self):
        self.move('stage'); self.move('dispatch')
        request_id = uuid.uuid4()
        self.move('transfer', target_conference_id=self.other.pk, request_id=request_id)
        self.move('transfer', target_conference_id=self.other.pk, request_id=request_id)
        self.assertFalse(self.event.assets.exists()); self.assertEqual(self.other.assets.count(), 1)
        self.event.refresh_from_db(); self.other.refresh_from_db()
        self.assertEqual(len(self.event.transfer_log), 1); self.assertEqual(len(self.other.transfer_log), 1)

    def test_injected_failure_rolls_back_memberships_status_and_history(self):
        self.move('stage'); self.move('dispatch')
        count = MovementReceipt.objects.count()
        with patch('core.asset_commands.canonical_conference', side_effect=RuntimeError('injected')):
            with self.assertRaises(RuntimeError): self.move('transfer', target_conference_id=self.other.pk)
        self.assertEqual(MovementReceipt.objects.count(), count)
        self.assertTrue(self.event.assets.filter(pk=self.asset.pk).exists()); self.assertFalse(self.other.assets.exists())
        self.other.refresh_from_db(); self.assertEqual(self.other.transfer_log, [])

    def test_quantity_stock_is_rejected_in_physical_workflow(self):
        Asset.objects.filter(pk=self.asset.pk).update(quantity=5)
        with self.assertRaises(CommandError) as error: self.move('stage')
        self.assertEqual(error.exception.code, 'quantity_stock_requires_quantity_workflow')

    def test_invalid_ids_unknown_items_and_batch_limit_do_not_write(self):
        for ids in ([], [True], ['1'], [999999], [self.asset.pk] * 501):
            response = self.client.post(f'/api/conferences/{self.event.pk}/asset-commands/',
                {'request_id': str(uuid.uuid4()), 'action': 'stage', 'asset_ids': ids}, format='json')
            self.assertEqual(response.status_code, 400)
        self.assertEqual(MovementReceipt.objects.count(), 0)

    def test_technician_can_request_and_return_only_assigned_event(self):
        tech = User.objects.create_user('worker', email='worker@example.test')
        employee = Employee.objects.create(name='Worker', employee_id='WORKER', email=tech.email, department='Operations', phone='N/A')
        data = {'request_id': str(uuid.uuid4()), 'action': 'require', 'asset_ids': [self.asset.pk]}
        with self.assertRaises(CommandError): execute_command(tech, self.event.pk, data)
        self.event.assigned_employees.add(employee)
        execute_command(tech, self.event.pk, data)
        for action in ('dispatch', 'verify_return', 'transfer'):
            with self.assertRaises(CommandError): execute_command(tech, self.event.pk, {**data, 'action': action, 'request_id': str(uuid.uuid4()), **({'target_conference_id': self.other.pk} if action == 'transfer' else {})})

    def test_missing_and_stale_revision_do_not_mutate_legacy_document(self):
        url = f'/api/conferences/{self.event.pk}/'
        self.assertEqual(self.client.patch(url, {'name': 'Changed'}, format='json').status_code, 428)
        revision = self.event.revision
        self.move('stage')
        self.assertEqual(self.client.patch(url, {'name': 'Changed', 'expected_revision': revision}, format='json').status_code, 409)
        self.event.refresh_from_db(); self.assertEqual(self.event.name, 'Movement event')

    def test_legacy_replacement_cannot_bypass_command_transitions(self):
        self.event.refresh_from_db()
        response = self.client.patch(f'/api/conferences/{self.event.pk}/',
            {'assets': [self.asset.pk], 'expected_revision': self.event.revision}, format='json')
        self.assertEqual(response.status_code, 409)
        self.assertFalse(self.event.assets.exists())

    def test_revision_tracks_membership_metadata_and_truck_changes(self):
        self.event.refresh_from_db(); first = self.event.revision
        self.event.staged_assets.add(self.asset); self.event.refresh_from_db(); second = self.event.revision
        self.event.name = 'Updated'; self.event.save(); third = self.event.revision
        truck = TruckChallan.objects.create(conference=self.event); self.event.refresh_from_db(); fourth = self.event.revision
        truck.assets.add(self.asset); self.event.refresh_from_db()
        self.assertTrue(first < second < third < fourth < self.event.revision)

    def test_allocation_summary_is_independent_of_inventory_search_and_paging(self):
        employee = Employee.objects.create(name='Issued staff', employee_id='ISSUED', department='Operations', phone='N/A')
        self.asset.assigned_to = employee; self.asset.save()
        response = self.client.get('/api/employee-allocations/?search=does-not-match&page=999')
        self.assertEqual(response.status_code, 200)
        self.assertEqual([row['id'] for row in response.data], [self.asset.pk])

    def test_command_receipt_contains_canonical_item_status(self):
        self.move('stage')
        result = self.move('dispatch')
        self.assertEqual(result['asset_states'][0]['status'], 'In Use')
        self.move('return')
        self.assertEqual(self.move('verify_return')['asset_states'][0]['status'], 'Available')

    def test_new_event_cannot_claim_physical_membership(self):
        self.other.assets.add(self.asset)
        for field in ('assets', 'staged_assets', 'crosscheck_assets', 'challan_assets', 'requirements'):
            response = self.client.post('/api/conferences/', {'name': 'Bypass', field: [self.asset.pk]}, format='json')
            self.assertEqual(response.status_code, 409)
        self.assertEqual(Conference.objects.count(), 2)

    def test_audit_conversion_checks_existing_memberships_even_when_omitted(self):
        self.event.is_audit = True; self.event.save()
        self.event.assets.add(self.asset); self.other.assets.add(self.asset)
        self.event.refresh_from_db()
        response = self.client.patch(f'/api/conferences/{self.event.pk}/',
            {'is_audit': False, 'expected_revision': self.event.revision}, format='json')
        self.assertEqual(response.status_code, 409)
        self.event.refresh_from_db(); self.assertTrue(self.event.is_audit)

    def test_multipart_empty_lists_and_explicit_zero_are_preserved(self):
        employee = Employee.objects.create(name='Staff', employee_id='STAFF', department='Operations', phone='N/A')
        self.event.assigned_employees.add(employee); self.event.refresh_from_db()
        response = self.client.patch(f'/api/conferences/{self.event.pk}/',
            {'expected_revision': self.event.revision, 'assigned_employees': '[]', 'approximate_value': '0',
             'vehicle_number': '', 'assets': '[]'}, format='multipart')
        self.assertEqual(response.status_code, 200, response.data)
        self.event.refresh_from_db()
        self.assertEqual(self.event.approximate_value, 0); self.assertFalse(self.event.assigned_employees.exists())

    def test_verification_preserves_required_service(self):
        self.move('stage'); self.move('dispatch'); self.move('return')
        Asset.objects.filter(pk=self.asset.pk).update(flag='Required Service')
        self.move('verify_return'); self.asset.refresh_from_db()
        self.assertEqual(self.asset.status, 'On Service')

    def test_truck_transfer_conserves_quantity_and_retries_once(self):
        from .truck_transfer import transfer_truck_allocation
        self.asset.quantity = 10; self.asset.save()
        source = TruckChallan.objects.create(conference=self.event, truck_number=1, asset_quantities={str(self.asset.pk): 10})
        target = TruckChallan.objects.create(conference=self.event, truck_number=2)
        source.assets.add(self.asset)
        payload = {'request_id': str(uuid.uuid4()), 'to_truck_id': target.pk,
                   'transfers': [{'asset_id': self.asset.pk, 'quantity': 6}]}
        transfer_truck_allocation(self.admin, source.pk, payload)
        self.assertTrue(transfer_truck_allocation(self.admin, source.pk, payload)['replayed'])
        source.refresh_from_db(); target.refresh_from_db(); self.asset.refresh_from_db()
        self.assertEqual(source.asset_quantities[str(self.asset.pk)], 4)
        self.assertEqual(target.asset_quantities[str(self.asset.pk)], 6); self.assertEqual(self.asset.quantity, 10)
        with self.assertRaises(CommandError): transfer_truck_allocation(self.admin, source.pk, {**payload, 'request_id': str(uuid.uuid4())})
        source.refresh_from_db(); self.assertEqual(source.asset_quantities[str(self.asset.pk)], 4)

    def test_truck_transfer_full_return_zero_and_injected_rollback(self):
        from .truck_transfer import transfer_truck_allocation
        source = TruckChallan.objects.create(conference=self.event, truck_number=1)
        target = TruckChallan.objects.create(conference=self.event, truck_number=2)
        source.assets.add(self.asset)
        payload = {'request_id': str(uuid.uuid4()), 'to_truck_id': target.pk, 'asset_ids': [self.asset.pk]}
        with patch('core.truck_transfer.canonical_conference', side_effect=RuntimeError('injected')):
            with self.assertRaises(RuntimeError): transfer_truck_allocation(self.admin, source.pk, payload)
        source.refresh_from_db(); target.refresh_from_db()
        self.assertTrue(source.assets.exists()); self.assertFalse(target.assets.exists()); self.assertFalse(MovementReceipt.objects.exists())
        transfer_truck_allocation(self.admin, source.pk, payload)
        source.refresh_from_db(); self.assertEqual(source.asset_quantities[str(self.asset.pk)], 0); self.assertFalse(source.assets.exists())
        with self.assertRaises(CommandError): transfer_truck_allocation(self.admin, source.pk, {**payload, 'request_id': str(uuid.uuid4())})

    def test_truck_transfer_rejects_invalid_existing_overallocation(self):
        from .truck_transfer import transfer_truck_allocation
        source = TruckChallan.objects.create(conference=self.event, truck_number=1)
        target = TruckChallan.objects.create(conference=self.event, truck_number=2)
        source.assets.add(self.asset); target.assets.add(self.asset)
        with self.assertRaises(CommandError) as error:
            transfer_truck_allocation(self.admin, source.pk,
                {'request_id': str(uuid.uuid4()), 'to_truck_id': target.pk, 'asset_ids': [self.asset.pk]})
        self.assertEqual(error.exception.code, 'existing_allocations_exceed_stock')
        self.assertFalse(MovementReceipt.objects.exists())


@skipUnless(connection.vendor == 'postgresql', 'Requires an isolated PostgreSQL test server; SQLite cannot prove row locking')
class PostgreSQLMovementConcurrencyTests(TransactionTestCase):
    def setUp(self):
        self.user = User.objects.create_user('concurrent-admin')
        self.user.profile.role = 'admin'; self.user.profile.save()
        self.asset = Asset.objects.create(sku='CONCURRENT')
        self.events = [Conference.objects.create(name=f'Event {index}') for index in range(2)]

    def run_together(self, payloads):
        barrier = Barrier(2)
        def run(index):
            close_old_connections()
            try:
                user = User.objects.get(pk=self.user.pk)
                barrier.wait(timeout=10)
                try: return execute_command(user, self.events[index].pk, payloads[index])
                except CommandError as error: return error.code
            finally: close_old_connections()
        with ThreadPoolExecutor(max_workers=2) as executor: return list(executor.map(run, range(2)))

    def test_two_devices_cannot_dispatch_one_item_to_two_events(self):
        for event in self.events: event.staged_assets.add(self.asset)
        results = self.run_together([{'request_id': str(uuid.uuid4()), 'action': 'dispatch', 'asset_ids': [self.asset.pk]} for _ in range(2)])
        self.assertEqual(sum(isinstance(result, dict) for result in results), 1)
        self.assertEqual(Conference.objects.filter(assets=self.asset, is_audit=False).count(), 1)

    def test_identical_simultaneous_retry_has_one_receipt(self):
        self.events[1] = self.events[0]
        payload = {'request_id': str(uuid.uuid4()), 'action': 'stage', 'asset_ids': [self.asset.pk]}
        results = self.run_together([payload, payload])
        self.assertTrue(all(isinstance(result, dict) for result in results))
        self.assertEqual(MovementReceipt.objects.count(), 1)
