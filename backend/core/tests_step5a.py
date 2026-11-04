"""Custody foundation regression tests; synthetic data only."""
import uuid
from django.contrib.auth.models import User
from django.db import connection
from .test_support import SnapshotTestCase, collect_readonly_snapshot
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient
from .models import Asset, Conference, Employee, QuantityAllocation, ConsumableAllocation, ChallanDocument
from .asset_commands import execute_command
from .custody import derived_status, review_assets, synchronize_statuses, available_quantity
from .legacy_reconciliation import collect_snapshot


class CustodyFoundationTests(SnapshotTestCase):
    def setUp(self):
        self.user = User.objects.create_user('custody-admin')
        self.user.profile.role = 'admin'; self.user.profile.save()
        self.client = APIClient(); self.client.force_authenticate(self.user)
        self.asset = Asset.objects.create(sku='SYNTHETIC-DEVICE')
        self.event = Conference.objects.create(name='Synthetic current event')
        self.audit = Conference.objects.create(name='Synthetic audit', is_audit=True)

    def state(self):
        self.asset.refresh_from_db()
        return self.asset.status

    def move(self, action, event=None):
        return execute_command(self.user, (event or self.event).pk, {'request_id':str(uuid.uuid4()), 'action':action, 'asset_ids':[self.asset.pk]})

    def delete_event(self, event):
        event.refresh_from_db()
        return self.client.delete(f'/api/conferences/{event.pk}/', {'expected_revision':event.revision}, format='json')

    def test_each_flag_survives_add_remove_clear_and_reverse_operations(self):
        for flag, expected in [('Missing','Missing'),('Expired','Expired'),('Required Service','On Service'),('On Service','On Service')]:
            self.asset.flag = flag; self.asset.save()
            self.event.assets.add(self.asset)
            self.assertEqual(self.state(), expected)
            self.event.crosscheck_assets.add(self.asset)
            self.assertEqual(self.state(), expected)
            self.event.assets.clear(); self.event.crosscheck_assets.clear()
            self.assertEqual(self.state(), expected)
            self.asset.assigned_conferences.add(self.event)
            self.asset.assigned_conferences.clear()
            self.assertEqual(self.state(), expected)

    def test_damage_condition_without_flag_is_never_available(self):
        self.asset.condition = 'Damaged'; self.asset.save()
        self.event.assets.add(self.asset); self.event.assets.remove(self.asset)
        self.assertEqual(self.state(), 'Damaged')
        self.assertEqual(derived_status(self.asset), 'Damaged')

    def test_standalone_reported_restriction_is_not_erased_by_save(self):
        self.asset.status = 'Missing'; self.asset.save()
        self.assertEqual(self.state(), 'Missing')
        self.asset.description = 'Metadata edit'; self.asset.save(update_fields=['description'])
        self.assertEqual(self.state(), 'Missing')

    def test_clearing_flag_alone_is_not_a_health_resolution(self):
        self.asset.flag = 'Missing'; self.asset.save()
        self.asset.flag = ''; self.asset.save(update_fields=['flag'])
        self.assertEqual(self.state(), 'Missing')

    def test_explicit_health_resolution_rederives_real_custody(self):
        self.event.assets.add(self.asset)
        self.asset.flag = 'Missing'; self.asset.save()
        self.asset.flag = ''; self.asset.status = 'Available'; self.asset.condition = 'Good'
        self.asset.save()
        self.assertEqual(self.state(), 'In Use')

    def test_metadata_save_does_not_silently_repair_unproved_custody(self):
        Asset.objects.filter(pk=self.asset.pk).update(status='In Use')
        self.asset.refresh_from_db(); self.asset.description = 'Unrelated metadata'; self.asset.save()
        self.assertEqual(self.state(), 'In Use')
        review = review_assets([self.asset.pk])[0]
        self.assertEqual(review['expected_status'], 'Available')
        self.assertIn('physical_custody_confirmation_required', review['blockers'])

    def test_clear_derives_after_removal_and_keeps_real_crosscheck(self):
        self.event.assets.add(self.asset); self.event.crosscheck_assets.add(self.asset)
        self.event.assets.clear()
        self.assertEqual(self.state(), 'Crosscheck')
        self.event.crosscheck_assets.clear()
        self.assertEqual(self.state(), 'Available')

    def test_remove_crosscheck_keeps_other_real_event(self):
        other = Conference.objects.create(name='Other real event')
        other.assets.add(self.asset); self.event.crosscheck_assets.add(self.asset)
        self.event.crosscheck_assets.remove(self.asset)
        self.assertEqual(self.state(), 'In Use')

    def test_reverse_clear_and_remove_work_for_both_relations(self):
        self.asset.assigned_conferences.add(self.event)
        self.asset.crosscheck_conferences.add(self.event)
        self.asset.assigned_conferences.remove(self.event)
        self.assertEqual(self.state(), 'Crosscheck')
        self.asset.crosscheck_conferences.clear()
        self.assertEqual(self.state(), 'Available')

    def test_audit_crosscheck_and_observation_do_not_lock_or_release(self):
        self.audit.crosscheck_assets.add(self.asset)
        self.assertEqual(self.state(), 'Available')
        self.event.assets.add(self.asset)
        self.audit.assets.add(self.asset); self.audit.crosscheck_assets.clear()
        self.assertEqual(self.state(), 'In Use')
        self.audit.assets.remove(self.asset)
        self.assertEqual(self.state(), 'In Use')

    def test_audit_remove_is_not_a_status_repair(self):
        Asset.objects.filter(pk=self.asset.pk).update(status='Crosscheck')
        self.audit.staged_assets.add(self.asset)
        self.move('audit_remove', self.audit)
        self.assertEqual(self.state(), 'Crosscheck')
        self.assertFalse(self.audit.staged_assets.exists())

    def test_direct_delete_cannot_free_another_event_or_damage(self):
        self.event.assets.add(self.asset)
        other = Conference.objects.create(name='Other real event'); other.assets.add(self.asset)
        self.asset.flag = 'Missing'; self.asset.save()
        self.event.delete()
        self.assertEqual(self.state(), 'Missing')
        self.asset.flag = ''; self.asset.status = 'Available'; self.asset.save()
        self.assertEqual(self.state(), 'In Use')

    def test_audit_delete_preserves_real_holder(self):
        self.event.assets.add(self.asset); self.audit.assets.add(self.asset)
        response = self.delete_event(self.audit)
        self.assertEqual(response.status_code, 204, response.data)
        self.assertEqual(self.state(), 'In Use')

    def test_real_event_delete_requires_return_and_verification(self):
        self.move('stage')
        self.assertEqual(self.delete_event(self.event).status_code, 409)
        self.move('dispatch')
        self.assertEqual(self.delete_event(self.event).status_code, 409)
        self.move('return')
        self.assertEqual(self.delete_event(self.event).status_code, 409)
        self.move('verify_return')
        response = self.delete_event(self.event)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data['error'], 'event_has_protected_operational_history_use_archive')
        self.assertTrue(self.event.challan_assets.filter(pk=self.asset.pk).exists())

    def test_empty_event_delete_allowed_and_stale_revision_refused(self):
        self.event.refresh_from_db()
        old = self.event.revision
        self.event.name = 'Changed'; self.event.save()
        response = self.client.delete(f'/api/conferences/{self.event.pk}/', {'expected_revision':old}, format='json')
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.delete_event(self.event).status_code, 204)

    def test_legacy_number_alone_blocks_deletion(self):
        self.event.challan_number = 'KEEP-ISSUED-NUMBER'; self.event.save()
        self.assertEqual(self.delete_event(self.event).status_code, 409)
        self.assertTrue(Conference.objects.filter(pk=self.event.pk).exists())

    def test_audit_mode_change_with_staged_observations_requires_review(self):
        self.audit.staged_assets.add(self.asset); self.audit.refresh_from_db()
        response = self.client.patch(f'/api/conferences/{self.audit.pk}/', {'expected_revision': self.audit.revision, 'is_audit':False}, format='json')
        self.assertEqual(response.status_code, 409)
        self.audit.refresh_from_db(); self.assertTrue(self.audit.is_audit)

    def test_staff_assignment_remains_held_after_event_removal(self):
        employee = Employee.objects.create(name='Synthetic custodian', employee_id='CUSTODY-1', department='Warehouse', phone='-')
        self.asset.assigned_to = employee; self.asset.save()
        self.event.assets.add(self.asset); self.event.assets.clear()
        self.assertEqual(self.state(), 'In Use')
        self.assertEqual(self.client.get('/api/employee-allocations/').data[0]['id'], self.asset.pk)

    def test_tracked_partial_bulk_is_available_and_full_unchecked_is_crosscheck(self):
        self.asset.quantity = 10; self.asset.save()
        row = QuantityAllocation.objects.create(asset=self.asset, conference=self.event, dispatched=4, dispatched_total=4)
        self.event.assets.add(self.asset)
        self.assertEqual(self.state(), 'Available')
        row.dispatched = 0; row.awaiting_verification = 10; row.save()
        self.event.assets.clear(); self.event.crosscheck_assets.add(self.asset)
        self.assertEqual(self.state(), 'Crosscheck')
        row.awaiting_verification = 0; row.verified_total = 10; row.save()
        self.event.crosscheck_assets.clear()
        self.assertEqual(self.state(), 'Available')

    def test_unknown_bulk_quantity_stays_blocked_in_review(self):
        self.asset.quantity = 10; self.asset.save()
        self.event.assets.add(self.asset)
        review = review_assets([self.asset.pk])[0]
        self.assertIn('unknown_legacy_quantity', review['blockers'])
        self.assertFalse(review['automatic_apply_allowed'])

    def test_consumer_settlement_state_and_flags_use_same_policy(self):
        self.asset.type = 'Consumables'; self.asset.quantity = 5; self.asset.save()
        row = ConsumableAllocation.objects.create(asset=self.asset, conference=self.event, requested=5, state='dispatched')
        synchronize_statuses([self.asset.pk]); self.assertEqual(self.state(), 'In Use')
        row.state = 'settled'; row.returned = 2; row.consumed = 3; row.save()
        synchronize_statuses([self.asset.pk]); self.assertEqual(self.state(), 'Available')
        self.asset.flag = 'Required Service'; self.asset.save()
        synchronize_statuses([self.asset.pk]); self.assertEqual(self.state(), 'On Service')

    def test_review_endpoint_is_select_only_repeatable_and_includes_history(self):
        Asset.objects.filter(pk=self.asset.pk).update(status='Crosscheck')
        self.audit.challan_assets.add(self.asset)
        before = collect_readonly_snapshot(connection)
        with CaptureQueriesContext(connection) as queries:
            response = self.client.get(f'/api/conferences/{self.audit.pk}/custody-review/')
            again = self.client.get(f'/api/conferences/{self.audit.pk}/custody-review/')
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data, again.data)
        self.assertEqual(before, collect_readonly_snapshot(connection))
        self.assertFalse(any(q['sql'].lstrip().upper().startswith(('INSERT','UPDATE','DELETE')) for q in queries.captured_queries))
        self.assertEqual(response.data['rows'][0]['expected_status'], 'Available')
        self.assertEqual(response.data['mismatch_count'], 1)
        self.assertFalse(response.data['rows'][0]['automatic_apply_allowed'])

    def test_review_roles_and_old_release_never_modify_inventory(self):
        self.audit.assets.add(self.asset)
        Asset.objects.filter(pk=self.asset.pk).update(status='In Use')
        for role in ('technician', 'accounts'):
            self.user.profile.role = role; self.user.profile.save()
            self.assertEqual(self.client.get(f'/api/conferences/{self.audit.pk}/custody-review/').status_code, 403)
        self.user.profile.role = 'admin'; self.user.profile.save()
        response = self.client.post(f'/api/conferences/{self.audit.pk}/release-audit-locks/')
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.state(), 'In Use')
        self.client.force_authenticate(None)
        self.assertEqual(self.client.get(f'/api/conferences/{self.audit.pk}/custody-review/').status_code, 401)

    def test_review_reports_staff_overlap_and_multiple_holders(self):
        employee = Employee.objects.create(name='Staff', employee_id='CUSTODY-2', department='Ops', phone='-')
        self.asset.assigned_to = employee; self.asset.save()
        self.event.assets.add(self.asset)
        other = Conference.objects.create(name='Other'); other.crosscheck_assets.add(self.asset)
        blockers = review_assets([self.asset.pk])[0]['blockers']
        self.assertIn('multiple_event_holders', blockers)
        self.assertIn('staff_and_event_custody_overlap', blockers)

    def test_document_history_protects_delete_and_survives_return(self):
        ChallanDocument.objects.create(conference=self.event,scope='master',number='SYNTHETIC-ISSUED')
        self.assertEqual(self.delete_event(self.event).status_code, 409)
        self.assertEqual(ChallanDocument.objects.count(), 1)

    def test_api_quantity_available_respects_current_custody_and_audit_only_history(self):
        route = f'/api/assets/{self.asset.pk}/'
        self.audit.challan_assets.add(self.asset)
        self.assertEqual(self.client.get(route).data['quantity_available'], 1)
        self.event.assets.add(self.asset)
        self.assertEqual(self.client.get(route).data['quantity_available'], 0)
        self.event.assets.clear()
        self.assertEqual(self.client.get(route).data['quantity_available'], 1)

    def test_api_quantity_available_blocks_restrictions_staff_and_unproved_status(self):
        route = f'/api/assets/{self.asset.pk}/'
        for values in ({'flag':'Missing'}, {'flag':'','condition':'Damaged'}, {'condition':'Good','status':'Crosscheck'}):
            Asset.objects.filter(pk=self.asset.pk).update(**values)
            self.assertEqual(self.client.get(route).data['quantity_available'], 0)
        employee = Employee.objects.create(name='Staff',employee_id='CAPACITY',department='Ops',phone='-')
        Asset.objects.filter(pk=self.asset.pk).update(status='Available',assigned_to=employee)
        self.assertEqual(self.client.get(route).data['quantity_available'], 0)

    def test_api_bulk_capacity_subtracts_all_events_without_making_partial_stock_unavailable(self):
        self.asset.quantity = 10; self.asset.save()
        other = Conference.objects.create(name='Other bulk allocation')
        QuantityAllocation.objects.create(asset=self.asset,conference=self.event,reserved=2,dispatched=3,dispatched_total=3)
        QuantityAllocation.objects.create(asset=self.asset,conference=other,awaiting_verification=1,dispatched_total=1)
        self.event.assets.add(self.asset)
        self.assertEqual(self.state(), 'Available')
        self.assertEqual(self.client.get(f'/api/assets/{self.asset.pk}/').data['quantity_available'], 4)

    def test_health_resolution_over_api_cannot_make_active_equipment_available(self):
        self.event.assets.add(self.asset)
        self.asset.flag='Required Service';self.asset.save()
        response=self.client.patch(f'/api/assets/{self.asset.pk}/',{'flag':'','condition':'Good','status':'Available'},format='json')
        self.assertEqual(response.status_code,200,response.data)
        self.assertEqual(response.data['status'],'In Use')
        self.assertEqual(response.data['quantity_available'],0)

    def test_annotated_physical_capacity_uses_existing_custody_without_extra_queries(self):
        for name, expected in [(None, 1), ('', 0), ('Current event', 0)]:
            self.asset.annotated_conference = name
            self.asset.annotated_staff_open = False
            with CaptureQueriesContext(connection) as queries:
                self.assertEqual(available_quantity(self.asset), expected)
            self.assertEqual(len(queries.captured_queries), 0)

    def test_existing_authorized_staff_return_releases_only_after_fk_removal(self):
        employee=Employee.objects.create(name='Staff',employee_id='RETURN-STAFF',department='Ops',phone='-')
        self.asset.assigned_to=employee;self.asset.save()
        response=self.client.patch(f'/api/assets/{self.asset.pk}/',{'assigned_to':None},format='json')
        self.assertEqual(response.status_code,400,response.data)
        from .staff_commands import execute_staff_command
        result=execute_staff_command(self.user,{'request_id':str(uuid.uuid4()),'action':'return','employee_id':employee.pk,'items':[{'asset_id':self.asset.pk,'expected_revision':0,'expected_employee_id':employee.pk}],'reason':'Verified staff return'})
        self.assertEqual(result['asset_states'][0]['status'],'Available')
        self.assertEqual(result['asset_states'][0]['quantity_available'],1)

    def test_existing_staff_return_preserves_another_holder_or_health_restriction(self):
        employee=Employee.objects.create(name='Staff',employee_id='RETURN-BLOCKED',department='Ops',phone='-')
        self.asset.assigned_to=employee;self.asset.save();self.event.assets.add(self.asset)
        response=self.client.patch(f'/api/assets/{self.asset.pk}/',{'assigned_to':None},format='json')
        self.assertEqual(response.status_code,400)
        from .staff_commands import execute_staff_command
        result=execute_staff_command(self.user,{'request_id':str(uuid.uuid4()),'action':'return','employee_id':employee.pk,'items':[{'asset_id':self.asset.pk,'expected_revision':0,'expected_employee_id':employee.pk}],'reason':'Verified return with other holder retained'})
        self.assertEqual(result['asset_states'][0]['status'],'In Use')
        self.event.assets.clear();self.asset.refresh_from_db()
        self.asset.assigned_to=employee;self.asset.flag='Missing';self.asset.save()
        response=self.client.patch(f'/api/assets/{self.asset.pk}/',{'assigned_to':None},format='json')
        self.assertEqual(response.status_code,400)
        result=execute_staff_command(self.user,{'request_id':str(uuid.uuid4()),'action':'return','employee_id':employee.pk,'items':[{'asset_id':self.asset.pk,'expected_revision':1,'expected_employee_id':employee.pk}],'reason':'Verified return still missing restriction'})
        self.assertEqual(result['asset_states'][0]['status'],'Missing')
        self.assertEqual(result['asset_states'][0]['quantity_available'],0)

    def test_unproved_bulk_lock_is_not_released_by_metadata_save_or_reported_as_free(self):
        self.asset.quantity=10;self.asset.status='In Use';self.asset.save()
        response=self.client.patch(f'/api/assets/{self.asset.pk}/',{'description':'Only metadata changed'},format='json')
        self.assertEqual(response.status_code,200,response.data)
        self.assertEqual(response.data['status'],'In Use')
        self.assertEqual(response.data['quantity_available'],0)
        review=review_assets([self.asset.pk])[0]
        self.assertIn('physical_custody_confirmation_required',review['blockers'])
