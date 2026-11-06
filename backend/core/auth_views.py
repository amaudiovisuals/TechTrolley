from django.views.decorators.csrf import csrf_exempt
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes, authentication_classes, throttle_classes
from collections.abc import Mapping
from .auth_throttling import LoginAttemptThrottle
from rest_framework.response import Response
from rest_framework.authtoken.models import Token
from django.contrib.auth import authenticate
from rest_framework.permissions import AllowAny
from django.contrib.auth import get_user_model
from django.db import transaction
from django.contrib.auth import logout
from rest_framework.permissions import IsAuthenticated
from .authentication import token_is_current

User = get_user_model()
from .permissions import get_business_role, is_business_administrator

@csrf_exempt
@api_view(['POST'])
@authentication_classes([])
@permission_classes([AllowAny])
@throttle_classes([LoginAttemptThrottle])
def custom_login(request):
    if not isinstance(request.data, Mapping):
        return Response({'error':'Provide an email and password object.'},status=400)
    email = request.data.get('email')
    password = request.data.get('password')

    if not isinstance(email, str) or not isinstance(password, str) or not email.strip() or not password or len(email)>254 or len(password)>1024:
        return Response({'error': 'Please provide both email and password'}, status=status.HTTP_400_BAD_REQUEST)

    # Find user by email case-insensitively
    email = email.strip()
    matches = list(User.objects.filter(email__iexact=email)[:2])
    if len(matches) != 1:
        from django.contrib.auth.hashers import make_password
        make_password(password)
        return Response({'error': 'Invalid Credentials'}, status=status.HTTP_400_BAD_REQUEST)
    # Password verification and token issuance share the same user lock as resets.
    with transaction.atomic():
        locked = User.objects.select_for_update().get(pk=matches[0].pk)
        user = authenticate(username=locked.username, password=password)
        if not user:
            return Response({'error': 'Invalid Credentials'}, status=status.HTTP_400_BAD_REQUEST)
        token = Token.objects.filter(user=user).first()
        if token and not token_is_current(token):
            token.delete()
            token = None
        if token is None:
            token = Token.objects.create(user=user)

    role = get_business_role(user)
    is_staff = is_business_administrator(user)

    from .permissions import assigned_employee_id
    employee_id = assigned_employee_id(user)

    response = Response({
        'token': token.key,
        'user_id': user.pk,
        'username': user.username,
        'email': user.email,
        'full_name': f"{user.first_name} {user.last_name}".strip() or user.username,
        'is_staff': is_staff,
        'employee_id': employee_id,
        'role': role
    })
    response['Cache-Control'] = 'no-store'
    return response


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def server_logout(request):
    with transaction.atomic():
        User.objects.select_for_update().get(pk=request.user.pk)
        # A delayed logout cannot delete a replacement token issued after a reset.
        tokens = Token.objects.filter(user=request.user)
        if request.auth is not None:
            tokens = tokens.filter(key=request.auth.key)
        tokens.delete()
        if hasattr(request, 'session'):
            logout(request)
    response = Response({'message': 'Signed out. API login on all devices using this token has ended.'})
    response['Cache-Control'] = 'no-store'
    return response
