"""Minimal read-only preparation contract. Never grants offline authority."""
from datetime import timedelta
from uuid import uuid4

from django.db import connection, transaction
from django.db.models import Q
from django.utils import timezone
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .models import Asset, Conference
from .permissions import WAREHOUSE_ROLES, get_business_role

MAX_ASSETS = 5000


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def offline_package(request, pk):
    def reply(data, status=200):
        response = Response(data, status=status)
        response['Cache-Control'] = 'private, no-store'
        response['Vary'] = 'Authorization, Cookie'
        return response

    # SET TRANSACTION must precede all snapshot reads. Refuse an unexpected
    # enclosing PostgreSQL transaction instead of returning a mixed snapshot.
    if connection.vendor == 'postgresql' and connection.in_atomic_block:
        return reply({'error': 'offline_snapshot_unavailable'}, 503)
    with transaction.atomic():
        if connection.vendor == 'postgresql':
            with connection.cursor() as cursor:
                cursor.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        role = get_business_role(request.user)
        if role not in WAREHOUSE_ROLES:
            return reply({'error': 'offline_role_not_supported'}, 403)
        event = Conference.objects.filter(pk=pk).first()
        if event is None:
            return reply({'error': 'event_not_found'}, 404)
        if event.is_audit or event.lifecycle_state != 'open':
            return reply({'error': 'offline_event_not_supported'}, 409)
        # Only independent, physically shared-godown unit stock in this first
        # version. Omitted stock must never be inferred to be available.
        rows = list(Asset.objects.filter(
            quantity=1, quantity_tracking=False, is_temporary=False,
            parent_asset__isnull=True, sub_assets__isnull=True,
            quantity_allocations__isnull=True, consumable_allocations__isnull=True,
        ).exclude(type='Consumables').filter(
            Q(subrental_company__isnull=True) |
            Q(subrental_company__inventory_mode='shared_warehouse')
        ).select_related('subrental_company').order_by('pk')[:MAX_ASSETS + 1])
        if len(rows) > MAX_ASSETS:
            return reply({'error': 'offline_index_too_large'}, 409)
        now = timezone.now()
        return reply({
            'schema': 1, 'package_id': str(uuid4()),
            'account_id': request.user.pk, 'role': role,
            'generated_at': now.isoformat(), 'expires_at': (now + timedelta(hours=24)).isoformat(),
            'scope': 'unit_requirements_stage',
            'event': {'id': event.pk, 'name': event.name, 'revision': event.revision,
                      'lifecycle_state': 'open',
                      'staged_ids': list(event.staged_assets.order_by('pk').values_list('pk', flat=True))},
            'assets': [{'id': a.pk, 'sku': a.sku or '', 'barcode': a.barcode or '',
                        'qr_code': a.qr_code or '', 'serial_number': a.serial_number or '',
                        'label': a.alias_name or a.sku or '', 'type': a.type or '',
                        'last_known_status': a.status,
                        'owner_label': a.subrental_company.name if a.subrental_company_id else ''}
                       for a in rows],
        })
