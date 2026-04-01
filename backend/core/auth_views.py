from django.views.decorators.csrf import csrf_exempt
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes, authentication_classes
from rest_framework.response import Response
from rest_framework.authtoken.models import Token
from django.contrib.auth import authenticate
from rest_framework.permissions import AllowAny
from django.contrib.auth import get_user_model

User = get_user_model()

@csrf_exempt
@api_view(['POST'])
@authentication_classes([])
@permission_classes([AllowAny])
def custom_login(request):
    email = request.data.get('email')
    password = request.data.get('password')

    if not email or not password:
        return Response({'error': 'Please provide both email and password'}, status=status.HTTP_400_BAD_REQUEST)

    # Find user by email case-insensitively
    user = User.objects.filter(email__iexact=email).first()
    if not user:
        return Response({'error': 'Invalid Credentials'}, status=status.HTTP_400_BAD_REQUEST)

    # Check password using the found user instance
    user = authenticate(username=user.username, password=password)

    if not user:
        return Response({'error': 'Invalid Credentials'}, status=status.HTTP_400_BAD_REQUEST)

    token, _ = Token.objects.get_or_create(user=user)
    
    # Try to find associated employee id if not staff
    employee_id = None
    if not user.is_staff:
        from .models import Employee
        emp = Employee.objects.filter(email=user.email).first()
        if emp:
            employee_id = emp.id

    return Response({
        'token': token.key,
        'user_id': user.pk,
        'username': user.username,
        'email': user.email,
        'full_name': f"{user.first_name} {user.last_name}".strip() or user.username,
        'is_staff': user.is_staff,
        'employee_id': employee_id,
        'role': user.profile.role if hasattr(user, 'profile') else ('admin' if user.is_staff else 'technician')
    })
