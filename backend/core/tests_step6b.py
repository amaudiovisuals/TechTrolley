"""Shared warehouse ownership, source overlap and paper preservation contracts."""
import copy,uuid
from decimal import Decimal
from unittest import skipUnless
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from django.contrib.auth.models import User
from django.db import connection,close_old_connections
from django.db.models.deletion import ProtectedError
from django.test import TransactionTestCase
from .test_support import SnapshotTestCase
from rest_framework.test import APIClient
from .models import (Asset,Conference,SubrentalCompany,SubrentalTicket,SubrentalTicketItem,QuantityAllocation,
    ConsumableAllocation,MovementReceipt,CompanySettings,ChallanDocument,ChallanLine,ChallanRevision,Employee,StaffAllocation)
from .asset_commands import CommandError,execute_command
from .quantity_commands import execute_quantity_command
from .consumable_commands import execute_consumable_command
from .supplier_commands import execute_supplier_command
from .challan_documents import save_document,document_data
from .truck_manifests import execute_manifest_command
from .event_lifecycle import build_review
from .inventory_ownership import inventory_summary,warehouse_managed

class SharedWarehouseTests(SnapshotTestCase):
    def setUp(self):
        self.user=User.objects.create_user('shared-owner-admin');self.user.profile.role='admin';self.user.profile.save()
        self.client=APIClient();self.client.force_authenticate(self.user)
        self.owner=SubrentalCompany.objects.create(name='AM Audiovisuals',inventory_mode='shared_warehouse')
        self.external=SubrentalCompany.objects.create(name='External catalogue',inventory_mode='external_supplier')
        self.unknown=SubrentalCompany.objects.create(name='Unclassified catalogue')
        self.event=Conference.objects.create(name='Mixed-owner event');self.other=Conference.objects.create(name='Competing event')
        self.bulk=Asset.objects.create(sku='AM-CABLE-MASTER',alias_name='AM cable stock',quantity=10,type='Cable',subrental_company=self.owner)
        self.consumer=Asset.objects.create(sku='AM-CONSUMER-MASTER',alias_name='AM consumable stock',quantity=10,type='Consumables',subrental_company=self.owner)
        self.owned=Asset.objects.create(sku='PVT-DEVICE',alias_name='Pvt device')
        CompanySettings.objects.create(name='AM Audiovisuals Pvt Ltd')
    def quantity(self,action,qty=3,event=None,asset=None,physical=None):
        event=event or self.event;event.refresh_from_db()
        return execute_quantity_command(self.user,event.pk,{'request_id':str(uuid.uuid4()),'action':action,'expected_revision':event.revision,'items':[{'asset_id':(asset or self.bulk).pk,'quantity':qty}],**({'physical_asset_ids':physical} if physical else {})})
    def consume(self,action='save',qty=4,returned=None,confirmed=False,event=None,asset=None):
        event=event or self.event;event.refresh_from_db()
        body={'request_id':str(uuid.uuid4()),'action':action,'expected_revision':event.revision,'metadata':{},'items':[{'asset_id':(asset or self.consumer).pk,'requested':qty,'returned':returned,'confirmed':confirmed}]}
        return execute_consumable_command(self.user,event.pk,body)
    def line(self,asset=None,qty=1,kind=None,**fields):
        asset=asset or self.bulk
        return {'id':str(uuid.uuid4()),'asset_id':asset.pk,'ticket_item_id':None,'supplier_id':asset.subrental_company_id,'source_kind':kind or ('supplier' if asset.subrental_company_id else 'owned'),
            'snapshot':{'alias_name':asset.alias_name or asset.sku,'supplier_name':''},'quantity':qty,'unit_value':'12.50','position':0,**fields}
    def paper(self,lines,document=None,state='draft',reason=''):
        self.event.refresh_from_db()
        return save_document(self.user,self.event.pk,'master',{'request_id':str(uuid.uuid4()),'expected_revision':document['revision'] if document else 0,'expected_event_revision':self.event.revision,
            'lines':lines,'number':document['number'] if document else 'SHARED-PAPER','total_override':None,'document_date':'2026-10-14','state':state,'correction_reason':reason})['document']
    def manifest(self,action,**fields):
        self.event.refresh_from_db()
        return execute_manifest_command(self.user,self.event.pk,{'request_id':str(uuid.uuid4()),'action':action,'expected_event_revision':self.event.revision,
            'expected_document_revisions':{d.scope:d.revision for d in self.event.challan_documents.all()},'reason':'Reviewed mixed-owner truck distribution',**fields})
    def test_schema_defaults_do_not_guess_existing_company_classification(self):
        self.assertEqual(self.unknown.inventory_mode,'unreviewed');self.assertFalse(warehouse_managed(Asset(subrental_company=self.unknown)))
        self.assertTrue(warehouse_managed(self.bulk));self.assertTrue(warehouse_managed(self.owned))
        self.assertFalse(warehouse_managed(Asset(subrental_company=self.owner,is_temporary=True)))
    def test_company_create_and_metadata_patch_cannot_enable_shared_mode(self):
        for method,url,body in [('post','/api/subrental-companies/',{'name':'Unreviewed new company','inventory_mode':'shared_warehouse'}),('patch',f'/api/subrental-companies/{self.unknown.pk}/',{'inventory_mode':'shared_warehouse'})]:
            response=getattr(self.client,method)(url,body,format='json');self.assertEqual(response.status_code,400,response.data)
        self.unknown.refresh_from_db();self.assertEqual(self.unknown.inventory_mode,'unreviewed')
    def test_idle_inventory_owner_has_model_level_delete_protection(self):
        with self.assertRaises(ProtectedError):self.owner.delete()
        self.assertEqual(Asset.objects.count(),3)
    def test_shared_bulk_full_cycle_keeps_one_master_and_owner(self):
        for action in ('stage','dispatch','return','verify_return'):self.quantity(action,6)
        self.bulk.refresh_from_db();allocation=QuantityAllocation.objects.get()
        self.assertEqual((self.bulk.quantity,self.bulk.subrental_company_id,self.bulk.status),(10,self.owner.pk,'Available'))
        self.assertEqual((allocation.reserved,allocation.dispatched,allocation.awaiting_verification,allocation.verified_total),(0,0,0,6))
        self.assertEqual(Asset.objects.filter(sku='AM-CABLE-MASTER').count(),1)
    def test_shared_bulk_capacity_is_global_across_events(self):
        self.quantity('stage',8)
        with self.assertRaises(CommandError):self.quantity('stage',3,event=self.other)
        self.assertEqual(QuantityAllocation.objects.count(),1);self.assertEqual(MovementReceipt.objects.count(),1)
    def test_external_and_unreviewed_bulk_cannot_allocate_warehouse_stock(self):
        for company in (self.external,self.unknown):
            asset=Asset.objects.create(sku=str(uuid.uuid4()),quantity=10,subrental_company=company)
            with self.assertRaises(CommandError) as error:self.quantity('stage',asset=asset)
            self.assertEqual(error.exception.code,'supplier_inventory_classification_required')
        self.assertEqual(QuantityAllocation.objects.count(),0)
    def test_recovery_and_closing_balances_work_after_mode_change_but_new_dispatch_refuses(self):
        first=self.quantity('stage');self.owner.inventory_mode='external_supplier';self.owner.save()
        self.user.profile.role='accounts';self.user.profile.save()
        # Exact recovery is exercised by the original normalized request.
        replay=execute_quantity_command(self.user,self.event.pk,{'request_id':first['request_id'],'action':'stage','expected_revision':0,'items':[{'asset_id':self.bulk.pk,'quantity':3}]})
        self.assertTrue(replay['replayed']);self.user.profile.role='admin';self.user.profile.save()
        with self.assertRaises(CommandError):self.quantity('dispatch')
        self.quantity('unstage');self.assertEqual(QuantityAllocation.objects.get().reserved,0)
    def test_actual_return_and_verification_preserve_health_after_owner_mode_change(self):
        self.quantity('stage');self.quantity('dispatch');self.owner.inventory_mode='unreviewed';self.owner.save()
        self.bulk.flag='Missing';self.bulk.save();self.quantity('return');self.quantity('verify_return');self.bulk.refresh_from_db()
        self.assertEqual((self.bulk.quantity,self.bulk.flag,self.bulk.status),(10,'Missing','Missing'))
    def test_legacy_bulk_membership_and_duplicate_identity_stay_blocked(self):
        self.event.assets.add(self.bulk)
        with self.assertRaises(CommandError):self.quantity('stage')
        self.event.assets.clear();Asset.objects.create(sku=self.bulk.sku,quantity=10)
        with self.assertRaises(CommandError):self.quantity('stage')
        self.assertEqual(QuantityAllocation.objects.count(),0)
    def test_restricted_temporary_and_kit_bulk_sources_stay_blocked(self):
        for fields in ({'flag':'Missing'},{'is_temporary':True},{'parent_asset':self.owned}):
            asset=Asset.objects.create(sku=str(uuid.uuid4()),quantity=10,subrental_company=self.owner,**fields)
            with self.assertRaises(CommandError):self.quantity('stage',asset=asset)
    def test_lost_staff_foreign_key_still_blocks_new_quantity_and_consumer_use(self):
        employee=Employee.objects.create(name='Recorded custodian',employee_id='SHARED-CUSTODY',department='Ops',phone='-')
        for asset in (self.bulk,self.consumer):StaffAllocation.objects.create(asset=asset,employee=employee,provenance='legacy_unverified')
        self.assertIsNone(self.bulk.assigned_to_id)
        with self.assertRaises(CommandError):self.quantity('stage')
        with self.assertRaises(CommandError):self.consume()
        self.assertEqual(MovementReceipt.objects.count(),0)

    def test_old_supplier_orders_require_review_before_bulk_reservation(self):
        ticket=SubrentalTicket.objects.create(company=self.owner,conference=self.other);SubrentalTicketItem.objects.create(ticket=ticket,asset=self.bulk,quantity=2)
        with self.assertRaises(CommandError) as error:self.quantity('stage')
        self.assertEqual(error.exception.code,'supplier_ticket_quantity_requires_review')
    def test_mixed_owned_unit_dispatch_conflict_rolls_back_shared_bulk(self):
        self.quantity('stage');self.other.assets.add(self.owned);before=MovementReceipt.objects.count()
        with self.assertRaises(CommandError):self.quantity('dispatch',physical=[self.owned.pk])
        row=QuantityAllocation.objects.get();self.assertEqual((row.reserved,row.dispatched),(3,0));self.assertEqual(MovementReceipt.objects.count(),before)
    def test_shared_consumable_deduction_and_exact_retry_happen_once(self):
        self.consume();self.consume('dispatch');self.event.refresh_from_db()
        body={'request_id':str(uuid.uuid4()),'action':'settle','expected_revision':self.event.revision,'metadata':{},'items':[{'asset_id':self.consumer.pk,'requested':4,'returned':1,'confirmed':True}]}
        first=execute_consumable_command(self.user,self.event.pk,body);second=execute_consumable_command(self.user,self.event.pk,body)
        self.consumer.refresh_from_db();self.assertEqual(self.consumer.quantity,7);self.assertTrue(second['replayed']);self.assertEqual(first['conference'],second['conference'])
    def test_shared_consumable_capacity_is_global(self):
        self.consume(qty=8)
        with self.assertRaises(CommandError):self.consume(qty=3,event=self.other)
        self.consumer.refresh_from_db();self.assertEqual(self.consumer.quantity,10)
    def test_external_and_unreviewed_consumables_cannot_reserve(self):
        for company in (self.external,self.unknown):
            asset=Asset.objects.create(sku=str(uuid.uuid4()),type='Consumables',quantity=10,subrental_company=company)
            with self.assertRaises(CommandError):self.consume(asset=asset)
        self.assertEqual(ConsumableAllocation.objects.count(),0)
    def test_existing_consumer_reduction_and_settlement_are_not_trapped_by_mode_change(self):
        self.consume(qty=4);self.owner.inventory_mode='unreviewed';self.owner.save();self.consume(qty=2)
        with self.assertRaises(CommandError):self.consume('dispatch',qty=2)
        self.owner.inventory_mode='shared_warehouse';self.owner.save();self.consume('dispatch',qty=2)
        self.owner.inventory_mode='external_supplier';self.owner.save();self.consume('settle',qty=2,returned=0,confirmed=True)
        self.consumer.refresh_from_db();self.assertEqual(self.consumer.quantity,8)
    def test_shared_consumer_old_supplier_order_never_becomes_stock_balance(self):
        ticket=SubrentalTicket.objects.create(company=self.owner,conference=self.other);SubrentalTicketItem.objects.create(ticket=ticket,asset=self.consumer,quantity=2)
        with self.assertRaises(CommandError):self.consume()
    def test_new_shared_stock_ticket_would_duplicate_inventory_and_is_refused(self):
        ticket=SubrentalTicket.objects.create(company=self.owner,conference=self.event)
        with self.assertRaises(CommandError) as error:execute_supplier_command(self.user,{'request_id':str(uuid.uuid4()),'action':'add_item','conference_id':self.event.pk,'expected_revision':0,'reason':'Attempt duplicate warehouse source','data':{'ticket_id':ticket.pk,'asset_id':self.bulk.pk,'quantity':2,'rental_price':10}})
        self.assertEqual(error.exception.code,'shared_stock_uses_warehouse_movements');self.assertEqual(ticket.items.count(),0)
    def test_mixed_inventory_ticket_sources_are_rejected_atomically(self):
        self.quantity('stage',3);ticket=SubrentalTicket.objects.create(company=self.owner,conference=self.event);item=SubrentalTicketItem.objects.create(ticket=ticket,asset=self.bulk,quantity=2)
        before=MovementReceipt.objects.count()
        with self.assertRaises(CommandError) as error:self.paper([self.line(qty=3),self.line(qty=2,ticket_item_id=item.pk)])
        self.assertEqual(error.exception.code,'overlapping_inventory_and_supplier_ticket');self.assertEqual(ChallanDocument.objects.count(),0);self.assertEqual(MovementReceipt.objects.count(),before)
    def test_supplier_order_quantity_bounds_first_save_and_increases(self):
        asset=Asset.objects.create(sku='EXTERNAL-ORDER',subrental_company=self.external,quantity=10)
        ticket=SubrentalTicket.objects.create(company=self.external,conference=self.event);item=SubrentalTicketItem.objects.create(ticket=ticket,asset=asset,quantity=2)
        with self.assertRaises(CommandError):self.paper([self.line(asset,qty=3,ticket_item_id=item.pk)])
        document=self.paper([self.line(asset,qty=2,ticket_item_id=item.pk)]);lines=copy.deepcopy(document['lines']);lines[0]['quantity']=3
        with self.assertRaises(CommandError):self.paper(lines,document)
    def test_shared_raw_bulk_document_needs_real_quantity_ledger(self):
        self.event.challan_assets.add(self.bulk)
        with self.assertRaises(CommandError):self.paper([self.line(qty=2)])
    def test_fresh_owner_label_is_authoritative_and_saved_label_is_immutable(self):
        self.quantity('stage',2);line=self.line(qty=2);line['snapshot']['supplier_name']='Invented supplier';document=self.paper([line])
        self.assertEqual(document['lines'][0]['snapshot']['supplier_name'],self.owner.name)
        lines=copy.deepcopy(document['lines']);lines[0]['snapshot']['supplier_name']='Altered owner'
        with self.assertRaises(CommandError) as error:self.paper(lines,document)
        self.assertEqual(error.exception.code,'printed_owner_label_is_immutable')
    def test_supplier_rename_manual_edit_and_return_preserve_new_document_snapshot(self):
        self.quantity('stage',2);self.quantity('dispatch',2)
        manual={'id':str(uuid.uuid4()),'asset_id':None,'ticket_item_id':None,'supplier_id':None,'source_kind':'manual','snapshot':{'alias_name':'Manual packing note'},'quantity':2,'unit_value':'0.25','position':1}
        first=self.paper([self.line(qty=2),manual],state='issued');self.owner.name='Later name';self.owner.save();lines=copy.deepcopy(first['lines']);lines[1]['quantity']=3
        saved=self.paper(lines,first,state='issued',reason='Reviewed manual note correction');self.quantity('return',2);self.quantity('verify_return',2)
        self.assertEqual(saved['lines'][0]['snapshot']['supplier_name'],'AM Audiovisuals');self.assertEqual(saved['lines'][1]['quantity'],3)
        self.assertEqual(document_data(ChallanDocument.objects.get())['lines'],saved['lines']);self.assertEqual(saved['header']['owner_sections_version'],1)
        self.assertEqual(saved['header']['alias_grouping_version'],1)
    def test_older_layout_is_preserved_during_draft_save_and_issue(self):
        self.event.challan_assets.add(self.owned);doc=ChallanDocument.objects.create(conference=self.event,scope='master',number='OLD-FLAT',header={'name':'Old event'})
        first=self.paper([self.line(self.owned)],document_data(doc));self.assertNotIn('owner_sections_version',first['header'])
        issued=self.paper(first['lines'],first,state='issued');self.assertNotIn('owner_sections_version',issued['header'])
    def test_manifest_mixed_owner_totals_and_truck_headers_follow_frozen_master(self):
        self.quantity('stage',4);self.event.staged_assets.add(self.owned)
        document=self.paper([self.line(qty=4),self.line(self.owned)] ,state='issued');CompanySettings.objects.update(name='Later issuer brand')
        result=self.manifest('start');master=ChallanDocument.objects.get(scope='master');trucks=list(self.event.truck_challans.order_by('truck_number'))
        for doc in self.event.challan_documents.exclude(scope='master'):
            self.assertEqual(doc.header['company']['name'],'AM Audiovisuals Pvt Ltd');self.assertEqual(doc.header['owner_sections_version'],1)
            self.assertEqual(doc.header['alias_grouping_version'],1)
        line=master.lines.get(asset=self.bulk)
        self.manifest('move',from_truck_id=trucks[0].pk,to_truck_id=trucks[1].pk,items=[{'master_line_id':str(line.pk),'quantity':2}])
        quantities=list(ChallanLine.objects.filter(document__truck__in=trucks,asset=self.bulk).values_list('quantity',flat=True));self.assertEqual(sum(quantities),4)
        self.bulk.refresh_from_db();self.assertEqual(self.bulk.quantity,10)
    def test_mixed_shared_bulk_and_consumer_documents_use_event_counts_not_master_quantities(self):
        self.quantity('stage',3);self.consume(qty=4)
        document=self.paper([self.line(qty=3),self.line(self.consumer,qty=4)])
        self.assertEqual([r['quantity'] for r in document['lines']],[3,4]);self.assertEqual(self.bulk.quantity,10);self.assertEqual(self.consumer.quantity,10)
    def test_new_shared_quantity_completion_requires_real_returns(self):
        self.quantity('stage',2);self.quantity('dispatch',2)
        self.assertFalse(build_review(self.event)['can_complete']);self.quantity('return',2);self.quantity('verify_return',2)
        self.assertTrue(build_review(self.event)['can_complete'])
    def test_ownership_summary_is_pure_separates_rows_and_does_not_claim_units(self):
        Asset.objects.create(sku='EXTERNAL-COUNT',subrental_company=self.external,quantity=20);Asset.objects.create(sku='UNKNOWN-COUNT',subrental_company=self.unknown)
        Asset.objects.create(sku='TEMP-NOT-STOCK',subrental_company=self.owner,is_temporary=True,quantity=200)
        before=list(Asset.objects.values());one=self.client.get('/api/inventory-ownership/');two=self.client.get('/api/inventory-ownership/')
        self.assertEqual(one.status_code,200);self.assertEqual(one.data,two.data);self.assertEqual(list(Asset.objects.values()),before);self.assertEqual(MovementReceipt.objects.count(),0)
        self.assertEqual(one.data['totals'],{'main_owned':1,'shared_supplier_owned':2,'shared_warehouse':3,'external_supplier_catalog':1,'unreviewed_supplier_catalog':1,'all_permanent':5})
    def test_empty_ownership_summary_read_does_not_create_settings_or_stock(self):
        Asset.objects.all().delete();CompanySettings.objects.all().delete();data=inventory_summary();self.assertEqual(data['totals']['all_permanent'],0);self.assertEqual(CompanySettings.objects.count(),0)
    def test_ownership_summary_read_requires_authentication(self):
        self.client.force_authenticate(None);self.assertIn(self.client.get('/api/inventory-ownership/').status_code,(401,403))
    def test_warehouse_management_metadata_is_derived_and_not_stock_availability(self):
        self.bulk.flag='Missing';self.bulk.save();data=self.client.get(f'/api/assets/{self.bulk.pk}/').data
        self.assertTrue(data['warehouse_managed']);self.assertEqual(data['subrental_inventory_mode'],'shared_warehouse');self.assertEqual(data['status'],'Missing')
    def test_service_counts_use_real_condition_and_flags_not_an_unused_status(self):
        Asset.objects.create(sku='SERVICE-CONDITION',condition='Damaged')
        Asset.objects.create(sku='SERVICE-FLAG',flag='Required Service',subrental_company=self.owner)
        Asset.objects.create(sku='TEMP-SERVICE',condition='Damaged',is_temporary=True)
        self.assertEqual(self.client.get('/api/asset-stats/').data['maintenance'],2)

    def test_late_paper_failure_rolls_back_owner_sections_lines_and_receipt(self):
        self.quantity('stage',2);before=MovementReceipt.objects.count()
        with patch('core.challan_documents.replace_lines',side_effect=RuntimeError('Late failure')):
            with self.assertRaises(RuntimeError):self.paper([self.line(qty=2)])
        self.assertEqual(ChallanDocument.objects.count(),0);self.assertEqual(ChallanRevision.objects.count(),0);self.assertEqual(MovementReceipt.objects.count(),before)

@skipUnless(connection.vendor=='postgresql','Isolated PostgreSQL is required for shared-stock races')
class SharedWarehouseConcurrencyTests(TransactionTestCase):
    def setUp(self):
        self.user=User.objects.create_user('shared-race');self.user.profile.role='admin';self.user.profile.save()
        self.owner=SubrentalCompany.objects.create(name='Shared owner',inventory_mode='shared_warehouse');self.asset=Asset.objects.create(sku='SHARED-RACE',quantity=10,subrental_company=self.owner)
        self.events=[Conference.objects.create(name='Race A'),Conference.objects.create(name='Race B')]
    def test_competing_shared_reservations_use_one_master_mutex(self):
        barrier=Barrier(2)
        def run(event):
            close_old_connections();barrier.wait()
            try:return execute_quantity_command(User.objects.get(pk=self.user.pk),event.pk,{'request_id':str(uuid.uuid4()),'action':'stage','expected_revision':0,'items':[{'asset_id':self.asset.pk,'quantity':6}]})
            except CommandError as error:return error.code
            finally:close_old_connections()
        with ThreadPoolExecutor(2) as pool:results=list(pool.map(run,self.events))
        self.assertEqual(sum(isinstance(r,dict) for r in results),1);self.assertEqual(sum(r.reserved for r in QuantityAllocation.objects.all()),6)
    def test_same_shared_consumer_settlement_uuid_deducts_once(self):
        self.asset.type='Consumables';self.asset.save();event=self.events[0]
        for action in ('save','dispatch'):
            event.refresh_from_db();execute_consumable_command(self.user,event.pk,{'request_id':str(uuid.uuid4()),'action':action,'expected_revision':event.revision,'metadata':{},'items':[{'asset_id':self.asset.pk,'requested':4,'returned':None,'confirmed':False}]})
        event.refresh_from_db();body={'request_id':str(uuid.uuid4()),'action':'settle','expected_revision':event.revision,'metadata':{},'items':[{'asset_id':self.asset.pk,'requested':4,'returned':1,'confirmed':True}]};barrier=Barrier(2)
        def run(index):
            close_old_connections();barrier.wait()
            try:return execute_consumable_command(User.objects.get(pk=self.user.pk),event.pk,body)
            finally:close_old_connections()
        with ThreadPoolExecutor(2) as pool:results=list(pool.map(run,[0,1]))
        self.asset.refresh_from_db();self.assertEqual(self.asset.quantity,7);self.assertEqual(MovementReceipt.objects.filter(request_id=body['request_id']).count(),1)
