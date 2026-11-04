from unittest.mock import patch
from django.contrib.auth.models import User
from django.utils import timezone
from rest_framework.test import APIClient
from .test_support import SnapshotTestCase
from .models import Asset, Conference, SubrentalCompany, MovementReceipt


class OfflinePackageTests(SnapshotTestCase):
    def setUp(self):
        self.user = User.objects.create_user('offline-admin')
        self.user.profile.role = 'admin'; self.user.profile.save()
        self.client = APIClient(); self.client.force_authenticate(self.user)
        self.event = Conference.objects.create(name='Prepare me', billing_address='PRIVATE BILLING', contact_phone='PRIVATE PHONE')
        self.asset = Asset.objects.create(sku='UNIT', barcode='CODE', serial_number='SERIAL', item_price=999, description='PRIVATE DESCRIPTION')

    def get(self):
        return self.client.get(f'/api/conferences/{self.event.pk}/offline-package/')

    def test_minimal_snapshot_has_no_private_fields_and_makes_no_writes(self):
        self.event.staged_assets.add(self.asset)
        before = self.event.revision
        response = self.get(); self.assertEqual(response.status_code, 200)
        p = response.data
        self.assertEqual(set(p), {'schema','package_id','account_id','role','generated_at','expires_at','scope','event','assets'})
        self.assertEqual(set(p['event']), {'id','name','revision','lifecycle_state','staged_ids'})
        self.assertEqual(set(p['assets'][0]), {'id','sku','barcode','qr_code','serial_number','label','type','last_known_status','owner_label'})
        self.assertEqual(p['event']['staged_ids'], [self.asset.pk])
        for secret in ('PRIVATE', 'item_price', 'password', 'token', 'contact_phone'):
            self.assertNotIn(secret, response.content.decode())
        self.assertIn('no-store', response['Cache-Control'])
        self.event.refresh_from_db(); self.assertEqual(self.event.revision, before)
        self.assertEqual(MovementReceipt.objects.count(), 0)

    def test_roles_anonymous_and_unsupported_events_fail_closed(self):
        self.client.force_authenticate(None); self.assertEqual(self.get().status_code, 401)
        self.client.force_authenticate(self.user)
        for role in ('technician', 'accounts'):
            self.user.profile.role = role; self.user.profile.save(); self.assertEqual(self.get().status_code, 403)
        for role in ('admin', 'boss', 'godown_incharge'):
            self.user.profile.role = role; self.user.profile.save(); self.assertEqual(self.get().status_code, 200)
        for field, value in [('is_audit', True), ('lifecycle_state', 'completed'), ('lifecycle_state', 'archived')]:
            Conference.objects.filter(pk=self.event.pk).update(is_audit=False, lifecycle_state='open')
            Conference.objects.filter(pk=self.event.pk).update(**{field:value}); self.assertEqual(self.get().status_code, 409)

    def test_only_independent_physical_unit_stock_included(self):
        shared = SubrentalCompany.objects.create(name='Shared', inventory_mode='shared_warehouse')
        allowed = Asset.objects.create(sku='SHARED', subrental_company=shared)
        for mode in ('unreviewed','external_supplier'):
            c=SubrentalCompany.objects.create(name=mode, inventory_mode=mode);Asset.objects.create(sku=mode, subrental_company=c)
        for fields in ({'quantity':2}, {'quantity_tracking':True}, {'is_temporary':True}, {'type':'Consumables'}):
            Asset.objects.create(sku=str(fields), **fields)
        parent=Asset.objects.create(sku='KIT');Asset.objects.create(sku='CHILD',parent_asset=parent)
        self.assertEqual([a['id'] for a in self.get().data['assets']], [self.asset.pk,allowed.pk])

    def test_size_limit_and_missing_event_do_not_return_partial_packages(self):
        with patch('core.offline_packages.MAX_ASSETS', 0):
            response=self.get();self.assertEqual(response.status_code,409);self.assertNotIn('assets',response.data)
        self.assertEqual(self.client.get('/api/conferences/999999/offline-package/').status_code,404)

    def test_expiring_authentication_is_not_bypassed_and_validity_is_bounded(self):
        from rest_framework.authtoken.models import Token
        from datetime import timedelta, datetime
        self.client.force_authenticate(None)
        t=Token.objects.create(user=self.user);Token.objects.filter(pk=t.pk).update(created=timezone.now()-timedelta(hours=25))
        self.client.credentials(HTTP_AUTHORIZATION='Token '+t.key);self.assertEqual(self.get().status_code,401)
        self.client.force_authenticate(self.user);p=self.get().data
        self.assertEqual(datetime.fromisoformat(p['expires_at'])-datetime.fromisoformat(p['generated_at']),timedelta(hours=24))
