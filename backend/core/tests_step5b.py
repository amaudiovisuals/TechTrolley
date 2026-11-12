import uuid
from unittest.mock import patch
from django.test import TransactionTestCase
from .test_support import SnapshotTestCase
from django.db import connection
from django.contrib.auth.models import User
from rest_framework.test import APIClient
from .models import Asset,Employee,Conference,StaffAllocation,EmployeeIdentityHistory,MovementReceipt,SubrentalCompany
from .staff_commands import execute_staff_command,execute_link_command
from .asset_commands import execute_command,CommandError
from .permissions import assigned_employee_id


class StaffCustodyTests(SnapshotTestCase):
    def setUp(self):
        self.admin=User.objects.create_user('staff-admin',email='staff-admin@example.test');self.admin.profile.role='admin';self.admin.profile.save()
        self.client=APIClient();self.client.force_authenticate(self.admin)
        self.employee=Employee.objects.create(name='First staff',employee_id='STAFF-1',email='first@example.test',department='Ops',phone='-')
        self.other=Employee.objects.create(name='Second staff',employee_id='STAFF-2',email='second@example.test',department='Ops',phone='-')
        self.asset=Asset.objects.create(sku='DEVICE-1',alias_name='Staff laptop',type='Laptops')

    def payload(self,action='issue',assets=None,employee=None):
        assets=assets or [self.asset]
        for a in assets:a.refresh_from_db()
        return {'request_id':str(uuid.uuid4()),'action':action,'employee_id':(employee or self.employee).pk,
                'items':[{'asset_id':a.pk,'expected_revision':a.staff_revision,'expected_employee_id':a.assigned_to_id} for a in assets],'reason':'Verified physical handover'}

    def run_staff(self,action='issue',**kw):return execute_staff_command(self.admin,self.payload(action,**kw))

    def test_recorded_issue_return_keeps_operator_dates_snapshots_and_revision(self):
        issued=self.run_staff();row=StaffAllocation.objects.get()
        self.assertEqual(row.employee,self.employee);self.assertEqual(row.issued_by,self.admin);self.assertIsNotNone(row.issued_at)
        self.asset.refresh_from_db();self.assertEqual((self.asset.assigned_to_id,self.asset.staff_revision,self.asset.status),(self.employee.pk,1,'In Use'))
        self.assertEqual(issued['asset_states'][0]['quantity_available'],0)
        self.employee.name='Renamed current staff';self.employee.save()
        returned=self.run_staff('return');row.refresh_from_db();self.asset.refresh_from_db()
        self.assertIsNotNone(row.returned_at);self.assertEqual(row.returned_by,self.admin)
        self.assertEqual(row.issue_snapshot['employee_name'],'First staff')
        self.assertEqual((self.asset.assigned_to_id,self.asset.staff_revision,self.asset.status),(None,2,'Available'))
        self.assertEqual(returned['asset_states'][0]['quantity_available'],1)
        self.assertEqual(MovementReceipt.objects.count(),2)

    def test_exact_issue_retry_survives_role_downgrade_and_later_return(self):
        payload=self.payload();first=execute_staff_command(self.admin,payload);self.run_staff('return')
        self.admin.profile.role='accounts';self.admin.profile.save()
        replay=execute_staff_command(self.admin,payload)
        self.assertTrue(replay['replayed']);self.assertEqual(first['allocations'],replay['allocations'])
        self.assertEqual(StaffAllocation.objects.count(),1);self.asset.refresh_from_db();self.assertIsNone(self.asset.assigned_to_id)
        with self.assertRaises(CommandError):execute_staff_command(self.admin,self.payload())

    def test_exact_return_retry_does_not_close_another_new_issue(self):
        self.run_staff();payload=self.payload('return');execute_staff_command(self.admin,payload);self.run_staff(employee=self.other)
        execute_staff_command(self.admin,payload);self.asset.refresh_from_db()
        self.assertEqual(self.asset.assigned_to_id,self.other.pk);self.assertEqual(StaffAllocation.objects.count(),2)

    def test_reused_uuid_with_changed_reason_is_rejected(self):
        payload=self.payload();execute_staff_command(self.admin,payload);payload['reason']='Different command'
        with self.assertRaises(CommandError) as caught:execute_staff_command(self.admin,payload)
        self.assertEqual(caught.exception.code,'request_id_reused')

    def test_stale_revision_and_stale_custodian_are_rejected(self):
        old=self.payload();self.run_staff();self.run_staff('return')
        with self.assertRaises(CommandError):execute_staff_command(self.admin,old)
        payload=self.payload();payload['items'][0]['expected_employee_id']=self.other.pk
        with self.assertRaises(CommandError):execute_staff_command(self.admin,payload)
        self.assertEqual(StaffAllocation.objects.count(),1)

    def test_no_direct_reassignment_or_wrong_person_return(self):
        self.run_staff()
        with self.assertRaises(CommandError):self.run_staff(employee=self.other)
        with self.assertRaises(CommandError):self.run_staff('return',employee=self.other)
        self.asset.refresh_from_db();self.assertEqual(self.asset.assigned_to_id,self.employee.pk)

    def test_event_active_crosscheck_and_staging_block_issue_but_audit_history_does_not(self):
        event=Conference.objects.create(name='Physical event')
        for relation in ('assets','crosscheck_assets','staged_assets'):
            getattr(event,relation).add(self.asset)
            with self.assertRaises(CommandError):self.run_staff()
            getattr(event,relation).clear()
        audit=Conference.objects.create(name='Audit',is_audit=True)
        audit.assets.add(self.asset);audit.crosscheck_assets.add(self.asset);audit.staged_assets.add(self.asset);audit.challan_assets.add(self.asset)
        self.run_staff();self.assertEqual(StaffAllocation.objects.count(),1)

    def test_supplier_owned_and_non_laptop_hardware_can_be_issued(self):
        supplier=SubrentalCompany.objects.create(name='Supplier')
        self.asset.type='Smartphones';self.asset.subrental_company=supplier;self.asset.save()
        self.run_staff();rows=self.client.get('/api/employee-allocations/').data
        self.assertEqual(rows[0]['type'],'Smartphones');self.assertEqual(rows[0]['subrental_company_name'],'Supplier')
        self.assertEqual(rows[0]['assigned_to'],self.employee.pk)

    def test_quantity_temporary_consumer_and_kit_issue_are_rejected(self):
        cases=[{'quantity':2},{'quantity_tracking':True},{'type':'Consumables'},{'is_temporary':True}]
        for values in cases:
            other=Asset.objects.create(sku='INVALID-'+str(uuid.uuid4()),**values)
            with self.assertRaises(CommandError):self.run_staff(assets=[other])
        Asset.objects.create(sku='CHILD',parent_asset=self.asset)
        with self.assertRaises(CommandError):self.run_staff()
        self.assertEqual(StaffAllocation.objects.count(),0)

    def test_flags_damage_and_unproved_lock_block_issue(self):
        for values in ({'flag':'Missing'},{'flag':'','condition':'Damaged'},{'condition':'Good','status':'Crosscheck'}):
            Asset.objects.filter(pk=self.asset.pk).update(**values)
            with self.assertRaises(CommandError):self.run_staff()

    def test_return_preserves_restriction_and_actual_other_holder(self):
        self.run_staff();event=Conference.objects.create(name='Unexpected event');event.assets.add(self.asset)
        self.run_staff('return');self.asset.refresh_from_db();self.assertEqual(self.asset.status,'In Use')
        event.assets.clear();self.run_staff();self.asset.refresh_from_db();self.asset.flag='Missing';self.asset.save();self.run_staff('return')
        self.asset.refresh_from_db();self.assertEqual((self.asset.status,self.asset.flag),('Missing','Missing'))

    def test_legacy_return_records_unknown_issue_date_without_backfill(self):
        self.asset.assigned_to=self.employee;self.asset.save()
        projection=self.client.get('/api/employee-allocations/').data[0]
        self.assertEqual(projection['staff_issue']['provenance'],'legacy_assignment_unrecorded')
        self.run_staff('return');row=StaffAllocation.objects.get()
        self.assertEqual(row.provenance,'legacy_assignment_at_return');self.assertIsNone(row.issued_at);self.assertIsNone(row.issued_by)
        self.assertIsNotNone(row.returned_at)

    def test_legacy_bulk_return_is_blocked_for_review(self):
        self.asset.quantity=10;self.asset.assigned_to=self.employee;self.asset.save()
        with self.assertRaises(CommandError):self.run_staff('return')
        self.asset.refresh_from_db();self.assertEqual(self.asset.assigned_to_id,self.employee.pk)

    def test_batch_conflict_has_no_partial_assignments_receipts_or_history(self):
        bad=Asset.objects.create(sku='MISSING',flag='Missing')
        with self.assertRaises(CommandError):self.run_staff(assets=[self.asset,bad])
        self.asset.refresh_from_db();self.assertIsNone(self.asset.assigned_to_id)
        self.assertEqual((StaffAllocation.objects.count(),MovementReceipt.objects.count()),(0,0))

    def test_late_receipt_failure_rolls_back_fk_revision_and_history(self):
        original=MovementReceipt.save
        def failure(receipt,*a,**kw):
            if receipt.result.get('operation')=='staff_allocation':raise RuntimeError('Synthetic late failure')
            return original(receipt,*a,**kw)
        with patch.object(MovementReceipt,'save',failure):
            with self.assertRaises(RuntimeError):self.run_staff()
        self.asset.refresh_from_db();self.assertEqual((self.asset.assigned_to_id,self.asset.staff_revision),(None,0))
        self.assertEqual((StaffAllocation.objects.count(),MovementReceipt.objects.count()),(0,0))

    def test_role_authentication_and_real_employee_ids_required(self):
        for role in ('technician','accounts'):
            self.admin.profile.role=role;self.admin.profile.save()
            self.assertEqual(self.client.post('/api/staff-commands/',self.payload(),format='json').status_code,403)
        self.admin.profile.role='godown_incharge';self.admin.profile.save()
        self.assertEqual(self.client.post('/api/staff-commands/',self.payload(),format='json').status_code,200)
        self.client.force_authenticate(None)
        self.assertEqual(self.client.post('/api/staff-commands/',self.payload('return'),format='json').status_code,401)

    def test_bool_duplicate_missing_reason_and_unknown_ids_rejected(self):
        for mutate in [lambda p:p.update(employee_id='u-1'),lambda p:p.update(reason=''),lambda p:p['items'][0].update(expected_revision=True),lambda p:p['items'].append(dict(p['items'][0])),lambda p:p['items'][0].update(asset_id=999999)]:
            payload=self.payload();mutate(payload)
            with self.assertRaises(CommandError):execute_staff_command(self.admin,payload)
        self.assertEqual(MovementReceipt.objects.count(),0)

    def test_generic_assignment_create_update_and_synthetic_bridge_are_closed(self):
        before=Employee.objects.count()
        for value in (self.employee.pk,'u-'+str(self.admin.pk)):
            response=self.client.patch(f'/api/assets/{self.asset.pk}/',{'assigned_to':value},format='json')
            self.assertEqual(response.status_code,400)
        self.assertEqual(Employee.objects.count(),before)
        response=self.client.post('/api/assets/',{'sku':'NEW','assigned_to':self.employee.pk},format='json')
        self.assertEqual(response.status_code,400)
        self.run_staff();response=self.client.patch(f'/api/assets/{self.asset.pk}/',{'assigned_to':None},format='json')
        self.assertEqual(response.status_code,400)
        self.assertEqual(self.client.patch(f'/api/assets/{self.asset.pk}/',{'alias_name':'Safe metadata','assigned_to':self.employee.pk},format='json').status_code,200)

    def test_active_history_blocks_inventory_identity_change_and_deletion(self):
        self.run_staff()
        for payload in ({'quantity':2},{'type':'Consumables'}):self.assertEqual(self.client.patch(f'/api/assets/{self.asset.pk}/',payload,format='json').status_code,400)
        self.assertEqual(self.client.delete(f'/api/employees/{self.employee.pk}/').status_code,409)
        self.assertEqual(self.client.delete(f'/api/assets/{self.asset.pk}/').status_code,409)

    def test_allocation_query_independent_of_search_page_supplier_and_category(self):
        supplier=SubrentalCompany.objects.create(name='Supplier')
        devices=[self.asset]+[Asset.objects.create(sku='DEVICE-'+str(i),type='Smartphones' if i==1 else 'Other',subrental_company=supplier if i==2 else None) for i in range(1,7)]
        self.run_staff(assets=devices)
        self.client.get('/api/assets/?search=DOES-NOT-EXIST&page=1')
        rows=self.client.get('/api/employee-allocations/?search=NO-MATCH&page=50').data
        self.assertEqual({r['id'] for r in rows},{a.pk for a in devices})
        self.assertEqual(self.client.get('/api/employee-allocations/'+str(self.asset.pk)+'/history/').data['records'][0]['issue_snapshot']['employee_name'],'First staff')

    def test_candidates_use_real_availability_and_include_other_categories_and_supplier(self):
        supplier=SubrentalCompany.objects.create(name='Supplier')
        good=Asset.objects.create(sku='PHONE',type='Smartphones',subrental_company=supplier)
        held=Asset.objects.create(sku='HELD');event=Conference.objects.create(name='Packing');event.staged_assets.add(held)
        self.run_staff()
        ids={r['id'] for r in self.client.get('/api/staff-issue-candidates/').data['results']}
        self.assertIn(good.pk,ids);self.assertNotIn(held.pk,ids);self.assertNotIn(self.asset.pk,ids)

    def test_staff_issued_equipment_cannot_be_staged_for_event(self):
        self.run_staff();event=Conference.objects.create(name='New event')
        with self.assertRaises(CommandError):execute_command(self.admin,event.pk,{'request_id':str(uuid.uuid4()),'action':'stage','asset_ids':[self.asset.pk]})
        self.assertFalse(event.staged_assets.exists())

    def test_foreign_technician_cannot_read_staff_history(self):
        self.run_staff();self.admin.profile.role='technician';self.admin.profile.save()
        self.assertEqual(self.client.get(f'/api/employee-allocations/{self.asset.pk}/history/').status_code,403)

    def test_open_history_with_lost_inventory_fk_stays_visible_unavailable_and_blocks_movement(self):
        self.run_staff();Asset.objects.filter(pk=self.asset.pk).update(assigned_to=None,status='Available')
        projection=self.client.get('/api/employee-allocations/').data
        self.assertEqual(projection[0]['allocation_employee_id'],self.employee.pk)
        self.assertIsNone(projection[0]['assigned_to'])
        self.assertFalse(projection[0]['staff_issue']['history_matches_current_custodian'])
        self.assertEqual(self.client.get(f'/api/assets/{self.asset.pk}/').data['quantity_available'],0)
        event=Conference.objects.create(name='Would seize lost-FK item')
        with self.assertRaises(CommandError):execute_command(self.admin,event.pk,{'request_id':str(uuid.uuid4()),'action':'stage','asset_ids':[self.asset.pk]})
        with self.assertRaises(CommandError):self.run_staff('return')
        self.asset.refresh_from_db()
        from .custody import review_assets
        self.assertIn('staff_history_disagrees_with_custodian',review_assets([self.asset.pk])[0]['blockers'])

    def link_payload(self,create=False,user=None):
        target=user or User.objects.create_user('linked-user',email='linked@example.test')
        common={'request_id':str(uuid.uuid4()),'action':'create_link' if create else 'link','user_id':target.pk,'reason':'Reviewed actual staff identity'}
        if create:common['profile']={'name':'Linked person','employee_id':'LINKED-1','department':'Ops','phone':'-'}
        else:self.employee.refresh_from_db();common.update(employee_id=self.employee.pk,expected_revision=self.employee.identity_revision,expected_user_id=self.employee.user_id)
        return common,target

    def test_explicit_link_uses_canonical_employee_without_changing_privileges(self):
        payload,target=self.link_payload();role=target.profile.role
        result=execute_link_command(self.admin,payload)
        self.employee.refresh_from_db();target.refresh_from_db()
        self.assertEqual(self.employee.user_id,target.pk);self.assertEqual(assigned_employee_id(target),self.employee.pk)
        self.assertEqual(target.profile.role,role);self.assertFalse(target.is_superuser)
        self.assertEqual(result['employee']['identity_revision'],1);self.assertEqual(EmployeeIdentityHistory.objects.count(),1)

    def test_create_link_and_exact_retry_produce_one_profile_and_no_new_login(self):
        payload,target=self.link_payload(create=True);before_users=User.objects.count()
        result=execute_link_command(self.admin,payload);replay=execute_link_command(self.admin,payload)
        self.assertEqual(result['employee'],replay['employee']);self.assertTrue(replay['replayed'])
        self.assertEqual(Employee.objects.filter(user=target).count(),1);self.assertEqual(User.objects.count(),before_users)

    def test_create_link_failure_after_profile_creation_is_atomic(self):
        payload,target=self.link_payload(create=True);before=Employee.objects.count()
        with patch.object(EmployeeIdentityHistory.objects,'create',side_effect=RuntimeError('Late link failure')):
            with self.assertRaises(RuntimeError):execute_link_command(self.admin,payload)
        self.assertEqual(Employee.objects.count(),before);self.assertEqual(EmployeeIdentityHistory.objects.count(),0);self.assertEqual(MovementReceipt.objects.count(),0)

    def test_link_authorization_stale_comparison_and_direct_user_field_guard(self):
        payload,target=self.link_payload();payload['expected_revision']=10
        with self.assertRaises(CommandError):execute_link_command(self.admin,payload)
        payload['expected_revision']=0;self.admin.profile.role='godown_incharge';self.admin.profile.save()
        with self.assertRaises(CommandError):execute_link_command(self.admin,payload)
        self.admin.profile.role='admin';self.admin.profile.save()
        response=self.client.put(f'/api/employees/{self.employee.pk}/',{'name':'Unsafe','email':self.employee.email,'employee_id':self.employee.employee_id,'user':target.pk},format='json')
        self.assertEqual(response.status_code,400)

    def test_existing_email_profile_must_be_reviewed_not_duplicated(self):
        target=User.objects.create_user('first-person',email=self.employee.email)
        payload,target=self.link_payload(create=True,user=target)
        with self.assertRaises(CommandError):execute_link_command(self.admin,payload)
        self.assertEqual(Employee.objects.count(),2)

    def test_explicit_link_override_and_email_fallback_never_borrow_another_login(self):
        target=User.objects.create_user('first-person',email=self.employee.email)
        self.assertEqual(assigned_employee_id(target),self.employee.pk)
        otheruser=User.objects.create_user('other-login',email='other-login@example.test')
        self.employee.user=otheruser;self.employee.save()
        self.assertIsNone(assigned_employee_id(target));self.assertEqual(assigned_employee_id(otheruser),self.employee.pk)

    def test_link_retry_after_admin_downgrade_and_protected_user_deletion(self):
        payload,target=self.link_payload();execute_link_command(self.admin,payload)
        self.admin.profile.role='accounts';self.admin.profile.save()
        self.assertTrue(execute_link_command(self.admin,payload)['replayed'])
        self.admin.profile.role='admin';self.admin.profile.save()
        self.assertEqual(self.client.delete(f'/api/system-users/{target.pk}/').status_code,409)

    def test_new_employee_provision_is_linked_without_shared_default_password(self):
        response=self.client.post('/api/employees/',{'name':'New staff','email':'new-staff@example.test','employee_id':'NEW-SAFE'},format='json')
        self.assertEqual(response.status_code,201,response.data)
        employee=Employee.objects.get(pk=response.data['id']);user=employee.user
        self.assertIsNotNone(user);self.assertFalse(user.has_usable_password());self.assertEqual(EmployeeIdentityHistory.objects.filter(employee=employee).count(),1)

    def test_weak_provisioning_password_rejected_without_partial_profile(self):
        before=(Employee.objects.count(),User.objects.count(),EmployeeIdentityHistory.objects.count())
        response=self.client.post('/api/employees/',{'name':'Weak staff','email':'weak@example.test','employee_id':'WEAK','password':'short'},format='json')
        self.assertEqual(response.status_code,400)
        self.assertEqual(before,(Employee.objects.count(),User.objects.count(),EmployeeIdentityHistory.objects.count()))

    def test_unlinked_employee_deletion_does_not_delete_accounts_by_email(self):
        user=User.objects.create_user('separate-user',email=self.employee.email)
        self.assertEqual(self.client.delete(f'/api/employees/{self.employee.pk}/').status_code,204)
        self.assertTrue(User.objects.filter(pk=user.pk).exists())

    def test_profile_and_login_show_explicit_link_and_ambiguous_login_is_refused(self):
        payload,target=self.link_payload();target.set_password('test-password');target.save();execute_link_command(self.admin,payload)
        self.client.force_authenticate(target);self.assertEqual(self.client.get('/api/my-profile/').data['employee_id'],self.employee.pk)
        response=self.client.post('/api/login/',{'email':target.email,'password':'test-password'},format='json');self.assertEqual(response.data['employee_id'],self.employee.pk)
        User.objects.create_user('duplicate-email',email=target.email,password='different')
        self.assertEqual(self.client.post('/api/login/',{'email':target.email,'password':'test-password'},format='json').status_code,400)


class StaffConcurrencyTests(TransactionTestCase):
    def race(self,functions):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Barrier
        from django.db import close_old_connections,connections
        gate=Barrier(2)
        def run(function):
            close_old_connections()
            try:
                gate.wait(timeout=10)
                try:return function()
                except CommandError as error:return error.code
            finally:connections.close_all()
        with ThreadPoolExecutor(max_workers=2) as pool:return list(pool.map(run,functions))

    @__import__('unittest').skipUnless(connection.vendor=='postgresql','Requires explicitly disposable PostgreSQL')
    def test_competing_staff_issues_have_one_custodian_history_and_receipt(self):
        case=StaffCustodyTests();case.setUp();one=case.payload();two=case.payload(employee=case.other)
        result=self.race([lambda:execute_staff_command(User.objects.get(pk=case.admin.pk),one),lambda:execute_staff_command(User.objects.get(pk=case.admin.pk),two)])
        self.assertEqual(sum(isinstance(r,dict) for r in result),1)
        self.assertEqual(StaffAllocation.objects.count(),1);self.assertEqual(MovementReceipt.objects.count(),1)
        case.asset.refresh_from_db();self.assertEqual(case.asset.staff_revision,1)
        self.assertEqual(case.asset.assigned_to_id,StaffAllocation.objects.get().employee_id)

    @__import__('unittest').skipUnless(connection.vendor=='postgresql','Requires explicitly disposable PostgreSQL')
    def test_competing_create_links_have_one_employee_profile(self):
        case=StaffCustodyTests();case.setUp();target=User.objects.create_user('racing-link',email='racing@example.test')
        one,_=case.link_payload(create=True,user=target);two,_=case.link_payload(create=True,user=target);two['profile']['employee_id']='LINKED-2'
        result=self.race([lambda:execute_link_command(User.objects.get(pk=case.admin.pk),one),lambda:execute_link_command(User.objects.get(pk=case.admin.pk),two)])
        self.assertEqual(sum(isinstance(r,dict) for r in result),1)
        self.assertEqual(Employee.objects.filter(user=target).count(),1)
        self.assertEqual(EmployeeIdentityHistory.objects.count(),1);self.assertEqual(MovementReceipt.objects.count(),1)
