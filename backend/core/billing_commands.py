"""Record audited changes to a program's billing classification."""

from uuid import UUID

from django.db import transaction
from django.shortcuts import get_object_or_404
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .asset_commands import CommandError, canonical_conference
from .models import Conference, MovementReceipt
from .permissions import get_business_role
from .program_deliveries import digest


@transaction.atomic
def set_demo_billing(user, conference_id, payload):
    if get_business_role(user) not in {'accounts', 'admin'}:
        raise CommandError('demo_billing_role_required', 403)
    if (not isinstance(payload, dict) or set(payload) != {'request_id', 'expected_revision', 'is_demo'}
            or type(payload['is_demo']) is not bool
            or type(payload['expected_revision']) is not int or payload['expected_revision'] < 0):
        raise CommandError('invalid_demo_billing_request', 400)
    try:
        request_id = UUID(str(payload['request_id']))
    except (ValueError, TypeError):
        raise CommandError('invalid_request_id', 400)

    fingerprint = digest({'operation': 'demo_billing', 'conference_id': conference_id, **payload})
    receipt, created = MovementReceipt.objects.get_or_create(
        actor=user, request_id=request_id, defaults={'payload_hash': fingerprint},
    )
    event = get_object_or_404(Conference.objects.select_for_update(), pk=conference_id)
    if not created:
        if receipt.payload_hash != fingerprint:
            raise CommandError('request_id_reused')
        return {'conference': canonical_conference(event), 'replayed': True}
    if event.revision != payload['expected_revision']:
        raise CommandError('document_changed')
    if event.is_audit:
        raise CommandError('demo_billing_audit_program', 400)

    before = event.is_demo
    after = payload['is_demo']
    if after and not before and event.is_invoiced:
        raise CommandError('demo_billing_already_invoiced')
    if before != after:
        event.is_demo = after
        event.save(update_fields=['is_demo'])
    receipt.result = {
        'operation': 'demo_billing', 'conference_id': event.pk,
        'before': {'is_demo': before, 'is_invoiced': event.is_invoiced},
        'after': {'is_demo': after, 'is_invoiced': event.is_invoiced},
    }
    receipt.save(update_fields=['result'])
    return {'conference': canonical_conference(event), 'replayed': False}


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def demo_billing(request, pk):
    try:
        return Response(set_demo_billing(request.user, pk, request.data))
    except CommandError as error:
        return Response({'error': error.code}, status=error.status)
