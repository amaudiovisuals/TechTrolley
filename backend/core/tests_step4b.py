import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest import skipUnless

from django.contrib.auth.models import User
from django.db import connection, close_old_connections
from django.test import TestCase, TransactionTestCase
from rest_framework.test import APIClient

from .asset_commands import CommandError, execute_command
from .models import Asset, Conference, Employee, MovementReceipt, QuantityAllocation, QuantityMovement, TruckChallan
from .quantity_commands import execute_quantity_command
from .serializers import AssetSerializer


class BulkQuantityTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user('bulk-admin')
        self.admin.profile.role = 'admin'; self.admin.profile.save()
        self.event = Conference.objects.create(name='Bulk A')
        self.other = Conference.objects.create(name='Bulk B')
        self.asset = Asset.objects.create(sku='BULK-ONLY', quantity=10)
        self.client = APIClient(); self.client.force_authenticate(self.admin)

    def payload(self, action, amount, event=None, **extra):
        event = event or self.event; event.refresh_from_db()
        return {'request_id': str(uuid.uuid4()), 'action': action, 'expected_revision': event.revision,
                'items': [{'asset_id': self.asset.pk, 'quantity': amount}], **extra}

    def move(self, action, amount, event=None, user=None):
        return execute_quantity_command(user or self.admin, (event or self.event).pk, self.payload(action, amount, event))

    def test_reserves_across_events_without_splitting_stock_or_identity(self):
        self.move('stage', 6); self.move('stage', 4, self.other)
        self.assertEqual(Asset.objects.count(), 1)
        self.asset.refresh_from_db(); self.assertEqual(self.asset.quantity, 10)
        self.assertEqual(AssetSerializer(self.asset).data['quantity_available'], 0)
        with self.assertRaises(CommandError): self.move('stage', 1, self.other)
        self.assertEqual(QuantityMovement.objects.count(), 2)

    def test_partial_returns_keep_unverified_units_unavailable(self):
        self.move('stage', 8); self.move('dispatch', 8); self.move('return', 3)
        self.assertTrue(self.event.assets.filter(pk=self.asset.pk).exists())
        self.assertTrue(self.event.crosscheck_assets.filter(pk=self.asset.pk).exists())
        self.assertEqual(AssetSerializer(self.asset).data['quantity_available'], 2)
        self.move('verify_return', 2)
        self.assertEqual(AssetSerializer(self.asset).data['quantity_available'], 4)
        self.move('return', 5); self.move('verify_return', 6)
        self.assertFalse(self.event.assets.exists()); self.assertFalse(self.event.crosscheck_assets.exists())
        self.assertTrue(self.event.challan_assets.filter(pk=self.asset.pk).exists())
        a = self.event.quantity_allocations.get(); self.assertEqual(a.dispatched_total, 8); self.assertEqual(a.verified_total, 8)
        self.assertEqual(self.asset.quantity, 10)

    def test_unstage_releases_only_selected_quantity_and_counts_bump_revision(self):
        first = self.move('stage', 4); second = self.move('stage', 2)
        self.assertGreater(second['conference']['revision'], first['conference']['revision'])
        self.move('unstage', 3)
        self.assertEqual(self.event.quantity_allocations.get().reserved, 3)
        self.assertEqual(AssetSerializer(self.asset).data['quantity_available'], 7)

    def test_lost_response_replay_is_exact_after_role_change(self):
        payload = self.payload('stage', 4)
        first = execute_quantity_command(self.admin, self.event.pk, payload)
        self.admin.profile.role = 'accounts'; self.admin.profile.save()
        second = execute_quantity_command(self.admin, self.event.pk, payload)
        self.assertTrue(second['replayed']); self.assertEqual(second['conference'], first['conference'])
        self.assertEqual(QuantityMovement.objects.count(), 1); self.assertEqual(MovementReceipt.objects.count(), 1)
        with self.assertRaises(CommandError) as e:
            execute_quantity_command(self.admin, self.event.pk, {**payload, 'items': [{'asset_id': self.asset.pk, 'quantity': 5}]})
        self.assertEqual(e.exception.code, 'request_id_reused')

    def test_invalid_integer_quantities_and_duplicate_sources_have_no_writes(self):
        for value in (True, 0, -1, 1.5, '3', None, 1000001):
            with self.assertRaises(CommandError): self.move('stage', value)
        payload = self.payload('stage', 3); payload['items'] *= 2
        with self.assertRaises(CommandError): execute_quantity_command(self.admin, self.event.pk, payload)
        self.assertEqual(QuantityAllocation.objects.count(), 0); self.assertEqual(MovementReceipt.objects.count(), 0)

    def test_stale_event_revision_rejects_without_reserving(self):
        payload = self.payload('stage', 4); self.event.name = 'Other edit'; self.event.save()
        with self.assertRaises(CommandError) as e: execute_quantity_command(self.admin, self.event.pk, payload)
        self.assertEqual(e.exception.code, 'document_changed'); self.assertEqual(MovementReceipt.objects.count(), 0)

    def test_late_batch_conflict_rolls_back_allocations_memberships_and_receipt(self):
        unavailable = Asset.objects.create(sku='BULK-FLAG', quantity=20, flag='Missing')
        payload = self.payload('stage', 3)
        payload['items'].append({'asset_id': unavailable.pk, 'quantity': 2})
        with self.assertRaises(CommandError): execute_quantity_command(self.admin, self.event.pk, payload)
        self.assertEqual(QuantityAllocation.objects.count(), 0); self.assertEqual(QuantityMovement.objects.count(), 0)
        self.assertFalse(self.event.staged_assets.exists()); self.assertEqual(MovementReceipt.objects.count(), 0)

    def test_mixed_physical_and_bulk_dispatch_commits_together(self):
        physical = Asset.objects.create(sku='SERIAL-ONLY')
        self.move('stage', 4)
        execute_command(self.admin, self.event.pk, {'request_id': str(uuid.uuid4()), 'action': 'stage', 'asset_ids': [physical.pk]})
        result = execute_quantity_command(self.admin, self.event.pk, self.payload('dispatch', 4, physical_asset_ids=[physical.pk]))
        self.assertEqual(set(result['conference']['assets']), {physical.pk, self.asset.pk})
        self.assertFalse(self.event.staged_assets.exists()); self.assertEqual(self.event.quantity_allocations.get().dispatched, 4)

    def test_mixed_dispatch_physical_failure_rolls_back_bulk_part(self):
        physical = Asset.objects.create(sku='UNSTAGED-PHYSICAL')
        self.move('stage', 4); count = MovementReceipt.objects.count()
        with self.assertRaises(CommandError):
            execute_quantity_command(self.admin, self.event.pk, self.payload('dispatch', 4, physical_asset_ids=[physical.pk]))
        self.assertEqual(self.event.quantity_allocations.get().reserved, 4)
        self.assertEqual(self.event.quantity_allocations.get().dispatched, 0)
        self.assertEqual(MovementReceipt.objects.count(), count)

    def test_legacy_memberships_require_review_without_guessing(self):
        self.other.assets.add(self.asset)
        with self.assertRaises(CommandError) as e: self.move('stage', 2)
        self.assertEqual(e.exception.code, 'legacy_quantity_requires_reconciliation')
        self.assertEqual(AssetSerializer(self.asset).data['quantity_available'], 0)
        self.assertEqual(QuantityAllocation.objects.count(), 0)

    def test_duplicate_old_identifiers_are_blocked(self):
        Asset.objects.create(sku='other', barcode=self.asset.sku, qr_code=self.asset.qr_code)
        with self.assertRaises(CommandError) as e: self.move('stage', 2)
        self.assertEqual(e.exception.code, 'duplicate_stock_identity_requires_review')

    def test_consumables_supplier_components_and_audits_do_not_use_bulk_ledger(self):
        self.asset.type = 'Consumables'; self.asset.save()
        with self.assertRaises(CommandError): self.move('stage', 2)
        self.asset.type = 'Cable'; self.asset.save(); self.event.is_audit = True; self.event.save()
        with self.assertRaises(CommandError): self.move('stage', 2)
        self.event.is_audit = False; self.event.save()
        self.asset.parent_asset = Asset.objects.create(sku='parent'); self.asset.save()
        with self.assertRaises(CommandError): self.move('stage', 2)
        self.assertEqual(QuantityAllocation.objects.count(), 0)

    def test_quantity_mode_remains_after_stock_is_reduced_to_one(self):
        self.move('stage', 2); self.move('unstage', 2)
        self.asset.quantity = 1; self.asset.save()
        self.assertTrue(AssetSerializer(self.asset).data['quantity_tracking'])
        with self.assertRaises(CommandError):
            execute_command(self.admin, self.event.pk, {'request_id': str(uuid.uuid4()), 'action': 'stage', 'asset_ids': [self.asset.pk]})
        self.move('stage', 1)

    def test_staff_stock_and_ledger_backed_stock_reduction_are_blocked(self):
        self.move('stage', 6)
        response = self.client.patch(f'/api/assets/{self.asset.pk}/', {'quantity': 5}, format='json')
        self.assertEqual(response.status_code, 400, response.data)
        self.asset.refresh_from_db(); self.assertEqual(self.asset.quantity, 10)
        employee = Employee.objects.create(name='Synthetic staff', employee_id='BULK-E', email='bulk@example.test')
        response = self.client.patch(f'/api/assets/{self.asset.pk}/', {'assigned_to': employee.pk}, format='json')
        self.assertEqual(response.status_code, 400)

    def test_metadata_save_accepts_shared_bulk_custody_but_history_cannot_be_deleted_or_audited(self):
        self.move('stage', 5); self.move('dispatch', 5)
        self.move('stage', 5, self.other); self.move('dispatch', 5, self.other)
        self.event.refresh_from_db()
        response = self.client.patch(f'/api/conferences/{self.event.pk}/', {'expected_revision': self.event.revision, 'name': 'Updated', 'assets': [self.asset.pk]}, format='json')
        self.assertEqual(response.status_code, 200, response.data)
        for method, fields in [('patch', {'is_audit': True}), ('delete', {})]:
            self.event.refresh_from_db()
            response = getattr(self.client, method)(f'/api/conferences/{self.event.pk}/', {'expected_revision': self.event.revision, **fields}, format='json')
            self.assertEqual(response.status_code, 409)

    def test_old_split_route_never_changes_stock(self):
        response = self.client.post(f'/api/assets/{self.asset.pk}/assign-quantity/', {'quantity': 3, 'conference_id': self.event.pk}, format='json')
        self.assertEqual(response.status_code, 409); self.assertEqual(response.data['error'], 'use_quantity_commands')
        self.assertEqual(Asset.objects.count(), 1); self.assertFalse(self.event.assets.exists())

    def test_read_only_document_preview_uses_recorded_dispatch_quantities(self):
        from .challan_preview import preview_legacy_documents
        from django.test.utils import CaptureQueriesContext
        self.move('stage', 4); self.move('dispatch', 4)
        with CaptureQueriesContext(connection) as queries:
            preview = preview_legacy_documents(self.event.pk)
        self.assertEqual(preview['documents'][0]['lines'][0]['quantity'], 4)
        self.assertFalse(any(q['sql'].lstrip().upper().startswith(('INSERT', 'UPDATE', 'DELETE')) for q in queries))

    def test_truck_coordination_gate_blocks_before_any_quantity_or_truck_changes(self):
        TruckChallan.objects.create(conference=self.event, truck_number=1)
        with self.assertRaises(CommandError) as e: self.move('stage', 2)
        self.assertEqual(e.exception.code, 'quantity_trucks_require_coordinated_workflow')
        self.assertEqual(QuantityAllocation.objects.count(), 0)
        clean = Conference.objects.create(name='Clean quantity event'); self.move('stage', 2, clean); clean.refresh_from_db()
        response = self.client.post(f'/api/conferences/{clean.pk}/trucks/', {'expected_revision': clean.revision}, format='json')
        self.assertEqual(response.status_code, 409); self.assertFalse(clean.truck_challans.exists())

    def test_technician_can_return_assigned_stock_but_cannot_stage_or_verify(self):
        tech = User.objects.create_user('bulk-tech', email='bulk-tech@example.test')
        employee = Employee.objects.create(name='Bulk tech', employee_id='BULK-T', email=tech.email)
        self.event.assigned_employees.add(employee)
        self.move('stage', 3); self.move('dispatch', 3)
        self.move('return', 2, user=tech)
        for action in ('stage', 'verify_return'):
            with self.assertRaises(CommandError): self.move(action, 1, user=tech)
        self.event.assigned_employees.remove(employee)
        with self.assertRaises(CommandError): self.move('return', 1, user=tech)


@skipUnless(connection.vendor == 'postgresql', 'Requires isolated PostgreSQL row locks')
class BulkQuantityConcurrencyTests(TransactionTestCase):
    def setUp(self):
        self.user = User.objects.create_user('bulk-concurrency-admin')
        self.user.profile.role = 'admin'; self.user.profile.save()
        self.asset = Asset.objects.create(sku='CONCURRENT-BULK', quantity=10)
        self.events = [Conference.objects.create(name=f'Concurrent {i}') for i in range(2)]

    def test_competing_event_reservations_cannot_exceed_stock(self):
        barrier = Barrier(2)
        def reserve(event_id):
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                execute_quantity_command(User.objects.get(pk=self.user.pk), event_id,
                    {'request_id': str(uuid.uuid4()), 'action': 'stage', 'expected_revision': 0,
                     'items': [{'asset_id': self.asset.pk, 'quantity': 7}]})
                return 'saved'
            except CommandError as error:
                return error.code
            finally:
                close_old_connections()
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(reserve, [e.pk for e in self.events]))
        self.assertCountEqual(results, ['saved', 'insufficient_available_quantity'])
        self.assertEqual(sum(a.reserved for a in QuantityAllocation.objects.all()), 7)
