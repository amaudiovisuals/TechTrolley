from copy import deepcopy
from datetime import date
from decimal import Decimal
from uuid import uuid4

from django.contrib.auth.models import User
from django.test import TestCase

from .asset_commands import execute_command
from .challan_documents import document_data
from .models import Asset, CompanySettings, Conference, SubrentalCompany
from .tests_program_deliveries import reviewed


class DraftDispatchTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_superuser('draft-dispatch-admin')
        CompanySettings.objects.create(name='Current issuer')
        self.event = Conference.objects.create(name='Later load', transport_address='Venue A')
        self.original = Asset.objects.create(sku='OLD', alias_name='Speaker')
        self.owner = SubrentalCompany.objects.create(name='Shared owner', inventory_mode='shared_warehouse')
        self.later = Asset.objects.create(sku='LED-BOX', alias_name='LED wall box P2', item_price='144000',
                                          subrental_company=self.owner)
        self.move('stage', self.event, self.original)
        self.move('dispatch', self.event, self.original)
        self.document = reviewed(self.event, [self.original])
        self.document.lines.update(unit_value='123.45')
        self.document.header['discount_60'] = True
        self.document.save()

    def move(self, action, event, *assets, **extra):
        return execute_command(self.user, event.pk, {
            'request_id': str(uuid4()), 'action': action, 'asset_ids': [asset.pk for asset in assets], **extra,
        })

    def test_later_load_adds_to_draft_once_with_owner_value_and_previous_rows_intact(self):
        before = document_data(self.document)
        self.move('stage', self.event, self.later)
        result = self.move('dispatch', self.event, self.later)
        self.document.refresh_from_db()
        lines = list(self.document.lines.order_by('position'))
        self.assertEqual([line.asset_id for line in lines], [self.original.pk, self.later.pk])
        self.assertEqual(lines[0].unit_value, Decimal('123.45'))
        self.assertEqual(lines[1].unit_value, Decimal('144000'))
        self.assertEqual(lines[1].snapshot['supplier_name'], 'Shared owner')
        self.assertEqual(self.document.revision, before['revision'] + 1)
        self.assertTrue(self.document.header['discount_60'])
        self.assertEqual(self.document.number, before['number'])
        self.assertEqual(len(result['conference']['challan_documents'][0]['lines']), 2)
        self.assertEqual(self.document.history.last().snapshot['lines'][0], before['lines'][0])
        self.move('dispatch', self.event, self.later)
        self.document.refresh_from_db()
        self.assertEqual(self.document.revision, before['revision'] + 1)
        self.assertEqual(self.document.lines.count(), 2)

    def test_issued_and_lapsed_drafts_keep_their_original_rows(self):
        self.document.state = 'issued'
        self.document.save()
        frozen = deepcopy(document_data(self.document))
        self.move('stage', self.event, self.later)
        self.move('dispatch', self.event, self.later)
        self.document.refresh_from_db()
        self.assertEqual(document_data(self.document), frozen)
        self.document.state = 'draft'
        self.document.save()
        self.event.end_date = date(2020, 1, 1)
        self.event.save()
        other = Asset.objects.create(sku='FURTHER')
        self.move('stage', self.event, other)
        self.move('dispatch', self.event, other)
        self.assertEqual(self.document.lines.count(), 1)

    def test_onward_transfer_updates_destination_draft_and_retains_source_original(self):
        target = Conference.objects.create(name='Second venue', transport_address='Venue B')
        target_doc = reviewed(target, [])
        frozen_source = deepcopy(document_data(self.document))
        self.move('transfer', self.event, self.original, target_conference_id=target.pk)
        target_doc.refresh_from_db()
        self.assertEqual(target_doc.lines.get().asset_id, self.original.pk)
        self.assertEqual(target_doc.header['dispatch_origins'][0]['address'], 'Venue A')
        self.document.refresh_from_db()
        self.assertEqual(document_data(self.document), frozen_source)
