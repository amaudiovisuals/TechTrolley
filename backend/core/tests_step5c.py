"""Disposable lifecycle acceptance tests; no customer databases or inferred returns."""
import copy
import uuid
from datetime import date
from unittest.mock import patch
from unittest import skipUnless
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from django.contrib.auth.models import User
from django.db import connection, close_old_connections
from django.db.models.deletion import ProtectedError
from django.test import TransactionTestCase
from .test_support import SnapshotTestCase
from rest_framework.test import APIClient
from .models import (Asset, Conference, PhysicalMovement, EventLifecycleHistory, MovementReceipt,
    QuantityAllocation, ConsumableAllocation, SubrentalCompany, SubrentalTicket, SubrentalTicketItem,
    ChallanDocument, ChallanLine, CompanySettings, TruckChallan)
from .asset_commands import CommandError, execute_command
from .event_lifecycle import build_review, execute_lifecycle_command
from .quantity_commands import execute_quantity_command
from .consumable_commands import execute_consumable_command
from .challan_documents import save_document
from .truck_manifests import execute_manifest_command
from .truck_transfer import transfer_truck_allocation


class EventLifecycleTests(SnapshotTestCase):
    def setUp(self):
        self.user = User.objects.create_user('closure-admin')
        self.user.profile.role = 'admin'; self.user.profile.save()
        self.event = Conference.objects.create(name='Verified event', start_date=date(2020,1,1), end_date=date(2020,1,2))
        self.asset = Asset.objects.create(sku='CLOSURE-DEVICE')
        self.client = APIClient(); self.client.force_authenticate(self.user)

    def review(self, event=None):
        event = event or self.event; event.refresh_from_db(); return build_review(event)

    def payload(self, action='complete', event=None):
        review = self.review(event)
        return {'request_id':str(uuid.uuid4()), 'action':action, 'expected_revision':review['revision'],
            'expected_snapshot_sha256':review['snapshot_sha256'], 'reason':'Verified warehouse records and physical return evidence', 'confirmed':True}

    def lifecycle(self, action='complete', event=None):
        return execute_lifecycle_command(self.user,(event or self.event).pk,self.payload(action,event))

    def move(self, action, event=None, ids=None, **extra):
        return execute_command(self.user,(event or self.event).pk,{'request_id':str(uuid.uuid4()),'action':action,'asset_ids':ids or [self.asset.pk],**extra})

    def returned(self):
        for action in ('stage','dispatch','return','verify_return'): self.move(action)

    def codes(self): return {row['reason'] for row in self.review()['blockers']}

    def test_ended_dates_and_empty_queues_stay_open_until_explicit_confirmation(self):
        self.assertEqual(self.event.lifecycle_state,'open'); self.assertIsNone(self.event.completed_at)
        self.assertTrue(self.review()['can_complete']);self.assertEqual(EventLifecycleHistory.objects.count(),0)
        result=self.lifecycle();self.event.refresh_from_db()
        self.assertEqual(self.event.lifecycle_state,'completed');self.assertEqual(self.event.completed_by,self.user)
        self.assertIsNotNone(self.event.completed_at);self.assertEqual(result['history']['operator_id'],self.user.pk)
        self.assertEqual(result['operation'],'event_lifecycle')

    def test_read_only_review_does_not_allocate_numbers_or_change_stock_history_status(self):
        self.move('stage'); before=list(Asset.objects.values()); receipts=MovementReceipt.objects.count();rev=self.review()['revision']
        one=self.client.get(f'/api/conferences/{self.event.pk}/lifecycle-review/');two=self.client.get(f'/api/conferences/{self.event.pk}/lifecycle-review/')
        self.assertEqual(one.status_code,200);self.assertEqual(one.data,two.data)
        self.assertEqual(list(Asset.objects.values()),before);self.assertEqual(MovementReceipt.objects.count(),receipts)
        self.assertEqual(self.review()['revision'],rev);self.assertEqual(CompanySettings.objects.count(),0)

    def test_each_operational_queue_blocks_completion(self):
        for field in ('assets','crosscheck_assets','staged_assets','requirements'):
            getattr(self.event,field).add(self.asset)
            self.assertIn('pending_'+field,self.codes())
            with self.assertRaises(CommandError): self.lifecycle()
            getattr(self.event,field).clear()
        self.assertEqual(EventLifecycleHistory.objects.count(),0)

    def test_physical_return_requires_warehouse_verification_and_keeps_restrictions(self):
        self.move('stage');self.move('dispatch');self.move('return')
        self.assertIn('physical_return_not_verified',self.codes())
        with self.assertRaises(CommandError):self.lifecycle()
        self.asset.condition='Damaged';self.asset.save();self.move('verify_return')
        self.lifecycle();self.asset.refresh_from_db();self.assertEqual(self.asset.status,'Damaged')
        last=PhysicalMovement.objects.order_by('pk').last();self.assertEqual(last.action,'verify_return');self.assertTrue(last.snapshot['before']['unchecked'])
        self.assertIsNotNone(last.created_at);self.assertEqual(last.receipt.actor,self.user)

    def test_missing_flag_cannot_be_certified_as_complete(self):
        self.returned();self.asset.flag='Missing';self.asset.save()
        self.assertIn('unresolved_missing_item',self.codes())
        with self.assertRaises(CommandError):self.lifecycle()

    def test_empty_legacy_history_has_unknown_return_evidence_not_an_inferred_date(self):
        self.event.challan_assets.add(self.asset)
        self.assertIn('physical_return_evidence_missing',self.codes())
        with self.assertRaises(CommandError):self.lifecycle()
        self.assertEqual(PhysicalMovement.objects.count(),0)
        self.event.crosscheck_assets.add(self.asset);self.move('verify_return')
        self.lifecycle();self.assertEqual(PhysicalMovement.objects.count(),1)
        self.assertEqual(PhysicalMovement.objects.get().action,'verify_return')

    def test_legacy_bulk_history_requires_review_even_when_queues_empty(self):
        self.asset.quantity=20;self.asset.save();self.event.challan_assets.add(self.asset)
        self.assertIn('legacy_quantity_requires_reconciliation',self.codes())
        with self.assertRaises(CommandError):self.lifecycle()

    def test_transfer_acceptance_closes_source_without_claiming_warehouse_return(self):
        other=Conference.objects.create(name='Receiving event');self.move('stage');self.move('dispatch')
        self.move('transfer',target_conference_id=other.pk)
        self.assertEqual(PhysicalMovement.objects.filter(action='transfer_out').count(),1)
        self.assertEqual(PhysicalMovement.objects.filter(action='transfer_in').count(),1)
        self.lifecycle();self.assertTrue(other.assets.filter(pk=self.asset.pk).exists())
        self.assertFalse(self.review(other)['can_complete'])
        self.assertEqual(self.review()['physical_returns'][0]['terminal_movement']['action'],'transfer_out')

    def test_terminal_transfer_without_matching_acceptance_is_blocked(self):
        other=Conference.objects.create(name='Receiver');self.move('stage');self.move('dispatch');self.move('transfer',target_conference_id=other.pk)
        PhysicalMovement.objects.filter(action='transfer_in').delete()
        self.assertIn('transfer_acceptance_evidence_missing',self.codes())
        with self.assertRaises(CommandError):self.lifecycle()

    def test_bulk_balances_and_recorded_totals_are_verified_before_completion(self):
        bulk=Asset.objects.create(sku='CLOSURE-BULK',quantity=10,quantity_tracking=True)
        for action in ('stage','dispatch','return','verify_return'):
            self.event.refresh_from_db();execute_quantity_command(self.user,self.event.pk,{'request_id':str(uuid.uuid4()),'action':action,'expected_revision':self.event.revision,'items':[{'asset_id':bulk.pk,'quantity':4}]})
            if action!='verify_return':
                self.assertIn('quantity_balance_outstanding',self.codes())
                with self.assertRaises(CommandError):self.lifecycle()
        self.lifecycle();bulk.refresh_from_db();self.assertEqual(bulk.quantity,10)
        row=QuantityAllocation.objects.get();self.assertEqual(row.verified_total,4)

    def test_fabricated_bulk_verified_total_without_movements_is_blocked(self):
        bulk=Asset.objects.create(sku='FAKE-BULK',quantity=10,quantity_tracking=True)
        QuantityAllocation.objects.create(asset=bulk,conference=self.event,dispatched_total=4,verified_total=4)
        self.assertIn('quantity_return_evidence_inconsistent',self.codes())
        with self.assertRaises(CommandError):self.lifecycle()

    def test_consumable_zero_return_is_explicitly_settled_not_assumed(self):
        item=Asset.objects.create(sku='CLOSURE-TAPE',type='Consumables',quantity=10)
        for action in ('save','dispatch','settle'):
            self.event.refresh_from_db();execute_consumable_command(self.user,self.event.pk,{'request_id':str(uuid.uuid4()),'action':action,'expected_revision':self.event.revision,'items':[{'asset_id':item.pk,'requested':3,'returned':0 if action=='settle' else None,'confirmed':action=='settle'}]})
            if action!='settle':
                self.assertIn('consumable_return_not_settled',self.codes())
                with self.assertRaises(CommandError):self.lifecycle()
        self.lifecycle();item.refresh_from_db();self.assertEqual(item.quantity,7)

    def test_legacy_settled_json_and_fabricated_consumer_row_do_not_prove_returns(self):
        self.event.consumable_data={'123':{'requested':3,'returned':0,'status':'settled'}};self.event.save()
        self.assertIn('legacy_consumables_require_reconciliation',self.codes())
        self.event.consumable_data={};self.event.save()
        item=Asset.objects.create(sku='FAKE-TAPE',type='Consumables',quantity=10)
        ConsumableAllocation.objects.create(asset=item,conference=self.event,requested=3,returned=0,consumed=3,state='settled')
        self.assertIn('consumable_settlement_evidence_inconsistent',self.codes())
        with self.assertRaises(CommandError):self.lifecycle()

    def test_untracked_supplier_returns_block_completion(self):
        supplier=SubrentalCompany.objects.create(name='AM supplier');ticket=SubrentalTicket.objects.create(company=supplier,conference=self.event)
        SubrentalTicketItem.objects.create(ticket=ticket,asset=self.asset,quantity=1)
        self.assertIn('legacy_supplier_obligation_requires_review',self.codes())
        with self.assertRaises(CommandError):self.lifecycle()

    def test_audit_observations_cannot_be_certified_as_real_returns(self):
        self.event.is_audit=True;self.event.save();self.event.staged_assets.add(self.asset)
        before=self.event.revision;self.assertIn('audit_lifecycle_requires_reviewed_conversion',self.codes())
        with self.assertRaises(CommandError):self.lifecycle()
        self.event.refresh_from_db();self.assertEqual(self.event.revision,before);self.assertTrue(self.event.staged_assets.filter(pk=self.asset.pk).exists())

    def test_stale_revision_and_asset_evidence_fail_without_any_new_history(self):
        old=self.payload();self.event.name='Changed after review';self.event.save()
        with self.assertRaises(CommandError) as caught:execute_lifecycle_command(self.user,self.event.pk,old)
        self.assertEqual(caught.exception.code,'event_changed')
        self.returned();old=self.payload();self.asset.alias_name='New inventory label';self.asset.save()
        with self.assertRaises(CommandError) as caught:execute_lifecycle_command(self.user,self.event.pk,old)
        self.assertEqual(caught.exception.code,'lifecycle_evidence_changed')
        self.assertEqual(EventLifecycleHistory.objects.count(),0)

    def test_archive_preserves_papers_numbers_memberships_stock_and_history(self):
        self.returned();doc=ChallanDocument.objects.create(conference=self.event,scope='master',number='PRESERVED',state='issued')
        ChallanLine.objects.create(document=doc,source_kind='manual',quantity=3,unit_value='10.50',position=0,snapshot={'alias_name':'Manual documentary item'})
        before=list(Asset.objects.values());self.lifecycle();self.lifecycle('archive');self.event.refresh_from_db()
        self.assertEqual(self.event.lifecycle_state,'archived');self.assertIsNotNone(self.event.archived_at)
        self.assertEqual(list(Asset.objects.values()),before);self.assertEqual(doc.lines.count(),1)
        self.assertTrue(self.event.challan_assets.filter(pk=self.asset.pk).exists());self.assertEqual(EventLifecycleHistory.objects.count(),2)
        self.assertEqual(self.client.get(f'/api/conferences/{self.event.pk}/challan-documents/master/').status_code,200)
        self.assertEqual(self.client.delete(f'/api/conferences/{self.event.pk}/',{'expected_revision':self.event.revision},format='json').status_code,409)

    def test_archive_requires_actual_completed_record_not_date_or_state_string(self):
        with self.assertRaises(CommandError):self.lifecycle('archive')
        Conference.objects.filter(pk=self.event.pk).update(lifecycle_state='completed')
        self.assertIn('lifecycle_record_inconsistent',self.codes())
        with self.assertRaises(CommandError):self.lifecycle('archive')

    def test_reopen_is_audited_admin_action_and_never_restores_custody(self):
        self.returned();self.lifecycle();self.lifecycle('archive')
        self.user.profile.role='godown_incharge';self.user.profile.save()
        with self.assertRaises(CommandError):self.lifecycle('reopen')
        self.user.profile.role='admin';self.user.profile.save();self.lifecycle('reopen');self.event.refresh_from_db()
        self.assertEqual(self.event.lifecycle_state,'open');self.assertIsNone(self.event.completed_at)
        self.assertFalse(self.event.assets.exists());self.assertFalse(self.event.crosscheck_assets.exists())
        self.assertEqual(list(self.event.lifecycle_history.values_list('action',flat=True)),['complete','archive','reopen'])
        self.move('stage');self.assertTrue(self.event.staged_assets.filter(pk=self.asset.pk).exists())

    def test_lost_complete_receipt_replays_after_downgrade_and_reopen_without_reclosing(self):
        payload=self.payload();first=execute_lifecycle_command(self.user,self.event.pk,payload)
        self.lifecycle('archive');self.lifecycle('reopen');self.user.profile.role='accounts';self.user.profile.save()
        replay=execute_lifecycle_command(self.user,self.event.pk,payload)
        self.assertTrue(replay['replayed']);self.assertEqual(first['history'],replay['history'])
        self.event.refresh_from_db();self.assertEqual(self.event.lifecycle_state,'open');self.assertEqual(EventLifecycleHistory.objects.count(),3)
        changed={**payload,'reason':'Different reason'}
        with self.assertRaises(CommandError) as caught:execute_lifecycle_command(self.user,self.event.pk,changed)
        self.assertEqual(caught.exception.code,'request_id_reused')

    def test_late_history_failure_rolls_back_state_revision_and_receipt(self):
        payload=self.payload();before=self.event.revision
        with patch('core.event_lifecycle.EventLifecycleHistory.objects.create',side_effect=RuntimeError('Synthetic write failure')):
            with self.assertRaises(RuntimeError):execute_lifecycle_command(self.user,self.event.pk,payload)
        self.event.refresh_from_db();self.assertEqual((self.event.lifecycle_state,self.event.revision),('open',before))
        self.assertEqual(MovementReceipt.objects.count(),0)

    def test_completed_event_seals_every_command_family_and_transfer_destination(self):
        first=TruckChallan.objects.create(conference=self.event,truck_number=1);second=TruckChallan.objects.create(conference=self.event,truck_number=2)
        self.lifecycle();self.event.refresh_from_db();rev=self.event.revision
        operations=[lambda:self.move('require'),lambda:execute_quantity_command(self.user,self.event.pk,{'request_id':str(uuid.uuid4()),'action':'stage','expected_revision':rev,'items':[{'asset_id':self.asset.pk,'quantity':1}]}),
            lambda:execute_consumable_command(self.user,self.event.pk,{'request_id':str(uuid.uuid4()),'action':'save','expected_revision':rev,'items':[]}),
            lambda:execute_manifest_command(self.user,self.event.pk,{'request_id':str(uuid.uuid4()),'action':'start','expected_event_revision':rev,'expected_document_revisions':{}}),
            lambda:save_document(self.user,self.event.pk,'master',{'request_id':str(uuid.uuid4()),'expected_revision':0,'expected_event_revision':rev,'number':'','lines':[]}),
            lambda:transfer_truck_allocation(self.user,first.pk,{'request_id':str(uuid.uuid4()),'to_truck_id':second.pk,'asset_ids':[self.asset.pk]})]
        for operation in operations:
            with self.assertRaises(CommandError) as caught:operation()
            self.assertEqual(caught.exception.code,'event_is_sealed')
        other=Conference.objects.create(name='Still open');self.move('stage',event=other);self.move('dispatch',event=other)
        with self.assertRaises(CommandError):self.move('transfer',event=other,target_conference_id=self.event.pk)
        self.assertTrue(other.assets.filter(pk=self.asset.pk).exists())

    def test_completed_legacy_writes_refused_but_invoice_marker_allowed(self):
        truck=TruckChallan.objects.create(conference=self.event);self.lifecycle();self.event.refresh_from_db()
        for method,url,body in [('patch',f'/api/conferences/{self.event.pk}/',{'name':'Changed'}),('post',f'/api/conferences/{self.event.pk}/trucks/',{}),('patch',f'/api/truck-challans/{truck.pk}/',{'label':'Changed'}),('post',f'/api/conferences/{self.event.pk}/trucks/add-to-truck/',{'asset_ids':[self.asset.pk]})]:
            response=getattr(self.client,method)(url,{**body,'expected_revision':self.event.revision},format='json');self.assertEqual(response.status_code,409,response.data)
        self.user.profile.role='accounts';self.user.profile.save()
        response=self.client.patch(f'/api/conferences/{self.event.pk}/',{'is_invoiced':True,'expected_revision':self.event.revision},format='json')
        self.assertEqual(response.status_code,200,response.data);self.event.refresh_from_db();self.assertTrue(self.event.is_invoiced)

    def test_generic_create_and_update_cannot_set_verified_lifecycle_fields(self):
        for field,value in [('lifecycle_state','completed'),('completed_at','2026-10-14T01:00:00Z'),('completed_by',self.user.pk),('archived_at','2026-10-14T01:00:00Z'),('archived_by',self.user.pk)]:
            response=self.client.post('/api/conferences/',{'name':'Forged',field:value},format='json');self.assertEqual(response.status_code,400,response.data)
            self.event.refresh_from_db();response=self.client.patch(f'/api/conferences/{self.event.pk}/',{field:value,'expected_revision':self.event.revision},format='json');self.assertEqual(response.status_code,400,response.data)
        self.assertEqual(Conference.objects.count(),1)

    def test_ticket_writes_are_revisioned_and_sealed_event_cascades_preserved(self):
        supplier=SubrentalCompany.objects.create(name='Preserved supplier');before=self.event.revision
        from .supplier_commands import execute_supplier_command
        response=execute_supplier_command(self.user,{'request_id':str(uuid.uuid4()),'action':'create_ticket','conference_id':self.event.pk,'expected_revision':self.event.revision,'reason':'Create reviewed supplier ticket','data':{'company_id':supplier.pk,'available_from':'2026-10-14','available_till':None}})
        ticket_id=response['ticket_id'];self.event.refresh_from_db();self.assertGreater(self.event.revision,before)
        self.lifecycle();self.lifecycle('archive')
        for method,url,body in [('post','/api/subrental-tickets/',{'conference':self.event.pk,'company':supplier.pk}),('patch',f'/api/subrental-tickets/{ticket_id}/',{'available_till':'2026-10-15'}),('delete',f'/api/subrental-tickets/{ticket_id}/',{}),('post',f'/api/subrental-tickets/{ticket_id}/add-item/',{'name':'Unapproved new item'}),('delete',f'/api/subrental-companies/{supplier.pk}/',{})]:
            response=getattr(self.client,method)(url,body,format='json');self.assertEqual(response.status_code,409,response.data)
        self.assertEqual(SubrentalTicket.objects.count(),1);self.assertEqual(Asset.objects.count(),1)

    def test_ticket_item_writes_and_ticket_move_cannot_change_sealed_evidence(self):
        self.lifecycle()
        # Deliberately simulate a database write bypassing the sealed API guard.
        supplier=SubrentalCompany.objects.create(name='Supplier');ticket=SubrentalTicket.objects.create(company=supplier,conference=self.event)
        item=SubrentalTicketItem.objects.create(ticket=ticket,asset=self.asset,quantity=0)
        self.assertIn('legacy_supplier_obligation_requires_review', self.codes())
        with self.assertRaises(CommandError): self.lifecycle('archive')
        for method in ('patch','delete'):
            response=getattr(self.client,method)(f'/api/subrental-ticket-items/{item.pk}/',{'quantity':1},format='json');self.assertEqual(response.status_code,409,response.data)
        other=Conference.objects.create(name='Other')
        self.assertEqual(self.client.patch(f'/api/subrental-tickets/{ticket.pk}/',{'conference':other.pk},format='json').status_code,409)
        item.refresh_from_db();self.assertEqual(item.quantity,0)

    def test_protected_physical_and_lifecycle_history_prevents_destructive_deletion(self):
        self.returned();self.lifecycle()
        for obj in (self.asset,self.event,self.user,PhysicalMovement.objects.first().receipt):
            with self.assertRaises(ProtectedError):obj.delete()
        self.assertEqual(self.client.delete(f'/api/assets/{self.asset.pk}/').status_code,409)

    def test_legacy_history_cannot_be_erased_by_generic_edit_or_inventory_deletion(self):
        self.event.challan_assets.add(self.asset);self.event.refresh_from_db()
        response=self.client.patch(f'/api/conferences/{self.event.pk}/',{'challan_assets':[],'expected_revision':self.event.revision},format='json')
        self.assertEqual(response.status_code,409,response.data)
        response=self.client.delete(f'/api/assets/{self.asset.pk}/')
        self.assertEqual(response.status_code,409,response.data)
        self.assertTrue(self.event.challan_assets.filter(pk=self.asset.pk).exists())
        self.assertIn('physical_return_evidence_missing',self.codes())

    def test_legacy_truck_removal_retains_references_without_creating_return_proof(self):
        truck=TruckChallan.objects.create(conference=self.event);truck.assets.add(self.asset);self.event.refresh_from_db()
        response=self.client.patch(f'/api/truck-challans/{truck.pk}/',{'assets':[],'expected_revision':self.event.revision},format='json')
        self.assertEqual(response.status_code,200,response.data);self.assertTrue(self.event.challan_assets.filter(pk=self.asset.pk).exists())
        truck.assets.add(self.asset);self.event.refresh_from_db()
        response=self.client.delete(f'/api/truck-challans/{truck.pk}/',{'expected_revision':self.event.revision},format='json')
        self.assertEqual(response.status_code,200,response.data);self.assertEqual(TruckChallan.objects.count(),0)
        self.assertTrue(self.event.challan_assets.filter(pk=self.asset.pk).exists());self.assertEqual(PhysicalMovement.objects.count(),0)
        with self.assertRaises(CommandError):self.lifecycle()

    def test_initial_truck_subset_does_not_remove_existing_legacy_history(self):
        self.event.challan_assets.add(self.asset);other=Asset.objects.create(sku='NEW-TRUCK-ITEM');self.event.refresh_from_db()
        CompanySettings.objects.create(name='Synthetic truck numbers')
        response=self.client.post(f'/api/conferences/{self.event.pk}/trucks/',{'asset_ids':[other.pk],'expected_revision':self.event.revision},format='json')
        self.assertEqual(response.status_code,201,response.data)
        self.assertEqual(set(self.event.challan_assets.values_list('pk',flat=True)),{self.asset.pk,other.pk})

    def test_contextual_health_report_cannot_edit_a_sealed_event_log(self):
        self.returned();self.lifecycle();self.event.refresh_from_db();before=self.event.flag_log;rev=self.event.revision
        response=self.client.patch(f'/api/assets/{self.asset.pk}/',{'flag':'Missing','conference_id':self.event.pk,'stage':'After closure'},format='json')
        self.assertEqual(response.status_code,409,response.data)
        self.event.refresh_from_db();self.asset.refresh_from_db()
        self.assertEqual((self.event.flag_log,self.event.revision),(before,rev));self.assertEqual(self.asset.flag,'')

    def test_archive_preserves_prior_completion_when_returned_equipment_later_changes_elsewhere(self):
        self.returned();self.lifecycle();completed=Conference.objects.get(pk=self.event.pk).completed_at
        self.asset.flag='Missing';self.asset.save();before=list(Asset.objects.values())
        review=self.review();self.assertTrue(review['can_archive']);self.assertTrue(review['review_notes'])
        self.lifecycle('archive');self.event.refresh_from_db()
        self.assertEqual(self.event.completed_at,completed);self.assertEqual(list(Asset.objects.values()),before)
        self.assertEqual(EventLifecycleHistory.objects.count(),2)

    def test_supplier_removal_or_zero_quantity_does_not_erase_unverified_return_obligations(self):
        supplier=SubrentalCompany.objects.create(name='Unverified supplier');ticket=SubrentalTicket.objects.create(company=supplier,conference=self.event)
        item=SubrentalTicketItem.objects.create(ticket=ticket,asset=self.asset,quantity=1)
        response=self.client.patch(f'/api/subrental-ticket-items/{item.pk}/',{'quantity':0},format='json')
        self.assertEqual(response.status_code,409,response.data)
        item.refresh_from_db(); self.assertEqual(item.quantity,1)
        for url in (f'/api/subrental-ticket-items/{item.pk}/',f'/api/subrental-tickets/{ticket.pk}/',f'/api/subrental-companies/{supplier.pk}/'):
            response=self.client.delete(url);self.assertEqual(response.status_code,409,response.data)
        self.assertEqual(SubrentalTicketItem.objects.count(),1)
        self.assertIn('legacy_supplier_obligation_requires_review',self.codes())
        with self.assertRaises(CommandError):self.lifecycle()

    def test_roles_payload_and_unknown_event_reject_without_partial_writes(self):
        payload=self.payload()
        for role in ('technician','accounts'):
            self.user.profile.role=role;self.user.profile.save()
            self.assertEqual(self.client.get(f'/api/conferences/{self.event.pk}/lifecycle-review/').status_code,403)
            with self.assertRaises(CommandError):execute_lifecycle_command(self.user,self.event.pk,payload)
        self.user.profile.role='godown_incharge';self.user.profile.save()
        for changes in ({'confirmed':False},{'confirmed':1},{'reason':' '},{'expected_revision':True},{'expected_snapshot_sha256':'bad'},{'action':[]},{'request_id':'bad'},{'unexpected':'value'}):
            with self.assertRaises(CommandError):execute_lifecycle_command(self.user,self.event.pk,{**payload,**changes})
        with self.assertRaises(CommandError) as caught:execute_lifecycle_command(self.user,999999,payload)
        self.assertEqual(caught.exception.status,404);self.assertEqual(MovementReceipt.objects.count(),0)
        self.lifecycle();self.assertEqual(EventLifecycleHistory.objects.count(),1)


@skipUnless(connection.vendor=='postgresql','PostgreSQL concurrency acceptance pending')
class EventLifecycleConcurrencyTests(TransactionTestCase):
    def setUp(self):
        self.user=User.objects.create_user('pg-closure');self.user.profile.role='admin';self.user.profile.save()
        self.event=Conference.objects.create(name='Concurrent closure');self.asset=Asset.objects.create(sku='PG-CLOSURE')
        self.event.refresh_from_db()
        review=build_review(self.event);self.body={'request_id':str(uuid.uuid4()),'action':'complete','expected_revision':review['revision'],'expected_snapshot_sha256':review['snapshot_sha256'],'reason':'Verified concurrency test','confirmed':True}

    def race(self, callbacks):
        gate=Barrier(2)
        def run(callback):
            close_old_connections();user=User.objects.get(pk=self.user.pk);gate.wait()
            try:return callback(user)
            except CommandError as error:return error.code
            finally:close_old_connections()
        with ThreadPoolExecutor(max_workers=2) as pool:return list(pool.map(run,callbacks))

    def test_two_completion_devices_create_only_one_history(self):
        other={**self.body,'request_id':str(uuid.uuid4())}
        self.race([lambda u:execute_lifecycle_command(u,self.event.pk,self.body),lambda u:execute_lifecycle_command(u,self.event.pk,other)])
        self.assertEqual(EventLifecycleHistory.objects.count(),1);self.assertEqual(MovementReceipt.objects.count(),1)

    def test_exact_uuid_race_replays_one_committed_result(self):
        results=self.race([lambda u:execute_lifecycle_command(u,self.event.pk,self.body)]*2)
        self.assertEqual(EventLifecycleHistory.objects.count(),1);self.assertEqual(sum(result['replayed'] for result in results),1)

    def test_closure_vs_new_packing_never_seals_an_outstanding_queue(self):
        self.race([lambda u:execute_lifecycle_command(u,self.event.pk,self.body),lambda u:execute_command(u,self.event.pk,{'request_id':str(uuid.uuid4()),'action':'stage','asset_ids':[self.asset.pk]})])
        self.event.refresh_from_db()
        self.assertFalse(self.event.lifecycle_state=='completed' and self.event.staged_assets.exists())
