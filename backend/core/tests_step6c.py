"""Reviewed same-ID ownership contracts; business DBs are never selected here."""
import copy
import io
import json
import os
import tempfile
import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest import skipUnless
from unittest.mock import patch

from django.contrib.auth.models import User
from django.core.management import call_command
from django.core.management.base import CommandError as CLIError
from django.db import close_old_connections, connection
from django.db.models.deletion import ProtectedError
from django.test import TransactionTestCase, override_settings
from .test_support import SnapshotTestCase
from rest_framework.test import APIClient

from .asset_commands import CommandError, execute_command
from .challan_documents import save_document
from .models import (Asset, ChallanDocument, ChallanLine, CompanySettings, Conference,
                     ConsumableAllocation, Employee, MovementReceipt, OwnershipHistory,
                     OwnershipTarget, PhysicalMovement, QuantityAllocation, StaffAllocation,
                     SubrentalCompany, SubrentalTicket, SubrentalTicketItem)
from .ownership_commands import (execute_ownership, identity, normalize_target,
                                 prepare_preview, snapshot, write_gate)
from .quantity_commands import execute_quantity_command


@override_settings(REVIEWED_OWNERSHIP_WRITES_ENABLED=True, OWNERSHIP_INSTANCE_ID='synthetic-ownership-only')
class OwnershipTests(SnapshotTestCase):
    def setUp(self):
        self.user = User.objects.create_user('ownership-admin')
        self.user.profile.role = 'admin'; self.user.profile.save()
        self.client = APIClient(); self.client.force_authenticate(self.user)
        self.company = SubrentalCompany.objects.create(name='AM Audiovisuals')
        self.external = SubrentalCompany.objects.create(name='External', inventory_mode='external_supplier')
        self.asset = Asset.objects.create(sku='SAME-ID-QR', alias_name='Original device', serial_number='UNIQUE-SERIAL',
            barcode='UNCHANGED-BARCODE', qr_code='UNCHANGED-QR', item_price='12.50')
        self.config = CompanySettings.objects.create(name='AM Audiovisuals Pvt Ltd')
        self.event = Conference.objects.create(name='Synthetic ownership event')

    def target(self, **fields):
        return {'action': 'change_owner', 'asset_ids': [self.asset.pk], 'source_owner_id': None,
                'target_owner_id': self.company.pk, **fields}

    def packet(self, target):
        preview = prepare_preview(target)[0]
        return {'request_id': str(uuid.uuid4()), 'target': preview['target'], 'database': preview['database'],
                'expected_snapshot_sha256': preview['snapshot_sha256'], 'reason': 'Reviewed ownership register',
                'evidence_reference': 'synthetic-invoice-review', 'confirmed': True,
                'warehouse_asset_ids': preview['plan']['warehouse_asset_ids']}

    def classify(self, mode='shared_warehouse'):
        return execute_ownership(self.user, self.packet({'action': 'classify_company', 'company_id': self.company.pk, 'inventory_mode': mode}))

    def move(self):
        self.classify()
        return execute_ownership(self.user, self.packet(self.target()))

    def test_preview_is_pure_and_does_not_guess_classification(self):
        before = (Asset.objects.count(), MovementReceipt.objects.count(), OwnershipHistory.objects.count())
        response = self.client.post('/api/ownership/preview/', self.target(), format='json')
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.data['can_apply'])
        self.assertIn('ownership_transfer_requires_shared_godown_owner', [b['reason'] for b in response.data['plan']['blockers']])
        self.company.refresh_from_db(); self.assertEqual(self.company.inventory_mode, 'unreviewed')
        self.assertEqual(before, (Asset.objects.count(), MovementReceipt.objects.count(), OwnershipHistory.objects.count()))

    def test_empty_company_classification_has_history_but_no_stock_or_brand_edits(self):
        result = self.classify(); self.company.refresh_from_db(); self.config.refresh_from_db()
        self.assertEqual((self.company.inventory_mode, self.company.ownership_revision), ('shared_warehouse', 1))
        self.assertEqual(self.config.name, 'AM Audiovisuals Pvt Ltd')
        self.assertEqual(Asset.objects.count(), 1); self.assertEqual(result['asset_ids'], [])
        self.assertEqual(OwnershipHistory.objects.count(), 1)

    def test_move_preserves_original_ids_every_identifier_quantity_and_custody(self):
        before = Asset.objects.values().get(pk=self.asset.pk)
        result = self.move(); after = Asset.objects.values().get(pk=self.asset.pk)
        self.assertEqual(after['subrental_company_id'], self.company.pk)
        self.assertEqual(after['ownership_revision'], 1)
        for key in set(before) - {'subrental_company_id', 'ownership_revision'}:
            self.assertEqual(before[key], after[key], key)
        self.assertEqual(Asset.objects.count(), 1); self.assertEqual(result['asset_ids'], [self.asset.pk])

    def test_saved_manual_and_owned_papers_remain_byte_equivalent_after_move(self):
        doc = ChallanDocument.objects.create(conference=self.event, scope='master', number='FROZEN-PAPER', state='issued',
            header={'company': {'name': 'Original issuer'}})
        ChallanLine.objects.create(document=doc, asset=self.asset, source_kind='owned', snapshot={'alias_name': 'Frozen owned row'}, quantity=1, unit_value=7, position=0)
        ChallanLine.objects.create(document=doc, source_kind='manual', snapshot={'alias_name': 'Manual note'}, quantity=2, unit_value=3, position=1)
        before = list(doc.lines.values()); header = copy.deepcopy(doc.header)
        self.move(); doc.refresh_from_db()
        self.assertEqual(list(doc.lines.values()), before); self.assertEqual(doc.header, header)

    def test_future_paper_uses_new_owner_but_old_saved_line_keeps_owned_identity(self):
        self.move(); self.event.challan_assets.add(self.asset); self.event.refresh_from_db()
        result = save_document(self.user, self.event.pk, 'master', {'request_id': str(uuid.uuid4()), 'expected_revision': 0,
            'expected_event_revision': self.event.revision, 'number': 'NEW-OWNER', 'document_date': '2026-10-14', 'state': 'draft',
            'total_override': None, 'correction_reason': '', 'lines': [{'id': str(uuid.uuid4()), 'asset_id': self.asset.pk,
            'ticket_item_id': None, 'supplier_id': self.company.pk, 'source_kind': 'supplier', 'snapshot': {'alias_name': 'Device'},
            'quantity': 1, 'unit_value': '12.50', 'position': 0}]})
        self.assertEqual(result['document']['lines'][0]['snapshot']['supplier_name'], 'AM Audiovisuals')

    def test_exact_receipt_recovers_after_later_owner_activity_role_and_gate_change(self):
        self.classify(); packet = self.packet(self.target()); first = execute_ownership(self.user, packet)
        self.asset.alias_name = 'Later metadata'; self.asset.save()
        self.user.profile.role = 'accounts'; self.user.profile.save()
        with override_settings(REVIEWED_OWNERSHIP_WRITES_ENABLED=False, OWNERSHIP_INSTANCE_ID='changed'):
            replay = execute_ownership(self.user, packet)
        self.assertTrue(replay['replayed']); self.assertEqual(replay['history'], first['history'])
        self.assertNotIn('asset_states', replay)
        self.assertEqual(OwnershipHistory.objects.count(), 2)

    def test_uuid_reuse_and_cross_actor_replay_cannot_mutate(self):
        self.classify(); packet = self.packet(self.target()); execute_ownership(self.user, packet)
        changed = {**packet, 'reason': 'Different operation'}
        with self.assertRaises(CommandError): execute_ownership(self.user, changed)
        other = User.objects.create_user('ownership-other'); other.profile.role = 'accounts'; other.profile.save()
        with self.assertRaises(CommandError): execute_ownership(other, packet)
        self.assertEqual(OwnershipHistory.objects.count(), 2)

    def test_disabled_gate_and_database_runtime_mismatch_leave_no_receipt(self):
        self.classify(); packet = self.packet(self.target()); count = MovementReceipt.objects.count()
        with override_settings(REVIEWED_OWNERSHIP_WRITES_ENABLED=False):
            with self.assertRaises(CommandError) as caught: execute_ownership(self.user, packet)
            self.assertEqual(caught.exception.code, 'ownership_writes_disabled')
        packet['database']['runtime_source_sha256'] = '0' * 64
        with self.assertRaises(CommandError): execute_ownership(self.user, packet)
        self.assertEqual(MovementReceipt.objects.count(), count)

    def test_ownership_gate_is_independent_of_custody_gate(self):
        with override_settings(REVIEWED_RECONCILIATION_WRITES_ENABLED=True, REVIEWED_OWNERSHIP_WRITES_ENABLED=False):
            self.assertEqual(prepare_preview({'action': 'classify_company', 'company_id': self.company.pk, 'inventory_mode': 'shared_warehouse'})[0]['write_gate'], 'ownership_writes_disabled')

    def test_business_sqlite_and_missing_instance_are_refused(self):
        database = identity()
        self.assertEqual(write_gate({**database, 'vendor': 'sqlite', 'name': '/tmp/business.sqlite3'}), 'business_sqlite_ownership_refused')
        self.assertEqual(write_gate({**database, 'instance_id': ''}), 'ownership_database_identity_required')

    def test_stale_metadata_owner_company_brand_or_paper_prevents_apply(self):
        self.classify()
        document = ChallanDocument.objects.create(conference=self.event, scope='master', number='STALE-PAPER')
        line = ChallanLine.objects.create(document=document, asset=self.asset, source_kind='owned',
            snapshot={'alias_name': 'Saved row'}, quantity=1, unit_value=7, position=0)
        for mutate in (lambda: Asset.objects.filter(pk=self.asset.pk).update(item_price=99),
                       lambda: SubrentalCompany.objects.filter(pk=self.company.pk).update(name='Later owner name'),
                       lambda: CompanySettings.objects.filter(pk=self.config.pk).update(name='Later brand'),
                       lambda: ChallanLine.objects.filter(pk=line.pk).update(unit_value=99)):
            packet = self.packet(self.target()); mutate()
            with self.assertRaises(CommandError) as caught: execute_ownership(self.user, packet)
            self.assertEqual(caught.exception.code, 'ownership_evidence_changed')
        self.assertEqual(OwnershipHistory.objects.count(), 1)

    def test_complete_kit_is_required_and_parent_links_are_preserved(self):
        child = Asset.objects.create(sku='KIT-CHILD', parent_asset=self.asset)
        self.classify(); preview = prepare_preview(self.target())[0]
        self.assertIn('select_complete_kit', [b['reason'] for b in preview['plan']['blockers']])
        result = execute_ownership(self.user, self.packet(self.target(asset_ids=[child.pk, self.asset.pk])))
        child.refresh_from_db(); self.assertEqual(child.parent_asset_id, self.asset.pk)
        self.assertEqual(child.subrental_company_id, self.company.pk); self.assertEqual(result['asset_ids'], sorted([self.asset.pk, child.pk]))

    def test_active_event_crosscheck_packing_audit_planning_and_staff_block_moves(self):
        self.classify()
        for field in ('assets', 'crosscheck_assets', 'staged_assets', 'requirements'):
            getattr(self.event, field).add(self.asset)
            self.assertFalse(prepare_preview(self.target())[0]['can_apply'])
            getattr(self.event, field).clear()
        self.event.is_audit = True; self.event.save(); self.event.assets.add(self.asset)
        self.assertFalse(prepare_preview(self.target())[0]['can_apply']); self.event.assets.clear()
        employee = Employee.objects.create(name='Staff', employee_id='OWNER-STAFF')
        StaffAllocation.objects.create(asset=self.asset, employee=employee, provenance='legacy_unverified')
        self.assertFalse(prepare_preview(self.target())[0]['can_apply'])

    def test_bulk_and_consumer_outstanding_balances_block_even_without_memberships(self):
        self.classify(); self.asset.quantity = 10; self.asset.save()
        row = QuantityAllocation.objects.create(asset=self.asset, conference=self.event, reserved=3)
        self.assertFalse(prepare_preview(self.target())[0]['can_apply']); row.delete()
        self.asset.type = 'Consumables'; self.asset.save()
        ConsumableAllocation.objects.create(asset=self.asset, conference=self.event, requested=4, state='dispatched')
        self.assertFalse(prepare_preview(self.target())[0]['can_apply'])

    def test_closed_bulk_history_is_preserved_and_future_shared_flow_uses_same_master(self):
        self.asset.quantity = 10; self.asset.quantity_tracking = True; self.asset.save()
        row = QuantityAllocation.objects.create(asset=self.asset, conference=self.event, dispatched_total=2, verified_total=2)
        before = QuantityAllocation.objects.values().get(pk=row.pk); self.move()
        self.assertEqual(QuantityAllocation.objects.values().get(pk=row.pk), before)
        self.event.refresh_from_db()
        execute_quantity_command(self.user, self.event.pk, {'request_id': str(uuid.uuid4()), 'expected_revision': self.event.revision,
            'action': 'stage', 'items': [{'asset_id': self.asset.pk, 'quantity': 3}]})
        self.assertEqual(Asset.objects.get(pk=self.asset.pk).quantity, 10)

    def test_supplier_obligation_restricted_temporary_and_ambiguous_codes_block(self):
        self.classify()
        for field, value in (('flag', 'Missing'), ('is_temporary', True), ('condition', 'Damaged'), ('status', 'Crosscheck')):
            old = getattr(self.asset, field); setattr(self.asset, field, value); self.asset.save()
            self.assertFalse(prepare_preview(self.target())[0]['can_apply']); setattr(self.asset, field, old); self.asset.save()
        duplicate = Asset.objects.create(sku=self.asset.barcode)
        self.assertFalse(prepare_preview(self.target())[0]['can_apply']); duplicate.delete()
        ticket = SubrentalTicket.objects.create(company=self.external, conference=self.event)
        SubrentalTicketItem.objects.create(ticket=ticket, asset=self.asset, quantity=1)
        self.assertFalse(prepare_preview(self.target())[0]['can_apply'])

    def test_unresolved_physical_history_cannot_be_cleared_by_move(self):
        receipt = MovementReceipt.objects.create(actor=self.user, request_id=uuid.uuid4(), payload_hash='a'*64)
        PhysicalMovement.objects.create(asset=self.asset, conference=self.event, receipt=receipt, action='dispatch', snapshot={})
        self.classify(); self.assertFalse(prepare_preview(self.target())[0]['can_apply'])

    def test_classification_reviews_all_permanent_stock_and_exact_warehouse_confirmation(self):
        self.asset.subrental_company = self.company; self.asset.save()
        target = {'action': 'classify_company', 'company_id': self.company.pk, 'inventory_mode': 'shared_warehouse'}
        packet = self.packet(target); packet['warehouse_asset_ids'] = []
        with self.assertRaises(CommandError): execute_ownership(self.user, packet)
        packet['warehouse_asset_ids'] = [self.asset.pk]; execute_ownership(self.user, packet)
        self.company.refresh_from_db(); self.assertEqual(self.company.inventory_mode, 'shared_warehouse')

    def test_new_company_inventory_or_child_after_preview_invalidates_review(self):
        target = {'action': 'classify_company', 'company_id': self.company.pk, 'inventory_mode': 'shared_warehouse'}
        packet = self.packet(target); Asset.objects.create(sku='ADDED-LATER', subrental_company=self.company)
        with self.assertRaises(CommandError): execute_ownership(self.user, packet)
        self.assertEqual(OwnershipHistory.objects.count(), 0)

    def test_external_source_or_destination_and_wrong_selected_source_are_blocked(self):
        self.classify()
        for target in (self.target(target_owner_id=self.external.pk), self.target(source_owner_id=self.company.pk), self.target(target_owner_id=None)):
            self.assertFalse(prepare_preview(target)[0]['can_apply'])

    def test_inverse_restores_only_owner_and_advances_epochs_preserving_history(self):
        result = self.move(); self.asset.refresh_from_db(); epoch = self.asset.ownership_revision
        inverse = execute_ownership(self.user, self.packet({'action': 'inverse', 'original_id': result['history']['id']}))
        self.asset.refresh_from_db(); self.assertIsNone(self.asset.subrental_company_id)
        self.assertEqual(self.asset.ownership_revision, epoch+1); self.assertEqual(OwnershipHistory.objects.count(), 3)
        self.assertEqual(inverse['history']['reverses'], result['history']['id'])
        self.assertFalse(prepare_preview({'action': 'inverse', 'original_id': inverse['history']['id']})[0]['can_apply'])

    def test_classification_inverse_is_bounded_and_later_stock_blocks_it(self):
        first = self.classify()
        target = {'action': 'inverse', 'original_id': first['history']['id']}
        execute_ownership(self.user, self.packet(target)); self.company.refresh_from_db()
        self.assertEqual(self.company.inventory_mode, 'unreviewed')
        second = self.classify(); Asset.objects.create(sku='LATER-REGISTERED', subrental_company=self.company)
        self.assertFalse(prepare_preview({'action': 'inverse', 'original_id': second['history']['id']})[0]['can_apply'])

    def test_later_scan_or_metadata_blocks_inverse_without_rewriting_documents(self):
        result = self.move(); self.asset.refresh_from_db()
        execute_command(self.user, self.event.pk, {'request_id': str(uuid.uuid4()), 'action': 'stage', 'asset_ids': [self.asset.pk]})
        self.assertFalse(prepare_preview({'action': 'inverse', 'original_id': result['history']['id']})[0]['can_apply'])

    def test_protected_history_prevents_asset_company_or_operator_deletion(self):
        self.move()
        self.assertEqual(self.client.delete(f'/api/assets/{self.asset.pk}/').status_code, 409)
        self.assertEqual(self.client.delete(f'/api/subrental-companies/{self.company.pk}/').status_code, 409)
        for row in (Asset.objects.get(pk=self.asset.pk), self.company, self.user):
            with self.assertRaises(ProtectedError): row.delete()

    def test_late_failure_rolls_back_every_owner_epoch_history_and_receipt(self):
        self.classify(); packet = self.packet(self.target()); count = MovementReceipt.objects.count()
        before = snapshot([self.asset.pk], [self.company.pk])
        with patch('core.ownership_commands.snapshot', side_effect=[before, RuntimeError('late failure after owner/epoch writes')]):
            with self.assertRaises(RuntimeError): execute_ownership(self.user, packet)
        self.asset.refresh_from_db(); self.assertIsNone(self.asset.subrental_company_id)
        self.assertEqual(self.asset.ownership_revision, 0); self.assertEqual(MovementReceipt.objects.count(), count)

    def test_strict_selection_fields_and_confirmation(self):
        for target in (self.target(asset_ids=[True]), self.target(asset_ids=[self.asset.pk]*2), self.target(asset_ids=[]), self.target(extra='unsafe'),
                       {'action': 'classify_company', 'company_id': True, 'inventory_mode': 'shared_warehouse'}):
            with self.assertRaises(CommandError): normalize_target(target)
        self.classify(); packet = self.packet(self.target()); packet['confirmed'] = 1
        with self.assertRaises(CommandError): execute_ownership(self.user, packet)

    def test_generic_owner_classification_and_revision_writes_do_not_bypass_review(self):
        response = self.client.patch(f'/api/assets/{self.asset.pk}/', {'subrental_company': self.company.pk}, format='json')
        self.assertEqual(response.status_code, 400)
        response = self.client.patch(f'/api/assets/{self.asset.pk}/', {'ownership_revision': 88}, format='json')
        self.assertEqual(response.status_code, 200); self.asset.refresh_from_db(); self.assertEqual(self.asset.ownership_revision, 0)
        response = self.client.patch(f'/api/subrental-companies/{self.company.pk}/', {'inventory_mode': 'shared_warehouse'}, format='json')
        self.assertEqual(response.status_code, 400)

    def test_new_mismatched_kit_registration_is_refused_atomically(self):
        response = self.client.post('/api/assets/', [{'sku': 'GOOD-NEW', 'quantity': 1},
            {'sku': 'WRONG-KIT-OWNER', 'parent_asset': self.asset.pk, 'subrental_company': self.company.pk}], format='json')
        self.assertEqual(response.status_code, 400); self.assertEqual(Asset.objects.count(), 1)

    def test_auth_role_authority_and_history_read_protection(self):
        anon = APIClient(); self.assertEqual(anon.post('/api/ownership/preview/', self.target(), format='json').status_code, 401)
        self.user.profile.role = 'godown_incharge'; self.user.profile.save()
        self.assertEqual(self.client.post('/api/ownership/preview/', self.target(), format='json').status_code, 200)
        packet = self.packet({'action': 'classify_company', 'company_id': self.company.pk, 'inventory_mode': 'shared_warehouse'})
        self.assertEqual(self.client.post('/api/ownership/commands/', packet, format='json').status_code, 403)
        self.user.profile.role = 'admin'; self.user.profile.save(); result = execute_ownership(self.user, packet)
        response = self.client.get(f"/api/ownership/history/{result['history']['id']}/")
        self.assertEqual(response.status_code, 200); self.assertIn('before_snapshot', response.data)

    def test_one_issuer_required_and_no_auto_creation_from_preview(self):
        self.config.delete()
        preview = prepare_preview({'action': 'classify_company', 'company_id': self.company.pk, 'inventory_mode': 'shared_warehouse'})[0]
        self.assertFalse(preview['can_apply']); self.assertEqual(CompanySettings.objects.count(), 0)


@override_settings(REVIEWED_OWNERSHIP_WRITES_ENABLED=True, OWNERSHIP_INSTANCE_ID='synthetic-cli')
class OwnershipCLITests(SnapshotTestCase):
    def setUp(self):
        self.company = SubrentalCompany.objects.create(name='Synthetic CLI company')
        CompanySettings.objects.create(name='Synthetic issuer')
        self.user = User.objects.create_user('owner-cli-admin'); self.user.profile.role = 'admin'; self.user.profile.save()
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.target = os.path.join(self.temp.name, 'target.json')
        with open(self.target, 'w') as f:
            json.dump({'action': 'classify_company', 'company_id': self.company.pk, 'inventory_mode': 'shared_warehouse'}, f)
        self.options = {'expected_database': connection.settings_dict['NAME'], 'expected_instance': 'synthetic-cli', 'stdout': io.StringIO()}

    def test_default_cli_preview_is_pure_and_output_private_exclusive(self):
        output = os.path.join(self.temp.name, 'preview.json')
        call_command('review_inventory_ownership', target=self.target, output=output, **self.options)
        self.assertEqual(os.stat(output).st_mode & 0o777, 0o600)
        self.assertFalse(json.load(open(output))['committed']); self.assertEqual(OwnershipHistory.objects.count(), 0)
        with self.assertRaises(CLIError): call_command('review_inventory_ownership', target=self.target, output=output, **self.options)

    def test_wrong_database_or_instance_is_refused(self):
        for key in ('expected_database', 'expected_instance'):
            options = {**self.options, key: 'wrong'}
            with self.assertRaises(CLIError): call_command('review_inventory_ownership', target=self.target, **options)

    def test_nested_cli_apply_is_refused(self):
        with self.assertRaises(CLIError): call_command('review_inventory_ownership', target=self.target, apply=True, **self.options)


@override_settings(REVIEWED_OWNERSHIP_WRITES_ENABLED=True, OWNERSHIP_INSTANCE_ID='synthetic-cli-apply')
class OwnershipCLIApplyTests(TransactionTestCase):
    def setUp(self):
        self.company = SubrentalCompany.objects.create(name='CLI applied company')
        CompanySettings.objects.create(name='CLI issuer')
        self.user = User.objects.create_user('cli-apply-admin'); self.user.profile.role = 'admin'; self.user.profile.save()
        target = {'action': 'classify_company', 'company_id': self.company.pk, 'inventory_mode': 'shared_warehouse'}
        preview = prepare_preview(target)[0]
        self.packet = {'request_id': str(uuid.uuid4()), 'target': target, 'database': preview['database'],
            'expected_snapshot_sha256': preview['snapshot_sha256'], 'reason': 'Reviewed CLI classification',
            'evidence_reference': 'synthetic-review-only', 'confirmed': True, 'warehouse_asset_ids': []}
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.packet_path = os.path.join(self.temp.name, 'packet.json')
        with open(self.packet_path, 'w') as f: json.dump(self.packet, f)
        self.options = {'expected_database': connection.settings_dict['NAME'], 'expected_instance': 'synthetic-cli-apply',
                        'packet': self.packet_path, 'apply': True, 'actor': self.user.pk, 'stdout': io.StringIO()}

    def test_cli_apply_commits_once_and_exact_packet_recovers_after_disabled_gate(self):
        output = os.path.join(self.temp.name, 'applied.json')
        call_command('review_inventory_ownership', output=output, **self.options)
        with open(output) as f: self.assertTrue(json.load(f)['committed'])
        with override_settings(REVIEWED_OWNERSHIP_WRITES_ENABLED=False):
            call_command('review_inventory_ownership', **self.options)
        self.assertEqual(OwnershipHistory.objects.count(), 1)
        self.company.refresh_from_db(); self.assertEqual(self.company.inventory_mode, 'shared_warehouse')

    def test_private_output_failure_reports_commit_and_same_packet_recovers(self):
        output = os.path.join(self.temp.name, 'failed-output.json')
        with patch('core.management.commands.review_inventory_ownership.json.dump', side_effect=OSError('synthetic disk full')):
            with self.assertRaises(CLIError) as caught:
                call_command('review_inventory_ownership', output=output, **self.options)
        self.assertIn('Data committed=True', str(caught.exception))
        self.assertEqual(OwnershipHistory.objects.count(), 1)
        call_command('review_inventory_ownership', **self.options)
        self.assertEqual(OwnershipHistory.objects.count(), 1)


@skipUnless(connection.vendor == 'postgresql', 'Isolated PostgreSQL is required for ownership races')
@override_settings(REVIEWED_OWNERSHIP_WRITES_ENABLED=True, OWNERSHIP_INSTANCE_ID='synthetic-ownership-pg')
class OwnershipRaceTests(TransactionTestCase):
    def setUp(self):
        self.user = User.objects.create_user('ownership-race'); self.user.profile.role = 'admin'; self.user.profile.save()
        self.company = SubrentalCompany.objects.create(name='Shared race owner', inventory_mode='shared_warehouse')
        self.asset = Asset.objects.create(sku='OWNER-RACE')
        CompanySettings.objects.create(name='Race issuer')
        self.event = Conference.objects.create(name='Race event')
        target = {'action': 'change_owner', 'asset_ids': [self.asset.pk], 'source_owner_id': None, 'target_owner_id': self.company.pk}
        preview = prepare_preview(target)[0]
        self.packet = {'request_id': str(uuid.uuid4()), 'target': target, 'database': preview['database'], 'expected_snapshot_sha256': preview['snapshot_sha256'],
                       'reason': 'Synthetic concurrent review', 'evidence_reference': 'synthetic-only', 'confirmed': True, 'warehouse_asset_ids': [self.asset.pk]}

    def race(self, functions):
        barrier = Barrier(2)
        def run(function):
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                try: return function(User.objects.get(pk=self.user.pk))
                except CommandError as error: return error.code
            finally: close_old_connections()
        with ThreadPoolExecutor(2) as pool: return list(pool.map(run, functions))

    def test_same_uuid_owner_race_commits_one_history(self):
        self.race([lambda user: execute_ownership(user, self.packet)]*2)
        self.assertEqual(OwnershipHistory.objects.count(), 1); self.assertEqual(MovementReceipt.objects.count(), 1)
        self.assertEqual(Asset.objects.get(pk=self.asset.pk).ownership_revision, 1)

    def test_competing_owner_reviews_cannot_both_apply_same_snapshot(self):
        other = {**self.packet, 'request_id': str(uuid.uuid4())}
        results = self.race([lambda user: execute_ownership(user, self.packet), lambda user: execute_ownership(user, other)])
        self.assertEqual(sum(isinstance(row, dict) for row in results), 1); self.assertEqual(OwnershipHistory.objects.count(), 1)

    def test_scan_versus_owner_review_is_serial_and_never_resets_custody(self):
        results = self.race([lambda user: execute_ownership(user, self.packet), lambda user: execute_command(user, self.event.pk,
            {'request_id': str(uuid.uuid4()), 'action': 'stage', 'asset_ids': [self.asset.pk]})])
        self.assertTrue(any(isinstance(row, dict) for row in results))
        self.assertTrue(self.event.staged_assets.filter(pk=self.asset.pk).exists())
        self.assertEqual(Asset.objects.get(pk=self.asset.pk).quantity, 1)

    def test_classification_versus_bulk_stage_cannot_leave_external_reserved_stock(self):
        self.asset.subrental_company = self.company; self.asset.quantity = 10; self.asset.save()
        target = {'action': 'classify_company', 'company_id': self.company.pk, 'inventory_mode': 'external_supplier'}
        preview = prepare_preview(target)[0]
        packet = {**self.packet, 'target': target, 'database': preview['database'],
                  'expected_snapshot_sha256': preview['snapshot_sha256'], 'warehouse_asset_ids': []}
        self.race([lambda user: execute_ownership(user, packet), lambda user: execute_quantity_command(user, self.event.pk,
            {'request_id': str(uuid.uuid4()), 'action': 'stage', 'expected_revision': 0, 'items': [{'asset_id': self.asset.pk, 'quantity': 3}]})])
        self.company.refresh_from_db()
        self.assertFalse(self.company.inventory_mode == 'external_supplier' and QuantityAllocation.objects.filter(asset=self.asset, reserved__gt=0).exists())

    def test_new_kit_registration_versus_move_cannot_split_owners(self):
        def register(user):
            client = APIClient(); client.force_authenticate(user)
            return client.post('/api/assets/', {'sku': 'CONCURRENT-CHILD', 'parent_asset': self.asset.pk}, format='json').status_code
        self.race([lambda user: execute_ownership(user, self.packet), register])
        self.asset.refresh_from_db()
        for child in self.asset.sub_assets.all(): self.assertEqual(child.subrental_company_id, self.asset.subrental_company_id)
