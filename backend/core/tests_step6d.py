"""External obligation and closure contracts, explicit disposable test settings."""
import copy, uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest import skipUnless
from unittest.mock import patch
from django.contrib.auth.models import User
from django.db import connection, close_old_connections, transaction, IntegrityError
from django.db.models.deletion import ProtectedError
from django.test import TransactionTestCase
from .test_support import SnapshotTestCase
from rest_framework.test import APIClient
from .models import (Asset, Conference, CompanySettings, SubrentalCompany, SubrentalTicket, SubrentalTicketItem,
                     SupplierBalance, SupplierMovement, SupplierChange, MovementReceipt, ChallanDocument, ChallanLine)
from .supplier_commands import execute_supplier_command
from .supplier_balances import balance_data, consistent
from .asset_commands import CommandError, execute_command
from .event_lifecycle import build_review, execute_lifecycle_command
from .challan_documents import save_document

class SupplierBalanceTests(SnapshotTestCase):
    def setUp(self):
        self.user=User.objects.create_user('rental-admin');self.user.profile.role='admin';self.user.profile.save()
        self.client=APIClient();self.client.force_authenticate(self.user)
        self.company=SubrentalCompany.objects.create(name='External supplier',inventory_mode='external_supplier')
        self.event=Conference.objects.create(name='Rental event');self.other=Conference.objects.create(name='Other rental event')
        self.asset=Asset.objects.create(sku='EXTERNAL-CATALOGUE',alias_name='Rental speaker',quantity=10,subrental_company=self.company)
        self.ticket=SubrentalTicket.objects.create(company=self.company,conference=self.event)
        CompanySettings.objects.create(name='Synthetic issuer')
    def order(self,qty=5,event=None):
        event=event or self.event
        ticket=self.ticket if event==self.event else SubrentalTicket.objects.create(company=self.company,conference=event)
        event.refresh_from_db()
        execute_supplier_command(self.user,{'request_id':str(uuid.uuid4()),'action':'add_item','conference_id':event.pk,'expected_revision':event.revision,
            'reason':'Reviewed supplier order','data':{'ticket_id':ticket.pk,'asset_id':self.asset.pk,'quantity':qty,'rental_price':'12.50'}})
        return ticket.items.get()
    def packet(self,item,action,qty=1,**fields):
        event=item.ticket.conference;event.refresh_from_db();balance=SupplierBalance.objects.filter(item=item).first()
        data={'ticket_id':item.ticket_id,'item_id':item.pk,'expected_balance_revision':balance.revision if balance else None,
              'evidence_reference':'synthetic supplier note','confirmed':True,**({'received':0,'returned':0,'cancelled':0} if action=='review_supplier_opening' else {'quantity':qty}),**fields}
        return {'request_id':str(uuid.uuid4()),'action':action,'conference_id':event.pk,'expected_revision':event.revision,'reason':'Checked supplier movement','data':data}
    def move(self,item,action,qty=1,**fields):return execute_supplier_command(self.user,self.packet(item,action,qty,**fields))
    def test_new_order_creates_zero_received_proven_balance(self):
        item=self.order();self.assertEqual(balance_data(item)['pending_receipt'],5);self.assertEqual(balance_data(item)['received'],0)
        self.assertFalse(balance_data(item)['closed']);self.assertEqual(SupplierMovement.objects.count(),0)
    def test_partial_receipt_return_and_cancellation_close_without_mutating_stock(self):
        item=self.order();before=Asset.objects.values().get(pk=self.asset.pk)
        self.move(item,'supplier_receive',3);self.move(item,'supplier_return',2);self.move(item,'supplier_cancel',2)
        self.assertEqual(balance_data(item)['with_us'],1);self.assertFalse(build_review(self.event)['can_complete'])
        self.move(item,'supplier_return',1);self.assertTrue(balance_data(item)['closed']);self.assertTrue(build_review(self.event)['can_complete'])
        self.assertEqual(before,Asset.objects.values().get(pk=self.asset.pk));self.assertEqual(item.quantity,5)
    def test_event_completion_uses_verified_supplier_balance_and_preserves_rows(self):
        item=self.order();self.move(item,'supplier_cancel',5);self.event.refresh_from_db();review=build_review(self.event)
        result=execute_lifecycle_command(self.user,self.event.pk,{'request_id':str(uuid.uuid4()),'action':'complete','expected_revision':self.event.revision,
            'expected_snapshot_sha256':review['snapshot_sha256'],'reason':'All rental obligations closed','confirmed':True})
        self.event.refresh_from_db();self.assertEqual(self.event.lifecycle_state,'completed');self.assertTrue(SubrentalTicketItem.objects.filter(pk=item.pk).exists())
    def test_cannot_return_unreceived_or_cancel_received_or_over_receive(self):
        item=self.order();self.move(item,'supplier_receive',3);before=balance_data(item)
        for action,quantity in [('supplier_return',4),('supplier_cancel',3),('supplier_receive',3)]:
            with self.assertRaises(CommandError):self.move(item,action,quantity)
            self.assertEqual(balance_data(item),before)
    def test_full_cancellation_releases_declared_catalogue_capacity(self):
        item=self.order(8)
        with self.assertRaises(CommandError):self.order(3,self.other)
        self.move(item,'supplier_cancel',3);new=self.order(3,self.other);self.assertEqual(new.quantity,3)
        self.assertEqual(Asset.objects.get(pk=self.asset.pk).quantity,10)
    def test_partial_supplier_return_releases_capacity_but_does_not_reopen_receipt(self):
        item=self.order(8);self.move(item,'supplier_receive',8);self.move(item,'supplier_return',3)
        self.order(5,self.other)
        with self.assertRaises(CommandError):self.move(item,'supplier_receive',1)
    def test_catalogue_capacity_cannot_be_reduced_below_unresolved_orders(self):
        self.order(8);response=self.client.patch(f'/api/assets/{self.asset.pk}/',{'quantity':7},format='json')
        self.assertEqual(response.status_code,400);self.asset.refresh_from_db();self.assertEqual(self.asset.quantity,10)
        SubrentalTicketItem.objects.create(ticket=self.ticket,asset=self.asset,quantity=0)
        response=self.client.patch(f'/api/assets/{self.asset.pk}/',{'quantity':9},format='json')
        self.assertEqual(response.status_code,400);self.asset.refresh_from_db();self.assertEqual(self.asset.quantity,10)
    def test_exact_retry_after_role_downgrade_and_event_seal_does_not_repeat_movement(self):
        item=self.order();packet=self.packet(item,'supplier_receive',2);first=execute_supplier_command(self.user,packet)
        Conference.objects.filter(pk=self.event.pk).update(lifecycle_state='completed');self.user.profile.role='accounts';self.user.profile.save()
        replay=execute_supplier_command(self.user,packet);self.assertTrue(replay['replayed']);self.assertEqual(replay['change_id'],first['change_id'])
        self.assertEqual(balance_data(item)['received'],2);self.assertEqual(SupplierMovement.objects.count(),1)
        self.assertNotIn('asset_states',replay)
    def test_changed_uuid_body_and_stale_event_or_balance_revision_refuse(self):
        item=self.order();packet=self.packet(item,'supplier_receive',2);execute_supplier_command(self.user,packet)
        with self.assertRaises(CommandError):execute_supplier_command(self.user,{**packet,'reason':'changed'})
        with self.assertRaises(CommandError):execute_supplier_command(self.user,{**packet,'request_id':str(uuid.uuid4())})
        packet=self.packet(item,'supplier_return');packet['data']['expected_balance_revision']=0
        with self.assertRaises(CommandError):execute_supplier_command(self.user,packet)
        self.assertEqual(SupplierMovement.objects.count(),1)
    def test_legacy_order_is_not_automatically_adopted_or_zeroed(self):
        item=SubrentalTicketItem.objects.create(ticket=self.ticket,asset=self.asset,quantity=5)
        self.assertEqual(balance_data(item),{'state':'opening_review_required'})
        self.assertIn('legacy_supplier_obligation_requires_review',[b['reason'] for b in build_review(self.event)['blockers']])
        with self.assertRaises(CommandError):self.move(item,'supplier_cancel',5)
        self.assertEqual(SupplierBalance.objects.count(),0)
    def test_reviewed_legacy_opening_is_admin_only_and_records_unknown_original_dates(self):
        item=SubrentalTicketItem.objects.create(ticket=self.ticket,asset=self.asset,quantity=5)
        packet=self.packet(item,'review_supplier_opening',received=3,returned=1,cancelled=2)
        self.user.profile.role='godown_incharge';self.user.profile.save()
        with self.assertRaises(CommandError):execute_supplier_command(self.user,packet)
        self.user.profile.role='admin';self.user.profile.save();execute_supplier_command(self.user,packet)
        self.assertEqual(balance_data(item)['with_us'],2);self.assertIsNone(SupplierMovement.objects.get().source_snapshot['original_movement_dates'])
        with self.assertRaises(CommandError):self.move(item,'review_supplier_opening',received=3,returned=1,cancelled=2)
    def test_legacy_opening_impossible_counts_are_rejected_atomically(self):
        item=SubrentalTicketItem.objects.create(ticket=self.ticket,asset=self.asset,quantity=5)
        for fields in ({'received':6},{'returned':1},{'received':4,'cancelled':2}):
            with self.assertRaises(CommandError):self.move(item,'review_supplier_opening',**fields)
        self.assertEqual(SupplierBalance.objects.count(),0);self.assertEqual(MovementReceipt.objects.count(),0)
    def test_strict_quantities_confirmation_evidence_and_context(self):
        item=self.order()
        for fields in ({'quantity':1.5},{'quantity':True},{'quantity':0},{'quantity':'2'},{'confirmed':1},{'evidence_reference':''},{'item_id':True},{'expected_balance_revision':True}):
            packet=self.packet(item,'supplier_receive');packet['data'].update(fields)
            with self.assertRaises(CommandError):execute_supplier_command(self.user,packet)
        packet=self.packet(item,'supplier_receive');packet['conference_id']=self.other.pk
        with self.assertRaises(CommandError):execute_supplier_command(self.user,packet)
        self.assertEqual(SupplierMovement.objects.count(),0)
    def test_wrong_owner_shared_stock_and_warehouse_hold_are_refused(self):
        item=self.order();self.company.inventory_mode='shared_warehouse';self.company.save()
        with self.assertRaises(CommandError):self.move(item,'supplier_receive')
        self.company.inventory_mode='external_supplier';self.company.save();self.event.assets.add(self.asset)
        with self.assertRaises(CommandError):self.move(item,'supplier_receive')
        self.event.assets.clear();self.asset.subrental_company=None;self.asset.save()
        with self.assertRaises(CommandError):self.move(item,'supplier_receive')
    def test_external_catalogue_does_not_use_ordinary_warehouse_scan(self):
        self.asset.quantity=1;self.asset.save()
        with self.assertRaises(CommandError) as caught:execute_command(self.user,self.event.pk,{'request_id':str(uuid.uuid4()),'action':'stage','asset_ids':[self.asset.pk]})
        self.assertEqual(caught.exception.code,'external_rental_uses_supplier_balance')
    def test_missing_or_unresolved_physical_history_cannot_be_received_as_external(self):
        from .models import PhysicalMovement
        item=self.order()
        self.asset.flag='Missing';self.asset.save()
        with self.assertRaises(CommandError):self.move(item,'supplier_receive')
        self.asset.flag='';self.asset.save()
        receipt=MovementReceipt.objects.create(actor=self.user,request_id=uuid.uuid4(),payload_hash='synthetic-dispatch')
        PhysicalMovement.objects.create(asset=self.asset,conference=self.other,receipt=receipt,action='dispatch',snapshot={})
        # No old M2M membership remains, but recorded custody still needs review.
        with self.assertRaises(CommandError):self.move(item,'supplier_receive')
        self.assertEqual(SupplierMovement.objects.count(),0)
    def test_received_order_quantity_is_immutable_but_price_correction_keeps_balances(self):
        item=self.order();self.move(item,'supplier_receive',2);self.event.refresh_from_db()
        payload={'request_id':str(uuid.uuid4()),'action':'edit_item','conference_id':self.event.pk,'expected_revision':self.event.revision,'reason':'Correct price','data':{'ticket_id':self.ticket.pk,'item_id':item.pk,'quantity':5,'rental_price':'15.00'}}
        execute_supplier_command(self.user,payload);self.assertEqual(balance_data(item)['received'],2)
        self.event.refresh_from_db();payload['request_id']=str(uuid.uuid4());payload['expected_revision']=self.event.revision;payload['data']['quantity']=4
        with self.assertRaises(CommandError):execute_supplier_command(self.user,payload)
    def test_unreceived_order_edit_updates_order_proof_and_epoch(self):
        item=self.order();self.event.refresh_from_db()
        execute_supplier_command(self.user,{'request_id':str(uuid.uuid4()),'action':'edit_item','conference_id':self.event.pk,'expected_revision':self.event.revision,'reason':'Correct planned order','data':{'ticket_id':self.ticket.pk,'item_id':item.pk,'quantity':4,'rental_price':0}})
        item.refresh_from_db();self.assertEqual(balance_data(item)['pending_receipt'],4);self.move(item,'supplier_receive',4)
        self.assertEqual(balance_data(item)['received'],4)
    def test_corrupt_balance_or_missing_movement_evidence_cannot_complete_or_mutate(self):
        item=self.order();SupplierBalance.objects.filter(item=item).update(received=3)
        self.assertEqual(balance_data(item)['state'],'inconsistent');self.assertFalse(build_review(self.event)['can_complete'])
        with self.assertRaises(CommandError):self.move(item,'supplier_return')
    def test_document_new_quantities_are_bounded_by_recorded_receipt_not_order(self):
        item=self.order();self.move(item,'supplier_receive',2);self.event.refresh_from_db()
        line={'id':str(uuid.uuid4()),'asset_id':self.asset.pk,'supplier_id':self.company.pk,'ticket_item_id':item.pk,'source_kind':'supplier','snapshot':{'alias_name':'Rental speaker'},'quantity':3,'unit_value':'12.50','position':0}
        body={'request_id':str(uuid.uuid4()),'expected_revision':0,'expected_event_revision':self.event.revision,'number':'RECEIPT-PAPER','document_date':'2026-10-15','state':'draft','total_override':None,'correction_reason':'','lines':[line]}
        with self.assertRaises(CommandError):save_document(self.user,self.event.pk,'master',body)
        body['lines'][0]['quantity']=2;save_document(self.user,self.event.pk,'master',body)
        self.assertEqual(ChallanLine.objects.get().quantity,2)
    def test_receipts_returns_and_cancel_preserve_manual_paper(self):
        item=self.order();doc=ChallanDocument.objects.create(conference=self.event,scope='master',number='MANUAL',header={'company':{'name':'Original issuer'}})
        ChallanLine.objects.create(document=doc,source_kind='manual',snapshot={'alias_name':'Manual rental note'},quantity=2,unit_value=3,position=0)
        before=list(doc.lines.values());self.move(item,'supplier_receive',3);self.move(item,'supplier_return',3);self.move(item,'supplier_cancel',2)
        self.assertEqual(list(doc.lines.values()),before);self.assertEqual(Asset.objects.count(),1)
    def test_managed_ticket_trucks_close_without_forging_warehouse_history(self):
        from .truck_manifests import execute_manifest_command
        item=self.order();self.move(item,'supplier_receive',5);self.event.refresh_from_db()
        line={'id':str(uuid.uuid4()),'asset_id':self.asset.pk,'supplier_id':self.company.pk,'ticket_item_id':item.pk,'source_kind':'supplier','snapshot':{'alias_name':'Rental speaker'},'quantity':5,'unit_value':'12.50','position':0}
        save_document(self.user,self.event.pk,'master',{'request_id':str(uuid.uuid4()),'expected_revision':0,'expected_event_revision':self.event.revision,'number':'RENTAL-TRUCKS','document_date':'2026-10-15','lines':[line]})
        def command(action,**fields):
            self.event.refresh_from_db()
            return execute_manifest_command(self.user,self.event.pk,{'request_id':str(uuid.uuid4()),'action':action,'expected_event_revision':self.event.revision,'expected_document_revisions':{doc.scope:doc.revision for doc in self.event.challan_documents.all()},**fields})
        command('start');trucks=list(self.event.truck_challans.order_by('truck_number'))
        command('move',from_truck_id=trucks[0].pk,to_truck_id=trucks[1].pk,items=[{'master_line_id':line['id'],'quantity':2}])
        self.assertFalse(self.event.challan_assets.exists())
        self.assertFalse(build_review(self.event)['can_complete'])
        self.move(item,'supplier_return',5)
        self.assertTrue(build_review(self.event)['can_complete'])
        # Raw legacy membership still requires independent warehouse proof.
        self.event.challan_assets.add(self.asset)
        self.assertFalse(build_review(self.event)['can_complete'])
        self.assertIn('legacy_quantity_requires_reconciliation',[b['reason'] for b in build_review(self.event)['blockers']])
    def test_history_keeps_source_names_and_protected_targets(self):
        item=self.order();self.move(item,'supplier_receive',1);self.company.name='Renamed supplier';self.company.save()
        response=self.client.get(f'/api/subrental-ticket-items/{item.pk}/supplier-history/')
        self.assertEqual(response.status_code,200);self.assertEqual(response.data['history'][0]['source_snapshot']['supplier_name'],'External supplier')
        for row in (item,self.company,self.asset):
            with self.assertRaises(ProtectedError):row.delete()
    def test_sealed_event_and_technician_cannot_start_new_movement(self):
        item=self.order();self.user.profile.role='technician';self.user.profile.save()
        with self.assertRaises(CommandError):self.move(item,'supplier_receive')
        self.user.profile.role='admin';self.user.profile.save();self.event.lifecycle_state='completed';self.event.save()
        with self.assertRaises(CommandError):self.move(item,'supplier_receive')
    def test_late_failure_rolls_back_counts_history_event_and_receipt(self):
        item=self.order();before=balance_data(item);count=MovementReceipt.objects.count()
        with patch('core.supplier_balances.SupplierMovement.objects.create',side_effect=RuntimeError('late failure')):
            with self.assertRaises(RuntimeError):self.move(item,'supplier_receive',2)
        self.assertEqual(balance_data(item),before);self.assertEqual(MovementReceipt.objects.count(),count)
    def test_read_has_no_initialization_side_effect_and_auth_is_required(self):
        item=SubrentalTicketItem.objects.create(ticket=self.ticket,asset=self.asset,quantity=1)
        anon=APIClient();self.assertEqual(anon.get(f'/api/subrental-ticket-items/{item.pk}/supplier-history/').status_code,401)
        self.assertEqual(self.client.get(f'/api/subrental-ticket-items/{item.pk}/supplier-history/').status_code,200)
        self.assertEqual(SupplierBalance.objects.count(),0)


@skipUnless(connection.vendor=='postgresql','Isolated PostgreSQL is required for supplier balance races')
class SupplierBalanceRaceTests(TransactionTestCase):
    def setUp(self):
        self.user=User.objects.create_user('supplier-balance-race');self.user.profile.role='admin';self.user.profile.save()
        self.company=SubrentalCompany.objects.create(name='External race',inventory_mode='external_supplier')
        self.asset=Asset.objects.create(sku='SUPPLIER-RACE',quantity=10,subrental_company=self.company)
        self.event=Conference.objects.create(name='Supplier race event');self.ticket=SubrentalTicket.objects.create(company=self.company,conference=self.event)
        execute_supplier_command(self.user,{'request_id':str(uuid.uuid4()),'action':'add_item','conference_id':self.event.pk,'expected_revision':0,'reason':'Order race','data':{'ticket_id':self.ticket.pk,'asset_id':self.asset.pk,'quantity':5,'rental_price':0}})
        self.item=self.ticket.items.get();self.event.refresh_from_db()
        self.body={'request_id':str(uuid.uuid4()),'action':'supplier_receive','conference_id':self.event.pk,'expected_revision':self.event.revision,'reason':'Receipt race','data':{'ticket_id':self.ticket.pk,'item_id':self.item.pk,'quantity':3,'expected_balance_revision':0,'confirmed':True,'evidence_reference':'Synthetic note'}}
    def race(self,bodies):
        barrier=Barrier(2)
        def run(body):
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                try:return execute_supplier_command(User.objects.get(pk=self.user.pk),body)
                except CommandError as error:return error.code
            finally:close_old_connections()
        with ThreadPoolExecutor(2) as pool:return list(pool.map(run,bodies))
    def test_same_uuid_receipt_counts_once(self):
        self.race([self.body,self.body]);self.assertEqual(SupplierMovement.objects.count(),1);self.assertEqual(balance_data(self.item)['received'],3)
    def test_competing_receipts_do_not_over_receive(self):
        other={**self.body,'request_id':str(uuid.uuid4())};result=self.race([self.body,other])
        self.assertEqual(sum(isinstance(row,dict) for row in result),1);self.assertEqual(balance_data(self.item)['received'],3)
    def test_cross_event_order_capacity_is_serialized(self):
        other_event=Conference.objects.create(name='Other race event');other_ticket=SubrentalTicket.objects.create(company=self.company,conference=other_event)
        third_event=Conference.objects.create(name='Third race event');third_ticket=SubrentalTicket.objects.create(company=self.company,conference=third_event)
        body={'request_id':str(uuid.uuid4()),'action':'add_item','conference_id':other_event.pk,'expected_revision':0,'reason':'Capacity race','data':{'ticket_id':other_ticket.pk,'asset_id':self.asset.pk,'quantity':3,'rental_price':0}}
        other={**body,'request_id':str(uuid.uuid4()),'conference_id':third_event.pk,'data':{**body['data'],'ticket_id':third_ticket.pk}}
        result=self.race([body,other]);self.assertEqual(sum(isinstance(row,dict) for row in result),1)
        self.assertEqual(sum(item.quantity for item in self.asset.ticket_items.all()),8)
