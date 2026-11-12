from .permissions import WarehouseWriteAuthenticatedRead
from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
from django.shortcuts import get_object_or_404
from .models import SubrentalTicket, SubrentalTicketItem, SubrentalCompany, Asset
from .serializers import SubrentalTicketSerializer, SubrentalTicketItemSerializer
from django.db import transaction
from .revisions import lock_conference_for_write
from .reconciliation_commands import read_snapshot

@api_view(['GET', 'POST'])
@permission_classes([WarehouseWriteAuthenticatedRead])
@transaction.atomic
def subrental_ticket_list(request):
    if request.method == 'GET':
        read_snapshot()
        company_id = request.query_params.get('company_id')
        conference_id = request.query_params.get('conference_id')
        
        tickets = SubrentalTicket.objects.all()
        if company_id:
            tickets = tickets.filter(company_id=company_id)
        if conference_id:
            tickets = tickets.filter(conference_id=conference_id)
            
        serializer = SubrentalTicketSerializer(tickets.order_by('-created_at'), many=True)
        return Response(serializer.data)
        
    return Response({'error': 'use_supplier_command'}, status=409)

@api_view(['GET', 'PUT', 'PATCH', 'DELETE'])
@permission_classes([WarehouseWriteAuthenticatedRead])
@transaction.atomic
def subrental_ticket_detail(request, pk):
    if request.method == 'GET': read_snapshot()
    ticket = get_object_or_404(SubrentalTicket.objects.select_related('conference', 'company'), pk=pk)
    
    if request.method == 'GET':
        serializer = SubrentalTicketSerializer(ticket)
        return Response(serializer.data)
    elif request.method in ['PUT', 'PATCH']:
        if 'conference' in request.data and str(request.data['conference']) != str(ticket.conference_id):
            return Response({'error': 'ticket_event_move_requires_review'}, status=409)
        event = lock_conference_for_write(ticket.conference_id, {})
        if event.lifecycle_state != 'open':
            return Response({'error': 'event_is_sealed'}, status=409)
        return Response({'error': 'use_supplier_command'}, status=409)
    elif request.method == 'DELETE':
        event = lock_conference_for_write(ticket.conference_id, {})
        if event.lifecycle_state != 'open' or event.lifecycle_history.exists():
            return Response({'error': 'ticket_has_event_lifecycle_history'}, status=409)
        if ticket.items.exists():
            return Response({'error': 'reviewed_supplier_removal_required'}, status=409)
        from django.db.models.deletion import ProtectedError
        try:
            ticket.delete()
            event.save(update_fields=['revision'])
        except ProtectedError:
            return Response({'error': 'ticket_has_challan_history'}, status=409)
        return Response(status=204)

@api_view(['POST'])
@permission_classes([WarehouseWriteAuthenticatedRead])
@transaction.atomic
def add_ticket_item(request, ticket_pk):
    ticket = get_object_or_404(SubrentalTicket, pk=ticket_pk)
    event = lock_conference_for_write(ticket.conference_id, {})
    if event.lifecycle_state != 'open':
        return Response({'error': 'event_is_sealed'}, status=409)
    
    return Response({'error': 'use_supplier_command'}, status=409)

@api_view(['PATCH', 'DELETE'])
@permission_classes([WarehouseWriteAuthenticatedRead])
@transaction.atomic
def ticket_item_detail(request, pk):
    item = get_object_or_404(SubrentalTicketItem, pk=pk)
    event = lock_conference_for_write(item.ticket.conference_id, {})
    if event.lifecycle_state != 'open' or request.method == 'DELETE' and event.lifecycle_history.exists():
        return Response({'error': 'ticket_item_has_event_lifecycle_history'}, status=409)
    if request.method == 'DELETE':
        return Response({'error': 'reviewed_supplier_removal_required'}, status=409)
    return Response({'error': 'use_supplier_command'}, status=409)
