"""Disposable manifest conservation/retry/correction tests. No customer settings."""
import copy
import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest import skipUnless
from unittest.mock import patch
from django.contrib.auth.models import User
from django.db import connection, close_old_connections
from django.test import TestCase, TransactionTestCase
from rest_framework.test import APIClient

from .asset_commands import CommandError, execute_command
from .challan_documents import save_document, document_data
from .consumable_commands import execute_consumable_command
from .quantity_commands import execute_quantity_command
from .truck_manifests import execute_manifest_command
from .models import (Asset, Conference, QuantityAllocation, ConsumableAllocation, SubrentalCompany,
    SubrentalTicket, SubrentalTicketItem, ChallanDocument, ChallanLine, ChallanRevision,
    TruckChallan, TruckManifest, TruckManifestEntry, MovementReceipt, CompanySettings)


class ManifestTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user('manifest-admin'); self.user.profile.role='admin'; self.user.profile.save()
        self.event = Conference.objects.create(name='Manifest event', challan_number='MANIFEST-1', vehicle_number='INITIAL', challan_date='2026-10-13')
        self.bulk = Asset.objects.create(sku='BULK', quantity=100, quantity_tracking=True)
        self.consume = Asset.objects.create(sku='TAPE', type='Consumables', quantity=5)
        self.physical = Asset.objects.create(sku='PHYSICAL', quantity=1)
        self.rental = Asset.objects.create(sku='RENTAL', quantity=20)
        QuantityAllocation.objects.create(asset=self.bulk, conference=self.event, dispatched=6, dispatched_total=6)
        ConsumableAllocation.objects.create(asset=self.consume, conference=self.event, requested=8, returned=3, consumed=5, state='settled')
        self.event.assets.add(self.bulk,self.physical);self.event.challan_assets.add(self.bulk,self.physical)
        supplier = SubrentalCompany.objects.create(name='AM supplier')
        ticket = SubrentalTicket.objects.create(company=supplier, conference=self.event)
        item = SubrentalTicketItem.objects.create(ticket=ticket, asset=self.rental, quantity=3, rental_price='12.50')
        self.lines = [self.line(self.bulk,6),self.line(self.consume,8),self.line(self.physical,1),
            self.line(self.rental,3,source_kind='supplier',supplier_id=supplier.pk,ticket_item_id=item.pk),self.line(None,4)]
        self.event.refresh_from_db()
        self.master = save_document(self.user,self.event.pk,'master',{'request_id':str(uuid.uuid4()),'expected_revision':0,
            'expected_event_revision':self.event.revision,'number':'MANIFEST-1','document_date':'2026-10-13','lines':self.lines})['document']
        self.client=APIClient();self.client.force_authenticate(self.user)

    def line(self,asset,quantity,**fields):
        return {'id':str(uuid.uuid4()),'asset_id':asset.pk if asset else None,'source_kind':'owned' if asset else 'manual',
            'ticket_item_id':None,'supplier_id':None,'snapshot':{'alias_name':asset.sku if asset else 'Manual cable'},'quantity':quantity,'unit_value':'10.25',**fields}

    def command(self,action,**fields):
        self.event.refresh_from_db()
        return {'request_id':str(uuid.uuid4()),'action':action,'expected_event_revision':self.event.revision,
            'expected_document_revisions':{doc.scope:doc.revision for doc in self.event.challan_documents.all()},**fields}

    def run_command(self,action,**fields):return execute_manifest_command(self.user,self.event.pk,self.command(action,**fields))
    def start(self):
        result=self.run_command('start');self.trucks=list(self.event.truck_challans.order_by('truck_number'));return result
    def move(self,index=0,quantity=2,**fields):
        return self.run_command('move',from_truck_id=self.trucks[0].pk,to_truck_id=self.trucks[1].pk,
            items=[{'master_line_id':self.lines[index]['id'],'quantity':quantity}],**fields)
    def stock(self):return list(Asset.objects.order_by('pk').values_list('quantity',flat=True))

    def test_start_copies_all_sources_once_and_allocates_distinct_numbers(self):
        before=self.stock();result=self.start()
        self.assertEqual(self.stock(),before);self.assertEqual(len(result['conference']['truck_manifest']['entries']),5)
        self.assertEqual(self.trucks[0].challan_number,self.master['number']);self.assertNotEqual(self.trucks[1].challan_number,self.master['number'])
        first=self.event.challan_documents.get(truck=self.trucks[0]);self.assertEqual(first.lines.count(),5)
        self.assertEqual(self.event.challan_documents.get(truck=self.trucks[1]).lines.count(),0)
        self.assertEqual(self.event.challan_documents.get(scope='master').revision,1)

    def test_partial_bulk_consumable_supplier_and_manual_transfer_conserves_each_source(self):
        self.start();before=self.stock()
        for index,quantity in ((0,2),(1,3),(3,1),(4,2)):self.move(index,quantity)
        self.assertEqual(self.stock(),before)
        for line in self.lines:self.assertEqual(sum(TruckManifestEntry.objects.filter(master_line_id=line['id']).values_list('quantity',flat=True)),line['quantity'])
        self.assertEqual(self.event.challan_documents.get(scope='master').lines.count(),5)
        self.assertEqual(self.event.challan_documents.get(truck=self.trucks[1]).lines.count(),4)

    def test_exact_retry_and_changed_payload_reuse(self):
        command=self.command('start');first=execute_manifest_command(self.user,self.event.pk,command)
        second=execute_manifest_command(self.user,self.event.pk,copy.deepcopy(command));self.assertTrue(second['replayed'])
        self.assertEqual(TruckChallan.objects.count(),2);self.assertEqual(first['conference'],second['conference'])
        command['action']='add'
        with self.assertRaises(CommandError):execute_manifest_command(self.user,self.event.pk,command)

    def test_move_receipt_survives_actor_role_change_and_new_moves_are_denied(self):
        self.start();command=self.command('move',from_truck_id=self.trucks[0].pk,to_truck_id=self.trucks[1].pk,items=[{'master_line_id':self.lines[0]['id'],'quantity':2}])
        execute_manifest_command(self.user,self.event.pk,command)
        self.user.profile.role='technician';self.user.profile.save()
        self.assertTrue(execute_manifest_command(self.user,self.event.pk,command)['replayed'])
        with self.assertRaises(CommandError) as error:self.move()
        self.assertEqual(error.exception.status,403)

    def test_stale_event_or_missing_document_revision_rejects_without_distribution(self):
        self.start();before=list(TruckManifestEntry.objects.values_list('quantity',flat=True))
        command=self.command('add');command['expected_event_revision']-=1
        with self.assertRaises(CommandError):execute_manifest_command(self.user,self.event.pk,command)
        command=self.command('add');command['expected_document_revisions'].pop('master')
        with self.assertRaises(CommandError):execute_manifest_command(self.user,self.event.pk,command)
        self.assertEqual(list(TruckManifestEntry.objects.values_list('quantity',flat=True)),before)

    def test_invalid_batch_unknown_source_foreign_truck_and_overdraw_roll_back(self):
        self.start();before=list(TruckManifestEntry.objects.values_list('quantity',flat=True));receipts=MovementReceipt.objects.count()
        for fields in ({'items':[{'master_line_id':str(uuid.uuid4()),'quantity':1}]},
            {'items':[{'master_line_id':self.lines[0]['id'],'quantity':7}]},
            {'items':[{'master_line_id':self.lines[0]['id'],'quantity':True}]}, {'to_truck_id':99999}):
            command=self.command('move',from_truck_id=self.trucks[0].pk,to_truck_id=self.trucks[1].pk,items=[{'master_line_id':self.lines[0]['id'],'quantity':1}]);command.update(fields)
            with self.assertRaises(CommandError):execute_manifest_command(self.user,self.event.pk,command)
        self.assertEqual(list(TruckManifestEntry.objects.values_list('quantity',flat=True)),before);self.assertEqual(MovementReceipt.objects.count(),receipts)

    def test_late_destination_write_failure_rolls_back_source_documents_entries_and_receipt(self):
        self.start();before=list(TruckManifestEntry.objects.values_list('quantity',flat=True));docs=[document_data(doc) for doc in self.event.challan_documents.order_by('scope')];receipts=MovementReceipt.objects.count()
        original=ChallanRevision.objects.create;calls=[]
        def fail_second(**kwargs):
            calls.append(kwargs)
            if len(calls)==2:raise RuntimeError('synthetic destination disk failure')
            return original(**kwargs)
        with patch('core.truck_manifests.ChallanRevision.objects.create',side_effect=fail_second):
            with self.assertRaises(RuntimeError):self.move()
        self.assertEqual(list(TruckManifestEntry.objects.values_list('quantity',flat=True)),before)
        self.assertEqual([document_data(doc) for doc in self.event.challan_documents.order_by('scope')],docs);self.assertEqual(MovementReceipt.objects.count(),receipts)

    def test_initial_creation_failure_rolls_back_trucks_and_numbers(self):
        with patch('core.truck_manifests.write_truck',side_effect=RuntimeError('synthetic disk')):
            with self.assertRaises(RuntimeError):self.start()
        self.assertFalse(TruckManifest.objects.exists());self.assertFalse(TruckChallan.objects.exists())
        self.assertEqual(ChallanDocument.objects.count(),1)

    def test_unassigned_is_documentary_not_stock_release(self):
        self.start();before=self.stock()
        self.run_command('move',from_truck_id=self.trucks[0].pk,to_truck_id=None,items=[{'master_line_id':self.lines[4]['id'],'quantity':2}])
        self.run_command('move',from_truck_id=None,to_truck_id=self.trucks[1].pk,items=[{'master_line_id':self.lines[4]['id'],'quantity':2}])
        self.assertEqual(self.stock(),before);self.assertEqual(self.event.challan_documents.get(scope='master').lines.get(pk=self.lines[4]['id']).quantity,4)

    def test_issue_captures_current_vehicle_then_corrections_preserve_history_header_and_number(self):
        self.start();truck=self.trucks[0];truck.vehicle_number='UPDATED';truck.save()
        self.run_command('issue',truck_id=truck.pk,document_date='2026-10-13')
        document=self.event.challan_documents.get(truck=truck);first=document_data(document)
        self.assertEqual(first['header']['vehicle_number'],'UPDATED')
        with self.assertRaises(CommandError):self.move()
        self.move(reason='Moved two cables to second vehicle');document.refresh_from_db()
        self.assertEqual(document.header,first['header']);self.assertEqual(document.number,first['number'])
        self.assertEqual(document.history.get(revision=2).snapshot,first)

    def test_empty_truck_cannot_issue_and_add_retry_creates_one_empty_truck(self):
        self.start()
        with self.assertRaises(CommandError):self.run_command('issue',truck_id=self.trucks[1].pk,document_date='2026-10-13')
        command=self.command('add');execute_manifest_command(self.user,self.event.pk,command);execute_manifest_command(self.user,self.event.pk,command)
        self.assertEqual(TruckChallan.objects.count(),3)

    def test_save_master_revises_truck_snapshots_without_replacing_source_identity(self):
        self.start();master=document_data(self.event.challan_documents.get(scope='master'));line_id=master['lines'][0]['id']
        self.event.refresh_from_db()
        draft={'request_id':str(uuid.uuid4()),'expected_revision':master['revision'],'expected_event_revision':self.event.revision,
            'lines':master['lines'],'number':master['number'],'document_date':'2026-10-13','state':'draft','total_override':None}
        draft['lines'][0]['snapshot']['alias_name']='Printed cable correction'
        result=self.run_command('save_master',document=draft)
        self.assertEqual(result['document']['lines'][0]['id'],line_id)
        self.assertEqual(self.event.challan_documents.get(truck=self.trucks[0]).lines.get(asset=self.bulk).snapshot['alias_name'],'Printed cable correction')
        self.assertEqual(self.stock(),[100,5,1,20])

    def test_master_reduction_below_assigned_fails_and_deallocated_manual_removal_preserves_history(self):
        self.start();master=document_data(self.event.challan_documents.get(scope='master'))
        def draft():
            self.event.refresh_from_db()
            return {'request_id':str(uuid.uuid4()),'expected_revision':master['revision'],'expected_event_revision':self.event.revision,
                'lines':copy.deepcopy(master['lines']),'number':master['number']}
        changed=draft();changed['lines'][0]['quantity']=5
        with self.assertRaises(CommandError):self.run_command('save_master',document=changed)
        self.run_command('move',from_truck_id=self.trucks[0].pk,to_truck_id=None,items=[{'master_line_id':self.lines[4]['id'],'quantity':4}])
        changed=draft();changed['lines']=[line for line in changed['lines'] if line['id']!=self.lines[4]['id']]
        self.run_command('save_master',document=changed)
        self.assertFalse(ChallanLine.objects.filter(pk=self.lines[4]['id']).exists())
        self.assertTrue(any(line['id']==self.lines[4]['id'] for line in self.event.challan_documents.get(scope='master').history.get(revision=1).snapshot['lines']))

    def test_master_edit_requires_reason_when_truck_copy_issued(self):
        self.start();self.run_command('issue',truck_id=self.trucks[0].pk,document_date='2026-10-13')
        master=document_data(self.event.challan_documents.get(scope='master'));self.event.refresh_from_db()
        draft={'request_id':str(uuid.uuid4()),'expected_revision':master['revision'],'expected_event_revision':self.event.revision,
            'lines':master['lines'],'number':master['number']}
        with self.assertRaises(CommandError):self.run_command('save_master',document=draft)
        draft['correction_reason']='Reviewed rate correction';self.run_command('save_master',document=draft)

    def test_legacy_trucks_and_unproved_bulk_cannot_initialize(self):
        TruckChallan.objects.create(conference=self.event,truck_number=1)
        with self.assertRaises(CommandError):self.start()
        TruckChallan.objects.all().delete();QuantityAllocation.objects.all().delete()
        with self.assertRaises(CommandError) as error:self.start()
        self.assertEqual(error.exception.code,'legacy_quantity_requires_reconciliation')

    def test_generic_routes_cannot_bypass_managed_document_and_membership(self):
        self.start();self.event.refresh_from_db()
        response=self.client.post(f'/api/conferences/{self.event.pk}/trucks/',{'expected_revision':self.event.revision},format='json');self.assertEqual(response.status_code,409)
        response=self.client.patch(f'/api/truck-challans/{self.trucks[0].pk}/',{'expected_revision':self.event.revision,'assets':[]},format='json');self.assertEqual(response.status_code,409)
        with self.assertRaises(CommandError):save_document(self.user,self.event.pk,'master',{'request_id':str(uuid.uuid4()),'expected_revision':1,'expected_event_revision':self.event.revision,'lines':self.lines})

    def test_bulk_return_and_verified_release_preserve_manifest_delivery_quantity(self):
        self.start();self.event.refresh_from_db()
        for action in ('return','verify_return'):
            self.event.refresh_from_db();execute_quantity_command(self.user,self.event.pk,{'request_id':str(uuid.uuid4()),'action':action,
                'expected_revision':self.event.revision,'items':[{'asset_id':self.bulk.pk,'quantity':2}]})
        self.assertEqual(self.event.challan_documents.get(truck=self.trucks[0]).lines.get(asset=self.bulk).quantity,6)
        self.assertEqual(self.stock()[0],100)

    def test_physical_dispatch_cannot_add_an_unrecorded_truck_membership(self):
        self.start();new=Asset.objects.create(sku='NEW-PHYSICAL');self.event.staged_assets.add(new)
        execute_command(self.user,self.event.pk,{'request_id':str(uuid.uuid4()),'action':'dispatch','asset_ids':[new.pk]})
        self.assertTrue(self.event.assets.filter(pk=new.pk).exists());self.assertFalse(self.trucks[1].assets.filter(pk=new.pk).exists())

    def test_managed_consumable_settlement_keeps_recorded_delivery_and_debits_once(self):
        row=ConsumableAllocation.objects.get();row.state='dispatched';row.consumed=0;row.returned=None;row.save()
        Asset.objects.filter(pk=self.consume.pk).update(quantity=10)
        self.start();self.event.refresh_from_db()
        command={'request_id':str(uuid.uuid4()),'action':'settle','expected_revision':self.event.revision,
            'items':[{'asset_id':self.consume.pk,'requested':8,'returned':3,'confirmed':True}]}
        execute_consumable_command(self.user,self.event.pk,command);execute_consumable_command(self.user,self.event.pk,command)
        self.assertEqual(Asset.objects.get(pk=self.consume.pk).quantity,5)
        self.assertEqual(self.event.challan_documents.get(truck=self.trucks[0]).lines.get(asset=self.consume).quantity,8)

    def test_master_total_override_cannot_silently_disagree_with_split_values(self):
        document=self.event.challan_documents.get(scope='master');document.total_override=0;document.save()
        with self.assertRaises(CommandError) as error:self.start()
        self.assertEqual(error.exception.code,'master_total_override_requires_review');self.assertFalse(TruckManifest.objects.exists())

    def test_managed_reservation_reduction_rolls_back_until_master_is_revised(self):
        allocation=QuantityAllocation.objects.get();allocation.dispatched=0;allocation.dispatched_total=0;allocation.reserved=6;allocation.save()
        self.start();self.event.refresh_from_db()
        with self.assertRaises(CommandError):execute_quantity_command(self.user,self.event.pk,{'request_id':str(uuid.uuid4()),'action':'unstage',
            'expected_revision':self.event.revision,'items':[{'asset_id':self.bulk.pk,'quantity':1}]})
        self.assertEqual(QuantityAllocation.objects.get().reserved,6)

    def test_partial_dispatch_preserves_sent_plus_still_reserved_capacity(self):
        allocation=QuantityAllocation.objects.get();allocation.dispatched=0;allocation.dispatched_total=0;allocation.reserved=6;allocation.save()
        self.start();self.event.refresh_from_db()
        execute_quantity_command(self.user,self.event.pk,{'request_id':str(uuid.uuid4()),'action':'dispatch','expected_revision':self.event.revision,
            'items':[{'asset_id':self.bulk.pk,'quantity':2}]})
        allocation.refresh_from_db();self.assertEqual((allocation.dispatched_total,allocation.reserved),(2,4))
        self.assertEqual(self.event.challan_documents.get(scope='master').lines.get(asset=self.bulk).quantity,6)

    def test_metadata_draft_refresh_and_issued_header_history(self):
        self.start();truck=self.trucks[0]
        self.run_command('metadata',truck_id=truck.pk,vehicle_number='NEW-VEHICLE',driver_phone='0000')
        doc=self.event.challan_documents.get(truck=truck);self.assertEqual(doc.header['vehicle_number'],'NEW-VEHICLE')
        self.run_command('issue',truck_id=truck.pk,document_date='2026-10-13');doc.refresh_from_db();before=document_data(doc)
        self.run_command('metadata',truck_id=truck.pk,vehicle_number='NEXT-VEHICLE')
        doc.refresh_from_db();self.assertEqual(document_data(doc),before)


@skipUnless(connection.vendor=='postgresql','Requires explicitly disposable PostgreSQL; SQLite cannot prove locking')
class ManifestConcurrencyTests(TransactionTestCase):
    def test_competing_initializations(self):
        case=ManifestTests();case.setUp();event=case.event;user=case.user
        barrier=Barrier(2)
        commands=[case.command('start') for _ in range(2)]
        def run(command):
            close_old_connections();barrier.wait()
            try:execute_manifest_command(User.objects.get(pk=user.pk),event.pk,command);return 'saved'
            except CommandError:return 'conflict'
            finally:close_old_connections()
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(run,commands))
        self.assertEqual(sorted(results),['conflict','saved']);self.assertEqual(TruckChallan.objects.count(),2)

    def test_competing_transfers_do_not_overdraw_one_source(self):
        case=ManifestTests();case.setUp();case.start();barrier=Barrier(2)
        commands=[case.command('move',from_truck_id=case.trucks[0].pk,to_truck_id=case.trucks[1].pk,
            items=[{'master_line_id':case.lines[0]['id'],'quantity':4}]) for _ in range(2)]
        def run(command):
            close_old_connections();barrier.wait()
            try:execute_manifest_command(User.objects.get(pk=case.user.pk),case.event.pk,command);return 'saved'
            except CommandError:return 'conflict'
            finally:close_old_connections()
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(run,commands))
        self.assertEqual(sorted(results),['conflict','saved'])
        self.assertEqual(sum(TruckManifestEntry.objects.filter(master_line_id=case.lines[0]['id']).values_list('quantity',flat=True)),6)
