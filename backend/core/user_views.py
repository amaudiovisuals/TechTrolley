from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
from django.contrib.auth.models import User
from django.contrib.auth import update_session_auth_hash
from .serializers import UserSerializer

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
    if request.method == 'GET':
        users = User.objects.filter(is_staff=True)
        serializer = UserSerializer(users, many=True)
        return Response(serializer.data)
    
    elif request.method == 'POST':
        email = request.data.get('email')
        password = request.data.get('password')
        
        if not email or not password:
            return Response({'error': 'Please provide both email and password.'}, status=status.HTTP_400_BAD_REQUEST)
        
        if User.objects.filter(username=email).exists():
            return Response({'error': 'User with this email already exists.'}, status=status.HTTP_400_BAD_REQUEST)
        
        # System Administrators are marked with is_staff=True
        user = User.objects.create_user(username=email, email=email, password=password, is_staff=True)
        return Response({'message': 'User created successfully.', 'id': user.id, 'email': user.email}, status=status.HTTP_201_CREATED)

@api_view(['DELETE'])
@permission_classes([IsAuthenticated])
def system_user_delete(request, pk):
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
    if not request.user.is_superuser and not request.user.is_staff:
        return Response({'error': 'Unauthorized.'}, status=status.HTTP_403_FORBIDDEN)
        
    email = request.data.get('email')
    role = request.data.get('role')
    
    if not email or not role:
        return Response({'error': 'Email and role required'}, status=status.HTTP_400_BAD_REQUEST)
        
    try:
        user = User.objects.get(username=email)
        
        # Ensure profile exists for legacy users
        if hasattr(user, 'profile'):
            user.profile.role = role
            user.profile.save()
        else:
            from .models import UserProfile
            UserProfile.objects.create(user=user, role=role)

        # Auto-update status based on role definition
        if role == 'admin':
            user.is_staff = True
            user.is_superuser = True
        else:
            user.is_superuser = False
            user.is_staff = False
            
        user.save()

        # Sync Employee model if it exists
        from .models import Employee
        try:
            employee = Employee.objects.get(email=email)
            employee.role = role
            employee.save()
            print(f"Synced Employee role for {email} to {role}")
        except Employee.DoesNotExist:
            print(f"No Employee record found for {email} to sync role.")

        return Response({'message': f'Role updated to {role}'})
    except User.DoesNotExist:
        return Response({'error': 'User not found.'}, status=status.HTTP_404_NOT_FOUND)

@api_view(['POST'])
@permission_classes([IsAuthenticated])
def admin_reset_password(request):
    if not request.user.is_superuser and not request.user.is_staff:
        return Response({'error': 'Unauthorized. Only admins can reset passwords.'}, status=status.HTTP_403_FORBIDDEN)
        
    email = request.data.get('email')
    if not email:
        return Response({'error': 'Email is required.'}, status=status.HTTP_400_BAD_REQUEST)
        
    user = User.objects.filter(username__iexact=email).first() or User.objects.filter(email__iexact=email).first()
    
    if user:
        user.set_password('amoffice')
        user.save()
        return Response({'message': f'Password for {user.email or user.username} has been reset to "amoffice".'})
    
    # Fallback to Employee table if no Django User exists yet
    from .models import Employee
    emp = Employee.objects.filter(email__iexact=email).first()
    if emp:
        User.objects.create_user(username=emp.email, email=emp.email, password='amoffice', is_staff=False)
        return Response({'message': f'User account provisioned and password set to "amoffice" for {emp.email}.'})

    return Response({'error': 'User not found.'}, status=status.HTTP_404_NOT_FOUND)


