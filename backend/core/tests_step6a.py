"""Supplier document saves and owner-preserving scan contracts on disposable DBs."""
import copy,uuid
from decimal import Decimal
from unittest.mock import patch
from unittest import skipUnless
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from django.contrib.auth.models import User
from django.db import connection,close_old_connections
from django.db.models.deletion import ProtectedError
from django.test import TestCase,TransactionTestCase
from rest_framework.test import APIClient
from .models import Asset,Conference,SubrentalCompany,SubrentalTicket,SubrentalTicketItem,SupplierChange,MovementReceipt,ChallanDocument,ChallanLine
from .supplier_commands import execute_supplier_command
from .asset_commands import execute_command,CommandError
from .challan_documents import save_document
from .event_lifecycle import build_review

class SupplierSaveTests(TestCase):
    def setUp(self):
        self.user=User.objects.create_user('supplier-admin');self.user.profile.role='admin';self.user.profile.save()
        self.client=APIClient();self.client.force_authenticate(self.user)
        self.event=Conference.objects.create(name='Shared warehouse event')
        self.company=SubrentalCompany.objects.create(name='AM Audiovisuals')
        self.other=SubrentalCompany.objects.create(name='External supplier')
        self.asset=Asset.objects.create(sku='AM-SHARED-DEVICE',alias_name='Shared supplier device',subrental_company=self.company)
        self.ticket=SubrentalTicket.objects.create(company=self.company,conference=self.event)
    def body(self,action='add_item',data=None):
        self.event.refresh_from_db()
        return {'request_id':str(uuid.uuid4()),'action':action,'conference_id':self.event.pk,'expected_revision':self.event.revision,'reason':'Reviewed supplier document change',
            'data':data if data is not None else {'ticket_id':self.ticket.pk,'asset_id':self.asset.pk,'quantity':1,'rental_price':'12.50'}}
    def save(self,action='add_item',data=None):return execute_supplier_command(self.user,self.body(action,data))
    def row(self):return SubrentalTicketItem.objects.create(ticket=self.ticket,asset=self.asset,quantity=1)
    def adhoc(self,**fields):return {'ticket_id':self.ticket.pk,'asset_id':None,'name':'Temporary cable pack','price':'25.00','depreciation':'10','quantity':5,'rental_price':'2.00',**fields}
    def test_item_save_has_protected_actor_history_and_no_physical_or_stock_changes(self):
        before=list(Asset.objects.values());rev=self.event.revision;result=self.save()
        self.assertEqual(result['operation'],'supplier_paperwork');self.assertEqual(result['ticket_id'],self.ticket.pk)
        history=SupplierChange.objects.get();self.assertEqual(history.receipt.actor,self.user);self.assertEqual(history.after['item']['quantity'],1)
        self.assertEqual(list(Asset.objects.values()),before);self.assertEqual(self.asset.physical_movements.count(),0)
        self.event.refresh_from_db();self.assertGreater(self.event.revision,rev)
    def test_exact_receipt_retry_survives_role_downgrade_and_later_event_change(self):
        body=self.body();first=execute_supplier_command(self.user,body);self.event.name='Later event';self.event.save()
        self.user.profile.role='accounts';self.user.profile.save();again=execute_supplier_command(self.user,body)
        self.assertTrue(again['replayed']);self.assertEqual(first['change_id'],again['change_id']);self.assertEqual(SubrentalTicketItem.objects.count(),1)
        with self.assertRaises(CommandError):execute_supplier_command(self.user,{**body,'reason':'Changed request body'})
    def test_stale_revision_rolls_back_receipt_and_new_temporary_inventory(self):
        body=self.body(data=self.adhoc());self.event.name='Changed';self.event.save()
        with self.assertRaises(CommandError):execute_supplier_command(self.user,body)
        self.assertEqual(Asset.objects.count(),1);self.assertEqual(MovementReceipt.objects.count(),0)
    def test_company_mismatch_and_main_stock_are_refused(self):
        for owner in (None,self.other):
            asset=Asset.objects.create(sku=str(uuid.uuid4()),subrental_company=owner)
            with self.assertRaises(CommandError):self.save(data={'ticket_id':self.ticket.pk,'asset_id':asset.pk,'quantity':1,'rental_price':0})
        self.assertEqual(SubrentalTicketItem.objects.count(),0)
    def test_duplicate_asset_on_one_ticket_is_refused_without_another_receipt(self):
        self.save();count=MovementReceipt.objects.count()
        with self.assertRaises(CommandError):self.save()
        self.assertEqual(SubrentalTicketItem.objects.count(),1);self.assertEqual(MovementReceipt.objects.count(),count)
    def test_invalid_quantities_and_nonfinite_or_negative_money_fail_without_rows(self):
        for fields in ({'quantity':0},{'quantity':-1},{'quantity':True},{'quantity':1.5},{'quantity':'2'},{'quantity':1000001},{'rental_price':'NaN'},{'rental_price':'Infinity'},{'rental_price':'-2'},{'rental_price':'1.001'},{'rental_price':True}):
            with self.assertRaises(CommandError):self.save(data={**self.body()['data'],**fields})
        self.assertEqual(MovementReceipt.objects.count(),0);self.assertEqual(SubrentalTicketItem.objects.count(),0)
    def test_invalid_names_prices_depreciation_and_fields_cannot_create_adhoc_asset(self):
        for fields in ({'name':None},{'name':[]},{'name':' '},{'name':'x'*201},{'price':'NaN'},{'depreciation':101},{'quantity':0},{'password':'must-not-store'}):
            with self.assertRaises(CommandError):self.save(data=self.adhoc(**fields))
        self.assertEqual(Asset.objects.count(),1);self.assertEqual(SupplierChange.objects.count(),0)
    def test_two_same_named_adhoc_rows_have_distinct_identifiers_and_exact_retry(self):
        body=self.body(data=self.adhoc());execute_supplier_command(self.user,body);execute_supplier_command(self.user,body);self.save(data=self.adhoc())
        assets=list(Asset.objects.filter(is_temporary=True));self.assertEqual(len(assets),2);self.assertNotEqual(assets[0].sku,assets[1].sku)
        self.assertTrue(all(a.qr_code==a.sku and a.quantity==5 for a in assets))
    def test_existing_temp_consumable_and_kit_sources_require_review(self):
        for fields in ({'is_temporary':True},{'type':'Consumables'},{'parent_asset':self.asset}):
            asset=Asset.objects.create(sku=str(uuid.uuid4()),subrental_company=self.company,**fields)
            with self.assertRaises(CommandError):self.save(data={'ticket_id':self.ticket.pk,'asset_id':asset.pk,'quantity':1,'rental_price':0})
    def test_document_quantity_is_bounded_by_master_without_decrementing_stock(self):
        self.asset.quantity=10;self.asset.save();self.save(data={**self.body()['data'],'quantity':8});row=SubrentalTicketItem.objects.get()
        self.save('edit_item',{'ticket_id':self.ticket.pk,'item_id':row.pk,'quantity':7,'rental_price':'3'})
        row.refresh_from_db();self.asset.refresh_from_db();self.assertEqual((row.quantity,self.asset.quantity),(7,10))
        with self.assertRaises(CommandError):self.save('edit_item',{'ticket_id':self.ticket.pk,'item_id':row.pk,'quantity':11,'rental_price':'3'})
    def test_paper_or_movement_history_blocks_quantity_rewriting_but_not_price_correction(self):
        self.asset.quantity=5;self.asset.save();row=self.row();doc=ChallanDocument.objects.create(conference=self.event,scope='master',number='SYNTHETIC',header={})
        line=ChallanLine.objects.create(document=doc,asset=self.asset,ticket_item=row,supplier=self.company,source_kind='supplier',snapshot={'supplier_name':'Original owner'},quantity=1,unit_value=7,position=0)
        with self.assertRaises(CommandError):self.save('edit_item',{'ticket_id':self.ticket.pk,'item_id':row.pk,'quantity':2,'rental_price':'3'})
        self.save('edit_item',{'ticket_id':self.ticket.pk,'item_id':row.pk,'quantity':1,'rental_price':'3'})
        line.refresh_from_db();self.assertEqual((line.quantity,line.unit_value,line.snapshot['supplier_name']),(1,Decimal('7'),'Original owner'))
    def test_actual_custody_blocks_ticket_quantity_edit(self):
        self.asset.quantity=5;self.asset.save();row=self.row();self.event.staged_assets.add(self.asset)
        with self.assertRaises(CommandError):self.save('edit_item',{'ticket_id':self.ticket.pk,'item_id':row.pk,'quantity':2,'rental_price':0})
    def test_ticket_and_item_context_cannot_be_swapped(self):
        row=self.row();other_event=Conference.objects.create(name='Other');other_ticket=SubrentalTicket.objects.create(conference=other_event,company=self.company)
        for action,data in [('add_item',{'ticket_id':other_ticket.pk,'asset_id':self.asset.pk,'quantity':1,'rental_price':0}),('edit_item',{'ticket_id':other_ticket.pk,'item_id':row.pk,'quantity':1,'rental_price':0})]:
            with self.assertRaises(CommandError):self.save(action,data)
    def test_custom_event_and_ticket_commit_once_and_roll_back_together(self):
        body={'request_id':str(uuid.uuid4()),'action':'create_custom_ticket','conference_id':None,'expected_revision':None,'reason':'Create temporary rental event','data':{'company_id':self.company.pk,'name':'Atomic custom event','available_from':'2026-10-15','available_till':'2026-10-16'}}
        with patch('core.supplier_commands.SupplierChange.objects.create',side_effect=RuntimeError('Late failure')):
            with self.assertRaises(RuntimeError):execute_supplier_command(self.user,body)
        self.assertEqual(Conference.objects.count(),1);self.assertEqual(MovementReceipt.objects.count(),0)
        first=execute_supplier_command(self.user,body);again=execute_supplier_command(self.user,body)
        self.assertEqual(first['ticket_id'],again['ticket_id']);self.assertEqual(Conference.objects.count(),2);self.assertEqual(SubrentalTicket.objects.count(),2)
    def test_date_ranges_and_custom_context_are_validated(self):
        for fields in ({'available_from':'2026-02-30'},{'available_till':'2020-01-01'},{'available_from':[]},{'company_id':True}):
            with self.assertRaises(CommandError):self.save('create_ticket',{'company_id':self.company.pk,'available_from':'2026-10-15','available_till':'2026-10-16',**fields})
    def test_ticket_date_edit_preserves_identity_and_uses_event_compare(self):
        self.save('edit_ticket',{'ticket_id':self.ticket.pk,'available_from':'2026-10-15','available_till':'2026-10-17'})
        self.ticket.refresh_from_db();self.assertEqual(self.ticket.company,self.company);self.assertEqual(str(self.ticket.available_till),'2026-10-17')
    def test_roles_audit_and_sealed_events_do_not_start_fresh_saves(self):
        for role in ('accounts','technician'):
            self.user.profile.role=role;self.user.profile.save()
            with self.assertRaises(CommandError):self.save()
        self.user.profile.role='godown_incharge';self.user.profile.save();self.save()
        for field,value in [('is_audit',True),('lifecycle_state','completed')]:
            Conference.objects.filter(pk=self.event.pk).update(**{field:value})
            with self.assertRaises(CommandError):self.save('create_ticket',{'company_id':self.company.pk,'available_from':None,'available_till':None})
    def test_late_failure_rolls_back_asset_item_history_revision_and_receipt(self):
        revision=self.event.revision
        with patch('core.supplier_commands.SupplierChange.objects.create',side_effect=RuntimeError('Synthetic history failure')):
            with self.assertRaises(RuntimeError):self.save(data=self.adhoc())
        self.event.refresh_from_db();self.assertEqual(self.event.revision,revision);self.assertEqual(Asset.objects.count(),1);self.assertEqual(SubrentalTicketItem.objects.count(),0);self.assertEqual(MovementReceipt.objects.count(),0)
    def test_legacy_mutation_routes_refuse_instead_of_silent_replacement(self):
        row=self.row()
        for method,url,body in [('post','/api/subrental-tickets/',{'company':self.company.pk,'conference':self.event.pk}),('post',f'/api/subrental-tickets/{self.ticket.pk}/add-item/',{}),('patch',f'/api/subrental-ticket-items/{row.pk}/',{'quantity':0}),('patch',f'/api/subrental-tickets/{self.ticket.pk}/',{'company':self.other.pk})]:
            response=getattr(self.client,method)(url,body,format='json');self.assertEqual(response.status_code,409,response.data)
        row.refresh_from_db();self.ticket.refresh_from_db();self.assertEqual(row.quantity,1);self.assertEqual(self.ticket.company,self.company)
    def test_supplier_inventory_and_protected_change_cannot_cascade_delete(self):
        self.assertEqual(self.client.delete(f'/api/subrental-companies/{self.company.pk}/').status_code,409)
        self.save()
        for obj in (self.company,self.ticket,SubrentalTicketItem.objects.get(),self.asset,SupplierChange.objects.get().receipt):
            with self.assertRaises(ProtectedError):obj.delete()
    def test_general_asset_owner_edit_is_blocked_and_keeps_identifiers(self):
        response=self.client.patch(f'/api/assets/{self.asset.pk}/',{'subrental_company':self.other.pk},format='json');self.assertEqual(response.status_code,400,response.data)
        self.asset.refresh_from_db();self.assertEqual(self.asset.subrental_company,self.company);self.assertEqual(self.asset.sku,'AM-SHARED-DEVICE')
    def test_scan_index_includes_idle_supplier_stock_and_keeps_owned_filter(self):
        owned=Asset.objects.create(sku='OWNED-DEVICE');temp=Asset.objects.create(sku='TICKET-ONLY',is_temporary=True,subrental_company=self.company)
        all_data=self.client.get('/api/assets/?all=true').data;self.assertEqual({r['id'] for r in all_data},{self.asset.pk,owned.pk})
        self.assertEqual(next(r for r in all_data if r['id']==self.asset.pk)['subrental_company_name'],'AM Audiovisuals')
        data=self.client.get('/api/assets/').data;rows=data.get('results',[]) if isinstance(data,dict) else data;self.assertEqual({r['id'] for r in rows},{owned.pk})
    def test_supplier_single_unit_uses_normal_physical_flow_and_snapshot_owner(self):
        for action in ('stage','dispatch'):
            execute_command(self.user,self.event.pk,{'request_id':str(uuid.uuid4()),'action':action,'asset_ids':[self.asset.pk]})
        self.asset.refresh_from_db();self.assertEqual(self.asset.status,'In Use');self.assertTrue(self.event.assets.filter(pk=self.asset.pk).exists())
        for action in ('return','verify_return'):execute_command(self.user,self.event.pk,{'request_id':str(uuid.uuid4()),'action':action,'asset_ids':[self.asset.pk]})
        self.asset.refresh_from_db();self.assertEqual(self.asset.status,'Available');self.assertEqual(self.asset.subrental_company,self.company)
    def test_scanned_supplier_and_manual_document_rows_survive_rename_edit_and_return(self):
        for action in ('stage','dispatch'):execute_command(self.user,self.event.pk,{'request_id':str(uuid.uuid4()),'action':action,'asset_ids':[self.asset.pk]})
        self.event.refresh_from_db()
        supplier_line={'id':str(uuid.uuid4()),'asset_id':self.asset.pk,'ticket_item_id':None,'supplier_id':self.company.pk,'source_kind':'supplier','snapshot':{'alias_name':'Original shared device','supplier_name':''},'quantity':1,'unit_value':'20.00','position':0}
        manual_line={'id':str(uuid.uuid4()),'asset_id':None,'ticket_item_id':None,'supplier_id':None,'source_kind':'manual','snapshot':{'alias_name':'Manual packing note'},'quantity':2,'unit_value':'5.00','position':1}
        body={'request_id':str(uuid.uuid4()),'expected_revision':0,'expected_event_revision':self.event.revision,'lines':[supplier_line,manual_line],'number':'SHARED-PAPER','total_override':None,'document_date':'2026-10-14','state':'draft','correction_reason':''}
        document=save_document(self.user,self.event.pk,'master',body)['document']
        self.assertEqual(document['lines'][0]['snapshot']['supplier_name'],'AM Audiovisuals')
        self.company.name='Later supplier name';self.company.save();lines=copy.deepcopy(document['lines']);lines[1]['quantity']=3;self.event.refresh_from_db()
        body.update(request_id=str(uuid.uuid4()),expected_revision=document['revision'],expected_event_revision=self.event.revision,lines=lines)
        updated=save_document(self.user,self.event.pk,'master',body)['document'];self.assertEqual(updated['lines'][0]['snapshot']['supplier_name'],'AM Audiovisuals');self.assertEqual(updated['lines'][1]['quantity'],3)
        for action in ('return','verify_return'):execute_command(self.user,self.event.pk,{'request_id':str(uuid.uuid4()),'action':action,'asset_ids':[self.asset.pk]})
        read=self.client.get(f'/api/conferences/{self.event.pk}/challan-documents/master/').data['document']
        self.assertEqual(read['lines'],updated['lines']);self.asset.refresh_from_db();self.assertEqual((self.asset.quantity,self.asset.status),(1,'Available'))

    def test_supplier_inventory_explicit_all_filter_includes_records_beyond_page_50(self):
        for number in range(51):Asset.objects.create(sku=f'OWNER-PAGE-{number}',subrental_company=self.company)
        page=self.client.get(f'/api/assets/?subrental_company_id={self.company.pk}').data
        self.assertEqual(len(page['results']),50);self.assertEqual(page['count'],52)
        all_rows=self.client.get(f'/api/assets/?all=true&subrental_company_id={self.company.pk}').data
        self.assertEqual(len(all_rows),52);self.assertTrue(all(row['subrental_company']==self.company.pk for row in all_rows))

    def test_ticket_edit_does_not_satisfy_return_or_completion_evidence(self):
        self.row();self.assertTrue(any(r['reason']=='legacy_supplier_obligation_requires_review' for r in build_review(self.event)['blockers']))
    def test_bad_uuid_missing_revision_extra_fields_and_wrong_types_never_start_write(self):
        for fields in ({'request_id':'bad'},{'expected_revision':None},{'expected_revision':True},{'reason':' '},{'action':[]},{'data':[]},{'password':'must-not-store'}):
            with self.assertRaises(CommandError):execute_supplier_command(self.user,{**self.body(),**fields})
        self.assertEqual(MovementReceipt.objects.count(),0)

@skipUnless(connection.vendor=='postgresql','PostgreSQL row-lock acceptance requires isolated PostgreSQL')
class SupplierConcurrencyTests(TransactionTestCase):
    def setUp(self):
        self.user=User.objects.create_user('supplier-race');self.user.profile.role='admin';self.user.profile.save()
        self.event=Conference.objects.create(name='Race event');self.company=SubrentalCompany.objects.create(name='Race supplier')
        self.asset=Asset.objects.create(sku='SUPPLIER-RACE',subrental_company=self.company);self.ticket=SubrentalTicket.objects.create(conference=self.event,company=self.company)
    def race(self,same=False):
        barrier=Barrier(2);request_id=str(uuid.uuid4())
        def run(index):
            close_old_connections();barrier.wait()
            try:
                return execute_supplier_command(User.objects.get(pk=self.user.pk),{'request_id':request_id if same else str(uuid.uuid4()),'action':'add_item','conference_id':self.event.pk,'expected_revision':0,'reason':'Concurrent documented supplier addition','data':{'ticket_id':self.ticket.pk,'asset_id':self.asset.pk,'quantity':1,'rental_price':0}})
            except CommandError as error:return error.code
            finally:close_old_connections()
        with ThreadPoolExecutor(2) as pool:return list(pool.map(run,[0,1]))
    def test_competing_item_saves_do_not_duplicate_or_overwrite(self):
        results=self.race();self.assertEqual(sum(isinstance(r,dict) for r in results),1);self.assertEqual(SubrentalTicketItem.objects.count(),1)
    def test_same_uuid_race_creates_one_change_and_one_receipt(self):
        self.race(same=True);self.assertEqual(SupplierChange.objects.count(),1);self.assertEqual(MovementReceipt.objects.count(),1)
