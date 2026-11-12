"""Business-role checks must never change accounts or trust editable staff data."""
from rest_framework.permissions import BasePermission, SAFE_METHODS

ADMIN_ROLES = {'admin', 'boss'}
BUSINESS_ROLES = ADMIN_ROLES | {'godown_incharge', 'technician', 'accounts'}
WAREHOUSE_ROLES = ADMIN_ROLES | {'godown_incharge'}


def get_business_role(user):
    if not user or not user.is_authenticated or not user.is_active:
        return None
    profile = getattr(user, 'profile', None)
    role = getattr(profile, 'role', None)
    if user.is_superuser:
        return role if role in ADMIN_ROLES else 'admin'
    return role if role in BUSINESS_ROLES else 'technician'


def is_business_administrator(user):
    return get_business_role(user) in ADMIN_ROLES


class AdministratorWriteAuthenticatedRead(BasePermission):
    def has_permission(self, request, view):
        if request.method in SAFE_METHODS:
            return bool(request.user and request.user.is_authenticated and request.user.is_active)
        return is_business_administrator(request.user)


class PublicSettingsReadAdministratorWrite(BasePermission):
    def has_permission(self, request, view):
        return request.method in SAFE_METHODS or is_business_administrator(request.user)


def assigned_employee_id(user):
    """Do not trust a client employee ID or an editable Employee.role for identity."""
    from .models import Employee
    linked = Employee.objects.filter(user=user).values_list('pk', flat=True).first()
    if linked is not None:
        return linked
    if not user.email:
        return None
    from django.contrib.auth.models import User
    if User.objects.filter(email__iexact=user.email).count() != 1:
        return None
    rows = list(Employee.objects.filter(email__iexact=user.email).values_list('pk', 'user_id')[:2])
    return rows[0][0] if len(rows) == 1 and rows[0][1] is None else None


def technician_has_event(user, conference_id):
    from .models import Conference
    employee_id = assigned_employee_id(user)
    return bool(employee_id and Conference.objects.filter(pk=conference_id, assigned_employees=employee_id).exists())


class WarehouseWriteAuthenticatedRead(AdministratorWriteAuthenticatedRead):
    def has_permission(self, request, view):
        if request.method in SAFE_METHODS:
            return super().has_permission(request, view)
        return get_business_role(request.user) in WAREHOUSE_ROLES


class ConferenceWritePermission(WarehouseWriteAuthenticatedRead):
    """Legacy scan payloads remain scoped pending the atomic command replacement."""
    technician_fields = {'assets', 'crosscheck_assets', 'staged_assets', 'challan_assets',
                         'flag_log', 'consumable_data', 'requirements', 'expected_revision'}

    def has_permission(self, request, view):
        if super().has_permission(request, view):
            return True
        if request.method not in {'PATCH', 'POST'} or 'pk' not in view.kwargs:
            return False
        fields = set(request.data)
        role = get_business_role(request.user)
        if role == 'accounts':
            return fields - {'expected_revision'} == {'is_invoiced'}
        return (role == 'technician' and bool(fields) and fields <= self.technician_fields
                and technician_has_event(request.user, view.kwargs['pk']))


class AssetWritePermission(WarehouseWriteAuthenticatedRead):
    def has_permission(self, request, view):
        if super().has_permission(request, view):
            return True
        if get_business_role(request.user) != 'technician' or request.method != 'PATCH':
            return False
        fields = set(request.data)
        if not fields or not fields <= {'flag', 'condition', 'status', 'conference_id', 'stage'}:
            return False
        # A condition report cannot release custody by setting Available/In Use.
        if 'status' in fields and request.data['status'] not in {'Missing', 'Damaged', 'On Service', 'Expired'}:
            return False
        from .models import Asset
        from django.db.models import Q
        asset_id = view.kwargs.get('pk')
        context = request.data.get('conference_id')
        if context is not None:
            if not str(context).isdigit() or not technician_has_event(request.user, context):
                return False
            return Asset.objects.filter(pk=asset_id).filter(
                Q(assigned_conferences__pk=context) | Q(crosscheck_conferences__pk=context)
            ).exists()
        employee_id = assigned_employee_id(request.user)
        if not employee_id:
            return False
        return Asset.objects.filter(pk=asset_id).filter(
            Q(assigned_to_id=employee_id)
            | Q(assigned_conferences__assigned_employees=employee_id, assigned_conferences__is_audit=False)
            | Q(crosscheck_conferences__assigned_employees=employee_id, crosscheck_conferences__is_audit=False)
        ).exists()


class TruckMembershipPermission(WarehouseWriteAuthenticatedRead):
    def has_permission(self, request, view):
        if super().has_permission(request, view):
            return True
        if get_business_role(request.user) != 'technician':
            return False
        from .models import TruckChallan
        if request.method == 'PATCH' and 'truck_pk' in view.kwargs:
            conference_id = TruckChallan.objects.filter(pk=view.kwargs['truck_pk']).values_list('conference_id', flat=True).first()
            return (bool(request.data) and set(request.data) <= {'assets', 'asset_quantities', 'expected_revision'}
                    and technician_has_event(request.user, conference_id))
        if request.method == 'POST' and 'pk' in view.kwargs:
            return (bool(request.data) and set(request.data) <= {'asset_ids', 'truck_id', 'truck_number', 'expected_revision'}
                    and technician_has_event(request.user, view.kwargs['pk']))
        return False


class QuantityAssignmentPermission(WarehouseWriteAuthenticatedRead):
    def has_permission(self, request, view):
        if super().has_permission(request, view):
            return True
        conference_id = request.data.get('conference_id')
        return (get_business_role(request.user) == 'technician' and request.method == 'POST'
                and bool(request.data) and set(request.data) <= {'quantity', 'conference_id'}
                and str(conference_id).isdigit()
                and technician_has_event(request.user, conference_id))
