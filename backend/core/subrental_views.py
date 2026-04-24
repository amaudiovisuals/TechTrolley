
from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
from django.shortcuts import get_object_or_404
from .models import SubrentalCompany
from .serializers import SubrentalCompanySerializer

@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
def subrental_company_list(request):
    if request.method == 'GET':
        companies = SubrentalCompany.objects.all().order_by('-created_at')
        serializer = SubrentalCompanySerializer(companies, many=True)
        return Response(serializer.data)
    elif request.method == 'POST':
        serializer = SubrentalCompanySerializer(data=request.data)
        if serializer.is_valid():
            serializer.save()
            return Response(serializer.data, status=201)
        return Response(serializer.errors, status=400)

@api_view(['GET', 'PUT', 'PATCH', 'DELETE'])
@permission_classes([IsAuthenticated])
def subrental_company_detail(request, pk):
    company = get_object_or_404(SubrentalCompany, pk=pk)
    if request.method == 'GET':
        serializer = SubrentalCompanySerializer(company)
        return Response(serializer.data)
    elif request.method in ['PUT', 'PATCH']:
        serializer = SubrentalCompanySerializer(company, data=request.data, partial=(request.method == 'PATCH'))
        if serializer.is_valid():
            serializer.save()
            return Response(serializer.data)
        return Response(serializer.errors, status=400)
    elif request.method == 'DELETE':
        company.delete()
        return Response(status=204)
