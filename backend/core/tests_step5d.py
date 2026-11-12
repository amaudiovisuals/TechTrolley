"""Disposable reviewed-repair contracts, gates, provenance and atomic inverses."""
import copy,uuid,json,os,tempfile
from pathlib import Path
from io import StringIO
from django.core.management import call_command
from django.core.management.base import CommandError as ManagementError
from unittest import skipUnless
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from django.contrib.auth.models import User
from django.db import connection,close_old_connections
from django.db.models.deletion import ProtectedError
from django.test import TransactionTestCase, override_settings
from .test_support import SnapshotTestCase
from rest_framework.test import APIClient
from .models import (Asset,Conference,Employee,MovementReceipt,ReconciliationHistory,
    PreservedAuditObservation,PhysicalMovement,QuantityAllocation,ConsumableAllocation,
    SubrentalCompany,SubrentalTicket,SubrentalTicketItem,ChallanDocument,ChallanLine)
from .reconciliation_commands import prepare_preview,execute_reconciliation,digest,write_gate
from .asset_commands import execute_command,CommandError
from .event_lifecycle import build_review,execute_lifecycle_command


@override_settings(REVIEWED_RECONCILIATION_WRITES_ENABLED=True,RECONCILIATION_INSTANCE_ID='synthetic-memory-step5d')
class ReviewedReconciliationTests(SnapshotTestCase):
    def setUp(self):
        self.admin=User.objects.create_user('repair-admin');self.admin.profile.role='admin';self.admin.profile.save()
        self.client=APIClient();self.client.force_authenticate(self.admin)
        self.event=Conference.objects.create(name='Reviewed real event');self.audit=Conference.objects.create(name='Reviewed audit',is_audit=True)
        self.asset=Asset.objects.create(sku='REVIEW-UNIT',alias_name='Reviewed device')

    def target(self,action='repair_status',assets=None,event=None,**fields):
        return {'action':action,'asset_ids':[a.pk for a in (assets or [self.asset])] if action in ('repair_status','legacy_return') else [],
            'conference_ids':[(event or self.event).pk] if action in ('audit_mode','legacy_return') else [],**fields}

    def command(self,target=None):
        preview,_,_=prepare_preview(target or self.target())
        return {'request_id':str(uuid.uuid4()),'target':preview['target'],'database':preview['database'],
            'expected_snapshot_sha256':preview['snapshot_sha256'],'reason':'Physical custody reviewed by authorized administrator',
            'evidence_reference':'Synthetic signed warehouse verification record','confirmed':True,
            'custody_confirmations':{str(row['asset_id']):row['required_custody_confirmation'] for row in preview['plan']['changes'] if 'required_custody_confirmation' in row}}

    def corrupt(self,asset=None,status='Crosscheck'):Asset.objects.filter(pk=(asset or self.asset).pk).update(status=status)
    def apply(self,target=None):return execute_reconciliation(self.admin,self.command(target))
    def inverse_target(self,result):return self.target('inverse',original_id=result['history']['id'])
    def move(self,action,event=None):return execute_command(self.admin,(event or self.event).pk,{'request_id':str(uuid.uuid4()),'action':action,'asset_ids':[self.asset.pk]})

    def test_discovery_and_preview_are_pure_and_database_source_bound(self):
        self.audit.staged_assets.add(self.asset);self.corrupt();before=list(Asset.objects.values());rev=Conference.objects.get(pk=self.audit.pk).revision
        first=self.client.get(f'/api/conferences/{self.audit.pk}/reconciliation-review/');second=self.client.get(f'/api/conferences/{self.audit.pk}/reconciliation-review/')
        self.assertEqual(first.status_code,200);self.assertEqual(first.data,second.data)
        target=self.target();one=self.client.post('/api/reconciliation/preview/',target,format='json');two=self.client.post('/api/reconciliation/preview/',target,format='json')
        self.assertEqual(one.status_code,200);self.assertEqual(one.data,two.data);self.assertEqual(one.data['database']['instance_id'],'synthetic-memory-step5d')
        self.assertEqual(len(one.data['database']['runtime_source_sha256']),64);self.assertEqual(list(Asset.objects.values()),before)
        self.assertEqual(Conference.objects.get(pk=self.audit.pk).revision,rev);self.assertEqual(MovementReceipt.objects.count(),0)

    def test_warehouse_ghost_status_correction_changes_no_stock_or_relations(self):
        self.audit.assets.add(self.asset);self.audit.crosscheck_assets.add(self.asset);self.audit.challan_assets.add(self.asset);self.corrupt()
        before_qty=self.asset.quantity;result=self.apply();self.asset.refresh_from_db()
        self.assertEqual((self.asset.status,self.asset.quantity),('Available',before_qty))
        self.assertTrue(self.audit.assets.filter(pk=self.asset.pk).exists());self.assertTrue(self.audit.challan_assets.filter(pk=self.asset.pk).exists())
        history=ReconciliationHistory.objects.get();self.assertEqual(history.action,'repair_status');self.assertNotEqual(history.before_sha256,history.after_sha256)
        self.assertEqual(result['operation'],'reviewed_reconciliation');self.assertGreater(self.asset.custody_revision,0)

    def test_real_holder_status_correction_never_releases_event_membership(self):
        self.event.assets.add(self.asset);self.audit.assets.add(self.asset);self.corrupt()
        command=self.command();self.assertEqual(command['custody_confirmations'],{str(self.asset.pk):'event'})
        execute_reconciliation(self.admin,command);self.asset.refresh_from_db()
        self.assertEqual(self.asset.status,'In Use');self.assertTrue(self.event.assets.filter(pk=self.asset.pk).exists())

    def test_crosscheck_and_staff_corrections_cannot_pretend_warehouse_custody(self):
        self.event.crosscheck_assets.add(self.asset);self.corrupt(status='In Use');command=self.command()
        command['custody_confirmations'][str(self.asset.pk)]='warehouse'
        with self.assertRaises(CommandError):execute_reconciliation(self.admin,command)
        self.apply();self.asset.refresh_from_db();self.assertEqual(self.asset.status,'Crosscheck')
        self.event.crosscheck_assets.clear();employee=Employee.objects.create(name='Known custodian',employee_id='KNOWN',department='Ops',phone='-')
        self.asset.assigned_to=employee;self.asset.save();self.corrupt(status='Available')
        self.assertEqual(self.command()['custody_confirmations'],{str(self.asset.pk):'staff'});self.apply();self.asset.refresh_from_db();self.assertEqual(self.asset.assigned_to,employee)

    def test_restricted_bulk_temporary_and_components_stay_blocked(self):
        for fields in ({'flag':'Missing'},{'condition':'Damaged'},{'status':'Expired'},{'quantity':5},{'quantity_tracking':True},{'type':'Consumables'},{'is_temporary':True},{'parent_asset':self.asset}):
            other=Asset.objects.create(sku=str(uuid.uuid4()),**fields)
            if not fields.get('status'):self.corrupt(other)
            preview,_,_=prepare_preview(self.target(assets=[other]));self.assertFalse(preview['can_apply'])
            with self.assertRaises(CommandError):self.apply(self.target(assets=[other]))
        self.assertEqual(ReconciliationHistory.objects.count(),0)

    def test_multiple_holders_and_staff_overlap_cannot_be_resolved_by_status_only(self):
        other=Conference.objects.create(name='Another holder');self.event.assets.add(self.asset);other.assets.add(self.asset);self.corrupt()
        with self.assertRaises(CommandError):self.apply()
        other.assets.clear();employee=Employee.objects.create(name='Conflict custodian',employee_id='CONFLICT',department='Ops',phone='-');self.asset.assigned_to=employee;self.asset.save();self.corrupt()
        with self.assertRaises(CommandError):self.apply()
        self.assertTrue(self.event.assets.filter(pk=self.asset.pk).exists())

    def test_packing_and_matching_status_are_not_auto_repaired(self):
        self.event.staged_assets.add(self.asset);self.corrupt()
        with self.assertRaises(CommandError):self.apply()
        self.event.staged_assets.clear();self.corrupt(status='Available')
        with self.assertRaises(CommandError):self.apply()

    def test_exact_retry_after_role_and_gate_change_and_newer_metadata(self):
        self.corrupt();command=self.command();first=execute_reconciliation(self.admin,command)
        self.asset.description='Later metadata';self.asset.save();self.admin.profile.role='accounts';self.admin.profile.save()
        with override_settings(REVIEWED_RECONCILIATION_WRITES_ENABLED=False):
            replay=execute_reconciliation(self.admin,command)
        self.assertTrue(replay['replayed']);self.assertEqual(first['history'],replay['history']);self.assertEqual(ReconciliationHistory.objects.count(),1)
        with self.assertRaises(CommandError):execute_reconciliation(self.admin,{**command,'reason':'Reused different body'})

    def test_stale_asset_event_and_runtime_database_identity_refuse(self):
        self.event.challan_assets.add(self.asset);self.corrupt();old=self.command();self.asset.description='Changed';self.asset.save()
        with self.assertRaises(CommandError):execute_reconciliation(self.admin,old)
        old=self.command();self.event.name='Changed context';self.event.save()
        with self.assertRaises(CommandError):execute_reconciliation(self.admin,old)
        old=self.command();old['database']['instance_id']='different-database'
        with self.assertRaises(CommandError):execute_reconciliation(self.admin,old)
        old=self.command();old['database']['runtime_source_sha256']='b'*64
        with self.assertRaises(CommandError):execute_reconciliation(self.admin,old)
        self.assertEqual(ReconciliationHistory.objects.count(),0)

    def test_gate_disabled_missing_identity_and_file_sqlite_refuse_before_writes(self):
        self.corrupt();command=self.command()
        with override_settings(REVIEWED_RECONCILIATION_WRITES_ENABLED=False):
            with self.assertRaises(CommandError):execute_reconciliation(self.admin,command)
        with override_settings(RECONCILIATION_INSTANCE_ID=''):
            preview,_,_=prepare_preview(self.target());self.assertFalse(preview['can_apply'])
        self.assertEqual(write_gate({'vendor':'sqlite','name':'/private/tmp/never-opened-business.sqlite3','instance_id':'provided'}),'business_sqlite_repairs_refused')
        self.assertEqual(MovementReceipt.objects.count(),0)

    def test_nonadministrators_can_preview_but_cannot_apply(self):
        self.corrupt();command=self.command()
        for role in ('technician','accounts','godown_incharge'):
            self.admin.profile.role=role;self.admin.profile.save()
            with self.assertRaises(CommandError):execute_reconciliation(self.admin,command)
            response=self.client.post('/api/reconciliation/preview/',self.target(),format='json')
            self.assertEqual(response.status_code,200 if role=='godown_incharge' else 403)
        self.assertEqual(ReconciliationHistory.objects.count(),0)

    def test_invalid_confirmation_reason_target_and_uuid_do_not_partially_mutate(self):
        self.corrupt();command=self.command()
        for fields in ({'confirmed':1},{'reason':''},{'evidence_reference':''},{'request_id':'bad'},{'expected_snapshot_sha256':'bad'},{'custody_confirmations':{}},{'target':{'action':[]}}, {'extra':True}):
            with self.assertRaises(CommandError):execute_reconciliation(self.admin,{**command,**fields})
        self.asset.refresh_from_db();self.assertEqual(self.asset.status,'Crosscheck');self.assertEqual(MovementReceipt.objects.count(),0)

    def test_selected_batch_is_atomic_and_unselected_defects_are_kept(self):
        other=Asset.objects.create(sku='OTHER-SELECTED');unselected=Asset.objects.create(sku='UNSELECTED');self.corrupt();self.corrupt(other);self.corrupt(unselected)
        command=self.command(self.target(assets=[self.asset,other]));other.flag='Missing';other.save()
        with self.assertRaises(CommandError):execute_reconciliation(self.admin,command)
        self.asset.refresh_from_db();self.assertEqual(self.asset.status,'Crosscheck')
        self.apply();unselected.refresh_from_db();self.assertEqual(unselected.status,'Crosscheck')

    def test_late_history_failure_rolls_back_repair_receipt_and_revision(self):
        self.corrupt();command=self.command();self.asset.refresh_from_db();rev=self.asset.custody_revision
        original_save=ReconciliationHistory.save
        def late_failure(instance,*args,**kwargs):
            if kwargs.get('update_fields'):raise RuntimeError('Synthetic late failure')
            return original_save(instance,*args,**kwargs)
        with patch('core.reconciliation_commands.ReconciliationHistory.save',new=late_failure):
            with self.assertRaises(RuntimeError):execute_reconciliation(self.admin,command)
        self.asset.refresh_from_db();self.assertEqual((self.asset.status,self.asset.custody_revision),('Crosscheck',rev));self.assertEqual(MovementReceipt.objects.count(),0)

    def test_audit_to_real_preserves_observations_flags_history_and_other_real_holder(self):
        self.event.assets.add(self.asset);self.audit.assets.add(self.asset);self.audit.crosscheck_assets.add(self.asset);self.audit.staged_assets.add(self.asset);self.audit.requirements.add(self.asset);self.audit.challan_assets.add(self.asset)
        self.asset.flag='Missing';self.asset.save();before=list(Asset.objects.values())
        target=self.target('audit_mode',event=self.audit,target_is_audit=False);self.apply(target);self.audit.refresh_from_db();self.asset.refresh_from_db()
        self.assertFalse(self.audit.is_audit);self.assertFalse(self.audit.assets.exists());self.assertFalse(self.audit.crosscheck_assets.exists());self.assertFalse(self.audit.staged_assets.exists());self.assertFalse(self.audit.requirements.exists())
        self.assertEqual(PreservedAuditObservation.objects.count(),4);self.assertTrue(self.audit.challan_assets.filter(pk=self.asset.pk).exists());self.assertTrue(self.event.assets.filter(pk=self.asset.pk).exists())
        self.assertEqual(self.asset.status,before[0]['status']);self.assertEqual(self.asset.quantity,before[0]['quantity']);self.assertEqual(self.asset.flag,'Missing')
        self.assertTrue(all(row.original_observed_at is None for row in PreservedAuditObservation.objects.all()))

    def test_audit_conversion_does_not_repair_a_phantom_status_or_allocate_seen_stock(self):
        self.audit.staged_assets.add(self.asset);self.corrupt();self.apply(self.target('audit_mode',event=self.audit,target_is_audit=False));self.asset.refresh_from_db()
        self.assertEqual(self.asset.status,'Crosscheck');self.assertFalse(self.audit.assets.exists());self.assertEqual(PhysicalMovement.objects.count(),0)
        self.apply();self.asset.refresh_from_db();self.assertEqual(self.asset.status,'Available')

    def test_real_to_audit_blocks_current_queues_then_preserves_paper(self):
        for phase in ('assets','crosscheck_assets','staged_assets','requirements'):
            getattr(self.event,phase).add(self.asset)
            with self.assertRaises(CommandError):self.apply(self.target('audit_mode',target_is_audit=True))
            getattr(self.event,phase).clear()
        self.event.challan_assets.add(self.asset);doc=ChallanDocument.objects.create(conference=self.event,scope='master',number='KEEP-PAPER')
        self.apply(self.target('audit_mode',target_is_audit=True));self.event.refresh_from_db();self.assertTrue(self.event.is_audit)
        self.assertTrue(self.event.challan_assets.filter(pk=self.asset.pk).exists());self.assertTrue(ChallanDocument.objects.filter(pk=doc.pk).exists())

    def test_outstanding_bulk_consumer_and_recorded_physical_history_block_mode_conversion(self):
        bulk=Asset.objects.create(sku='BULK',quantity=10,quantity_tracking=True);QuantityAllocation.objects.create(asset=bulk,conference=self.audit,reserved=2)
        with self.assertRaises(CommandError):self.apply(self.target('audit_mode',event=self.audit,target_is_audit=False))
        QuantityAllocation.objects.all().delete();consumer=Asset.objects.create(sku='TAPE',type='Consumables',quantity=10);ConsumableAllocation.objects.create(asset=consumer,conference=self.audit,requested=2,state='dispatched')
        with self.assertRaises(CommandError):self.apply(self.target('audit_mode',event=self.audit,target_is_audit=False))
        ConsumableAllocation.objects.all().delete();self.audit.consumable_data={'999':{'requested':2,'status':'settled'}};self.audit.save()
        with self.assertRaises(CommandError):self.apply(self.target('audit_mode',event=self.audit,target_is_audit=False))
        self.move('stage');self.move('dispatch');self.event.assets.clear()
        with self.assertRaises(CommandError):self.apply(self.target('audit_mode',target_is_audit=True))

    def test_generic_mode_switch_refused_even_when_empty_but_creation_can_be_audit(self):
        self.event.refresh_from_db();response=self.client.patch(f'/api/conferences/{self.event.pk}/',{'is_audit':True,'expected_revision':self.event.revision},format='json')
        self.assertEqual(response.status_code,409);self.assertEqual(response.data['error'],'use_reviewed_audit_conversion')
        response=self.client.post('/api/conferences/',{'name':'New audit','is_audit':True},format='json');self.assertEqual(response.status_code,201,response.data)

    def test_sealed_event_mode_conversion_is_refused(self):
        self.event.lifecycle_state='completed';self.event.save()
        with self.assertRaises(CommandError):self.apply(self.target('audit_mode',target_is_audit=True))

    def test_inverse_status_preserves_history_and_monotonic_revision(self):
        self.corrupt();result=self.apply();self.asset.refresh_from_db();rev=self.asset.custody_revision
        inverse=self.apply(self.inverse_target(result));self.asset.refresh_from_db()
        self.assertEqual(self.asset.status,'Crosscheck');self.assertGreater(self.asset.custody_revision,rev)
        self.assertEqual(ReconciliationHistory.objects.count(),2);self.assertEqual(inverse['history']['reverses'],result['history']['id'])
        with self.assertRaises(CommandError):self.apply(self.inverse_target(result))
        with self.assertRaises(CommandError):self.apply(self.inverse_target(inverse))

    def test_inverse_audit_mode_restores_only_observations_never_real_allocations(self):
        self.audit.assets.add(self.asset);self.audit.crosscheck_assets.add(self.asset);self.audit.staged_assets.add(self.asset)
        self.event.assets.add(self.asset);self.asset.refresh_from_db();status=self.asset.status
        result=self.apply(self.target('audit_mode',event=self.audit,target_is_audit=False));self.apply(self.inverse_target(result))
        self.audit.refresh_from_db();self.asset.refresh_from_db();self.assertTrue(self.audit.is_audit)
        self.assertTrue(self.audit.assets.filter(pk=self.asset.pk).exists());self.assertTrue(self.event.assets.filter(pk=self.asset.pk).exists());self.assertEqual(self.asset.status,status)
        self.assertEqual(PreservedAuditObservation.objects.count(),3)

    def test_later_metadata_restored_to_same_value_still_blocks_inverse(self):
        self.corrupt();result=self.apply();self.asset.refresh_from_db();original=self.asset.description
        self.asset.description='Intervening edit';self.asset.save();self.asset.description=original;self.asset.save()
        with self.assertRaises(CommandError):self.apply(self.inverse_target(result))
        self.assertEqual(ReconciliationHistory.objects.count(),1)

    def test_intervening_packing_in_a_new_event_then_cleared_still_blocks_inverse(self):
        self.corrupt();result=self.apply();new=Conference.objects.create(name='Intervening event');self.move('stage',event=new);self.move('unstage',event=new)
        with self.assertRaises(CommandError):self.apply(self.inverse_target(result))

    def test_new_dependency_during_lock_collection_stops_entire_mode_conversion(self):
        self.audit.staged_assets.add(self.asset);target=self.target('audit_mode',event=self.audit,target_is_audit=False);command=self.command(target)
        extra=Asset.objects.create(sku='NEW-OBSERVATION');self.audit.staged_assets.add(extra)
        with self.assertRaises(CommandError):execute_reconciliation(self.admin,command)
        self.audit.refresh_from_db();self.assertTrue(self.audit.is_audit);self.assertEqual(PreservedAuditObservation.objects.count(),0)

    def test_legacy_return_records_review_time_with_unknown_original_dates_and_allows_completion(self):
        self.event.challan_assets.add(self.asset);self.corrupt();result=self.apply(self.target('legacy_return'))
        row=PhysicalMovement.objects.get();self.assertEqual(row.action,'legacy_return_review');self.assertIsNone(row.snapshot['original_return_at']);self.assertIsNone(row.snapshot['original_dispatch_at']);self.assertIsNotNone(row.created_at)
        review=build_review(Conference.objects.get(pk=self.event.pk));self.assertTrue(review['can_complete'])
        execute_lifecycle_command(self.admin,self.event.pk,{'request_id':str(uuid.uuid4()),'action':'complete','expected_revision':review['revision'],'expected_snapshot_sha256':review['snapshot_sha256'],'reason':'Verified reviewed legacy return','confirmed':True})
        with self.assertRaises(CommandError):self.apply(self.inverse_target(result))

    def test_legacy_return_cannot_release_real_or_staff_custody_or_unsupported_quantities(self):
        self.event.challan_assets.add(self.asset);other=Conference.objects.create(name='Actual holder');other.assets.add(self.asset)
        with self.assertRaises(CommandError):self.apply(self.target('legacy_return'))
        other.assets.clear();employee=Employee.objects.create(name='Actual custodian',employee_id='ACTUAL',department='Ops',phone='-');self.asset.assigned_to=employee;self.asset.save()
        with self.assertRaises(CommandError):self.apply(self.target('legacy_return'))
        self.asset.assigned_to=None;self.asset.quantity=3;self.asset.save()
        with self.assertRaises(CommandError):self.apply(self.target('legacy_return'))

    def test_legacy_return_requires_source_reference_and_cannot_replace_recorded_or_supplier_returns(self):
        with self.assertRaises(CommandError):self.apply(self.target('legacy_return'))
        self.event.challan_assets.add(self.asset);supplier=SubrentalCompany.objects.create(name='Supplier');ticket=SubrentalTicket.objects.create(company=supplier,conference=self.event);SubrentalTicketItem.objects.create(ticket=ticket,asset=self.asset)
        with self.assertRaises(CommandError):self.apply(self.target('legacy_return'))
        SubrentalTicketItem.objects.all().delete();self.move('stage');self.move('dispatch');self.move('return');self.move('verify_return')
        with self.assertRaises(CommandError):self.apply(self.target('legacy_return'))

    def test_legacy_return_inverse_appends_revocation_without_deleting_evidence(self):
        self.event.challan_assets.add(self.asset);self.corrupt();result=self.apply(self.target('legacy_return'));self.apply(self.inverse_target(result))
        self.assertEqual(PhysicalMovement.objects.count(),2);self.assertEqual(PhysicalMovement.objects.order_by('pk').last().action,'legacy_return_review_revoked')
        review=build_review(Conference.objects.get(pk=self.event.pk));self.assertFalse(review['can_complete']);self.asset.refresh_from_db();self.assertEqual(self.asset.status,'Crosscheck')

    def test_protected_reconciliation_targets_and_observations_cannot_be_deleted(self):
        self.audit.staged_assets.add(self.asset);self.apply(self.target('audit_mode',event=self.audit,target_is_audit=False))
        for obj in (self.asset,self.audit,self.admin,MovementReceipt.objects.first(),ReconciliationHistory.objects.first()):
            with self.assertRaises(ProtectedError):obj.delete()
        self.audit.refresh_from_db();self.assertEqual(self.client.delete(f'/api/conferences/{self.audit.pk}/',{'expected_revision':self.audit.revision},format='json').status_code,409)

    def test_metadata_and_membership_versions_are_server_owned(self):
        self.asset.refresh_from_db();rev=self.asset.custody_revision
        response=self.client.patch(f'/api/assets/{self.asset.pk}/',{'description':'Normal metadata','custody_revision':0},format='json');self.assertEqual(response.status_code,200,response.data)
        self.asset.refresh_from_db();self.assertGreater(self.asset.custody_revision,rev);rev=self.asset.custody_revision
        self.audit.staged_assets.add(self.asset);self.asset.refresh_from_db();self.assertGreater(self.asset.custody_revision,rev)

    def test_http_recovery_never_runs_schema_migrations(self):
        self.admin.is_superuser=True;self.admin.save()
        with patch('django.core.management.call_command') as migrate:
            response=self.client.post('/api/system-recovery/',{},format='json')
        self.assertEqual(response.status_code,409);migrate.assert_not_called()

    def test_current_projection_is_pure_and_recovers_after_role_downgrade(self):
        self.event.challan_assets.add(self.asset);self.corrupt();result=self.apply()
        self.admin.profile.role='accounts';self.admin.profile.save();self.asset.description='Later current metadata';self.asset.save()
        before=list(Asset.objects.values());response=self.client.post('/api/reconciliation/current-state/',{'asset_ids':[self.asset.pk],'conference_ids':[self.event.pk]},format='json')
        self.assertEqual(response.status_code,200,response.data);self.assertEqual(response.data['asset_states'][0]['description'],'Later current metadata')
        self.assertEqual(list(Asset.objects.values()),before);self.assertNotEqual(result['asset_states'][0]['description'],response.data['asset_states'][0]['description'])
        for body in ({'asset_ids':[{}],'conference_ids':[]},{'asset_ids':[True],'conference_ids':[]},{'asset_ids':[self.asset.pk,self.asset.pk],'conference_ids':[]}):
            self.assertEqual(self.client.post('/api/reconciliation/current-state/',body,format='json').status_code,400)

    def test_default_cli_preview_is_private_no_overwrite_and_never_applies(self):
        self.corrupt();command=self.command();name=str(connection.settings_dict['NAME'])
        with tempfile.TemporaryDirectory(prefix='tt-reviewed-cli-') as directory:
            target=Path(directory)/'target.json';target.write_text(json.dumps(command['target']));output=Path(directory)/'preview.json'
            call_command('review_custody_reconciliation',target=str(target),expected_database=name,expected_instance='synthetic-memory-step5d',output=str(output),stdout=StringIO())
            self.assertEqual(os.stat(output).st_mode&0o777,0o600);self.assertFalse(json.loads(output.read_text())['committed'])
            with self.assertRaises(ManagementError):call_command('review_custody_reconciliation',target=str(target),expected_database=name,expected_instance='wrong-instance',stdout=StringIO())
            with self.assertRaises(ManagementError):call_command('review_custody_reconciliation',target=str(target),expected_database=name,expected_instance='synthetic-memory-step5d',output=str(output),stdout=StringIO())
            self.assertEqual(ReconciliationHistory.objects.count(),0)
            with self.assertRaises(ManagementError):call_command('review_custody_reconciliation',packet=str(target),apply=True,actor=self.admin.pk,expected_database=name,expected_instance='synthetic-memory-step5d',stdout=StringIO())

    def test_generic_asset_edit_cannot_clear_an_unproved_lock_without_review(self):
        self.corrupt();before=Asset.objects.get(pk=self.asset.pk).custody_revision
        response=self.client.patch(f'/api/assets/{self.asset.pk}/',{'status':'Available'},format='json')
        self.assertEqual(response.status_code,400,response.data);self.asset.refresh_from_db()
        self.assertEqual((self.asset.status,self.asset.custody_revision),('Crosscheck',before))
        response=self.client.patch(f'/api/assets/{self.asset.pk}/',{'description':'Safe current metadata'},format='json')
        self.assertEqual(response.status_code,200,response.data);self.asset.refresh_from_db();self.assertEqual(self.asset.status,'Crosscheck')

    def test_generic_model_and_stale_metadata_import_cannot_release_an_unproved_lock(self):
        self.corrupt();self.asset.description='Stale object metadata';self.asset.status='Available';self.asset.save()
        self.asset.refresh_from_db();self.assertEqual(self.asset.status,'Crosscheck')
        self.apply();self.asset.refresh_from_db();self.assertEqual(self.asset.status,'Available')

    def test_read_snapshot_is_set_before_business_role_queries(self):
        from unittest.mock import MagicMock
        targets=[('core.reconciliation_commands.get_business_role','post','/api/reconciliation/preview/',self.target()),('core.reconciliation_commands.get_business_role','get',f'/api/conferences/{self.audit.pk}/reconciliation-review/',{}),('core.event_lifecycle.get_business_role','get',f'/api/conferences/{self.event.pk}/lifecycle-review/',{}),('core.permissions.get_business_role','get',f'/api/conferences/{self.event.pk}/custody-review/',{})]
        for module,method,url,body in targets:
            events=[];cursor=MagicMock();cursor.__enter__.return_value=cursor;cursor.execute.side_effect=lambda sql,*args:events.append(sql)
            def role(user):
                self.assertTrue(any('SET TRANSACTION ISOLATION LEVEL' in sql for sql in events));events.append('role-query');return 'technician'
            with patch.object(connection,'vendor','postgresql'),patch.object(connection,'cursor',return_value=cursor),patch(module,side_effect=role):
                response=getattr(self.client,method)(url,body,format='json')
            self.assertEqual(response.status_code,403);self.assertIn('role-query',events)


@override_settings(REVIEWED_RECONCILIATION_WRITES_ENABLED=True,RECONCILIATION_INSTANCE_ID='synthetic-cli-apply')
class ReconciliationCliApplyTests(TransactionTestCase):
    def setUp(self):
        self.user=User.objects.create_user('cli-admin');self.user.profile.role='admin';self.user.profile.save();self.asset=Asset.objects.create(sku='CLI-UNIT')
        Asset.objects.filter(pk=self.asset.pk).update(status='Crosscheck');target={'action':'repair_status','asset_ids':[self.asset.pk],'conference_ids':[]};preview,_,_=prepare_preview(target)
        self.packet={'request_id':str(uuid.uuid4()),'target':target,'database':preview['database'],'expected_snapshot_sha256':preview['snapshot_sha256'],'reason':'Explicit fixture review','evidence_reference':'Synthetic verified warehouse record','confirmed':True,'custody_confirmations':{str(self.asset.pk):'warehouse'}}
    def run_cli(self,path,**extra):
        return call_command('review_custody_reconciliation',packet=str(path),apply=True,actor=self.user.pk,expected_database=str(connection.settings_dict['NAME']),expected_instance='synthetic-cli-apply',stdout=StringIO(),**extra)
    def test_exact_private_packet_apply_and_retry_create_one_history(self):
        with tempfile.TemporaryDirectory(prefix='tt-cli-apply-') as directory:
            packet=Path(directory)/'packet.json';packet.write_text(json.dumps(self.packet));output=Path(directory)/'result.json'
            self.run_cli(packet,output=str(output));self.assertTrue(json.loads(output.read_text())['committed']);self.run_cli(packet)
        self.assertEqual(ReconciliationHistory.objects.count(),1);self.asset.refresh_from_db();self.assertEqual(self.asset.status,'Available')
    def test_output_collision_stops_before_any_data_write(self):
        with tempfile.TemporaryDirectory(prefix='tt-cli-collision-') as directory:
            packet=Path(directory)/'packet.json';packet.write_text(json.dumps(self.packet));output=Path(directory)/'result.json';output.write_text('Preserve existing evidence')
            with self.assertRaises(ManagementError):self.run_cli(packet,output=str(output))
            self.assertEqual(output.read_text(),'Preserve existing evidence')
        self.assertEqual(ReconciliationHistory.objects.count(),0)
    def test_output_failure_after_commit_reports_commit_and_exact_retry_recovers(self):
        with tempfile.TemporaryDirectory(prefix='tt-cli-output-') as directory:
            packet=Path(directory)/'packet.json';packet.write_text(json.dumps(self.packet));output=Path(directory)/'result.json'
            with patch('core.management.commands.review_custody_reconciliation.os.fdopen',side_effect=OSError('Synthetic output failure')):
                with self.assertRaisesRegex(ManagementError,'Data committed=True'):self.run_cli(packet,output=str(output))
            self.run_cli(packet)
        self.assertEqual(ReconciliationHistory.objects.count(),1);self.assertEqual(MovementReceipt.objects.count(),1)


@skipUnless(connection.vendor=='postgresql','PostgreSQL reviewed-repair concurrency pending')
@override_settings(REVIEWED_RECONCILIATION_WRITES_ENABLED=True,RECONCILIATION_INSTANCE_ID='synthetic-pg-step5d')
class ReconciliationConcurrencyTests(TransactionTestCase):
    def setUp(self):
        self.user=User.objects.create_user('pg-review');self.user.profile.role='admin';self.user.profile.save();self.asset=Asset.objects.create(sku='PG-REPAIR')
        Asset.objects.filter(pk=self.asset.pk).update(status='Crosscheck')
        target={'action':'repair_status','asset_ids':[self.asset.pk],'conference_ids':[]};preview,_,_=prepare_preview(target)
        self.body={'request_id':str(uuid.uuid4()),'target':target,'database':preview['database'],'expected_snapshot_sha256':preview['snapshot_sha256'],'reason':'Reviewed PG fixture','evidence_reference':'Synthetic warehouse check','confirmed':True,'custody_confirmations':{str(self.asset.pk):'warehouse'}}
    def race(self,callbacks):
        gate=Barrier(2)
        def run(callback):
            close_old_connections();user=User.objects.get(pk=self.user.pk);gate.wait()
            try:return callback(user)
            except CommandError as error:return error.code
            finally:close_old_connections()
        with ThreadPoolExecutor(max_workers=2) as pool:return list(pool.map(run,callbacks))
    def test_two_reviewers_do_not_apply_a_stale_snapshot(self):
        other={**self.body,'request_id':str(uuid.uuid4())};self.race([lambda u:execute_reconciliation(u,self.body),lambda u:execute_reconciliation(u,other)])
        self.assertEqual(ReconciliationHistory.objects.count(),1)
    def test_same_review_uuid_creates_one_receipt_and_history(self):
        result=self.race([lambda u:execute_reconciliation(u,self.body)]*2);self.assertEqual(ReconciliationHistory.objects.count(),1);self.assertEqual(sum(r['replayed'] for r in result),1)
    def test_repair_vs_real_dispatch_never_releases_a_real_holder(self):
        event=Conference.objects.create(name='Racing event')
        def dispatch(user):
            execute_command(user,event.pk,{'request_id':str(uuid.uuid4()),'action':'stage','asset_ids':[self.asset.pk]})
            return execute_command(user,event.pk,{'request_id':str(uuid.uuid4()),'action':'dispatch','asset_ids':[self.asset.pk]})
        self.race([lambda u:execute_reconciliation(u,self.body),dispatch])
        self.asset.refresh_from_db();self.assertFalse(event.assets.filter(pk=self.asset.pk).exists() and self.asset.status=='Available')
