from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from .models import Employee
from .permissions import get_business_role, is_business_administrator

@api_view(['GET'])
@permission_classes([IsAuthenticated])
def get_my_profile(request):
    user = request.user
    
    role = get_business_role(user)
    is_staff = is_business_administrator(user)

    from .permissions import assigned_employee_id
    employee_id = assigned_employee_id(user)

    from .saved_work_views import email_scope_allowed
    return Response({
        'user_id': user.pk,
        'legacy_email_scope_allowed': email_scope_allowed(user),
        'username': user.username,
        'email': user.email,
        'full_name': f"{user.first_name} {user.last_name}".strip() or user.username,
        'is_staff': is_staff,
        'employee_id': employee_id,
        'role': role
    })
