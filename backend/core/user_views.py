from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
from django.contrib.auth.models import User
from django.contrib.auth import update_session_auth_hash
from .serializers import UserSerializer


def check_is_admin(user):
    """Checks if the user has administrator privileges across all models."""
    if not user or not user.is_authenticated:
        return False
    if user.is_superuser or user.is_staff:
        return True
    if hasattr(user, 'profile') and user.profile.role == 'admin':
        # Self-heal is_staff flag if missing
        if not user.is_staff:
            user.is_staff = True
            user.is_superuser = True
            user.save(update_fields=['is_staff', 'is_superuser'])
        return True
    from .models import Employee
    emp = Employee.objects.filter(email__iexact=user.email).first()
    if emp and emp.role == 'admin':
        if not user.is_staff:
            user.is_staff = True
            user.is_superuser = True
            user.save(update_fields=['is_staff', 'is_superuser'])
        return True
    return False


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def change_password(request):
    user = request.user
    old_password = request.data.get('old_password')
    new_password = request.data.get('new_password')

    if not user.check_password(old_password):
        return Response({'error': 'Incorrect old password.'}, status=status.HTTP_400_BAD_REQUEST)

    user.set_password(new_password)
    user.save()
    update_session_auth_hash(request, user)  # Important to keep the session active
    return Response({'message': 'Password changed successfully.'}, status=status.HTTP_200_OK)


@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
def system_user_list(request):
    if not check_is_admin(request.user):
        return Response({'error': 'Unauthorized. Only administrators can access system users.'}, status=status.HTTP_403_FORBIDDEN)

    if request.method == 'GET':
        users = User.objects.filter(is_staff=True)
        serializer = UserSerializer(users, many=True)
        return Response(serializer.data)
    
    elif request.method == 'POST':
        email = (request.data.get('email') or '').strip()
        password = request.data.get('password')
        
        if not email or not password:
            return Response({'error': 'Please provide both email and password.'}, status=status.HTTP_400_BAD_REQUEST)
        
        if User.objects.filter(username__iexact=email).exists() or User.objects.filter(email__iexact=email).exists():
            return Response({'error': 'User with this email already exists.'}, status=status.HTTP_400_BAD_REQUEST)
        
        # System Administrators are marked with is_staff=True
        user = User.objects.create_user(username=email, email=email, password=password, is_staff=True, is_superuser=True)
        from .models import UserProfile
        UserProfile.objects.get_or_create(user=user, defaults={'role': 'admin'})
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

    user.delete()
    return Response(status=status.HTTP_204_NO_CONTENT)


@api_view(['PUT'])
@permission_classes([IsAuthenticated])
def update_user_role(request):
    if not check_is_admin(request.user):
        return Response({'error': 'Unauthorized. Only administrators can update roles.'}, status=status.HTTP_403_FORBIDDEN)
        
    email = (request.data.get('email') or '').strip()
    role = (request.data.get('role') or '').strip()
    
    if not email or not role:
        return Response({'error': 'Email and role required'}, status=status.HTTP_400_BAD_REQUEST)

    valid_roles = ['admin', 'godown_incharge', 'technician', 'accounts']
    if role not in valid_roles:
        return Response({'error': f'Invalid role: {role}'}, status=status.HTTP_400_BAD_REQUEST)

    # Self-demotion check
    if email.lower() == (request.user.email or '').lower() and role != 'admin':
        return Response({'error': 'You cannot demote your own admin account.'}, status=status.HTTP_400_BAD_REQUEST)

    from .models import UserProfile, Employee

    # 1. Update or create Django User
    target_user = (
        User.objects.filter(email__iexact=email).first() or
        User.objects.filter(username__iexact=email).first()
    )

    if target_user:
        if hasattr(target_user, 'profile'):
            target_user.profile.role = role
            target_user.profile.save()
        else:
            UserProfile.objects.create(user=target_user, role=role)

        if role == 'admin':
            target_user.is_staff = True
            target_user.is_superuser = True
        else:
            target_user.is_superuser = False
            target_user.is_staff = False
        target_user.save()
    else:
        # If no Django User exists, provision one so this employee can log in with their assigned role
        target_user = User.objects.create_user(
            username=email,
            email=email,
            password='amoffice',
            is_staff=(role == 'admin'),
            is_superuser=(role == 'admin')
        )
        UserProfile.objects.create(user=target_user, role=role)

    # 2. Sync Employee model
    employee = Employee.objects.filter(email__iexact=email).first()
    if employee:
        employee.role = role
        employee.save()
    else:
        name_part = email.split('@')[0].replace('.', ' ').title()
        Employee.objects.create(
            name=name_part,
            email=email,
            role=role,
            designation=role.replace('_', ' ').title()
        )

    return Response({'message': f'Role for {email} updated to {role}'})


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def admin_reset_password(request):
    if not check_is_admin(request.user):
        return Response({'error': 'Unauthorized. Only administrators can reset passwords.'}, status=status.HTTP_403_FORBIDDEN)
        
    email = (request.data.get('email') or '').strip()
    if not email:
        return Response({'error': 'Email is required.'}, status=status.HTTP_400_BAD_REQUEST)
        
    user = User.objects.filter(username__iexact=email).first() or User.objects.filter(email__iexact=email).first()
    
    if user:
        user.set_password('amoffice')
        user.save()
        return Response({'message': f'Password for {user.email or user.username} has been reset to "amoffice".'})
    
    # Fallback to Employee table if no Django User exists yet
    from .models import Employee, UserProfile
    emp = Employee.objects.filter(email__iexact=email).first()
    if emp:
        new_u = User.objects.create_user(username=emp.email, email=emp.email, password='amoffice', is_staff=(emp.role == 'admin'))
        UserProfile.objects.create(user=new_u, role=emp.role or 'technician')
        return Response({'message': f'User account provisioned and password set to "amoffice" for {emp.email}.'})

    return Response({'error': 'User not found.'}, status=status.HTTP_404_NOT_FOUND)


