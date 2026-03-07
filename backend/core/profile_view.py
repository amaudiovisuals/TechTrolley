from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from .models import Employee

@api_view(['GET'])
@permission_classes([IsAuthenticated])
def get_my_profile(request):
    user = request.user
    
    # Try to find associated employee id if not staff
    employee_id = None
    if not user.is_staff:
        emp = Employee.objects.filter(email=user.email).first()
        if emp:
            employee_id = emp.id

    return Response({
        'user_id': user.pk,
        'email': user.email,
        'is_staff': user.is_staff,
        'employee_id': employee_id
    })
