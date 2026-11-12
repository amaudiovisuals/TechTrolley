"""Read-only legacy evidence; all fixtures live in the isolated test database."""
import io
import json
import os
import tempfile
from unittest.mock import patch, MagicMock
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import connection
from .test_support import SnapshotTestCase, collect_readonly_snapshot
from django.test.utils import CaptureQueriesContext
from .legacy_reconciliation import collect_snapshot, preview_reconciliation
from .models import (Asset, Conference, TruckChallan, QuantityAllocation, ConsumableAllocation,
                     SubrentalCompany, SubrentalTicket, SubrentalTicketItem, ChallanDocument)


class LegacyReconciliationTests(SnapshotTestCase):
    def setUp(self):
        self.event = Conference.objects.create(name='Synthetic legacy event', challan_number='LEGACY-1')
        self.asset = Asset.objects.create(sku='TEST-ONE', quantity=1)

    def report(self):
        return preview_reconciliation(collect_readonly_snapshot(connection))

    def codes(self):
        return self.report()['finding_counts']

    def test_collector_and_report_are_select_only_and_repeatable(self):
        self.event.challan_assets.add(self.asset)
        with CaptureQueriesContext(connection) as queries:
            before = collect_readonly_snapshot(connection)
            first = preview_reconciliation(before)
            second = self.report()
            after = collect_readonly_snapshot(connection)
        self.assertEqual(first, second)
        self.assertEqual(before, after)
        forbidden = ('INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP')
        self.assertTrue(queries.captured_queries)
        self.assertFalse(any(q['sql'].lstrip().upper().startswith(forbidden) for q in queries.captured_queries))
        self.assertTrue(all(not f['automatic_apply_allowed'] for f in first['findings']))

    def test_changed_stock_changes_fingerprint(self):
        before = self.report()['snapshot_sha256']
        Asset.objects.filter(pk=self.asset.pk).update(quantity=4)
        self.assertNotEqual(before, self.report()['snapshot_sha256'])

    def test_collector_rejects_reads_outside_snapshot_transaction(self):
        fake = MagicMock(in_atomic_block=False)
        with self.assertRaisesRegex(ValueError, 'snapshot_requires_transaction'):
            collect_snapshot(fake)
        fake.cursor.assert_not_called()

    def test_postgresql_read_write_snapshot_is_refused_before_table_reads(self):
        fake = MagicMock(in_atomic_block=True, vendor='postgresql')
        cursor = fake.cursor.return_value.__enter__.return_value
        cursor.fetchone.return_value = ('off',)
        with self.assertRaisesRegex(ValueError, 'postgresql_snapshot_requires_read_only'):
            collect_snapshot(fake)
        fake.introspection.table_names.assert_not_called()

    def test_postgresql_read_committed_is_refused_before_table_reads(self):
        fake = MagicMock(in_atomic_block=True, vendor='postgresql')
        cursor = fake.cursor.return_value.__enter__.return_value
        cursor.fetchone.side_effect = [('on',), ('read committed',)]
        with self.assertRaisesRegex(ValueError, 'snapshot_requires_repeatable_read'):
            collect_snapshot(fake)
        fake.introspection.table_names.assert_not_called()

    def test_old_schema_missing_new_columns_and_tables_is_unknown_not_zero(self):
        snapshot = collect_readonly_snapshot(connection)
        for table in list(snapshot['schema']):
            if table in ('core_quantityallocation', 'core_consumableallocation', 'core_challandocument', 'core_challanline', 'core_truckmanifest', 'core_truckmanifestentry'):
                snapshot['schema'][table] = None
                snapshot['tables'].pop(table)
        snapshot['schema']['core_asset'].remove('quantity_tracking')
        snapshot['tables']['core_asset'][0].pop('quantity_tracking')
        snapshot['schema']['core_conference'].remove('revision')
        snapshot['tables']['core_conference'][0].pop('revision')
        report = preview_reconciliation(snapshot)
        self.assertIn('core_quantityallocation', report['missing_optional_tables'])
        self.assertEqual(report['counts']['assets'], 1)

    def test_collector_fails_closed_on_missing_required_schema(self):
        original = connection.introspection.table_names
        with patch.object(connection.introspection, 'table_names', side_effect=lambda c: [t for t in original(c) if t != 'core_asset']):
            with self.assertRaisesRegex(ValueError, 'incomplete_required_schema:core_asset'):
                collect_readonly_snapshot(connection)

    def test_history_and_audit_are_not_real_custody(self):
        self.event.is_audit = True
        self.event.save()
        self.event.assets.add(self.asset)
        self.event.crosscheck_assets.add(self.asset)
        self.event.challan_assets.add(self.asset)
        self.asset.status = 'In Use'
        self.asset.save()
        codes = self.codes()
        self.assertIn('custody_status_without_current_holder', codes)
        self.assertIn('historical_or_plan_relations_are_not_custody', codes)
        self.assertNotIn('available_despite_current_holder', codes)

    def test_real_holder_restrictions_are_kept_in_evidence(self):
        self.event.assets.add(self.asset)
        self.asset.flag = 'Missing'
        self.asset.condition = 'Damaged'
        self.asset.save()
        Asset.objects.filter(pk=self.asset.pk).update(status='Available')
        report = self.report()
        finding = next(f for f in report['findings'] if f['code'] == 'available_despite_current_holder')
        self.assertEqual(finding['evidence']['asset']['flag'], 'Missing')
        self.assertEqual(finding['evidence']['asset']['condition'], 'Damaged')
        self.assertNotIn('proposed_status', finding)

    def test_tracked_bulk_can_be_available_and_allocated_to_multiple_events(self):
        second = Conference.objects.create(name='Second')
        self.asset.quantity = 100
        self.asset.quantity_tracking = True
        self.asset.save()
        for event in (self.event, second):
            event.assets.add(self.asset)
            QuantityAllocation.objects.create(asset=self.asset, conference=event, dispatched=3, dispatched_total=3)
        codes = self.codes()
        self.assertNotIn('multiple_current_event_holders', codes)
        self.assertNotIn('available_despite_current_holder', codes)
        self.assertNotIn('legacy_bulk_membership_without_ledger', codes)

    def test_unknown_bulk_membership_does_not_propose_stock_quantity(self):
        self.asset.quantity = 100
        self.asset.save()
        self.event.staged_assets.add(self.asset)
        finding = next(f for f in self.report()['findings'] if f['code'] == 'legacy_bulk_membership_without_ledger')
        self.assertNotIn('proposed_quantity', finding)
        self.assertEqual(finding['evidence']['asset']['quantity'], 100)

    def test_historical_master_bulk_source_is_reviewed_even_without_live_holdings(self):
        self.asset.quantity = 20
        self.asset.save()
        self.event.challan_assets.add(self.asset)
        codes = self.codes()
        self.assertIn('legacy_master_quantity_without_source_proof', codes)
        self.assertNotIn('legacy_bulk_membership_without_ledger', codes)
        self.assertIn('legacy_master_requires_snapshot_review', codes)

    def test_saved_master_is_not_reconstructed_from_legacy_membership(self):
        self.event.challan_assets.add(self.asset)
        ChallanDocument.objects.create(conference=self.event, scope='master', number='LEGACY-1')
        self.assertNotIn('legacy_master_requires_snapshot_review', self.codes())

    def test_duplicate_case_insensitive_identifier_never_merges_rows(self):
        other = Asset.objects.create(sku=' test-one ', quantity=1)
        finding = next(f for f in self.report()['findings'] if f['code'] == 'duplicate_identity_requires_review')
        self.assertEqual(finding['references']['asset_ids'], [self.asset.pk, other.pk])
        self.assertEqual(Asset.objects.count(), 2)

    def consumer(self, entry):
        self.asset.type = 'Consumables'
        self.asset.save()
        self.event.consumable_data = {str(self.asset.pk): entry}
        self.event.save()

    def test_settled_legacy_label_does_not_prove_prior_debit(self):
        self.consumer({'requested': 4, 'returned': 0, 'consumed': 4, 'status': 'settled'})
        self.assertIn('legacy_consumable_prior_debit_unknown', self.codes())
        self.asset.refresh_from_db()
        self.assertEqual(self.asset.quantity, 1)
        self.assertEqual(ConsumableAllocation.objects.count(), 0)

    def test_unknown_returns_and_explicit_zero_are_preserved(self):
        for returned in (None, 0):
            self.consumer({'requested': 4, 'returned': returned})
            finding = next(f for f in self.report()['findings'] if f['code'] == 'legacy_consumable_prior_debit_unknown')
            self.assertEqual(finding['evidence']['raw']['returned'], returned)
            self.assertNotIn('invalid_legacy_consumable_quantities', self.codes())

    def test_malformed_bool_and_foreign_consumer_values_are_flagged(self):
        self.consumer({'requested': True, 'returned': 7})
        self.assertIn('invalid_legacy_consumable_quantities', self.codes())
        self.event.consumable_data = {'not-an-id': {'requested': 3}}
        self.event.save()
        self.assertIn('invalid_legacy_consumable_reference', self.codes())
        self.event.consumable_data = ['bad']
        self.event.save()
        self.assertIn('malformed_legacy_consumables', self.codes())

    def test_tracked_consumer_is_not_reported_as_unknown_prior_debit(self):
        self.consumer({'requested': 4, 'returned': 0, 'consumed': 4, 'status': 'settled'})
        ConsumableAllocation.objects.create(asset=self.asset, conference=self.event, requested=4, returned=0, consumed=4, state='settled')
        self.assertNotIn('legacy_consumable_prior_debit_unknown', self.codes())

    def truck(self, number=1, **fields):
        return TruckChallan.objects.create(conference=self.event, truck_number=number, **fields)

    def test_master_truck_one_alias_allowed_but_truck_two_collision_flagged(self):
        self.truck(challan_number='LEGACY-1')
        self.assertNotIn('challan_number_collision', self.codes())
        self.truck(2, challan_number='LEGACY-1')
        self.assertIn('challan_number_collision', self.codes())

    def test_collisions_include_saved_documents_and_unconverted_legacy(self):
        other = Conference.objects.create(name='Other', challan_number='LEGACY-1')
        ChallanDocument.objects.create(conference=other, scope='master', number='LEGACY-1')
        self.assertIn('challan_number_collision', self.codes())

    def test_truck_missing_orphan_bool_quantity_not_inferred(self):
        truck = self.truck(asset_quantities={'99999': 3, str(self.asset.pk): True})
        truck.assets.add(self.asset)
        self.assertIn('invalid_or_orphan_truck_quantity', self.codes())
        truck.asset_quantities = {}
        truck.save()
        self.assertIn('truck_membership_without_explicit_quantity', self.codes())
        truck.asset_quantities = ['bad']
        truck.save()
        self.assertIn('malformed_truck_quantity_map', self.codes())

    def test_rental_and_multiple_truck_sources_need_review(self):
        company = SubrentalCompany.objects.create(name='Synthetic supplier')
        ticket = SubrentalTicket.objects.create(company=company, conference=self.event)
        SubrentalTicketItem.objects.create(ticket=ticket, asset=self.asset, quantity=2)
        for number in (1, 2):
            self.truck(number, asset_quantities={str(self.asset.pk): 1}).assets.add(self.asset)
        self.assertIn('rental_truck_source_identity_ambiguous', self.codes())
        self.assertIn('legacy_asset_on_multiple_trucks', self.codes())

    def test_management_command_private_no_overwrite_no_sqlite_business(self):
        with tempfile.TemporaryDirectory() as folder:
            expected = connection.settings_dict['NAME']
            path = os.path.join(folder, 'private.json')
            out = io.StringIO()
            call_command('preview_legacy_reconciliation', expected_database=expected, allow_test_sqlite=True, output=path, stdout=out)
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            with open(path) as file:
                evidence = json.load(file)
            self.assertEqual(evidence['report']['mode'], 'preview_only')
            with self.assertRaises(CommandError):
                call_command('preview_legacy_reconciliation', expected_database=expected, allow_test_sqlite=True, output=path)
            with self.assertRaises(CommandError):
                call_command('preview_legacy_reconciliation', expected_database=':memory:')
            with self.assertRaises(CommandError):
                call_command('preview_legacy_reconciliation', expected_database='wrong', allow_test_sqlite=True)
