from copy import deepcopy
from datetime import date
from uuid import uuid4
from unittest.mock import patch

from django.contrib.auth.models import User
from django.test import TestCase

from .asset_commands import CommandError
from .challan_documents import document_data, save_document
from .models import (Asset, ChallanDocument, ChallanLine, ChallanRevision, Conference,
                     MovementReceipt, TruckChallan, CompanySettings, SubrentalCompany, SubrentalTicket, SubrentalTicketItem)
from .tests_program_deliveries import reviewed
from .unit_challan_quantities import correct_unit_draft
from .truck_manifests import validate_sources, validate_total, execute_manifest_command
from .program_deliveries import sources


class UnitChallanTests(TestCase):
    def setUp(self):
        self.actor = User.objects.create_superuser('unit-challan-admin')
        CompanySettings.objects.create(name='Issuing company')
        self.event = Conference.objects.create(name='Individual QR event')
        self.assets = [Asset.objects.create(sku=f'QR-{i}', qr_code=f'QR-{i}', alias_name='Cable') for i in range(5)]
        self.event.challan_assets.add(*self.assets)
        self.document = reviewed(self.event, self.assets)
        self.document.lines.update(unit_value='10.00')
        self.line = self.document.lines.order_by('position').first()
        self.line.quantity = 8; self.line.save()
        self.document.total_override = 0
        self.document.header['discount_60'] = True; self.document.save(); self.document.refresh_from_db()
        ChallanRevision.objects.create(document=self.document, revision=self.document.revision,
            actor=self.actor, reason='Synthetic previous version', snapshot=document_data(self.document))
        self.event.refresh_from_db()
        self.review = dict(expected_event_revision=self.event.revision, expected_document_revision=self.document.revision,
            expected_quantities={str(self.line.pk): 8}, request_id=str(uuid4()), reason='Approved individual QR quantity correction')

    def correct(self, **fields):
        return correct_unit_draft(self.actor, self.event.pk, self.document.pk, **{**self.review, **fields})

    def payload(self, **fields):
        self.event.refresh_from_db(); self.document.refresh_from_db()
        data = document_data(self.document)
        return {'request_id': str(uuid4()), 'expected_revision': data['revision'],
            'expected_event_revision': self.event.revision, 'lines': deepcopy(data['lines']),
            'number': data['number'], 'state': data['state'], 'document_date': data['document_date'],
            'total_override': data['total_override'], **fields}

    def test_correction_preserves_every_qr_rate_header_and_previous_copy(self):
        before = document_data(self.document)
        stock = list(Asset.objects.values())
        result = self.correct()
        self.document.refresh_from_db(); after = document_data(self.document)
        expected = deepcopy(before)
        expected['lines'][0]['quantity'] = 1; expected['revision'] += 1; expected['total_override'] = None
        self.assertEqual(after, expected)
        self.assertEqual(list(Asset.objects.values()), stock)
        self.assertEqual(ChallanRevision.objects.get(document=self.document, revision=1).snapshot, before)
        self.assertEqual(ChallanRevision.objects.get(document=self.document, revision=2).snapshot, after)
        self.assertEqual(result['units'], 5)  # Five individual QRs still group as five cables.
        self.assertEqual(result['grand_total'], '20.00')
        self.assertEqual(self.event.challan_assets.count(), 5)
        self.assertFalse(self.event.assets.exists()); self.assertFalse(self.event.crosscheck_assets.exists())
        self.assertTrue(self.correct()['replayed'])
        self.assertEqual(ChallanRevision.objects.count(), 2)
        with self.assertRaises(CommandError): self.correct(reason='Different operation')

    def test_corrected_draft_previews_delivery_and_splits_trucks_without_stock_changes(self):
        self.correct(); self.document.refresh_from_db(); self.event.refresh_from_db()
        validate_sources(self.event, list(self.document.lines.select_related('asset'))); validate_total(self.document)
        self.assertEqual(sum(row['quantity'] for row in sources(self.event)['rows']), 5)
        result = execute_manifest_command(self.actor, self.event.pk, {
            'request_id': str(uuid4()), 'action': 'start', 'expected_event_revision': self.event.revision,
            'expected_document_revisions': {'master': self.document.revision}})
        self.assertEqual(self.event.truck_challans.count(), 2)
        self.assertEqual(list(Asset.objects.values_list('quantity', flat=True)), [1]*5)

    def test_stale_or_changed_reviews_and_injected_failure_roll_back(self):
        before = document_data(self.document)
        for change in ({'expected_event_revision': 999}, {'expected_document_revision': 999},
                       {'expected_quantities': {str(self.line.pk): 7}}):
            with self.assertRaises(CommandError): self.correct(**change)
        with patch('core.unit_challan_quantities.ChallanRevision.objects.create', side_effect=RuntimeError('failure')):
            with self.assertRaises(RuntimeError): self.correct()
        self.document.refresh_from_db()
        self.assertEqual(document_data(self.document), before)
        self.assertEqual(ChallanRevision.objects.count(), 1); self.assertFalse(MovementReceipt.objects.exists())

    def test_issued_locked_audit_and_truck_workflows_are_never_rewritten(self):
        for field, value in (('state', 'issued'), ('provenance', 'reviewed_legacy_archive')):
            setattr(self.document, field, value); self.document.save()
            with self.assertRaises(CommandError): self.correct()
            setattr(self.document, field, 'draft' if field == 'state' else 'legacy_snapshot_at_first_save'); self.document.save()
        for field, value in (('is_audit', True), ('lifecycle_state', 'completed'), ('end_date', date(2020, 1, 1))):
            old = getattr(self.event, field); setattr(self.event, field, value); self.event.save()
            self.event.refresh_from_db()
            with self.assertRaises(CommandError): self.correct(expected_event_revision=self.event.revision)
            setattr(self.event, field, old); self.event.save()
        TruckChallan.objects.create(conference=self.event, truck_number=1)
        self.event.refresh_from_db()
        with self.assertRaises(CommandError): self.correct(expected_event_revision=self.event.revision)
        self.document.refresh_from_db(); self.assertEqual(self.document.lines.get(pk=self.line.pk).quantity, 8)

    def test_new_or_existing_draft_cannot_save_multiple_units_against_one_qr(self):
        for previous in (True, False):
            if not previous:
                self.event = Conference.objects.create(name='New unit draft')
                self.event.challan_assets.add(*self.assets)
                self.event.refresh_from_db()
            payload = self.payload() if previous else {
                'request_id': str(uuid4()), 'expected_revision': 0, 'expected_event_revision': self.event.revision,
                'lines': [{'id': str(uuid4()), 'asset_id': self.assets[0].pk, 'source_kind': 'owned',
                          'quantity': 8, 'unit_value': '10.00', 'snapshot': {'alias_name': 'Cable'}}]}
            with self.assertRaises(CommandError) as error: save_document(self.actor, self.event.pk, 'master', payload)
            self.assertEqual(error.exception.code, 'individual_challan_quantity_exceeds_one')

    def test_issued_history_remains_editable_with_reason_without_allowing_new_inflation(self):
        self.document.state = 'issued'; self.document.document_date = date.today(); self.document.save()
        payload = self.payload(correction_reason='Corrected text only')
        save_document(self.actor, self.event.pk, 'master', payload)
        self.document.refresh_from_db(); self.assertEqual(self.document.lines.get(pk=self.line.pk).quantity, 8)
        payload = self.payload(correction_reason='Invalid quantity increase'); payload['lines'][0]['quantity'] = 9
        with self.assertRaises(CommandError) as error: save_document(self.actor, self.event.pk, 'master', payload)
        self.assertEqual(error.exception.code, 'individual_challan_quantity_exceeds_one')

    def test_consumable_bulk_manual_and_supplier_ticket_quantities_are_preserved(self):
        consumable = Asset.objects.create(sku='TAPE', type='Consumables', quantity=1)
        bulk = Asset.objects.create(sku='BULK', quantity=1, quantity_tracking=True)
        owner = SubrentalCompany.objects.create(name='External supplier', inventory_mode='external_supplier')
        rental = Asset.objects.create(sku='SUPPLIER-CATALOGUE', quantity=1, subrental_company=owner)
        ticket = SubrentalTicket.objects.create(company=owner, conference=self.event)
        item = SubrentalTicketItem.objects.create(ticket=ticket, asset=rental, quantity=3)
        for index, asset in enumerate((consumable, bulk, None, rental)):
            ChallanLine.objects.create(document=self.document, asset=asset,
                source_kind='supplier' if asset == rental else 'owned' if asset else 'manual',
                ticket_item=item if asset == rental else None, supplier=owner if asset == rental else None,
                quantity=3, unit_value='1.00', position=5+index)
        self.document.history.filter(revision=1).update(snapshot=document_data(self.document))
        self.correct(); self.document.refresh_from_db()
        self.assertEqual(list(self.document.lines.filter(position__gte=5).values_list('quantity', flat=True)), [3]*4)

    def test_external_supplier_ticket_with_multiple_units_is_still_allowed(self):
        owner = SubrentalCompany.objects.create(name='External supplier', inventory_mode='external_supplier')
        rental = Asset.objects.create(sku='SUPPLIER-CATALOGUE', quantity=1, subrental_company=owner)
        event = Conference.objects.create(name='Supplier delivery')
        ticket = SubrentalTicket.objects.create(company=owner, conference=event)
        item = SubrentalTicketItem.objects.create(ticket=ticket, asset=rental, quantity=3)
        payload = {'request_id': str(uuid4()), 'expected_revision': 0, 'expected_event_revision': event.revision,
            'lines': [{'id': str(uuid4()), 'asset_id': rental.pk, 'supplier_id': owner.pk, 'ticket_item_id': item.pk,
                       'source_kind': 'supplier', 'quantity': 3, 'unit_value': '10.00', 'snapshot': {'alias_name': 'Rental'}}]}
        result = save_document(self.actor, event.pk, 'master', payload)
        self.assertEqual(result['document']['lines'][0]['quantity'], 3)
