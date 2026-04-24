from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
from django.shortcuts import get_object_or_404
from .models import SubrentalTicket, SubrentalTicketItem, SubrentalCompany, Asset
from .serializers import SubrentalTicketSerializer, SubrentalTicketItemSerializer

@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
def subrental_ticket_list(request):
    if request.method == 'GET':
        company_id = request.query_params.get('company_id')
        conference_id = request.query_params.get('conference_id')
        
        tickets = SubrentalTicket.objects.all()
        if company_id:
            tickets = tickets.filter(company_id=company_id)
        if conference_id:
            tickets = tickets.filter(conference_id=conference_id)
            
        serializer = SubrentalTicketSerializer(tickets.order_by('-created_at'), many=True)
        return Response(serializer.data)
        
    elif request.method == 'POST':
        serializer = SubrentalTicketSerializer(data=request.data)
        if serializer.is_valid():
            serializer.save()
            return Response(serializer.data, status=201)
        return Response(serializer.errors, status=400)

@api_view(['GET', 'PUT', 'PATCH', 'DELETE'])
@permission_classes([IsAuthenticated])
def subrental_ticket_detail(request, pk):
    ticket = get_object_or_404(SubrentalTicket, pk=pk)
    
    if request.method == 'GET':
        serializer = SubrentalTicketSerializer(ticket)
        return Response(serializer.data)
    elif request.method in ['PUT', 'PATCH']:
        serializer = SubrentalTicketSerializer(ticket, data=request.data, partial=(request.method == 'PATCH'))
        if serializer.is_valid():
            serializer.save()
            return Response(serializer.data)
        return Response(serializer.errors, status=400)
    elif request.method == 'DELETE':
        ticket.delete()
        return Response(status=204)

@api_view(['POST'])
@permission_classes([IsAuthenticated])
def add_ticket_item(request, ticket_pk):
    ticket = get_object_or_404(SubrentalTicket, pk=ticket_pk)
    asset_id = request.data.get('asset_id')
    
    # If no asset_id, create a new one based on provided details
    if not asset_id:
        from decimal import Decimal
        asset = Asset.objects.create(
            alias_name=request.data.get('name'),
            name=request.data.get('name', ''),
            sku=f"SR-{request.data.get('name', 'ITEM')[:10].upper()}-{ticket.id}",
            item_price=Decimal(str(request.data.get('price', 0))),
            depreciation_percentage=Decimal(str(request.data.get('depreciation', 0))),
            quantity=int(request.data.get('quantity', 1)),
            subrental_company=ticket.company,
            is_temporary=True,
            type='Other'
        )
    else:
        asset = get_object_or_404(Asset, pk=asset_id)
        
    ticket_item = SubrentalTicketItem.objects.create(
        ticket=ticket,
        asset=asset,
        rental_price=request.data.get('rental_price', 0),
        quantity=request.data.get('quantity', 1)
    )
    
    serializer = SubrentalTicketItemSerializer(ticket_item)
    return Response(serializer.data, status=201)

@api_view(['PATCH', 'DELETE'])
def ticket_item_detail(request, pk):
    item = get_object_or_404(SubrentalTicketItem, pk=pk)
    if request.method == 'DELETE':
        item.delete()
        return Response(status=204)
    elif request.method == 'PATCH':
        item.rental_price = request.data.get('rental_price', item.rental_price)
        item.quantity = request.data.get('quantity', item.quantity)
        item.save()
        
        # If it's a temporary asset, update its details too
        if item.asset.is_temporary:
            asset = item.asset
            asset.alias_name = request.data.get('name', asset.alias_name)
            asset.name = request.data.get('name', asset.name)
            asset.item_price = request.data.get('price', asset.item_price)
            asset.depreciation_percentage = request.data.get('depreciation', asset.depreciation_percentage)
            asset.save()
            
        serializer = SubrentalTicketItemSerializer(item)
        return Response(serializer.data)
