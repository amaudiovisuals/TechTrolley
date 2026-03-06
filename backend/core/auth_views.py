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

    # Find user by email (since default auth uses username)
    try:
        user = User.objects.get(email=email)
    except User.DoesNotExist:
        return Response({'error': 'Invalid Credentials'}, status=status.HTTP_400_BAD_REQUEST)

    # Check password using the found user instance
    user = authenticate(username=user.username, password=password)

    if not user:
        return Response({'error': 'Invalid Credentials'}, status=status.HTTP_400_BAD_REQUEST)

    token, _ = Token.objects.get_or_create(user=user)
    return Response({
        'token': token.key,
        'user_id': user.pk,
        'email': user.email
    })
