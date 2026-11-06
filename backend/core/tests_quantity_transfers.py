from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from threading import Barrier
from unittest import skipUnless
from uuid import uuid4
from django.contrib.auth.models import User
from django.db import connection,close_old_connections
from django.test import TransactionTestCase
from rest_framework.test import APIClient
from .test_support import SnapshotTestCase
from .asset_commands import execute_command,CommandError
from .quantity_commands import execute_quantity_command,outstanding
from .quantity_transfers import execute_transfer
from .event_lifecycle import build_review
from .models import Asset,Conference,CompanySettings,SubrentalCompany,QuantityAllocation,QuantityMovement,MovementReceipt,TruckChallan,TruckManifest
from .tests_program_deliveries import reviewed


class QuantityTransferTests(SnapshotTestCase):
    def setUp(self):
        self.user=User.objects.create_user('quantity-transfer-admin',is_staff=False);self.user.profile.role='admin';self.user.profile.save()
        self.client=APIClient();self.client.force_authenticate(self.user)
        CompanySettings.objects.create(name='Synthetic Pvt Ltd',address='Godown address')
        self.owner=SubrentalCompany.objects.create(name='AM shared owner',inventory_mode='shared_warehouse',address='AM address')
        self.asset=Asset.objects.create(sku='TRANSFER-CABLE',alias_name='Cable master',quantity=100,subrental_company=self.owner)
        self.source=Conference.objects.create(name='Program A',transport_address='Venue A\n'+'Full source address '*15)
        self.target=Conference.objects.create(name='Program B',transport_address='Venue B')
        self.move(self.source,'stage',20);self.move(self.source,'dispatch',20)

    def move(self,event,action,count):
        event.refresh_from_db()
        return execute_quantity_command(self.user,event.pk,{'request_id':str(uuid4()),'action':action,'expected_revision':event.revision,'items':[{'asset_id':self.asset.pk,'quantity':count}]})

    def payload(self,count=8,**updates):
        self.source.refresh_from_db();self.target.refresh_from_db()
        return {'request_id':str(uuid4()),'expected_revision':self.source.revision,'expected_target_revision':self.target.revision,
            'target_conference_id':self.target.pk,'items':[{'asset_id':self.asset.pk,'quantity':count}],'physical_asset_ids':[],**updates}

    def send(self,body=None):return execute_transfer(self.user,self.source.pk,body or self.payload())

    def test_twenty_becomes_twelve_plus_eight_without_returning_or_cloning_stock(self):
        before=outstanding(self.asset);result=self.send()
        source=QuantityAllocation.objects.get(conference=self.source,asset=self.asset);target=QuantityAllocation.objects.get(conference=self.target,asset=self.asset)
        self.assertEqual((source.dispatched,source.dispatched_total,source.transferred_out_total),(12,20,8))
        self.assertEqual((target.dispatched,target.dispatched_total,target.transferred_in_total),(8,8,8))
        self.asset.refresh_from_db();self.assertEqual(self.asset.quantity,100);self.assertEqual(outstanding(self.asset),before)
        self.assertEqual(Asset.objects.filter(sku=self.asset.sku).count(),1);self.assertEqual(result['transferred_quantity'],8)
        origin=result['target_conference']['dispatch_origins'][0]
        self.assertEqual(origin['address'],self.source.transport_address);self.assertEqual(origin['asset_quantities'],{str(self.asset.pk):8})
        rows=QuantityMovement.objects.filter(receipt__request_id=result['request_id']);self.assertEqual(rows.count(),2)
        self.assertEqual(set(rows.values_list('action',flat=True)),{'transfer_in','transfer_out'})

    def test_full_transfer_removes_source_membership_but_keeps_original_dispatch(self):
        doc=reviewed(self.source,[self.asset]);doc.lines.update(quantity=20);doc.state='issued';doc.save();header=deepcopy(doc.header)
        result=self.send(self.payload(20));self.assertNotIn(self.asset.pk,result['conference']['assets']);self.assertIn(self.asset.pk,result['conference']['challan_assets'])
        doc.refresh_from_db();self.assertEqual(doc.header,header);self.assertEqual(doc.lines.get().quantity,20)
        self.assertIn(self.asset.pk,result['target_conference']['assets']);self.assertEqual(result['target_conference']['quantity_allocations'][str(self.asset.pk)]['dispatched'],20)

    def test_target_existing_reservations_are_not_silently_unpacked(self):
        self.move(self.target,'stage',5);before=outstanding(self.asset);self.send()
        target=QuantityAllocation.objects.get(conference=self.target,asset=self.asset)
        self.assertEqual((target.reserved,target.dispatched),(5,8));self.assertEqual(outstanding(self.asset),before)
        self.assertIn(self.asset.pk,self.target.staged_assets.values_list('pk',flat=True))

    def test_retry_after_source_address_edit_recovers_same_receipt_without_moving_again(self):
        body=self.payload();first=self.send(body);self.source.transport_address='Later address';self.source.save()
        again=self.send(body);self.assertTrue(again['replayed']);self.assertEqual(first['target_conference'],again['target_conference'])
        self.assertEqual(QuantityMovement.objects.filter(action='transfer_in').count(),1)
        with self.assertRaisesMessage(CommandError,'request_id_reused'):self.send({**body,'items':[{'asset_id':self.asset.pk,'quantity':7}]})

    def test_invalid_amounts_duplicates_audit_closed_stale_and_self_transfers_are_atomic(self):
        for value in [0,-1,True,1.5,'8',21]:
            with self.assertRaises(CommandError):self.send(self.payload(value))
        body=self.payload()
        for change in [{'items':body['items']*2},{'physical_asset_ids':[self.asset.pk]},{'target_conference_id':self.source.pk}]:
            with self.assertRaises(CommandError):self.send({**body,'request_id':str(uuid4()),**change})
        for field,value in [('is_audit',True),('lifecycle_state','completed')]:
            setattr(self.target,field,value);self.target.save()
            with self.assertRaises(CommandError):self.send()
            setattr(self.target,field,False if field=='is_audit' else 'open');self.target.save()
        body=self.payload();self.target.name='New target metadata';self.target.save()
        with self.assertRaisesMessage(CommandError,'transfer_program_changed_reload_both_programs'):self.send(body)
        self.assertEqual(QuantityMovement.objects.filter(action='transfer_in').count(),0)
        self.assertEqual(QuantityAllocation.objects.get(conference=self.source,asset=self.asset).dispatched,20)

    def test_accounts_and_staff_technician_cannot_transfer(self):
        self.user.is_staff=True;self.user.save()
        for role in ['accounts','technician']:
            self.user.profile.role=role;self.user.profile.save()
            self.assertEqual(self.client.post(f'/api/conferences/{self.source.pk}/quantity-transfers/',self.payload(),format='json').status_code,403)

    def test_mixed_physical_conflict_rolls_back_bulk_and_receipts(self):
        unit=Asset.objects.create(sku='UNSTAGED-UNIT')
        count=MovementReceipt.objects.count()
        with self.assertRaises(CommandError):self.send(self.payload(physical_asset_ids=[unit.pk]))
        self.assertEqual(MovementReceipt.objects.count(),count);self.assertFalse(QuantityMovement.objects.filter(action='transfer_in').exists())
        self.assertEqual(QuantityAllocation.objects.get(conference=self.source,asset=self.asset).dispatched,20)

    def test_mixed_bulk_and_individual_items_commit_as_one_transfer(self):
        unit=Asset.objects.create(sku='PHYSICAL-UNIT')
        for action in ['stage','dispatch']:execute_command(self.user,self.source.pk,{'request_id':str(uuid4()),'action':action,'asset_ids':[unit.pk],'source':'fixture'})
        result=self.send(self.payload(physical_asset_ids=[unit.pk]));self.assertEqual(result['transferred_quantity'],9)
        self.assertIn(unit.pk,result['target_conference']['assets']);self.assertNotIn(unit.pk,result['conference']['assets'])
        self.assertEqual(result['conference']['quantity_allocations'][str(self.asset.pk)]['dispatched'],12)

    def test_forwarding_and_verified_returns_allow_both_programs_to_close(self):
        self.send();self.move(self.source,'return',12);self.move(self.source,'verify_return',12)
        self.move(self.target,'return',8);self.move(self.target,'verify_return',8)
        self.source.refresh_from_db();self.target.refresh_from_db()
        for event in [self.source,self.target]:self.assertEqual(build_review(event)['blockers'],[])
        incoming=QuantityMovement.objects.get(allocation__conference=self.target,action='transfer_in');incoming.context={};incoming.save()
        codes=[b['reason'] for b in build_review(self.source)['blockers']];self.assertIn('quantity_transfer_evidence_inconsistent',codes)

    def test_multiple_arrivals_issue_new_delivery_from_the_right_recorded_venue(self):
        self.move(self.target,'stage',10);self.move(self.target,'dispatch',10)
        doc=reviewed(self.target,[self.asset]);doc.lines.update(quantity=10)
        def issue(reference,quantity):
            url=f'/api/conferences/{self.target.pk}/deliveries/';preview=self.client.get(url+'preview/').data
            response=self.client.post(url,{'request_key':str(uuid4()),'source_hash':preview['source_hash'],'reference':reference,'delivery_date':'2026-11-06','truck_id':None,
                'rows':[{'key':preview['source']['rows'][0]['key'],'quantity':quantity}]},format='json')
            self.assertEqual(response.status_code,201,response.data);return response.data['snapshot']
        old=issue('First warehouse delivery',10);self.send();doc.lines.update(quantity=18)
        new=issue('Eight from venue A',8)
        for paper in [new['customer_document'],*new['supplier_documents']]:
            self.assertEqual(len(paper['dispatch_origins']),1);self.assertEqual(paper['dispatch_origins'][0]['address'],self.source.transport_address)
            self.assertEqual(paper['dispatch_origins'][0]['asset_quantities'],{str(self.asset.pk):8})
        self.assertEqual(old['customer_document']['dispatch_origins'][0]['address'],'Godown address')

    def test_two_hop_transfer_and_transfer_back_preserve_global_counts(self):
        self.send();third=Conference.objects.create(name='Program C',transport_address='Venue C')
        self.target.refresh_from_db()
        execute_transfer(self.user,self.target.pk,{'request_id':str(uuid4()),'expected_revision':self.target.revision,'expected_target_revision':third.revision,'target_conference_id':third.pk,'items':[{'asset_id':self.asset.pk,'quantity':3}],'physical_asset_ids':[]})
        self.assertEqual(outstanding(self.asset),20)
        third.refresh_from_db();self.source.refresh_from_db()
        execute_transfer(self.user,third.pk,{'request_id':str(uuid4()),'expected_revision':third.revision,'expected_target_revision':self.source.revision,'target_conference_id':self.source.pk,'items':[{'asset_id':self.asset.pk,'quantity':2}],'physical_asset_ids':[]})
        self.assertEqual(outstanding(self.asset),20);self.assertEqual(QuantityAllocation.objects.get(conference=self.source,asset=self.asset).dispatched,14)

    def test_legacy_truck_memberships_and_bad_balance_require_review(self):
        TruckChallan.objects.create(conference=self.target,truck_number=1)
        with self.assertRaisesMessage(CommandError,'quantity_trucks_require_coordinated_workflow'):self.send()
        self.target.truck_challans.all().delete()
        QuantityAllocation.objects.filter(conference=self.source,asset=self.asset).update(dispatched_total=19)
        with self.assertRaisesMessage(CommandError,'quantity_balance_requires_review'):self.send()

    def test_unchecked_units_do_not_prevent_transferring_other_on_site_units(self):
        self.move(self.source,'return',2);self.send()
        row=QuantityAllocation.objects.get(conference=self.source,asset=self.asset)
        self.assertEqual((row.dispatched,row.awaiting_verification,row.transferred_out_total),(10,2,8))

    def test_existing_managed_truck_documents_remain_historical(self):
        from .truck_manifests import execute_manifest_command
        doc=reviewed(self.source,[self.asset]);doc.lines.update(quantity=20)
        self.source.refresh_from_db()
        execute_manifest_command(self.user,self.source.pk,{'request_id':str(uuid4()),'action':'start',
            'expected_event_revision':self.source.revision,'expected_document_revisions':{'master':doc.revision}})
        before=list(self.source.challan_documents.order_by('scope').values('header','number','revision'))
        self.send()
        self.assertEqual(list(self.source.challan_documents.order_by('scope').values('header','number','revision')),before)
        self.assertEqual(list(doc.lines.values_list('quantity',flat=True)),[20])
        self.assertEqual(QuantityAllocation.objects.get(conference=self.source,asset=self.asset).dispatched,12)

    def test_inconsistent_target_membership_requires_review(self):
        self.move(self.target,'stage',2);self.target.staged_assets.remove(self.asset)
        with self.assertRaisesMessage(CommandError,'quantity_membership_requires_review'):self.send()
        self.assertFalse(QuantityMovement.objects.filter(action='transfer_in').exists())


@skipUnless(connection.vendor=='postgresql','PostgreSQL row-lock transfer acceptance')
class QuantityTransferConcurrencyTests(TransactionTestCase):
    setUp=QuantityTransferTests.setUp;move=QuantityTransferTests.move;payload=QuantityTransferTests.payload
    def race(self,same):
        body=self.payload(15);barrier=Barrier(2)
        def run(index):
            close_old_connections()
            try:
                user=User.objects.get(pk=self.user.pk);barrier.wait(timeout=10)
                try:return execute_transfer(user,self.source.pk,{**body,'request_id':body['request_id'] if same else str(uuid4())})['replayed']
                except CommandError as error:return error.code
            finally:close_old_connections()
        with ThreadPoolExecutor(max_workers=2) as pool:return list(pool.map(run,range(2)))
    def test_two_operators_cannot_forward_more_than_twenty(self):
        result=self.race(False);self.assertEqual(result.count(False),1)
        self.assertEqual(QuantityAllocation.objects.get(conference=self.source,asset=self.asset).dispatched,5)
        self.assertEqual(QuantityMovement.objects.filter(action='transfer_in').count(),1)
    def test_simultaneous_same_request_moves_once(self):
        self.assertEqual(sorted(self.race(True)),[False,True]);self.assertEqual(QuantityMovement.objects.filter(action='transfer_out').count(),1)
