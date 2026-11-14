from copy import deepcopy
from uuid import uuid4

from django.contrib.auth.models import User
from django.test import TestCase
from rest_framework.test import APIClient

from .asset_commands import execute_command
from .models import Asset, Conference, MovementReceipt
from .tests_program_deliveries import reviewed


class DemoBillingTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_superuser('demo-admin')
        self.accounts = User.objects.create_user('demo-accounts')
        self.accounts.profile.role = 'accounts'
        self.accounts.profile.save()
        self.client = APIClient()
        self.client.force_authenticate(self.accounts)
        self.event = Conference.objects.create(name='Operational demo')
        self.url = f'/api/conferences/{self.event.pk}/'
        self.unit = Asset.objects.create(sku='DEMO-UNIT')

    def payload(self, value):
        self.event.refresh_from_db()
        return {'request_id': str(uuid4()), 'is_demo': value, 'expected_revision': self.event.revision}

    def mark(self, body):
        return self.client.post(self.url + 'demo-billing/', body, format='json')

    def test_demo_round_trip_keeps_custody_and_outward_paper(self):
        for action in ('stage', 'dispatch'):
            execute_command(self.admin, self.event.pk, {
                'request_id': str(uuid4()), 'action': action, 'asset_ids': [self.unit.pk],
            })
        document = reviewed(self.event, [self.unit])
        original = deepcopy(document.header)
        original_lines = list(document.lines.values())
        body = self.payload(True)
        result = self.mark(body)
        self.assertEqual(result.status_code, 200, result.data)
        current = result.data['conference']
        self.assertTrue(current['is_demo'])
        self.assertFalse(current['is_invoiced'])
        self.assertFalse(current['is_audit'])
        self.assertEqual(current['assets'], [self.unit.pk])
        self.assertEqual(self.mark(body).data['conference']['revision'], current['revision'])
        receipt = MovementReceipt.objects.get(actor=self.accounts, request_id=body['request_id'])
        self.assertEqual(receipt.result['before'], {'is_demo': False, 'is_invoiced': False})
        self.assertEqual(receipt.result['after'], {'is_demo': True, 'is_invoiced': False})
        denied = self.client.patch(self.url, {'is_invoiced': True, 'expected_revision': current['revision']}, format='json')
        self.assertEqual(denied.status_code, 400)
        self.assertTrue(self.client.get(self.url).data['is_demo'])
        restored = self.mark(self.payload(False)).data['conference']
        self.assertFalse(restored['is_demo'])
        self.assertFalse(restored['is_invoiced'])
        self.assertEqual(list(document.lines.values()), original_lines)
        document.refresh_from_db()
        self.assertEqual(document.header, original)

    def test_invoiced_program_keeps_billing_history_and_stale_revision_is_rejected(self):
        stale = self.payload(True)
        self.event.is_invoiced = True
        self.event.save(update_fields=['is_invoiced'])
        self.assertEqual(self.mark(stale).data['error'], 'document_changed')
        self.assertEqual(self.mark(self.payload(True)).data['error'], 'demo_billing_already_invoiced')
        self.event.refresh_from_db()
        self.assertTrue(self.event.is_invoiced)
        self.assertFalse(self.event.is_demo)

    def test_restrict_roles_and_direct_edits(self):
        user = User.objects.create_user('demo-godown')
        user.profile.role = 'godown_incharge'
        user.profile.save()
        self.client.force_authenticate(user)
        self.assertEqual(self.mark(self.payload(True)).status_code, 403)
        self.client.force_authenticate(self.admin)
        direct = self.client.patch(self.url, {'is_demo': True, 'expected_revision': self.event.revision}, format='json')
        self.assertEqual(direct.status_code, 400)
        self.assertEqual(self.mark(self.payload(True)).status_code, 200)
        self.assertEqual(self.mark({**self.payload(False), 'name': 'Changed'}).status_code, 400)
