"""Document source integration, conservation, legacy review and temporary truck guards."""
import copy
import uuid
from unittest.mock import patch

from django.contrib.auth.models import User
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from .asset_commands import CommandError
from .challan_documents import save_document, document_data
from .challan_preview import preview_legacy_documents
from .consumable_commands import execute_consumable_command
from .models import (Asset, Conference, ConsumableAllocation, ChallanDocument, ChallanRevision,
                     MovementReceipt, TruckChallan, QuantityAllocation)
from .serializers import ConferenceSerializer
from .truck_transfer import transfer_truck_allocation


class DocumentQuantitySourceTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user('quantity-document-admin')
        self.user.profile.role = 'admin'; self.user.profile.save()
        self.client = APIClient(); self.client.force_authenticate(self.user)
        self.event = Conference.objects.create(name='Quantity source event', challan_number='SOURCE-1')
        self.asset = Asset.objects.create(sku='TAPE-10', alias_name='Tape', type='Consumables', quantity=10, item_price='12.50')

    def consume(self, action, returned=None, confirmed=False):
        self.event.refresh_from_db()
        return execute_consumable_command(self.user, self.event.pk, {'request_id': str(uuid.uuid4()), 'action': action,
            'expected_revision': self.event.revision, 'items': [{'asset_id': self.asset.pk, 'requested': 8,
            'returned': returned, 'confirmed': confirmed}]})

    def line(self, quantity=8):
        return {'id': str(uuid.uuid4()), 'asset_id': self.asset.pk, 'ticket_item_id': None, 'supplier_id': None,
            'source_kind': 'owned', 'snapshot': {'alias_name': 'Printed tape', 'type': 'Consumables'},
            'quantity': quantity, 'unit_value': '12.50'}

    def document(self, lines=None, previous=None, **fields):
        self.event.refresh_from_db()
        command = {'request_id': str(uuid.uuid4()), 'expected_revision': previous['revision'] if previous else 0,
            'expected_event_revision': self.event.revision, 'lines': lines or [self.line()], 'number': 'SOURCE-1',
            'total_override': None, 'document_date': '2026-10-08', 'state': 'draft', 'correction_reason': '', **fields}
        return save_document(self.user, self.event.pk, 'master', command)

    def test_consumable_metadata_is_embedded_without_physical_membership(self):
        self.consume('save')
        bulk = Asset.objects.create(sku='QUANTITY-100', alias_name='Bulk cable', quantity=100)
        QuantityAllocation.objects.create(asset=bulk, conference=self.event, reserved=6)
        data = ConferenceSerializer(self.event).data
        self.assertEqual(data['consumable_assets_details'][0]['id'], self.asset.pk)
        self.assertEqual(data['consumable_assets_details'][0]['item_price'], '12.50')
        self.assertIn('current_value', data['consumable_assets_details'][0])
        self.assertEqual(data['quantity_assets_details'][0]['id'], bulk.pk)
        self.assertFalse(self.event.assets.exists())
        self.assertFalse(self.event.challan_assets.exists())

    def test_settled_source_prints_request_not_remaining_stock_or_consumption(self):
        self.consume('dispatch'); self.consume('settle', 3, True)
        result = self.document()
        self.asset.refresh_from_db()
        self.assertEqual(self.asset.quantity, 5)
        self.assertEqual(result['document']['lines'][0]['quantity'], 8)
        self.assertEqual(ConsumableAllocation.objects.get().consumed, 5)
        self.assertFalse(self.event.assets.exists())

    def test_requests_can_prepare_a_draft_without_debiting_stock(self):
        self.consume('save'); result = self.document()
        self.asset.refresh_from_db()
        self.assertEqual(self.asset.quantity, 10)
        self.assertEqual(result['document']['lines'][0]['quantity'], 8)

    def test_old_bulk_draft_cannot_save_warehouse_stock_as_event_quantity(self):
        bulk = Asset.objects.create(sku='BULK-100', quantity=100, item_price=25)
        QuantityAllocation.objects.create(asset=bulk, conference=self.event, dispatched=6, dispatched_total=6)
        self.assertFalse(self.event.challan_assets.exists())
        line = {**self.line(100), 'asset_id': bulk.pk}
        with self.assertRaises(CommandError) as error: self.document([line])
        self.assertEqual(error.exception.code, 'document_quantity_exceeds_event_allocation')
        self.assertFalse(ChallanDocument.objects.exists()); self.assertFalse(MovementReceipt.objects.exists())
        line['quantity'] = 6
        saved = self.document([line])['document']
        bulk.refresh_from_db(); self.assertEqual(bulk.quantity, 100)
        self.assertEqual(saved['lines'][0]['quantity'], 6)

    def test_new_source_cannot_exceed_recorded_request_or_use_old_json(self):
        self.consume('save')
        with self.assertRaises(CommandError) as error: self.document([self.line(9)])
        self.assertEqual(error.exception.code, 'document_quantity_exceeds_consumable_request')
        self.assertFalse(ChallanDocument.objects.exists())
        other = Conference.objects.create(name='Legacy event', consumable_data={str(self.asset.pk): {'requested': 8}})
        other.challan_assets.add(self.asset)
        self.event = other
        with self.assertRaises(CommandError) as error: self.document()
        self.assertEqual(error.exception.code, 'legacy_consumables_require_reconciliation')
        self.asset.refresh_from_db(); self.assertEqual(self.asset.quantity, 10)

    def test_snapshot_edits_replay_and_history_do_not_consume_more_stock(self):
        self.consume('dispatch'); self.consume('settle', 3, True)
        first = self.document(state='issued')['document']
        line = copy.deepcopy(first['lines'][0]); line['quantity'] = 7; line['unit_value'] = '10.25'
        saved = self.document([line], first, state='issued', correction_reason='Verified paper correction')['document']
        self.asset.refresh_from_db(); self.assertEqual(self.asset.quantity, 5)
        self.assertEqual(saved['header'], first['header'])
        self.assertEqual(ChallanRevision.objects.get(revision=1).snapshot['lines'][0]['quantity'], 8)
        self.assertEqual(ChallanRevision.objects.get(revision=2).snapshot['lines'][0]['quantity'], 7)
        with self.assertRaises(CommandError): self.document([{**line, 'quantity': 9}], saved, state='issued', correction_reason='Invalid increase')

    def test_existing_print_is_independent_of_later_stock_changes(self):
        self.consume('dispatch'); self.consume('settle', 3, True)
        first = self.document(state='issued')['document']
        Asset.objects.filter(pk=self.asset.pk).update(quantity=0, alias_name='Renamed stock', item_price=99)
        self.assertEqual(document_data(ChallanDocument.objects.get()), first)
        next_doc = self.document(first['lines'], first, state='issued', correction_reason='No source change')['document']
        self.assertEqual(next_doc['lines'], first['lines'])

    def test_late_document_failure_preserves_ledger_stock_and_no_orphan_receipt(self):
        self.consume('dispatch'); self.consume('settle', 3, True)
        before = MovementReceipt.objects.count()
        with patch('core.challan_documents.ChallanRevision.objects.create', side_effect=RuntimeError('synthetic document failure')):
            with self.assertRaises(RuntimeError): self.document()
        self.assertFalse(ChallanDocument.objects.exists())
        self.assertEqual(MovementReceipt.objects.count(), before)
        self.asset.refresh_from_db(); self.assertEqual(self.asset.quantity, 5)
        self.assertEqual(ConsumableAllocation.objects.get().state, 'settled')

    def test_preview_includes_ledger_once_without_false_legacy_warning(self):
        self.consume('dispatch'); self.consume('settle', 3, True)
        preview = preview_legacy_documents(self.event.pk)
        self.assertEqual([line['quantity'] for line in preview['documents'][0]['lines']], [8])
        self.assertEqual(preview['warnings'], [])
        self.event.challan_assets.add(self.asset)
        self.assertEqual(len(preview_legacy_documents(self.event.pk)['documents'][0]['lines']), 1)

    def test_cancelled_source_and_old_unknown_return_are_not_inferred(self):
        self.consume('save')
        row = ConsumableAllocation.objects.get(); row.requested = 0; row.save()
        self.event.consumable_data = {}; self.event.save()
        self.assertEqual(preview_legacy_documents(self.event.pk)['documents'][0]['lines'], [])
        self.event = Conference.objects.create(name='Unknown legacy return',
            consumable_data={str(self.asset.pk): {'requested': 8, 'status': 'settled'}})
        preview = preview_legacy_documents(self.event.pk)
        self.assertEqual(preview['documents'][0]['lines'], [])
        self.assertIn('consumable_legacy_ledger_requires_settlement_review', [w['code'] for w in preview['warnings']])

    def test_malformed_legacy_preview_warns_instead_of_crashing(self):
        self.event.consumable_data = ['ambiguous']; self.event.save()
        self.assertIn('invalid_legacy_consumable_data', [w['code'] for w in preview_legacy_documents(self.event.pk)['warnings']])

    def test_reads_create_no_documents_numbers_movements_or_memberships(self):
        self.consume('dispatch'); self.consume('settle', 3, True)
        with CaptureQueriesContext(connection) as queries:
            self.client.get(f'/api/conferences/{self.event.pk}/')
            self.client.get(f'/api/conferences/{self.event.pk}/challan-documents/master/')
            self.client.get(f'/api/conferences/{self.event.pk}/trucks/')
            preview_legacy_documents(self.event.pk)
        writes = [q['sql'] for q in queries if q['sql'].lstrip().upper().startswith(('INSERT', 'UPDATE', 'DELETE'))]
        self.assertEqual(writes, [])
        self.assertFalse(ChallanDocument.objects.exists())

    def test_truck_creation_cannot_bypass_consumable_history_or_legacy_source(self):
        self.consume('save'); self.event.refresh_from_db()
        response = self.client.post(f'/api/conferences/{self.event.pk}/trucks/', {'expected_revision': self.event.revision}, format='json')
        self.assertEqual(response.status_code, 409); self.assertFalse(TruckChallan.objects.exists())
        legacy = Conference.objects.create(name='Legacy truck event'); legacy.challan_assets.add(self.asset)
        response = self.client.post(f'/api/conferences/{legacy.pk}/trucks/', {'expected_revision': legacy.revision}, format='json')
        self.assertEqual(response.status_code, 409); self.assertFalse(TruckChallan.objects.exists())

    def test_truck_add_patch_document_transfer_and_consume_commands_are_gated(self):
        source = TruckChallan.objects.create(conference=self.event, truck_number=1)
        destination = TruckChallan.objects.create(conference=self.event, truck_number=2)
        self.event.refresh_from_db()
        response = self.client.post(f'/api/conferences/{self.event.pk}/trucks/add-to-truck/',
            {'expected_revision': self.event.revision, 'asset_ids': [self.asset.pk], 'truck_id': source.pk}, format='json')
        self.assertEqual(response.status_code, 409); self.assertFalse(source.assets.exists())
        response = self.client.patch(f'/api/truck-challans/{source.pk}/',
            {'expected_revision': self.event.revision, 'assets': [self.asset.pk]}, format='json')
        self.assertEqual(response.status_code, 409); self.assertFalse(source.assets.exists())
        with self.assertRaises(CommandError) as error: self.consume('save')
        self.assertEqual(error.exception.code, 'consumable_trucks_require_coordinated_workflow')
        source.assets.add(self.asset); source.asset_quantities = {str(self.asset.pk): 8}; source.save()
        with self.assertRaises(CommandError) as error:
            transfer_truck_allocation(self.user, source.pk, {'request_id': str(uuid.uuid4()), 'to_truck_id': destination.pk, 'transfers': [{'asset_id': self.asset.pk, 'quantity': 2}]})
        self.assertEqual(error.exception.code, 'consumable_trucks_require_coordinated_workflow')
        self.event.refresh_from_db()
        with self.assertRaises(CommandError) as error:
            save_document(self.user, self.event.pk, f'truck-{source.pk}', {'request_id': str(uuid.uuid4()), 'expected_revision': 0,
                'expected_event_revision': self.event.revision, 'lines': [self.line()], 'number': 'SOURCE-1'})
        self.assertEqual(error.exception.code, 'consumable_trucks_require_coordinated_workflow')
        self.assertFalse(ChallanDocument.objects.exists()); self.assertFalse(MovementReceipt.objects.exists())

    def test_truck_vehicle_metadata_is_still_allowed_but_deletion_is_blocked(self):
        self.consume('save')
        source = TruckChallan.objects.create(conference=self.event, truck_number=1)
        self.event.refresh_from_db()
        response = self.client.patch(f'/api/truck-challans/{source.pk}/',
            {'expected_revision': self.event.revision, 'vehicle_number': 'SYNTHETIC-VEHICLE'}, format='json')
        self.assertEqual(response.status_code, 200)
        self.event.refresh_from_db()
        response = self.client.delete(f'/api/truck-challans/{source.pk}/', {'expected_revision': self.event.revision}, format='json')
        self.assertEqual(response.status_code, 409); self.assertTrue(TruckChallan.objects.filter(pk=source.pk).exists())
