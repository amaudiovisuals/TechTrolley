"""Disposable document tests: inventory conservation, retries and historical print data."""
import copy
from datetime import date, datetime, timezone
import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest import skipUnless
from decimal import Decimal
from unittest.mock import patch
import json
import tempfile
from pathlib import Path

from django.contrib.auth.models import User
from django.test import TransactionTestCase
from .test_support import SnapshotTestCase
from rest_framework.test import APIClient

from .asset_commands import CommandError
from .challan_documents import save_document, document_data, allocate_number
from .models import (Asset, Conference, TruckChallan, SubrentalCompany, SubrentalTicket,
                     SubrentalTicketItem, ChallanDocument, ChallanRevision, MovementReceipt,
                     ChallanNumberReservation, CompanySettings, get_current_financial_year)
from .challan_preview import preview_legacy_documents
from django.db import connection
from django.db import close_old_connections
from django.test.utils import CaptureQueriesContext
from django.core.management import call_command
from django.core.management.base import CommandError as ManagementCommandError
from io import StringIO


class ChallanDocumentTests(SnapshotTestCase):
    def setUp(self):
        self.user = User.objects.create_user('document-admin')
        self.user.profile.role = 'admin'; self.user.profile.save()
        self.event = Conference.objects.create(name='Document event', challan_number='LEGACY-1', billing_address='Original address')
        self.asset = Asset.objects.create(sku='STOCK-100', alias_name='Cable', quantity=100, item_price=100, depreciation_percentage=15)
        self.event.challan_assets.add(self.asset)
        self.client = APIClient(); self.client.force_authenticate(self.user)

    def line(self, asset=None, kind='manual', **fields):
        return {'id': str(uuid.uuid4()), 'asset_id': asset.pk if asset else None,
                'ticket_item_id': None, 'supplier_id': None, 'source_kind': kind,
                'snapshot': {'alias_name': 'Manual cable', 'sku': 'Printed tag', 'serial_number': 'Printed serial'},
                'quantity': 2, 'unit_value': '12.50', **fields}

    def payload(self, lines=None, document=None, **fields):
        self.event.refresh_from_db()
        return {'request_id': str(uuid.uuid4()), 'expected_revision': document['revision'] if document else 0,
                'expected_event_revision': self.event.revision, 'lines': lines if lines is not None else [self.line(), self.line()],
                'number': document['number'] if document else 'LEGACY-1', 'total_override': None,
                'document_date': '2026-10-08', 'state': 'draft', 'correction_reason': '', **fields}

    def save(self, payload=None, scope='master'):
        return save_document(self.user, self.event.pk, scope, payload or self.payload())

    def test_manual_lines_reopen_from_server_without_creating_stock(self):
        first = self.save()['document']
        read = self.client.get(f'/api/conferences/{self.event.pk}/challan-documents/master/')
        self.assertEqual(read.status_code, 200)
        self.assertEqual(read.data['document'], first)
        self.assertEqual(Asset.objects.count(), 1)
        self.assertEqual(ChallanRevision.objects.count(), 1)

    def test_retry_and_uuid_reuse(self):
        command = self.payload()
        first = self.save(command)
        retry = self.save(copy.deepcopy(command))
        self.assertTrue(retry['replayed'])
        self.assertEqual(first['document'], retry['document'])
        self.assertEqual(ChallanRevision.objects.count(), 1)
        command['lines'][0]['quantity'] = 9
        with self.assertRaisesMessage(CommandError, '') as error:
            self.save(command)
        self.assertEqual(error.exception.code, 'request_id_reused')

    def test_discount_is_versioned_and_omitting_it_preserves_the_saved_choice(self):
        first = self.save()['document']
        self.assertNotIn('discount_60', first['header'])
        discounted = self.save(self.payload(first['lines'], first, discount_60=True))['document']
        self.assertIs(discounted['header']['discount_60'], True)
        self.assertIsNone(discounted['total_override'])

        retained = self.save(self.payload(discounted['lines'], discounted))['document']
        self.assertIs(retained['header']['discount_60'], True)
        cleared = self.save(self.payload(retained['lines'], retained, discount_60=False))['document']
        self.assertNotIn('discount_60', cleared['header'])
        self.assertIs(ChallanRevision.objects.get(document_id=discounted['id'], revision=discounted['revision']).snapshot['header']['discount_60'], True)

        with self.assertRaises(CommandError) as error:
            self.save(self.payload(cleared['lines'], cleared, discount_60=1))
        self.assertEqual(error.exception.code, 'invalid_discount')

    def test_line_edits_never_change_inventory_or_depreciation(self):
        line = self.line(self.asset, 'owned', quantity=10)
        first = self.save(self.payload([line]))['document']
        line = copy.deepcopy(first['lines'][0]); line['quantity'] = 8; line['unit_value'] = '99.00'
        line['snapshot']['alias_name'] = 'Printed alias'
        saved = self.save(self.payload([line], first))['document']
        self.asset.refresh_from_db()
        self.assertEqual((self.asset.quantity, self.asset.alias_name, self.asset.item_price, self.asset.depreciation_percentage), (100, 'Cable', Decimal('100'), Decimal('15')))
        self.assertEqual(saved['lines'][0]['quantity'], 8)
        self.assertEqual(ChallanRevision.objects.count(), 2)

    def test_atomic_failure_leaves_no_document_or_number_or_receipt(self):
        with patch('core.challan_documents.ChallanRevision.objects.create', side_effect=RuntimeError('synthetic storage failure')):
            with self.assertRaises(RuntimeError): self.save()
        self.assertFalse(ChallanDocument.objects.exists())
        self.assertFalse(ChallanNumberReservation.objects.exists())
        self.assertFalse(MovementReceipt.objects.exists())
        self.assertEqual(self.event.challan_number, 'LEGACY-1')

    def test_stale_revision_fails_and_deliberate_removal_keeps_history(self):
        first = self.save()['document']
        self.save(self.payload([], first))
        with self.assertRaises(CommandError) as error: self.save(self.payload(first['lines'], first))
        self.assertEqual(error.exception.code, 'document_changed')
        document = ChallanDocument.objects.get()
        self.assertFalse(document.lines.exists())
        self.assertEqual(len(document.history.get(revision=1).snapshot['lines']), 2)

    def test_issued_snapshot_stays_stable_after_inventory_event_supplier_changes(self):
        supplier = SubrentalCompany.objects.create(name='Original supplier',inventory_mode='shared_warehouse')
        self.asset.subrental_company = supplier; self.asset.save()
        from .models import QuantityAllocation
        QuantityAllocation.objects.create(conference=self.event,asset=self.asset,reserved=2)
        line = self.line(self.asset, 'supplier', supplier_id=supplier.pk)
        line['snapshot']['supplier_name'] = supplier.name
        first = self.save(self.payload([line], state='issued'))['document']
        self.asset.alias_name = 'Changed inventory'; self.asset.item_price = 900; self.asset.subrental_company = None; self.asset.save()
        self.event.billing_address = 'Changed address'; self.event.save()
        supplier.name = 'Renamed supplier'; supplier.save()
        self.assertEqual(document_data(ChallanDocument.objects.get()), first)
        command = self.payload(first['lines'], first, state='issued', correction_reason='Verified correction')
        saved = self.save(command)['document']
        self.assertEqual(saved['header'], first['header'])
        self.assertEqual(saved['lines'], first['lines'])
        self.assertEqual(ChallanRevision.objects.get(revision=2).reason, 'Verified correction')

    def test_issued_changes_require_reason_and_cannot_change_number_or_unissue(self):
        first = self.save(self.payload(state='issued'))['document']
        for fields in ({'state': 'issued'}, {'state': 'draft', 'correction_reason': 'reason'}, {'state': 'issued', 'number': 'OTHER', 'correction_reason': 'reason'}):
            with self.assertRaises(CommandError): self.save(self.payload(first['lines'], first, **fields))
        self.assertEqual(ChallanRevision.objects.count(), 1)

    def test_india_deadline_preserves_custody_and_original_version(self):
        self.event.end_date = date(2026, 11, 10)
        self.event.save(update_fields=['end_date'])
        issuer = CompanySettings.objects.create(name='Original AM', gst_number='OLD-GST')
        warehouse = User.objects.create_user('lock-warehouse', is_staff=True)
        warehouse.profile.role = 'godown_incharge'
        warehouse.profile.save()
        payload = self.payload(state='issued')
        with patch('django.utils.timezone.now', return_value=datetime(2026, 11, 17, 18, 29, tzinfo=timezone.utc)):
            original = save_document(warehouse, self.event.pk, 'master', payload)['document']
        with patch('django.utils.timezone.now', return_value=datetime(2026, 11, 17, 18, 30, tzinfo=timezone.utc)):
            command = self.payload(original['lines'], original, state='issued', correction_reason='Verified line correction')
            with self.assertRaisesMessage(CommandError, 'challan_edit_window_closed'):
                save_document(warehouse, self.event.pk, 'master', command)
            self.assertTrue(save_document(warehouse, self.event.pk, 'master', payload)['replayed'])
            response = self.client.patch(f'/api/conferences/{self.event.pk}/',
                                         {'end_date': '2026-12-31', 'expected_revision': self.event.revision}, format='json')
            self.assertEqual(response.status_code, 400)
            truck = TruckChallan.objects.create(conference=self.event)
            self.event.refresh_from_db()
            response = self.client.patch(f'/api/truck-challans/{truck.pk}/',
                                         {'label': 'Overwrite', 'expected_revision': self.event.revision}, format='json')
            self.assertEqual(response.data['error'], 'challan_edit_window_closed')
            issuer.name = 'New Pvt Ltd'
            issuer.save()
            self.event.lifecycle_state = 'completed'
            self.event.save(update_fields=['lifecycle_state'])
            command = self.payload(original['lines'], original, state='issued', correction_reason='Verified correction')
            command['lines'] = copy.deepcopy(command['lines'])
            command['lines'][0]['quantity'] = 1
            corrected = self.save(command)['document']
            self.assertEqual(corrected['header']['company']['name'], 'Original AM')
            self.assertEqual(corrected['lines'][0]['quantity'], 1)
            self.assertEqual(ChallanRevision.objects.get(revision=1).snapshot, original)
            self.event.refresh_from_db()
            self.assertEqual(self.event.revision, command['expected_event_revision'])
            self.assertEqual(self.event.lifecycle_state, 'completed')

    def test_reviewed_archive_is_admin_only_even_without_end_date(self):
        original = self.save(self.payload(state='issued'))['document']
        ChallanDocument.objects.filter(pk=original['id']).update(provenance='reviewed_legacy_archive')
        warehouse = User.objects.create_user('archive-warehouse')
        warehouse.profile.role = 'godown_incharge'
        warehouse.profile.save()
        command = self.payload(original['lines'], original, state='issued', correction_reason='Reviewed wording')
        with self.assertRaisesMessage(CommandError, 'challan_edit_window_closed'):
            save_document(warehouse, self.event.pk, 'master', command)
        self.assertEqual(self.save(command)['document']['revision'], 2)

    def test_ticket_source_validation_and_duplicate_source_rejection(self):
        supplier = SubrentalCompany.objects.create(name='Supplier')
        ticket = SubrentalTicket.objects.create(company=supplier, conference=self.event)
        item = SubrentalTicketItem.objects.create(ticket=ticket, asset=self.asset, quantity=5, rental_price=20)
        line = self.line(self.asset, 'supplier', ticket_item_id=item.pk, supplier_id=supplier.pk, quantity=5)
        first = self.save(self.payload([line]))['document']
        duplicate = copy.deepcopy(first['lines'][0]); duplicate['id'] = str(uuid.uuid4())
        with self.assertRaises(CommandError) as error: self.save(self.payload([first['lines'][0], duplicate], first))
        self.assertEqual(error.exception.code, 'duplicate_source')
        other = Conference.objects.create(name='Other ticket event')
        ticket.conference = other; ticket.save()
        with self.assertRaises(CommandError): self.save(self.payload(first['lines'], first))

    def test_manual_reference_foreign_line_and_unknown_asset_rejected(self):
        for line in (self.line(self.asset), self.line(kind='owned', asset_id=9999)):
            with self.assertRaises(CommandError): self.save(self.payload([line]))
        first = self.save()['document']
        other = Conference.objects.create(name='Other event')
        payload = self.payload(first['lines']); payload['expected_event_revision'] = other.revision; payload['number'] = 'OTHER-2'
        with self.assertRaises(CommandError): save_document(self.user, other.pk, 'master', payload)

    def test_invalid_quantities_and_decimal_values_have_no_side_effects(self):
        for value in (0, -1, True, 1.5, '2'):
            with self.assertRaises(CommandError): self.save(self.payload([self.line(quantity=value)]))
        for value in ('NaN', 'Infinity', '-1', '0.001', True, '1e30'):
            with self.assertRaises(CommandError): self.save(self.payload([self.line(unit_value=value)]))
        self.assertFalse(MovementReceipt.objects.exists())

    def test_truck_document_updates_quantity_atomically_without_splitting_stock(self):
        truck = TruckChallan.objects.create(conference=self.event, truck_number=1, challan_number='LEGACY-1', asset_quantities={str(self.asset.pk): 10})
        truck.assets.add(self.asset)
        first = self.save(self.payload([self.line(self.asset, 'owned', quantity=10)]), f'truck-{truck.pk}')['document']
        first['lines'][0]['quantity'] = 8
        self.save(self.payload(first['lines'], first), f'truck-{truck.pk}')
        self.asset.refresh_from_db(); truck.refresh_from_db()
        self.assertEqual(self.asset.quantity, 100)
        self.assertEqual(truck.asset_quantities[str(self.asset.pk)], 8)
        self.assertEqual(Asset.objects.count(), 1)

    def test_truck_overallocation_rolls_back_every_line_and_membership(self):
        first = TruckChallan.objects.create(conference=self.event, truck_number=1, challan_number='LEGACY-1', asset_quantities={str(self.asset.pk): 90})
        first.assets.add(self.asset)
        second = TruckChallan.objects.create(conference=self.event, truck_number=2, challan_number='TRUCK-2')
        command = self.payload([self.line(), self.line(self.asset, 'owned', quantity=11)], number='TRUCK-2')
        with self.assertRaises(CommandError) as error: self.save(command, f'truck-{second.pk}')
        self.assertEqual(error.exception.code, 'truck_allocations_exceed_stock')
        self.assertFalse(second.assets.exists()); self.assertFalse(ChallanDocument.objects.exists())

    def test_master_and_inherited_truck_one_alias_allowed_other_scope_conflicts(self):
        master = self.save()['document']
        truck = TruckChallan.objects.create(conference=self.event, truck_number=1, challan_number='LEGACY-1')
        self.save(self.payload(), f'truck-{truck.pk}')
        other_truck = TruckChallan.objects.create(conference=self.event, truck_number=2, challan_number='TRUCK-2')
        with self.assertRaises(CommandError): self.save(self.payload(), f'truck-{other_truck.pk}')
        self.assertEqual(ChallanNumberReservation.objects.count(), 1)
        other = Conference.objects.create(name='Other')
        payload = self.payload(); payload['expected_event_revision'] = other.revision
        with self.assertRaises(CommandError): save_document(self.user, other.pk, 'master', payload)

    def test_read_endpoints_create_no_documents_trucks_numbers_or_revisions(self):
        before = (Conference.objects.get(pk=self.event.pk).revision, TruckChallan.objects.count(), MovementReceipt.objects.count())
        for url in (f'/api/conferences/{self.event.pk}/', '/api/conferences/', f'/api/conferences/{self.event.pk}/trucks/', f'/api/conferences/{self.event.pk}/challan-documents/master/'):
            self.assertEqual(self.client.get(url).status_code, 200)
        self.assertFalse(ChallanDocument.objects.exists()); self.assertFalse(ChallanNumberReservation.objects.exists())
        self.assertEqual(before, (Conference.objects.get(pk=self.event.pk).revision, TruckChallan.objects.count(), MovementReceipt.objects.count()))

    def test_old_writers_and_deletion_cannot_replace_saved_document(self):
        first = self.save()['document']
        self.event.refresh_from_db()
        for data in ({'challan_number': 'OTHER'}, {'challan_assets': []}, {'approximate_value': 99}):
            response = self.client.patch(f'/api/conferences/{self.event.pk}/', {**data, 'expected_revision': self.event.revision}, format='json')
            self.assertEqual(response.status_code, 409)
        self.assertEqual(self.client.delete(f'/api/conferences/{self.event.pk}/', {'expected_revision': self.event.revision}, format='json').status_code, 409)
        self.assertEqual(document_data(ChallanDocument.objects.get()), first)

    def test_number_allocator_skips_legacy_documents_and_resets_financial_year(self):
        fy = get_current_financial_year()
        CompanySettings.objects.create(challan_fy='00-01', next_challan_number=999)
        Conference.objects.create(name='Legacy number', challan_number=f'{fy}/AMDL-00001')
        ChallanNumberReservation.objects.create(number=f'{fy}/AMDL-00002', conference=self.event)
        self.assertEqual(allocate_number(), f'{fy}/AMDL-00003')
        self.assertEqual(allocate_number(), f'{fy}/AMDL-00004')

    def test_accounts_and_technicians_cannot_save_documents(self):
        for role in ('accounts', 'technician'):
            self.user.profile.role = role; self.user.profile.save()
            response = self.client.put(f'/api/conferences/{self.event.pk}/challan-documents/master/', self.payload(), format='json')
            self.assertEqual(response.status_code, 403)
        self.assertFalse(ChallanDocument.objects.exists())

    def test_owner_can_confirm_exact_committed_receipt_after_role_change(self):
        command = self.payload()
        self.save(command)
        self.user.profile.role = 'accounts'; self.user.profile.save()
        response = self.client.put(f'/api/conferences/{self.event.pk}/challan-documents/master/', command, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data['replayed'])
        self.assertEqual(ChallanRevision.objects.count(), 1)

    def test_backfill_preview_is_deterministic_and_never_writes(self):
        with CaptureQueriesContext(connection) as queries:
            first = preview_legacy_documents()
            second = preview_legacy_documents()
        self.assertEqual(first, second)
        self.assertEqual(first['mode'], 'preview_only')
        self.assertFalse(any(query['sql'].lstrip().upper().startswith(('INSERT', 'UPDATE', 'DELETE')) for query in queries))
        self.assertFalse(ChallanDocument.objects.exists())
        self.assertEqual(first['documents'][0]['provenance'], 'legacy_snapshot_at_preview')

    def test_inventory_and_supplier_ticket_deletion_preserves_document(self):
        supplier = SubrentalCompany.objects.create(name='Supplier')
        ticket = SubrentalTicket.objects.create(company=supplier, conference=self.event)
        item = SubrentalTicketItem.objects.create(ticket=ticket, asset=self.asset, quantity=2)
        self.save(self.payload([self.line(self.asset, 'supplier', supplier_id=supplier.pk, ticket_item_id=item.pk)]))
        for url in (f'/api/assets/{self.asset.pk}/', f'/api/subrental-companies/{supplier.pk}/', f'/api/subrental-tickets/{ticket.pk}/', f'/api/subrental-ticket-items/{item.pk}/'):
            self.assertEqual(self.client.delete(url).status_code, 409)
        self.assertEqual(ChallanDocument.objects.count(), 1)

    def test_preview_command_creates_private_export_without_overwriting_or_backfilling(self):
        with tempfile.TemporaryDirectory(prefix='tt-private-preview-test-') as folder:
            destination = Path(folder) / 'preview.json'
            output = StringIO()
            call_command('preview_challan_documents', output=str(destination), stdout=output)
            self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(destination.read_text())['mode'], 'preview_only')
            before = destination.read_text()
            with self.assertRaises(ManagementCommandError):
                call_command('preview_challan_documents', output=str(destination), stdout=StringIO())
            self.assertEqual(destination.read_text(), before)
        self.assertFalse(ChallanDocument.objects.exists())

    def test_preview_flags_legacy_temporary_inventory_without_guessing_manual_custody(self):
        self.asset.is_temporary = True; self.asset.save()
        result = preview_legacy_documents(self.event.pk)
        self.assertTrue(any(warning['code'] == 'legacy_temporary_item_requires_manual_source_review' for warning in result['warnings']))
        self.assertEqual(result['documents'][0]['lines'][0]['asset_id'], self.asset.pk)

    def test_unrelated_metadata_edit_and_empty_history_free_event_deletion_still_work(self):
        first = self.save()['document']
        self.event.refresh_from_db()
        response = self.client.patch(f'/api/conferences/{self.event.pk}/', {'expected_revision': self.event.revision,
            'name': 'Updated event', 'approximate_value': 0}, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(document_data(ChallanDocument.objects.get()), first)
        new = self.client.post('/api/conferences/', {'name': 'Empty new event'}, format='json')
        self.assertEqual(new.status_code, 201)
        number = new.data['challan_number']
        self.assertEqual(self.client.delete(f"/api/conferences/{new.data['id']}/", {'expected_revision': new.data['revision']}, format='json').status_code, 204)
        self.assertIsNone(ChallanNumberReservation.objects.get(number=number).conference_id)


@skipUnless(connection.vendor == 'postgresql', 'Requires a disposable PostgreSQL test database; never run on production')
class PostgreSQLDocumentConcurrencyTests(TransactionTestCase):
    def setUp(self):
        self.user = User.objects.create_user('concurrent-document-admin')
        self.user.profile.role = 'admin'; self.user.profile.save()
        self.event = Conference.objects.create(name='Concurrent document event')
        from .models import ChallanNumberLock
        ChallanNumberLock.objects.create(pk=1)
        CompanySettings.objects.create(challan_fy=get_current_financial_year(), next_challan_number=1)

    def test_concurrent_numbers_are_distinct(self):
        barrier = Barrier(2)
        def worker():
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                return allocate_number()
            finally:
                close_old_connections()
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: worker(), range(2)))
        self.assertEqual(len(set(results)), 2)

    def test_two_initial_saves_cannot_overwrite_each_other(self):
        barrier = Barrier(2)
        def worker():
            close_old_connections()
            try:
                user = User.objects.get(pk=self.user.pk)
                barrier.wait(timeout=10)
                payload = {'request_id': str(uuid.uuid4()), 'expected_revision': 0, 'expected_event_revision': 0,
                    'lines': [{'id': str(uuid.uuid4()), 'source_kind': 'manual', 'snapshot': {'alias_name': 'Device draft'},
                               'quantity': 1, 'unit_value': '0.00'}], 'number': '', 'total_override': None}
                try:
                    return save_document(user, self.event.pk, 'master', payload)['document']['revision']
                except CommandError as error:
                    return error.code
            finally:
                close_old_connections()
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: worker(), range(2)))
        self.assertEqual(results.count(1), 1)
        self.assertEqual(results.count('document_changed'), 1)
        self.assertEqual(ChallanDocument.objects.count(), 1)
