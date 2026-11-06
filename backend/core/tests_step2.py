"""Security, custody and account provisioning regressions. Synthetic records only."""
from unittest.mock import patch

from django.contrib.auth.models import User
from django.test import TestCase
from rest_framework.test import APIClient

from .models import Asset, CompanySettings, Conference, Employee, SubrentalCompany, SubrentalTicket, SubrentalTicketItem, TruckChallan, UserProfile
from .permissions import get_business_role
from .serializers import AssetSerializer, SubAssetSerializer
from .user_views import check_is_admin


class AccessRegressionTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.tech = User.objects.create_user('tech', email='tech@example.test', password='test-password')
        self.admin = User.objects.create_user('admin', email='admin@example.test', password='test-password')
        UserProfile.objects.filter(user=self.admin).update(role='admin')
        self.admin.refresh_from_db()
        self.employee = Employee.objects.create(name='Tech', employee_id='TECH', email=self.tech.email,
                                                phone='N/A', department='Operations', role='technician')
        self.asset = Asset.objects.create(sku='SECURITY-TEST')
        self.event = Conference.objects.create(name='Synthetic event')
        self.event.challan_assets.add(self.asset)

    def test_retired_destructive_routes_do_not_exist_or_change_records(self):
        for user in (None, self.tech, self.admin):
            self.client.force_authenticate(user=user)
            for route in ('ad-hoc-cleanup', 'nuke-ghosts', 'snipe-91', 'reset-statuses'):
                for method in ('get', 'post'):
                    with self.subTest(user=user, route=route, method=method):
                        self.assertEqual(getattr(self.client, method)(f'/api/{route}/').status_code, 404)
        self.assertTrue(Asset.objects.filter(pk=self.asset.pk).exists())
        self.assertEqual(list(self.event.challan_assets.values_list('pk', flat=True)), [self.asset.pk])

    def test_technician_cannot_edit_employees_settings_or_accounts(self):
        self.client.force_authenticate(self.tech)
        settings = CompanySettings.objects.create(pk=1, name='Original')
        cases = [
            ('post', '/api/employees/', {'name': 'Attacker', 'email': 'new@example.test', 'role': 'admin'}),
            ('put', f'/api/employees/{self.employee.pk}/', {'name': 'Promoted', 'email': self.tech.email, 'role': 'admin'}),
            ('delete', f'/api/employees/{self.employee.pk}/', {}),
            ('post', '/api/company-settings/', {'name': 'Changed', 'next_challan_number': 1}),
            ('post', '/api/system-users/', {'email': 'new@example.test', 'password': 'test-password'}),
            ('put', '/api/users/role/', {'email': self.tech.email, 'role': 'admin'}),
            ('post', '/api/users/reset-password/', {'email': self.admin.email}),
            ('delete', f'/api/system-users/{self.admin.pk}/', {}),
        ]
        for method, route, body in cases:
            with self.subTest(route=route):
                self.assertEqual(getattr(self.client, method)(route, body, format='json').status_code, 403)
        self.employee.refresh_from_db()
        settings.refresh_from_db()
        self.assertEqual(self.employee.role, 'technician')
        self.assertEqual(settings.name, 'Original')
        self.assertEqual(User.objects.count(), 2)
        self.admin.refresh_from_db()
        self.assertTrue(self.admin.check_password('test-password'))

    def test_login_profile_and_admin_checks_ignore_editable_employee_role(self):
        Employee.objects.filter(pk=self.employee.pk).update(role='admin')
        User.objects.filter(pk=self.tech.pk).update(is_staff=True)
        self.tech.refresh_from_db()
        self.assertFalse(check_is_admin(self.tech))
        self.assertEqual(get_business_role(self.tech), 'technician')
        self.client.force_authenticate(self.tech)
        response = self.client.get('/api/my-profile/')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['role'], 'technician')
        self.assertFalse(response.data['is_staff'])
        self.assertEqual(response.data['employee_id'], self.employee.pk)
        self.client.force_authenticate(user=None)
        response = self.client.post('/api/login/', {'email': self.tech.email.upper(), 'password': 'test-password'}, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['role'], 'technician')
        self.assertFalse(response.data['is_staff'])
        self.tech.refresh_from_db()
        self.assertFalse(self.tech.is_superuser)
        self.assertEqual(self.tech.profile.role, 'technician')

    def test_profile_admin_check_does_not_change_django_flags(self):
        self.assertTrue(check_is_admin(self.admin))
        self.client.force_authenticate(self.admin)
        self.assertTrue(self.client.get('/api/my-profile/').data['is_staff'])
        self.admin.refresh_from_db()
        self.assertFalse(self.admin.is_staff)
        self.assertFalse(self.admin.is_superuser)

    def test_inactive_and_unrecognized_roles_cannot_manage_accounts(self):
        UserProfile.objects.filter(user=self.tech).update(role='invalid')
        self.tech.refresh_from_db()
        self.assertFalse(check_is_admin(self.tech))
        self.assertEqual(get_business_role(self.tech), 'technician')
        self.admin.is_active = False
        self.assertFalse(check_is_admin(self.admin))

    def test_technician_can_read_employees(self):
        self.client.force_authenticate(self.tech)
        self.assertEqual(self.client.get('/api/employees/').status_code, 200)
        self.assertEqual(self.client.get(f'/api/employees/{self.employee.pk}/').status_code, 200)

    def test_anonymous_branding_read_is_limited_and_never_creates_settings(self):
        response = self.client.get('/api/company-settings/')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(set(response.data), {'name', 'logo', 'powered_by_name', 'theme_template', 'website'})
        self.assertEqual(CompanySettings.objects.count(), 0)
        self.assertIn(self.client.post('/api/company-settings/', {'name': 'Changed'}, format='json').status_code, (401, 403))
        self.assertEqual(CompanySettings.objects.count(), 0)

    def test_settings_get_does_not_reset_old_financial_year_sequence(self):
        obj = CompanySettings.objects.create(pk=1, challan_fy='24-25', next_challan_number=500)
        self.client.get('/api/company-settings/')
        self.client.force_authenticate(self.tech)
        response = self.client.get('/api/company-settings/')
        self.assertEqual(response.data['next_challan_number'], 500)
        obj.refresh_from_db()
        self.assertEqual((obj.challan_fy, obj.next_challan_number), ('24-25', 500))

    def test_administrator_can_write_settings_and_provision_employee(self):
        self.client.force_authenticate(self.admin)
        self.assertEqual(self.client.post('/api/company-settings/', {'name': 'Updated'}, format='json').status_code, 200)
        response = self.client.post('/api/employees/', {'name': 'New employee', 'email': 'employee@example.test',
                                   'employee_id': 'NEW', 'role': 'godown_incharge', 'password': 'test-password'}, format='json')
        self.assertEqual(response.status_code, 201, response.data)
        user = User.objects.get(email='employee@example.test')
        self.assertEqual(user.profile.role, 'godown_incharge')
        self.assertFalse(user.is_superuser)

    def test_system_user_creation_handles_automatically_created_profile(self):
        self.client.force_authenticate(self.admin)
        response = self.client.post('/api/system-users/', {'email': 'new-admin@example.test', 'password': 'test-password'}, format='json')
        self.assertEqual(response.status_code, 201, response.data)
        user = User.objects.get(email='new-admin@example.test')
        self.assertEqual(UserProfile.objects.filter(user=user).count(), 1)
        self.assertEqual(user.profile.role, 'admin')

    def test_role_change_requires_existing_unique_login(self):
        self.client.force_authenticate(self.admin)
        response = self.client.put('/api/users/role/', {'email': 'new-role@example.test', 'role': 'accounts'}, format='json')
        self.assertEqual(response.status_code, 409, response.data)
        self.assertFalse(User.objects.filter(email='new-role@example.test').exists())
        self.assertFalse(Employee.objects.filter(email='new-role@example.test').exists())

    def test_reset_does_not_provision_or_guess_an_employee_identity(self):
        employee = Employee.objects.create(name='Existing', employee_id='EXISTING', email='existing@example.test', phone='N/A', department='Operations')
        self.client.force_authenticate(self.admin)
        response = self.client.post('/api/users/reset-password/', {'email': employee.email}, format='json')
        self.assertEqual(response.status_code, 409, response.data)
        self.assertFalse(User.objects.filter(email=employee.email).exists())

    def test_role_refusal_leaves_no_partial_account_or_employee(self):
        self.client.force_authenticate(self.admin)
        response = self.client.put('/api/users/role/', {'email': 'rollback@example.test', 'role': 'accounts'}, format='json')
        self.assertEqual(response.status_code, 409)
        self.assertFalse(User.objects.filter(email='rollback@example.test').exists())
        self.assertFalse(Employee.objects.filter(email='rollback@example.test').exists())

    def test_employee_provisioning_failure_rolls_back_employee(self):
        self.client.force_authenticate(self.admin)
        with patch.object(User.objects, 'create_user', side_effect=RuntimeError('injected write failure')):
            with self.assertRaises(RuntimeError):
                self.client.post('/api/employees/', {'name': 'Failed', 'employee_id': 'FAILED', 'email': 'failed@example.test'}, format='json')
        self.assertFalse(Employee.objects.filter(email='failed@example.test').exists())

    def test_accounts_cannot_mutate_operational_endpoints(self):
        accounts = User.objects.create_user('accounts', email='accounts@example.test')
        accounts.profile.role = 'accounts'
        accounts.profile.save()
        self.client.force_authenticate(accounts)
        truck = TruckChallan.objects.create(conference=self.event, truck_number=1)
        company = SubrentalCompany.objects.create(name='Supplier')
        ticket = SubrentalTicket.objects.create(company=company, conference=self.event)
        item = SubrentalTicketItem.objects.create(ticket=ticket, asset=self.asset)
        cases = [
            ('post', '/api/assets/', {'sku': 'FORBIDDEN'}),
            ('patch', f'/api/assets/{self.asset.pk}/', {'assigned_to': self.employee.pk}),
            ('delete', f'/api/assets/{self.asset.pk}/', {}),
            ('post', f'/api/assets/{self.asset.pk}/assign-quantity/', {'quantity': 1, 'conference_id': self.event.pk}),
            ('post', f'/api/assets/{self.asset.pk}/sub-assets/', {'child_id': self.asset.pk}),
            ('delete', f'/api/assets/{self.asset.pk}/sub-assets/{self.asset.pk}/', {}),
            ('post', '/api/upload-assets/', {}),
            ('post', '/api/conferences/', {'name': 'FORBIDDEN'}),
            ('patch', f'/api/conferences/{self.event.pk}/', {'assets': [self.asset.pk]}),
            ('patch', f'/api/conferences/{self.event.pk}/', {'is_invoiced': True, 'is_audit': True}),
            ('delete', f'/api/conferences/{self.event.pk}/', {}),
            ('post', f'/api/conferences/{self.event.pk}/transfer-assets/', {}),
            ('post', f'/api/conferences/{self.event.pk}/trucks/', {}),
            ('post', f'/api/conferences/{self.event.pk}/trucks/add-to-truck/', {'asset_ids': [self.asset.pk]}),
            ('post', f'/api/conferences/{self.event.pk}/trucks/add-to-truck1/', {'asset_ids': [self.asset.pk]}),
            ('post', f'/api/conferences/{self.event.pk}/release-audit-locks/', {}),
            ('patch', f'/api/truck-challans/{truck.pk}/', {'assets': []}),
            ('delete', f'/api/truck-challans/{truck.pk}/', {}),
            ('post', f'/api/truck-challans/{truck.pk}/transfer/', {}),
            ('post', '/api/subrental-companies/', {'name': 'FORBIDDEN'}),
            ('patch', f'/api/subrental-companies/{company.pk}/', {'name': 'FORBIDDEN'}),
            ('post', '/api/subrental-tickets/', {}),
            ('patch', f'/api/subrental-tickets/{ticket.pk}/', {}),
            ('post', f'/api/subrental-tickets/{ticket.pk}/add-item/', {}),
            ('patch', f'/api/subrental-ticket-items/{item.pk}/', {'quantity': 2}),
        ]
        for user in (accounts, None):
            self.client.force_authenticate(user)
            for method, route, data in cases:
                with self.subTest(user=user, route=route):
                    self.assertIn(getattr(self.client, method)(route, data, format='json').status_code, (401, 403))
        self.assertEqual(Asset.objects.count(), 1)
        self.assertEqual(self.asset.assigned_to_id, None)
        self.assertEqual(Conference.objects.count(), 1)
        self.event.refresh_from_db()
        self.assertFalse(self.event.is_audit)

    def test_accounts_invoice_marker_still_works(self):
        self.tech.profile.role = 'accounts'
        self.tech.profile.save()
        self.client.force_authenticate(self.tech)
        response = self.client.patch(f'/api/conferences/{self.event.pk}/', {'is_invoiced': True, 'expected_revision': self.event.revision}, format='json')
        self.assertEqual(response.status_code, 200, response.data)
        self.event.refresh_from_db()
        self.assertTrue(self.event.is_invoiced)

    def test_godown_can_create_inventory_and_change_event_membership(self):
        self.tech.profile.role = 'godown_incharge'
        self.tech.profile.save()
        self.client.force_authenticate(self.tech)
        response = self.client.post('/api/assets/', {'sku': 'GODOWN-NEW', 'quantity': 1, 'status': 'Available', 'type': 'Other'}, format='json')
        self.assertEqual(response.status_code, 201, response.data)
        response = self.client.patch(f'/api/conferences/{self.event.pk}/', {'vehicle_number': 'GODOWN-TRUCK', 'expected_revision': self.event.revision}, format='json')
        self.assertEqual(response.status_code, 200, response.data)
        self.event.refresh_from_db()
        self.assertEqual(self.event.vehicle_number, 'GODOWN-TRUCK')

    def test_technician_writes_are_scoped_to_assigned_event_and_allowed_fields(self):
        self.client.force_authenticate(self.tech)
        route = f'/api/conferences/{self.event.pk}/'
        self.assertEqual(self.client.patch(route, {'assets': [self.asset.pk], 'expected_revision': self.event.revision}, format='json').status_code, 403)
        self.event.assigned_employees.add(self.employee)
        response = self.client.patch(route, {'assets': [], 'expected_revision': self.event.revision}, format='json')
        self.assertEqual(response.status_code, 200, response.data)
        for payload in ({'is_audit': True}, {'assigned_employees': []}, {'name': 'Changed'}, {'is_invoiced': True}):
            self.assertEqual(self.client.patch(route, payload, format='json').status_code, 403)
        self.assertEqual(self.client.delete(route).status_code, 403)
        other = Conference.objects.create(name='Other event')
        self.assertEqual(self.client.patch(f'/api/conferences/{other.pk}/', {'assets': []}, format='json').status_code, 403)

    def test_technician_asset_reports_require_actual_custody(self):
        self.client.force_authenticate(self.tech)
        route = f'/api/assets/{self.asset.pk}/'
        self.assertEqual(self.client.patch(route, {'flag': 'Missing'}, format='json').status_code, 403)
        self.event.assigned_employees.add(self.employee)
        self.event.assets.add(self.asset)
        response = self.client.patch(route, {'flag': 'Missing'}, format='json')
        self.assertEqual(response.status_code, 200, response.data)
        for payload in ({'assigned_to': self.employee.pk}, {'item_price': 999}, {'status': 'Available'}):
            self.assertEqual(self.client.patch(route, payload, format='json').status_code, 403)
        self.assertEqual(self.client.patch(route, {'flag': 'Missing', 'conference_id': 99999}, format='json').status_code, 403)

    def test_technician_truck_membership_requires_assigned_event(self):
        truck = TruckChallan.objects.create(conference=self.event, truck_number=1)
        self.client.force_authenticate(self.tech)
        route = f'/api/truck-challans/{truck.pk}/'
        self.assertEqual(self.client.patch(route, {'assets': [self.asset.pk], 'expected_revision': self.event.revision}, format='json').status_code, 403)
        self.event.assigned_employees.add(self.employee)
        response = self.client.patch(route, {'assets': [self.asset.pk], 'expected_revision': self.event.revision}, format='json')
        self.assertEqual(response.status_code, 200, response.data)
        self.assertTrue(truck.assets.filter(pk=self.asset.pk).exists())
        self.assertEqual(self.client.patch(route, {'driver_phone': 'Changed'}, format='json').status_code, 403)
        self.assertEqual(self.client.delete(route).status_code, 403)

    def test_ambiguous_employee_identity_cannot_authorize_technician(self):
        Employee.objects.create(name='Duplicate', employee_id='DUP', email=self.tech.email.upper(), phone='N/A', department='Operations')
        self.event.assigned_employees.add(self.employee)
        self.client.force_authenticate(self.tech)
        self.assertEqual(self.client.patch(f'/api/conferences/{self.event.pk}/', {'assets': [self.asset.pk], 'expected_revision': self.event.revision}, format='json').status_code, 403)

    def test_ai_admin_permission_uses_the_same_trusted_policy(self):
        from .ai_views import check_ai_permission
        User.objects.filter(pk=self.tech.pk).update(is_staff=True)
        self.tech.refresh_from_db()
        self.assertFalse(check_ai_permission(self.tech))
        self.assertTrue(check_ai_permission(self.admin))

    def test_system_administrator_list_uses_roles_instead_of_staff_flag(self):
        User.objects.filter(pk=self.tech.pk).update(is_staff=True)
        self.client.force_authenticate(self.admin)
        response = self.client.get('/api/system-users/')
        self.assertEqual(response.status_code, 200)
        ids = {row['id'] for row in response.data}
        self.assertIn(self.admin.pk, ids)
        self.assertNotIn(self.tech.pk, ids)

    def test_technician_quantity_assignment_requires_assigned_event(self):
        self.client.force_authenticate(self.tech)
        route = f'/api/assets/{self.asset.pk}/assign-quantity/'
        data = {'quantity': 1, 'conference_id': self.event.pk}
        self.assertEqual(self.client.post(route, data, format='json').status_code, 403)
        self.event.assigned_employees.add(self.employee)
        response = self.client.post(route, data, format='json')
        self.assertEqual(response.status_code, 409, response.data)
        self.assertEqual(response.data['error'], 'use_asset_commands')
        self.assertFalse(self.event.assets.filter(pk=self.asset.pk).exists())


class CustodyRegressionTests(TestCase):
    def setUp(self):
        self.asset = Asset.objects.create(sku='CUSTODY-TEST')
        self.audit = Conference.objects.create(name='Audit history', is_audit=True)
        self.history = Conference.objects.create(name='Historical document')
        self.live = Conference.objects.create(name='Live event')
        self.client = APIClient()
        self.client.force_authenticate(User.objects.create_user('custody-test'))

    def assertLocation(self, expected):
        fresh = Asset.objects.get(pk=self.asset.pk)
        self.assertEqual(AssetSerializer(fresh).data['current_conference_name'], expected)
        self.assertEqual(SubAssetSerializer(fresh).data['current_conference_name'], expected)
        response = self.client.get('/api/assets/?all=true')
        self.assertEqual(response.status_code, 200)
        row = next(row for row in response.data if row['id'] == self.asset.pk)
        self.assertEqual(row['current_conference_name'], expected)
        response = self.client.get(f'/api/assets/{self.asset.pk}/')
        self.assertEqual(response.data['current_conference_name'], expected)

    def test_audit_observations_and_historical_documents_are_not_current_custody(self):
        self.audit.assets.add(self.asset)
        self.audit.crosscheck_assets.add(self.asset)
        self.audit.staged_assets.add(self.asset)
        self.audit.challan_assets.add(self.asset)
        self.history.challan_assets.add(self.asset)
        self.history.staged_assets.add(self.asset)
        self.assertLocation(None)
        self.assertTrue(self.history.challan_assets.filter(pk=self.asset.pk).exists())
        self.assertTrue(self.audit.assets.filter(pk=self.asset.pk).exists())

    def test_subrental_history_does_not_imply_current_custody(self):
        company = SubrentalCompany.objects.create(name='Synthetic supplier')
        ticket = SubrentalTicket.objects.create(company=company, conference=self.history)
        SubrentalTicketItem.objects.create(ticket=ticket, asset=self.asset)
        self.assertLocation(None)

    def test_real_active_custody_takes_precedence_over_audit(self):
        self.audit.assets.add(self.asset)
        self.live.assets.add(self.asset)
        self.assertLocation(self.live.name)

    def test_real_crosscheck_remains_current_until_returned(self):
        self.live.crosscheck_assets.add(self.asset)
        self.live.challan_assets.add(self.asset)
        self.assertLocation(self.live.name)
        self.live.crosscheck_assets.remove(self.asset)
        self.assertLocation(None)
        self.assertTrue(self.live.challan_assets.filter(pk=self.asset.pk).exists())
