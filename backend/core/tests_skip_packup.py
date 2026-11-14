from uuid import uuid4

from django.contrib.auth.models import User
from django.test import TestCase
from rest_framework.test import APIClient

from .asset_commands import execute_command
from .models import Asset, CompanySettings, Conference, MovementReceipt, PhysicalMovement
from .quantity_commands import execute_quantity_command
from .tests_program_deliveries import reviewed


class SkipPackupTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user('packup-admin')
        self.user.profile.role = 'admin'
        self.user.profile.save()
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        CompanySettings.objects.create(name='Warehouse', address='Godown road')
        self.event = Conference.objects.create(name='Show', transport_address='Venue road')
        self.target = Conference.objects.create(name='Next show', transport_address='Next road')
        self.unit = Asset.objects.create(sku='SKIP-UNIT')
        self.bulk = Asset.objects.create(sku='SKIP-BULK', quantity=10)
        self.url = f'/api/conferences/{self.event.pk}/skip-packup/'

    def physical(self, action, *assets, **extra):
        return execute_command(self.user, self.event.pk, {
            'request_id': str(uuid4()), 'action': action, 'asset_ids': [asset.pk for asset in assets], **extra,
        })

    def quantity(self, action, amount):
        self.event.refresh_from_db()
        return execute_quantity_command(self.user, self.event.pk, {
            'request_id': str(uuid4()), 'action': action, 'expected_revision': self.event.revision,
            'items': [{'asset_id': self.bulk.pk, 'quantity': amount}],
        })

    def review(self):
        response = self.client.get(self.url)
        self.assertEqual(response.status_code, 200, response.data)
        return response.data

    def payload(self, view):
        return {'request_id': str(uuid4()), 'reason': 'Packed together by the venue team',
                'expected_revision': view['revision'], 'review_hash': view['review_hash']}

    def skip(self, body):
        return self.client.post(self.url, body, format='json')

    def test_skip_records_mixed_returns_without_verifying_and_supports_return_trucks(self):
        linked = Asset.objects.create(sku='SKIP-LINK', parent_asset=self.unit)
        forwarded = Asset.objects.create(sku='SKIP-FORWARDED')
        self.physical('stage', self.unit, linked, forwarded)
        self.physical('dispatch', self.unit, linked, forwarded)
        self.physical('transfer', forwarded, target_conference_id=self.target.pk)
        self.quantity('stage', 6)
        self.quantity('dispatch', 6)
        self.quantity('return', 2)
        outward = reviewed(self.event, [self.unit, linked, forwarded, self.bulk])
        original = list(outward.lines.values())
        view = self.review()
        self.assertEqual(view['unit_count'], 6)
        body = self.payload(view)
        result = self.skip(body)
        self.assertEqual(result.status_code, 200, result.data)
        self.assertFalse(self.event.assets.exists())
        self.assertEqual(set(self.event.crosscheck_assets.values_list('pk', flat=True)),
                         {self.unit.pk, linked.pk, self.bulk.pk})
        self.assertTrue(self.target.assets.filter(pk=forwarded.pk).exists())
        allocation = self.event.quantity_allocations.get()
        self.assertEqual((allocation.dispatched, allocation.awaiting_verification, allocation.verified_total), (0, 6, 0))
        self.assertEqual(list(outward.lines.values()), original)
        self.assertEqual(PhysicalMovement.objects.filter(action='return', snapshot__source='admin-skip-packup').count(), 2)
        self.assertEqual(allocation.movements.get(context__source='admin-skip-packup').quantity, 4)
        receipt = MovementReceipt.objects.get(request_id=body['request_id'])
        self.assertEqual(receipt.result['reason'], body['reason'])
        self.assertEqual(len(receipt.result['child_request_ids']), 2)
        self.assertTrue(self.skip(body).data['replayed'])

        preview = self.client.get(f'/api/conferences/{self.event.pk}/return-deliveries/preview/').data
        self.assertEqual(sum(row['quantity'] for row in preview['source']['rows']), 8)
        self.assertNotIn(forwarded.pk, {row['asset_id'] for row in preview['source']['rows']})

    def test_failed_quantity_return_rolls_back_physical_moves_and_receipts(self):
        self.physical('stage', self.unit)
        self.physical('dispatch', self.unit)
        self.quantity('stage', 4)
        self.quantity('dispatch', 4)
        Asset.objects.create(sku='DUPLICATE', serial_number='ambiguous')
        Asset.objects.filter(pk=self.bulk.pk).update(serial_number='ambiguous')
        body = self.payload(self.review())
        receipts_before = MovementReceipt.objects.count()
        response = self.skip(body)
        self.assertEqual(response.status_code, 409, response.data)
        self.assertEqual(response.data['error'], 'duplicate_stock_identity_requires_review')
        self.assertEqual(MovementReceipt.objects.count(), receipts_before)
        self.assertEqual(set(self.event.assets.values_list('pk', flat=True)), {self.unit.pk, self.bulk.pk})
        self.assertFalse(self.event.crosscheck_assets.exists())
        self.assertFalse(PhysicalMovement.objects.filter(action='return').exists())

    def test_stale_review_and_blocked_items(self):
        self.physical('stage', self.unit)
        self.physical('dispatch', self.unit)
        view = self.review()
        Asset.objects.filter(pk=self.unit.pk).update(flag='Missing')
        response = self.skip(self.payload(view))
        self.assertEqual(response.data['error'], 'skip_packup_review_changed')
        blocked = self.review()
        self.assertEqual(blocked['blockers'][0]['asset_id'], self.unit.pk)
        self.assertEqual(self.skip(self.payload(blocked)).data['error'], 'skip_packup_review_blocked')
        self.assertTrue(self.event.assets.filter(pk=self.unit.pk).exists())

    def test_whole_packup_can_exceed_single_scan_batch_size(self):
        assets = Asset.objects.bulk_create([Asset(sku=f'PACK-{index}') for index in range(501)])
        self.event.assets.add(*(asset.pk for asset in assets))
        response = self.skip(self.payload(self.review()))
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['unit_count'], 501)
        self.assertEqual(self.event.crosscheck_assets.count(), 501)
        self.assertFalse(self.event.assets.exists())
        self.assertEqual(PhysicalMovement.objects.filter(action='return').count(), 501)

    def test_role_and_audit_restrictions(self):
        for role in ['boss', 'godown_incharge', 'accounts', 'technician']:
            user = User.objects.create_user(role)
            user.profile.role = role
            user.profile.save()
            self.client.force_authenticate(user)
            self.assertEqual(self.client.get(self.url).status_code, 403)
            self.assertEqual(self.skip({}).status_code, 403)
        self.client.force_authenticate(self.user)
        self.event.is_audit = True
        self.event.save(update_fields=['is_audit'])
        self.assertEqual(self.client.get(self.url).status_code, 400)
