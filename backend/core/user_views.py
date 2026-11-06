from rest_framework import status
from rest_framework.decorators import api_view, permission_classes, throttle_classes
from collections.abc import Mapping
from .auth_throttling import PasswordAttemptThrottle
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
from django.contrib.auth.models import User
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from rest_framework.authtoken.models import Token
from .authentication import token_is_current
from django.db import transaction
from django.db.models import Q
from .serializers import UserSerializer
from .permissions import ADMIN_ROLES, is_business_administrator


def check_is_admin(user):
    return is_business_administrator(user)


def password_error(password, user):
    if not isinstance(password, str) or not 10 <= len(password) <= 1024:
        return 'Use a password between 10 and 1024 characters.'
    try:
        validate_password(password, user=user)
    except ValidationError as error:
        return ' '.join(error.messages)
    return None


def email_input(data):
    value = data.get('email')
    return value.strip() if isinstance(value, str) and len(value) <= 254 else ''


def unique_user(email):
    matches = list(User.objects.filter(Q(email__iexact=email) | Q(username__iexact=email)).distinct()[:2])
    return matches[0] if len(matches) == 1 else None


def credential_still_current(request, user):
    if request.auth is not None:
        token = Token.objects.filter(user=user, key=request.auth.key).first()
        return bool(token and token_is_current(token))
    # Session auth verified the password hash before entering the view. Recheck
    # after the row lock, so a concurrent reset cannot revive an old session.
    return user.password == request.user.password


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@throttle_classes([PasswordAttemptThrottle])
@transaction.atomic
def change_password(request):
    if not isinstance(request.data, Mapping):
        return Response({'error':'Provide password fields as an object.'},status=400)
    user = User.objects.select_for_update().get(pk=request.user.pk)
    if not credential_still_current(request, user):
        return Response({'error': 'Sign in again before changing your password.'}, status=401)
    old_password = request.data.get('old_password')
    new_password = request.data.get('new_password')
    if not isinstance(old_password, str) or len(old_password) > 1024 or not user.check_password(old_password):
        return Response({'error': 'Incorrect old password.'}, status=400)
    error = password_error(new_password, user)
    if error:
        return Response({'error': error}, status=400)
    if user.check_password(new_password):
        return Response({'error': 'Choose a different password.'}, status=400)
    user.set_password(new_password)
    user.save(update_fields=['password'])
    Token.objects.filter(user=user).delete()
    response = Response({'message': 'Password changed. Sign in again on your devices. Saved work is retained.', 'login_required': True})
    response['Cache-Control'] = 'no-store'
    return response


@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
@transaction.atomic
def system_user_list(request):
    if not check_is_admin(request.user):
        return Response({'error': 'Unauthorized. Only administrators can access system users.'}, status=status.HTTP_403_FORBIDDEN)

    if request.method == 'GET':
        users = User.objects.filter(Q(profile__role__in=ADMIN_ROLES) | Q(is_superuser=True)).distinct()
        serializer = UserSerializer(users, many=True)
        return Response(serializer.data)
    
    elif request.method == 'POST':
        email = email_input(request.data)
        password = request.data.get('password')
        
        if not email or not password:
            return Response({'error': 'Please provide both email and password.'}, status=status.HTTP_400_BAD_REQUEST)
        
        if User.objects.filter(username__iexact=email).exists() or User.objects.filter(email__iexact=email).exists():
            return Response({'error': 'User with this email already exists.'}, status=status.HTTP_400_BAD_REQUEST)
        
        error = password_error(password, User(username=email, email=email))
        if error:
            return Response({'error': error}, status=400)

        # System Administrators are marked with is_staff=True
        user = User.objects.create_user(username=email, email=email, password=password, is_staff=True, is_superuser=True)
        from .models import UserProfile
        UserProfile.objects.update_or_create(user=user, defaults={'role': 'admin'})
        return Response({'message': 'User created successfully.', 'id': user.id, 'email': user.email}, status=status.HTTP_201_CREATED)


@api_view(['DELETE'])
@permission_classes([IsAuthenticated])
def system_user_delete(request, pk):
    if not check_is_admin(request.user):
        return Response({'error': 'Unauthorized. Only administrators can delete users.'}, status=status.HTTP_403_FORBIDDEN)

    try:
        user = User.objects.get(pk=pk)
    except User.DoesNotExist:
        return Response(status=status.HTTP_404_NOT_FOUND)

    if user == request.user:
        return Response({'error': 'You cannot delete your own account.'}, status=status.HTTP_400_BAD_REQUEST)

    from django.db.models.deletion import ProtectedError
    try:
        user.delete()
    except ProtectedError:
        return Response({'error':'user_has_protected_operational_history'},status=409)
    return Response(status=status.HTTP_204_NO_CONTENT)


@api_view(['PUT'])
@permission_classes([IsAuthenticated])
@transaction.atomic
def update_user_role(request):
    if not check_is_admin(request.user):
        return Response({'error': 'Unauthorized. Only administrators can update roles.'}, status=status.HTTP_403_FORBIDDEN)
        
    email = email_input(request.data)
    role_value = request.data.get('role')
    role = role_value.strip() if isinstance(role_value, str) else ''
    
    if not email or not role:
        return Response({'error': 'Email and role required'}, status=status.HTTP_400_BAD_REQUEST)

    valid_roles = ['admin', 'boss', 'godown_incharge', 'technician', 'accounts']
    if role not in valid_roles:
        return Response({'error': f'Invalid role: {role}'}, status=status.HTTP_400_BAD_REQUEST)

    # Self-demotion check
    if email.lower() == (request.user.email or '').lower() and role not in ('admin', 'boss'):
        return Response({'error': 'You cannot demote your own admin account.'}, status=status.HTTP_400_BAD_REQUEST)

    from .models import UserProfile, Employee

    # Role edits must never create an account with an implicit password or
    # guess between ambiguous employees. Provision/link identities separately.
    target_user = unique_user(email)
    if target_user is None:
        return Response({'error': 'A unique existing login is required. Create/link the employee login first.'}, status=409)
    target_user = User.objects.select_for_update().get(pk=target_user.pk)
    if target_user.pk == request.user.pk and role not in ADMIN_ROLES:
        return Response({'error': 'You cannot demote your own admin account.'}, status=400)
    employees = list(Employee.objects.filter(Q(user=target_user) | Q(email__iexact=email)).distinct()[:2])
    if len(employees) > 1 or (employees and employees[0].user_id not in (None, target_user.pk)):
        return Response({'error': 'Employee identity is ambiguous. Review the identity link first.'}, status=409)
    UserProfile.objects.update_or_create(user=target_user, defaults={'role': role})
    target_user.is_staff = role in ADMIN_ROLES
    target_user.is_superuser = role in ADMIN_ROLES
    target_user.save(update_fields=['is_staff', 'is_superuser'])
    if employees:
        employees[0].role = role
        employees[0].save(update_fields=['role'])

    return Response({'message': f'Role for {email} updated to {role}'})


@api_view(['POST'])
@permission_classes([IsAuthenticated])
@throttle_classes([PasswordAttemptThrottle])
@transaction.atomic
def admin_reset_password(request):
    if not isinstance(request.data, Mapping):
        return Response({'error':'Provide password fields as an object.'},status=400)
    if not check_is_admin(request.user):
        return Response({'error': 'Unauthorized. Only administrators can reset passwords.'}, status=status.HTTP_403_FORBIDDEN)
        
    email = email_input(request.data)
    if not email:
        return Response({'error': 'Email is required.'}, status=status.HTTP_400_BAD_REQUEST)
        
    # Never provision or relink an identity through a password reset.
    user = unique_user(email)
    if user is None:
        return Response({'error': 'A unique existing login is required. Create/link the employee login first.'}, status=409)
    # Lock in primary-key order, including the approving administrator.
    locked = {u.pk: u for u in User.objects.select_for_update().filter(pk__in=[request.user.pk, user.pk]).order_by('pk')}
    administrator = locked[request.user.pk]
    current_password = request.data.get('current_password')
    if not credential_still_current(request, administrator) or not is_business_administrator(administrator):
        return Response({'error': 'Sign in again before resetting a password.'}, status=401)
    if not isinstance(current_password, str) or len(current_password) > 1024 or not administrator.check_password(current_password):
        return Response({'error': 'Your administrator password is incorrect.'}, status=400)
    user = locked[user.pk]
    new_password = request.data.get('new_password')
    error = password_error(new_password, user)
    if error:
        return Response({'error': error}, status=400)
    if user.check_password(new_password):
        return Response({'error': 'Choose a different password.'}, status=400)
    user.set_password(new_password)
    user.save(update_fields=['password'])
    Token.objects.filter(user=user).delete()
    response = Response({'message': 'Password set. Previous API logins are revoked. Share the new password privately.', 'login_required': user.pk == request.user.pk})
    response['Cache-Control'] = 'no-store'
    return response
