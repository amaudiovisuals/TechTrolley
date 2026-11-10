"""Production delivery snapshots across the audited stock/document upgrade."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import date
from threading import Barrier
from unittest import skipUnless
from uuid import uuid4
from django.contrib.auth.models import User
from django.db import connection, close_old_connections
from django.db.models.deletion import ProtectedError
from django.test import TestCase, TransactionTestCase
from rest_framework.test import APIClient
from .challan_documents import capture_header
from .models import (Asset, ChallanDocument, ChallanLine, CompanySettings, Conference,
    ProgramDelivery, SubrentalCompany, SubrentalTicket, SubrentalTicketItem, TruckChallan, UserProfile)
from .quantity_commands import execute_quantity_command
from .consumable_commands import execute_consumable_command

def reviewed(event, assets, truck=None):
    doc=ChallanDocument.objects.create(conference=event,truck=truck,scope=f'truck-{truck.pk}' if truck else 'master',
        number=f'REVIEWED-{uuid4()}',header=capture_header(event,truck),revision=1)
    for position,asset in enumerate(assets):
        ChallanLine.objects.create(document=doc,asset=asset,supplier=asset.subrental_company,
            source_kind='supplier' if asset.subrental_company_id else 'owned',quantity=1,unit_value=0,position=position,
            snapshot={'sku':asset.sku,'alias_name':asset.alias_name,'serial_number':asset.serial_number or '',
                'supplier_name':asset.subrental_company.name if asset.subrental_company_id else ''})
    return doc

class ProgramDeliveryTests(TestCase):
    def setUp(self):
        user=User.objects.create_user('warehouse')
        UserProfile.objects.filter(user=user).update(role='godown_incharge')
        self.user=User.objects.get(pk=user.pk);self.client=APIClient();self.client.force_authenticate(self.user)
        self.settings=CompanySettings.objects.create(name='Pvt Ltd original',address='Original address')
        self.company=SubrentalCompany.objects.create(name='AM original',address='Supplier address',inventory_mode='shared_warehouse')
        self.other=SubrentalCompany.objects.create(name='Other supplier',inventory_mode='shared_warehouse')
        self.event=Conference.objects.create(name='Program original',association_name='Customer original',billing_address='Customer address')
        self.own=Asset.objects.create(sku='OWN',alias_name='Owned speaker')
        self.supplier=Asset.objects.create(sku='AM-QR',alias_name='Supplier speaker',serial_number='ORIGINAL-SERIAL',subrental_company=self.company)
        self.event.challan_assets.add(self.own,self.supplier)
        self.document=reviewed(self.event,[self.own,self.supplier]);self.url=f'/api/conferences/{self.event.pk}/deliveries/'
    def preview(self,suffix=''):return self.client.get(self.url+'preview/'+suffix)
    def payload(self,preview=None,**updates):
        if preview is None:
            response=self.preview();self.assertEqual(response.status_code,200,response.data);preview=response.data
        body={'request_key':str(uuid4()),'source_hash':preview['source_hash'],'reference':preview['suggested_reference'],
            'delivery_date':'2026-11-03','truck_id':None,'rows':[{'key':r['key'],'quantity':r['quantity'],'name':r['name']} for r in preview['source']['rows']]}
        body.update(updates);return body
    def issue(self,body=None):return self.client.post(self.url,self.payload() if body is None else body,format='json')
    def quantity(self,action,amount):
        self.event.refresh_from_db()
        return execute_quantity_command(self.user,self.event.pk,{'request_id':str(uuid4()),'action':action,
            'expected_revision':self.event.revision,'items':[{'asset_id':self.supplier.pk,'quantity':amount}]})
    def consume(self,action,returned=None,confirmed=False):
        self.event.refresh_from_db()
        return execute_consumable_command(self.user,self.event.pk,{'request_id':str(uuid4()),'action':action,
            'expected_revision':self.event.revision,'items':[{'asset_id':self.supplier.pk,'requested':4,'returned':returned,'confirmed':confirmed}]})
    def test_customer_and_each_supplier_paper_use_saved_quantities_only(self):
        unit=Asset.objects.create(sku='OTHER',subrental_company=self.other)
        ChallanLine.objects.create(document=self.document,asset=unit,supplier=self.other,source_kind='supplier',quantity=1,unit_value=0,position=2,snapshot={'sku':unit.sku,'supplier_name':self.other.name})
        result=self.issue();self.assertEqual(result.status_code,201,result.data);snap=result.data['snapshot']
        self.assertEqual(len(snap['customer_document']['rows']),3);self.assertEqual(len(snap['supplier_documents']),2)
        am=next(d for d in snap['supplier_documents'] if d['issuer']['name']==self.company.name)
        self.assertEqual(am['recipient']['name'],self.settings.name);self.assertEqual(am['rows'][0]['sku'],'AM-QR')
        self.assertNotIn('price',str(am).lower());self.assertEqual(Asset.objects.count(),3)
    def test_retry_reprint_and_preupgrade_snapshots_stay_frozen(self):
        body=self.payload();first=self.issue(body);self.assertEqual(first.status_code,201,first.data);original=deepcopy(first.data['snapshot'])
        self.settings.name='Renamed';self.settings.save();self.company.name='Renamed supplier';self.company.save()
        self.supplier.alias_name='Changed';self.supplier.item_price=999;self.supplier.save()
        self.event.lifecycle_state='completed';self.event.save()
        retry=self.issue(body);self.assertEqual(retry.status_code,200,retry.data);self.assertEqual(retry.data['snapshot'],original)
        self.assertEqual(self.client.get(self.url).data[0]['snapshot'],original)
        old={'version':1,'customer_document':{'number':'OLD','rows':[]},'supplier_documents':[]}
        ProgramDelivery.objects.create(conference=self.event,request_key=uuid4(),request_hash='old',reference='Preupgrade',snapshot=old,issued_by='Recorded operator')
        self.assertEqual(self.client.get(self.url).data[0]['snapshot'],old)

    def test_locked_pair_requires_admin_and_replacement_uses_frozen_issuer(self):
        body = self.payload()
        issued = self.issue(body)
        self.assertEqual(issued.status_code, 201)
        delivery = issued.data
        self.event.end_date = date(2020, 1, 1)
        self.event.save(update_fields=['end_date'])
        self.assertEqual(self.preview().status_code, 400)
        self.assertEqual(self.issue(body).status_code, 200)
        void_url = f"{self.url}{delivery['id']}/void/"
        self.assertEqual(self.client.post(void_url, {'reason': 'Wrong description'}, format='json').status_code, 403)
        admin = User.objects.create_user('delivery-corrector')
        admin.profile.role = 'admin'
        admin.profile.save()
        self.client.force_authenticate(admin)
        self.assertEqual(self.client.post(void_url, {'reason': 'Wrong description'}, format='json').status_code, 200)
        self.settings.name = 'Later company'
        self.settings.save()
        self.supplier.subrental_company = None
        self.supplier.save()
        preview = self.preview(f"?replaces_delivery_id={delivery['id']}")
        self.assertEqual(preview.status_code, 200, preview.data)
        replacement = self.payload(preview.data, replaces_delivery_id=delivery['id'], correction_reason='Correct label')
        replacement['rows'][0]['name'] = 'Corrected label'
        saved = self.issue(replacement)
        self.assertEqual(saved.status_code, 201, saved.data)
        self.assertEqual(saved.data['snapshot']['replaces_delivery_id'], delivery['id'])
        self.assertEqual(saved.data['snapshot']['customer_document']['issuer']['name'], 'Pvt Ltd original')
        self.assertNotEqual(saved.data['snapshot']['customer_document']['number'], delivery['snapshot']['customer_document']['number'])
        self.assertEqual(ProgramDelivery.objects.get(pk=delivery['id']).snapshot, delivery['snapshot'])
        self.assertEqual(self.issue(replacement).status_code, 200)
    def test_supplier_defaults_use_supplier_and_issuer_parties_but_not_customer_transport(self):
        self.settings.gst_number='PVT-GST';self.settings.save()
        self.company.gst_number='SUPPLIER-GST';self.company.save()
        self.event.transport_address='Customer venue';self.event.vehicle_number='CUSTOMER-TRUCK';self.event.driver_phone='111111';self.event.save()
        self.document.header=capture_header(self.event);self.document.save()
        result=self.issue();self.assertEqual(result.status_code,201,result.data)
        customer=result.data['snapshot']['customer_document'];supplier=result.data['snapshot']['supplier_documents'][0]
        self.assertEqual((customer['destination'],customer['vehicle_number'],customer['driver_phone']),('Customer venue','CUSTOMER-TRUCK','111111'))
        self.assertEqual((supplier['issuer']['name'],supplier['issuer']['address'],supplier['issuer']['gst_number']),('AM original','Supplier address','SUPPLIER-GST'))
        self.assertEqual((supplier['recipient']['name'],supplier['recipient']['address'],supplier['recipient']['gst_number']),('Pvt Ltd original','Original address','PVT-GST'))
        self.assertEqual((supplier['destination'],supplier['vehicle_number'],supplier['driver_phone']),('Original address','',''))
        self.assertEqual(supplier['program'],customer['program']);self.assertEqual([row['sku'] for row in supplier['rows']],['AM-QR'])
    def test_optional_supplier_edits_are_paper_only_and_frozen_for_retry(self):
        edits={str(self.company.pk):{'issuer_address':'Paper supplier address','recipient_address':'Paper receiving address',
            'destination':'Alternate delivery point','vehicle_number':'SUPPLIER-TRUCK','driver_phone':'222222'}}
        body=self.payload(supplier_details=edits);result=self.issue(body);self.assertEqual(result.status_code,201,result.data)
        paper=result.data['snapshot']['supplier_documents'][0]
        self.assertEqual((paper['issuer']['address'],paper['recipient']['address'],paper['destination'],paper['vehicle_number'],paper['driver_phone']),
            ('Paper supplier address','Paper receiving address','Alternate delivery point','SUPPLIER-TRUCK','222222'))
        self.company.refresh_from_db();self.settings.refresh_from_db()
        self.assertEqual(self.company.address,'Supplier address');self.assertEqual(self.settings.address,'Original address')
        self.assertEqual(result.data['snapshot']['customer_document']['recipient']['address'],'Customer address')
        self.assertEqual(self.issue(body).data['snapshot'],result.data['snapshot'])
        self.assertEqual(self.issue({**body,'supplier_details':{str(self.company.pk):{'destination':'Changed retry'}}}).status_code,409)
        self.assertEqual(ProgramDelivery.objects.count(),1)
    def test_invalid_or_unselected_supplier_edits_reject_the_entire_delivery(self):
        for edits in [None,[],{str(self.other.pk):{'destination':'Wrong owner'}},
            {str(self.company.pk):{'owner_id':self.other.pk}}, {str(self.company.pk):{'vehicle_number':False}},
            {str(self.company.pk):{'issuer_name':' '}},{str(self.company.pk):{'destination':'x'*4001}}]:
            response=self.issue(self.payload(supplier_details=edits));self.assertEqual(response.status_code,400,response.data)
        self.assertEqual(ProgramDelivery.objects.count(),0)
    def test_next_delivery_new_numbers_and_reused_request_key_refusal(self):
        body=self.payload();first=self.issue(body)
        self.assertEqual(self.issue({**body,'reference':'Wrong reuse'}).status_code,409)
        second=self.issue(self.payload(reference='Tomorrow',delivery_date='2026-11-04'));self.assertEqual(second.status_code,201,second.data)
        self.assertNotEqual(first.data['snapshot']['supplier_documents'][0]['number'],second.data['snapshot']['supplier_documents'][0]['number'])
    def test_accounts_read_both_directions_but_cannot_issue_or_void(self):
        result=self.issue();self.assertEqual(result.status_code,201,result.data)
        User.objects.filter(pk=self.user.pk).update(is_staff=True);UserProfile.objects.filter(user=self.user).update(role='accounts')
        self.client.force_authenticate(User.objects.get(pk=self.user.pk))
        self.assertEqual(self.client.get(self.url).status_code,200);self.assertEqual(len(self.client.get(self.url).data[0]['snapshot']['supplier_documents']),1)
        self.assertEqual(self.preview().status_code,403);self.assertEqual(self.issue({}).status_code,403)
        self.assertEqual(self.client.post(self.url+f"{result.data['id']}/void/",{'reason':'No'},format='json').status_code,403)
    def test_anonymous_and_staff_technician_refused(self):
        self.client.force_authenticate(None);self.assertEqual(self.client.get(self.url).status_code,401)
        User.objects.filter(pk=self.user.pk).update(is_staff=True);UserProfile.objects.filter(user=self.user).update(role='technician')
        self.client.force_authenticate(User.objects.get(pk=self.user.pk));self.assertEqual(self.client.get(self.url).status_code,403)
    def test_missing_document_and_stale_event_or_document_require_review(self):
        body=self.payload();self.event.vehicle_number='Changed';self.event.save();self.assertEqual(self.issue(body).status_code,409)
        body=self.payload();self.document.revision+=1;self.document.save();self.assertEqual(self.issue(body).status_code,409)
        self.document.delete();self.assertEqual(self.preview().status_code,400);self.assertEqual(ProgramDelivery.objects.count(),0)
    def test_owner_changes_require_review_but_saved_copy_survives(self):
        old=self.issue().data['snapshot'];Asset.objects.filter(pk=self.supplier.pk).update(subrental_company=self.other)
        self.assertEqual(self.preview().status_code,400);self.assertEqual(self.client.get(self.url).data[0]['snapshot'],old)
    def test_bad_quantities_duplicates_and_foreign_rows_reject_entire_issue(self):
        body=self.payload();row=body['rows'][0]
        for rows in [[{**row,'quantity':2}],[{**row,'quantity':0}],[{**row,'quantity':1.5}],[{**row,'quantity':True}],[row,row],[{'key':'asset:999999','quantity':1}],[]]:
            self.assertEqual(self.issue({**body,'rows':rows}).status_code,400)
        self.assertEqual(ProgramDelivery.objects.count(),0)
    def test_reference_and_cross_program_key_cannot_be_duplicated(self):
        body=self.payload();self.assertEqual(self.issue(body).status_code,201)
        self.assertEqual(self.issue(self.payload(reference=body['reference'].lower())).status_code,409)
        other=Conference.objects.create(name='Other');self.assertEqual(self.client.post(f'/api/conferences/{other.pk}/deliveries/',body,format='json').status_code,409)
    def test_void_keeps_original_numbers_and_custody(self):
        issued=self.issue();path=self.url+f"{issued.data['id']}/void/"
        self.assertEqual(self.preview().data['previously_delivered'][f'asset:{self.supplier.pk}'],1)
        result=self.client.post(path,{'reason':'Correct vehicle'},format='json');self.assertEqual(result.data['snapshot'],issued.data['snapshot'])
        self.assertEqual(self.client.post(path,{'reason':'Another reason'},format='json').data['void_reason'],'Correct vehicle')
        self.assertEqual(self.preview().data['previously_delivered'],{});self.assertEqual(self.event.challan_assets.count(),2)
    def test_protected_history_does_not_release_asset_status(self):
        self.issue();self.event.assets.add(self.own);Asset.objects.filter(pk=self.own.pk).update(status='In Use');self.event.refresh_from_db()
        result=self.client.delete(f'/api/conferences/{self.event.pk}/',{'expected_revision':self.event.revision},format='json')
        self.assertEqual(result.status_code,409);self.own.refresh_from_db();self.assertEqual(self.own.status,'In Use')
        with self.assertRaises(ProtectedError):self.event.delete()
    def test_manual_lines_persist_only_on_customer_copy(self):
        line=ChallanLine.objects.create(document=self.document,source_kind='manual',quantity=2,unit_value=0,position=2,snapshot={'alias_name':'Saved manual note'})
        result=self.issue();self.assertEqual(result.status_code,201,result.data)
        self.assertIn(f'line:{line.pk}',[r['key'] for r in result.data['snapshot']['customer_document']['rows']])
        self.assertEqual(len(result.data['snapshot']['supplier_documents'][0]['rows']),1)
    def test_truck_scope_and_duplicate_inventory_ticket_refs(self):
        truck=TruckChallan.objects.create(conference=self.event,truck_number=1);truck.assets.add(self.supplier);reviewed(self.event,[self.supplier],truck)
        preview=self.preview(f'?truck_id={truck.pk}');self.assertEqual(preview.status_code,200,preview.data)
        result=self.issue(self.payload(preview.data,truck_id=truck.pk));self.assertEqual(result.status_code,201,result.data)
        self.assertEqual(len(result.data['snapshot']['customer_document']['rows']),1);self.assertEqual(self.preview('?truck_id=999999').status_code,404)
        ticket=SubrentalTicket.objects.create(company=self.company,conference=self.event);item=SubrentalTicketItem.objects.create(ticket=ticket,asset=self.supplier)
        ChallanLine.objects.create(document=self.document,asset=self.supplier,ticket_item=item,supplier=self.company,source_kind='supplier',quantity=1,unit_value=0,position=2,snapshot={})
        self.assertEqual(self.preview().status_code,400)
    def test_bulk_packet_uses_ledger_count_and_survives_return_without_cloning(self):
        Asset.objects.filter(pk=self.supplier.pk).update(quantity=100);self.quantity('stage',8);self.quantity('dispatch',6)
        self.document.lines.filter(asset=self.supplier).update(quantity=6)
        body=self.payload();result=self.issue(body);self.assertEqual(result.status_code,201,result.data)
        row=result.data['snapshot']['supplier_documents'][0]['rows'][0];self.assertEqual((row['asset_id'],row['quantity']),(self.supplier.pk,6))
        self.quantity('return',6);self.quantity('verify_return',6);self.assertEqual(self.issue(body).data['snapshot'],result.data['snapshot'])
        self.supplier.refresh_from_db();self.assertEqual(self.supplier.quantity,100);self.assertEqual(Asset.objects.filter(sku='AM-QR').count(),1)
    def test_consumable_packet_survives_single_stock_deduction(self):
        Asset.objects.filter(pk=self.supplier.pk).update(type='Consumables',quantity=10);self.consume('save');self.consume('dispatch')
        self.document.lines.filter(asset=self.supplier).update(quantity=4);body=self.payload();result=self.issue(body);self.assertEqual(result.status_code,201,result.data)
        self.consume('settle',returned=1,confirmed=True);self.supplier.refresh_from_db();self.assertEqual(self.supplier.quantity,7)
        self.assertEqual(self.issue(body).data['snapshot'],result.data['snapshot'])
        self.assertEqual(next(r for r in self.preview().data['source']['rows'] if r['asset_id']==self.supplier.pk)['quantity'],4)
    def test_audit_closed_and_unrecorded_bulk_refuse_new_issue(self):
        self.event.is_audit=True;self.event.save();self.assertEqual(self.preview().status_code,400)
        self.event.is_audit=False;self.event.lifecycle_state='completed';self.event.save();self.assertEqual(self.preview().status_code,400)
        self.event.lifecycle_state='open';self.event.save();Asset.objects.filter(pk=self.supplier.pk).update(quantity=10);self.assertEqual(self.preview().status_code,400)

@skipUnless(connection.vendor=='postgresql','PostgreSQL row-lock/concurrency acceptance')
class ProgramDeliveryConcurrencyTests(TransactionTestCase):
    setUp=ProgramDeliveryTests.setUp;preview=ProgramDeliveryTests.preview;payload=ProgramDeliveryTests.payload
    def race(self,same_key):
        body=self.payload();barrier=Barrier(2)
        def issue(index):
            close_old_connections()
            try:
                client=APIClient();client.force_authenticate(User.objects.get(pk=self.user.pk))
                data={**body,'request_key':body['request_key'] if same_key else str(uuid4())};barrier.wait(timeout=10)
                return client.post(self.url,data,format='json').status_code
            finally:close_old_connections()
        with ThreadPoolExecutor(max_workers=2) as pool:statuses=sorted(pool.map(issue,[0,1]))
        self.assertEqual(statuses,[200,201] if same_key else [201,409]);self.assertEqual(ProgramDelivery.objects.count(),1)
    def test_concurrent_retry_issues_once(self):self.race(True)
    def test_concurrent_reference_refuses_duplicate(self):self.race(False)
