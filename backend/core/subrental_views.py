from .permissions import WarehouseWriteAuthenticatedRead

from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
from django.shortcuts import get_object_or_404
from .models import SubrentalCompany
from .serializers import SubrentalCompanySerializer
from django.db import transaction

@api_view(['GET', 'POST'])
@permission_classes([WarehouseWriteAuthenticatedRead])
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
@permission_classes([WarehouseWriteAuthenticatedRead])
@transaction.atomic
def subrental_company_detail(request, pk):
    company = get_object_or_404(SubrentalCompany, pk=pk)
    if request.method == 'GET':
        serializer = SubrentalCompanySerializer(company)
        return Response(serializer.data)
    elif request.method in ['PUT', 'PATCH']:
        company = get_object_or_404(SubrentalCompany.objects.select_for_update(), pk=pk)
        serializer = SubrentalCompanySerializer(company, data=request.data, partial=(request.method == 'PATCH'))
        if serializer.is_valid():
            serializer.save()
            return Response(serializer.data)
        return Response(serializer.errors, status=400)
    elif request.method == 'DELETE':
        # Protect sealed paperwork from the supplier -> ticket cascade.
        from .models import Asset, Conference
        from .event_lifecycle import referenced_asset_ids
        event_ids = list(company.tickets.order_by('conference_id').values_list('conference_id', flat=True).distinct())
        ids = set(company.assets.values_list('pk', flat=True))
        for event_id in event_ids:
            ids.update(referenced_asset_ids(event_id))
        list(Asset.objects.select_for_update().filter(pk__in=ids).order_by('pk'))
        events = list(Conference.objects.select_for_update().filter(pk__in=event_ids).order_by('pk'))
        SubrentalCompany.objects.select_for_update().get(pk=company.pk)
        if set(company.tickets.values_list('conference_id', flat=True)) != set(event_ids):
            return Response({'error': 'supplier_event_links_changed_retry'}, status=409)
        if any(event.lifecycle_state != 'open' or event.lifecycle_history.exists() for event in events):
            return Response({'error': 'supplier_has_event_lifecycle_history'}, status=409)
        if company.ownership_targets.exists():
            return Response({'error': 'supplier_has_ownership_history'}, status=409)
        if company.assets.exists():
            return Response({'error': 'supplier_inventory_requires_review'}, status=409)
        if company.tickets.filter(items__isnull=False).exists():
            return Response({'error': 'reviewed_supplier_removal_required'}, status=409)
        from django.db.models.deletion import ProtectedError
        try:
            company.delete()
            for event in events:
                event.save(update_fields=['revision'])
        except ProtectedError:
            return Response({'error': 'supplier_has_challan_history'}, status=409)
        return Response(status=204)
