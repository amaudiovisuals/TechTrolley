from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from decimal import Decimal
from threading import Barrier
from unittest import skipUnless
from uuid import uuid4
import io
import json
from pathlib import Path
import tempfile

from django.contrib.auth.models import User
from django.db import close_old_connections, connection
from django.test import TestCase, TransactionTestCase, override_settings
from django.core.management import call_command
from rest_framework.test import APIClient

from .asset_commands import execute_command, CommandError
from .challan_documents import capture_header
from .inventory_ownership import inventory_summary
from .led_cases import convert, prepare
from .models import Asset, ChallanDocument, ChallanLine, CompanySettings, Conference, LedCaseConversion, LedCasePanel, SubrentalCompany
from .serializers import AssetSerializer, ConferenceSerializer


@override_settings(LED_CASE_CONVERSION_WRITES_ENABLED=True, LED_CASE_CONVERSION_INSTANCE_ID='isolated-led-case-test')
class LedCaseTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user('led-admin', is_staff=False)
        self.user.profile.role = 'admin'; self.user.profile.save()
        self.client = APIClient(); self.client.force_authenticate(self.user)
        CompanySettings.objects.create(name='Original AM', address='Original godown')
        self.box = Asset.objects.create(sku='NORMAL-P2-BOX', qr_code='ORIGINAL-BOX-QR', alias_name='LED WALL BOX P2', item_price=Decimal('100.03'), purchased_date='2026-01-01')
        self.box.refresh_from_db()
        self.flexible = Asset.objects.create(sku='FLEXIBLE-BOX', alias_name='LED WALL P2 FLEXIBLE BOX')
        self.event = Conference.objects.create(name='New program', transport_address='Venue')
        self.owner = SubrentalCompany.objects.create(name='AM supplier', inventory_mode='shared_warehouse')

    def body(self, **changes):
        payload = {'request_id': str(uuid4()), 'review_hash': prepare(self.box)[0]['review_hash'], 'reason': 'Verified six normal P2 panels in the original box', 'confirmed_panel_count': 6}
        return {**payload, **changes}

    def conversion(self, body=None):
        result = convert(self.user, self.box.pk, body or self.body())
        return result, list(Asset.objects.filter(led_panel_record__case__source_asset=self.box).order_by('led_panel_record__slot'))

    def test_six_panels_replace_box_stock_preserving_identifiers_metadata_cost_and_owner(self):
        before = deepcopy(prepare(self.box)[1]['asset']); value = self.box.current_value
        result, panels = self.conversion(); self.box.refresh_from_db(); self.flexible.refresh_from_db()
        self.assertEqual(len(panels), 6); self.assertEqual(self.box.quantity, 1); self.assertEqual(self.box.stock_kind, 'led_case')
        after = prepare(self.box)[1]['asset']
        for field, original in before.items():
            if field not in {'stock_kind', 'custody_revision'}: self.assertEqual(after[field], original, field)
        self.assertEqual(sum(a.quantity for a in panels), 6); self.assertEqual(sum(a.item_price for a in panels), Decimal('100.03'))
        self.assertEqual(sum(a.current_value for a in panels), value)
        self.assertEqual({a.stock_kind for a in panels}, {'led_panel'}); self.assertEqual({a.subrental_company_id for a in panels}, {None})
        self.assertEqual(self.flexible.stock_kind, 'equipment'); self.assertEqual(inventory_summary()['totals']['all_permanent'], 7)
        self.assertEqual(AssetSerializer(self.box).data['quantity_available'], 0)
        self.assertEqual(len(AssetSerializer(self.box).data['led_case']['panels']), 6)
        self.assertEqual(LedCaseConversion.objects.get().actor_id, self.user.pk)

    def test_retries_and_different_requests_cannot_duplicate_panels(self):
        body = self.body(); first, _ = self.conversion(body)
        retry = convert(self.user, self.box.pk, body); self.assertTrue(retry['replayed'])
        self.assertEqual([p['asset_id'] for p in first['panels']], [p['asset_id'] for p in retry['panels']])
        with self.assertRaises(CommandError): convert(self.user, self.box.pk, {**body, 'request_id': str(uuid4())})
        self.assertEqual(LedCasePanel.objects.count(), 6)

    def test_stale_review_and_active_or_planned_custody_fail_without_partial_conversion(self):
        body = self.body(); self.box.description = 'Changed after review'; self.box.save()
        with self.assertRaisesMessage(CommandError, 'box_changed_reload_conversion_review'): convert(self.user, self.box.pk, body)
        for relation in ['assets', 'staged_assets', 'crosscheck_assets', 'requirements']:
            getattr(self.event, relation).add(self.box); review = prepare(self.box)[0]
            self.assertTrue(review['blockers'], relation); getattr(self.event, relation).clear()
        self.assertEqual(LedCaseConversion.objects.count(), 0); self.assertEqual(Asset.objects.count(), 2)

    def test_audit_observations_and_old_paper_membership_remain_box_records_not_new_panel_custody(self):
        old = Conference.objects.create(name='Historical program'); old.challan_assets.add(self.box)
        audit = Conference.objects.create(name='Audit observation', is_audit=True); audit.assets.add(self.box)
        document = ChallanDocument.objects.create(conference=old, scope='master', state='issued', number='OLD-BOX', header=capture_header(old))
        ChallanLine.objects.create(document=document, asset=self.box, source_kind='owned', quantity=1, unit_value=self.box.item_price,
            position=0, snapshot={'sku':self.box.sku,'alias_name':self.box.alias_name})
        header = deepcopy(document.header); line = deepcopy(document.lines.values().get())
        self.conversion(); document.refresh_from_db()
        self.assertEqual(document.header, header); self.assertEqual(document.lines.values().get(), line)
        serialized = ConferenceSerializer(old).data
        self.assertEqual(serialized['challan_assets_details'][0]['quantity'], 1)
        self.assertEqual(serialized['challan_assets_details'][0]['alias_name'], 'LED WALL BOX P2')
        self.assertEqual(list(audit.assets.values_list('pk',flat=True)), [self.box.pk])
        self.assertEqual(self.event.assets.count(), 0)

    def test_two_main_and_four_supplier_panels_dispatch_and_partial_return_without_counting_box(self):
        _, panels = self.conversion()
        Asset.objects.filter(pk__in=[a.pk for a in panels[2:]]).update(subrental_company=self.owner)
        ids = [a.pk for a in panels]
        for action in ['stage', 'dispatch']:
            result = execute_command(self.user,self.event.pk,{'request_id':str(uuid4()),'action':action,'asset_ids':ids,'source':'case-picker'})
        self.assertEqual(set(result['conference']['assets']), set(ids))
        self.assertNotIn(self.box.pk, result['conference']['assets'])
        from .tests_program_deliveries import reviewed
        reviewed(self.event, list(Asset.objects.filter(pk__in=ids).select_related('subrental_company')))
        preview = self.client.get(f'/api/conferences/{self.event.pk}/deliveries/preview/').data
        response = self.client.post(f'/api/conferences/{self.event.pk}/deliveries/', {
            'request_key':str(uuid4()), 'source_hash':preview['source_hash'], 'reference':'Six panels from one mixed-owner case',
            'delivery_date':'2026-11-06','truck_id':None,
            'rows':[{'key':row['key'],'name':row['name'],'quantity':1} for row in preview['source']['rows']]},format='json')
        self.assertEqual(response.status_code,201,response.data)
        self.assertEqual(sum(row['quantity'] for row in response.data['snapshot']['customer_document']['rows']),6)
        self.assertEqual(sum(row['quantity'] for row in response.data['snapshot']['supplier_documents'][0]['rows']),4)
        self.assertNotIn(self.box.pk,[row['asset_id'] for row in response.data['snapshot']['customer_document']['rows']])
        returned = execute_command(self.user,self.event.pk,{'request_id':str(uuid4()),'action':'return','asset_ids':ids[:2],'source':'case-picker'})
        self.assertEqual(len(returned['conference']['assets']), 4)
        verified = execute_command(self.user,self.event.pk,{'request_id':str(uuid4()),'action':'verify_return','asset_ids':ids[:2],'source':'case-picker'})
        self.assertEqual(verified['conference']['crosscheck_assets'], [])
        self.assertEqual(inventory_summary()['totals']['shared_supplier_owned'], 4)
        for action in ['stage','dispatch','return','require','audit_observe']:
            with self.assertRaisesMessage(CommandError,'select_led_case_panels_not_historical_box'):
                execute_command(self.user,self.event.pk,{'request_id':str(uuid4()),'action':action,'asset_ids':[self.box.pk],'source':'old-code'})

    def test_api_stock_lists_exports_offline_and_generic_writes_cannot_reintroduce_box(self):
        _, panels = self.conversion()
        normal = self.client.get('/api/assets/').data['results']; self.assertNotIn(self.box.pk, [a['id'] for a in normal])
        index = self.client.get('/api/assets/?all=true').data; self.assertIn(self.box.pk, [a['id'] for a in index])
        self.assertEqual(self.client.get('/api/asset-stats/').data['total'], 7)
        offline = self.client.get(f'/api/conferences/{self.event.pk}/offline-package/').data
        self.assertNotIn(self.box.pk, [a['id'] for a in offline['assets']])
        self.assertEqual(self.client.patch(f'/api/assets/{self.box.pk}/', {'quantity': 6}, format='json').status_code, 400)
        self.assertEqual(self.client.patch(f'/api/assets/{panels[0].pk}/', {'quantity': 6}, format='json').status_code, 400)
        self.assertEqual(self.client.delete(f'/api/assets/{self.box.pk}/').status_code, 409)
        self.assertEqual(self.client.delete(f'/api/assets/{panels[0].pk}/').status_code, 409)
        self.assertEqual(self.client.patch(f'/api/assets/{panels[0].pk}/', {'qr_code':'NEW-INDIVIDUAL-LABEL'}, format='json').status_code, 200)

    def test_flexible_duplicate_and_count_mismatch_do_not_convert(self):
        self.assertTrue(prepare(self.flexible)[0]['blockers'])
        with self.assertRaises(CommandError): convert(self.user,self.box.pk,self.body(confirmed_panel_count=5))
        Asset.objects.create(sku=f'LED-P2-{self.box.pk}-P1')
        self.assertIn('duplicate_box_or_generated_panel_identifier', prepare(self.box)[0]['blockers'])
        self.assertEqual(LedCasePanel.objects.count(), 0)

    @override_settings(LED_CASE_CONVERSION_WRITES_ENABLED=False)
    def test_disabled_gate_never_changes_stock(self):
        self.assertEqual(prepare(self.box)[0]['write_gate'], 'conversion_writes_disabled')
        with self.assertRaisesMessage(CommandError,'conversion_writes_disabled'): self.conversion()
        self.assertEqual(Asset.objects.count(), 2)

    def test_business_roles_not_staff_flag_control_conversion(self):
        self.user.is_staff = True; self.user.save()
        for role in ['technician','accounts','godown_incharge']:
            self.user.profile.role=role; self.user.profile.save()
            self.assertEqual(self.client.get(f'/api/assets/{self.box.pk}/led-case-conversion/').status_code,403)
            self.assertEqual(self.client.post(f'/api/assets/{self.box.pk}/led-case-conversion/', self.body(), format='json').status_code,403)
        self.assertEqual(LedCaseConversion.objects.count(),0)

    @override_settings(REVIEWED_OWNERSHIP_WRITES_ENABLED=True, OWNERSHIP_INSTANCE_ID='synthetic-led-owner-split')
    def test_six_cases_produce_36_panels_and_reviewed_32_plus_four_owner_split(self):
        from .ownership_commands import prepare_preview, execute_ownership
        boxes=[self.box]+[Asset.objects.create(sku=f'CASE-{number}',alias_name='LED WALL BOX P2') for number in range(5)]
        all_panels=[]
        for box in boxes:
            review,_=prepare(box)
            convert(self.user,box.pk,{'request_id':str(uuid4()),'review_hash':review['review_hash'],'reason':'Six physical normal P2 panels confirmed','confirmed_panel_count':6})
            all_panels.extend(LedCasePanel.objects.filter(case__source_asset=box).order_by('slot').values_list('asset_id',flat=True))
        target={'action':'change_owner','asset_ids':all_panels[-4:],'source_owner_id':None,'target_owner_id':self.owner.pk}
        preview=prepare_preview(target)[0];self.assertEqual(preview['plan']['blockers'],[])
        execute_ownership(self.user,{'request_id':str(uuid4()),'target':preview['target'],'database':preview['database'],
            'expected_snapshot_sha256':preview['snapshot_sha256'],'reason':'Reviewed two main plus four AM in sixth case',
            'evidence_reference':'synthetic ownership proof','confirmed':True,'warehouse_asset_ids':preview['plan']['warehouse_asset_ids']})
        self.assertEqual(Asset.objects.filter(stock_kind='led_panel',subrental_company=None).count(),32)
        self.assertEqual(Asset.objects.filter(stock_kind='led_panel',subrental_company=self.owner).count(),4)
        self.assertEqual(Asset.objects.filter(stock_kind='led_case').count(),6)
        self.assertEqual(LedCasePanel.objects.filter(case__source_asset=boxes[-1],asset__subrental_company=None).count(),2)


@override_settings(LED_CASE_CONVERSION_WRITES_ENABLED=True, LED_CASE_CONVERSION_INSTANCE_ID='isolated-led-command')
class LedCaseCommandTests(TransactionTestCase):
    setUp = LedCaseTests.setUp

    def test_private_preview_then_exact_apply_and_retry_preserve_six_panel_ids(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);preview=root/'preview.json'
            common={'source_id':self.box.pk,'expected_database':str(connection.settings_dict['NAME']),'expected_instance':'isolated-led-command','stdout':io.StringIO()}
            call_command('review_led_case', output=str(preview), **common)
            saved=json.loads(preview.read_text());self.assertFalse(saved['applied']);self.assertEqual(LedCasePanel.objects.count(),0)
            self.assertEqual(preview.stat().st_mode & 0o777,0o600)
            packet=root/'packet.json';packet.write_text(json.dumps({'source_id':self.box.pk,'command':{'request_id':str(uuid4()),
                'review_hash':saved['review']['review_hash'],'reason':'Exact reviewed six-panel conversion','confirmed_panel_count':6}}))
            call_command('review_led_case',apply=True,packet=str(packet),actor=self.user.pk,output=str(root/'result.json'),**common)
            call_command('review_led_case',apply=True,packet=str(packet),actor=self.user.pk,output=str(root/'retry.json'),**common)
            result=json.loads((root/'result.json').read_text());retry=json.loads((root/'retry.json').read_text())
            self.assertTrue(result['applied']);self.assertTrue(retry['replayed']);self.assertEqual(LedCasePanel.objects.count(),6)
            self.assertEqual([p['asset_id'] for p in result['panels']],[p['asset_id'] for p in retry['panels']])


@skipUnless(connection.vendor == 'postgresql', 'PostgreSQL conversion/movement row locks')
@override_settings(LED_CASE_CONVERSION_WRITES_ENABLED=True, LED_CASE_CONVERSION_INSTANCE_ID='isolated-led-race')
class LedCaseConcurrencyTests(TransactionTestCase):
    setUp = LedCaseTests.setUp
    body = LedCaseTests.body

    def test_two_simultaneous_conversions_create_only_six_panels(self):
        barrier=Barrier(2);body=self.body()
        def run(index):
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                try:
                    return convert(User.objects.get(pk=self.user.pk),self.box.pk,{**body,'request_id':str(uuid4())})['replayed']
                except CommandError as error:return error.code
            finally:close_old_connections()
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(run,range(2)))
        self.assertEqual(results.count(False),1);self.assertEqual(LedCasePanel.objects.count(),6)

    def test_dispatch_racing_conversion_cannot_dispatch_historical_box_and_create_panels(self):
        barrier=Barrier(2);body=self.body()
        execute_command(self.user,self.event.pk,{'request_id':str(uuid4()),'action':'stage','asset_ids':[self.box.pk],'source':'fixture'})
        # Stage is a blocker; testing a conflicting dispatch must never permit conversion.
        def run(action):
            close_old_connections()
            try:
                user=User.objects.get(pk=self.user.pk);barrier.wait(timeout=10)
                try:
                    return convert(user,self.box.pk,body) if action=='convert' else execute_command(user,self.event.pk,{'request_id':str(uuid4()),'action':'dispatch','asset_ids':[self.box.pk],'source':'race'})
                except CommandError as error:return error.code
            finally:close_old_connections()
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(run,['convert','dispatch']))
        self.assertEqual(LedCasePanel.objects.count(),0);self.assertEqual(self.event.assets.count(),1)
