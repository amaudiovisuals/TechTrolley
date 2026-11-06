"""Reusable contacts. Programs/papers retain copied values, never live links."""
import hashlib
import json

from django.db import IntegrityError, transaction
from django.db.models import Q
from django.shortcuts import get_object_or_404
from rest_framework import serializers
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .models import SavedCustomer, SavedVenue
from .permissions import get_business_role


class CustomerSerializer(serializers.ModelSerializer):
    billing_address = serializers.CharField(max_length=4000)
    contact_phone = serializers.CharField(max_length=15, required=False, allow_blank=True)

    class Meta:
        model = SavedCustomer
        exclude = ['identity_hash']
        read_only_fields = ['id', 'revision']


class VenueSerializer(serializers.ModelSerializer):
    address = serializers.CharField(max_length=4000)

    class Meta:
        model = SavedVenue
        exclude = ['identity_hash']
        read_only_fields = ['id', 'revision']


def identity(values):
    normalized = {key: ' '.join(str(value).split()).casefold() for key, value in values.items() if key != 'is_active'}
    return hashlib.sha256(json.dumps(normalized, sort_keys=True).encode()).hexdigest()


def handle(request, kind, pk):
    role = get_business_role(request.user)
    if role not in {'admin', 'boss', 'accounts', 'godown_incharge'} or (request.method != 'GET' and role == 'godown_incharge'):
        return Response({'detail': 'This login cannot change saved customers or venues.'}, status=403)
    model, serializer = (SavedCustomer, CustomerSerializer) if kind == 'customers' else (SavedVenue, VenueSerializer)
    if request.method == 'GET':
        if pk is not None:
            return Response(serializer(get_object_or_404(model, pk=pk)).data)
        query = str(request.query_params.get('search', '')).strip()[:200]
        rows = model.objects.filter(is_active=True)
        if query:
            fields = Q(name__icontains=query)
            fields |= Q(billing_address__icontains=query) | Q(gst_number__icontains=query) if kind == 'customers' else Q(address__icontains=query)
            rows = rows.filter(fields)
        return Response(serializer(rows.order_by('name', 'pk')[:100], many=True).data)
    if not isinstance(request.data, dict):
        return Response({'detail': 'Enter valid saved contact details.'}, status=400)
    allowed = set(serializer().fields) - {'id', 'revision'}
    if set(request.data) - allowed - {'expected_revision'}:
        return Response({'detail': 'Unexpected saved contact fields.'}, status=400)
    try:
        with transaction.atomic():
            existing = get_object_or_404(model.objects.select_for_update(), pk=pk) if pk is not None else None
            if existing is not None:
                expected = request.data.get('expected_revision')
                if type(expected) is not int:
                    return Response({'detail': 'Reload the saved contact before editing.'}, status=428)
                if expected != existing.revision:
                    return Response({'detail': 'This saved contact changed. Reload it before editing.'}, status=409)
            data = {key: value for key, value in request.data.items() if key != 'expected_revision'}
            parsed = serializer(existing, data=data, partial=existing is not None)
            parsed.is_valid(raise_exception=True)
            values = {key: getattr(existing, key) for key in allowed} if existing else {}
            values.update(parsed.validated_data)
            if existing is None:
                for key, field in serializer().fields.items():
                    if key in allowed and key not in values:
                        values[key] = True if key == 'is_active' else ''
            fingerprint = identity(values)
            duplicate = model.objects.filter(identity_hash=fingerprint).first()
            if duplicate and (existing is None or duplicate.pk != existing.pk):
                if existing is None and duplicate.is_active:
                    return Response(serializer(duplicate).data)
                return Response({'detail': 'These details already have a saved entry.'}, status=409)
            saved = parsed.save(identity_hash=fingerprint, revision=existing.revision + 1 if existing else 1)
            return Response(serializer(saved).data, status=200 if existing else 201)
    except IntegrityError:
        return Response({'detail': 'This entry was just saved elsewhere. Search and reload it.'}, status=409)


@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
def customers(request):
    return handle(request, 'customers', None)


@api_view(['GET', 'PATCH'])
@permission_classes([IsAuthenticated])
def customer_detail(request, pk):
    return handle(request, 'customers', pk)


@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
def venues(request):
    return handle(request, 'venues', None)


@api_view(['GET', 'PATCH'])
@permission_classes([IsAuthenticated])
def venue_detail(request, pk):
    return handle(request, 'venues', pk)
