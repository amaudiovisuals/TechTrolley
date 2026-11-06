from django.core.exceptions import SuspiciousOperation
from .upload_safety import BoundedJSONParser, BoundedFormParser
from rest_framework.exceptions import APIException
from .permissions import ConferenceWritePermission, WarehouseWriteAuthenticatedRead
import traceback
import json
from decimal import Decimal, InvalidOperation
from rest_framework.exceptions import ValidationError
from rest_framework.decorators import api_view, parser_classes, permission_classes
from rest_framework.parsers import MultiPartParser, FormParser, JSONParser
from rest_framework.response import Response
from .models import Conference
from .serializers import ConferenceSerializer
from django.shortcuts import get_object_or_404
from django.db import transaction
from .revisions import lock_conference_for_write
from django.db.models import Q


def document_input(data):
    if not hasattr(data, 'getlist'):
        return data
    result = {key: data.get(key) for key in data}
    for field in ('assets', 'crosscheck_assets', 'staged_assets', 'challan_assets', 'requirements', 'assigned_employees'):
        if field in data:
            values = data.getlist(field)
            result[field] = json.loads(values[0]) if len(values) == 1 and values[0].startswith('[') else values
    for field in ('consumable_data', 'flag_log', 'transfer_log'):
        if field in data:
            result[field] = json.loads(data[field])
    return result

@api_view(['GET', 'POST'])
@parser_classes([MultiPartParser, BoundedFormParser, BoundedJSONParser])
@permission_classes([WarehouseWriteAuthenticatedRead])
def conference_list(request):
    if request.method == 'GET':
        conferences = Conference.objects.prefetch_related(
            'assets', 'crosscheck_assets', 'challan_assets', 'requirements', 'assigned_employees',
            'truck_challans', 'truck_challans__assets', 'challan_documents__lines'
        ).order_by('-start_date')
        serializer = ConferenceSerializer(conferences, many=True)
        return Response(serializer.data)
    elif request.method == 'POST':
        try:
            serializer = ConferenceSerializer(data=document_input(request.data))
            if serializer.is_valid():
                if serializer.validated_data.get('consumable_data'):
                    return Response({'error': 'create_event_then_use_consumable_commands'}, status=409)
                for field in ('assets', 'crosscheck_assets', 'staged_assets', 'challan_assets', 'requirements'):
                    if serializer.validated_data.get(field):
                        return Response({'error': 'create_event_then_use_asset_commands', 'field': field}, status=409)
                serializer.save()
                return Response(serializer.data, status=201)
            return Response(serializer.errors, status=400)
        except ValidationError as error:
            return Response(error.detail, status=400)
        except (APIException, SuspiciousOperation):
            raise
        except Exception as e:
            return Response({"error": str(e), "traceback": traceback.format_exc()}, status=500)

@api_view(['GET', 'PUT', 'DELETE', 'PATCH', 'POST'])
@parser_classes([MultiPartParser, BoundedFormParser, BoundedJSONParser])
@permission_classes([ConferenceWritePermission])
@transaction.atomic
def conference_detail(request, pk):
    conference = get_object_or_404(
        Conference.objects.prefetch_related(
            'assets', 'crosscheck_assets', 'challan_assets', 'requirements', 'assigned_employees',
            'truck_challans', 'truck_challans__assets', 'challan_documents__lines'
        ),
        pk=pk
    )

    if request.method != 'GET':
        try:
            payload = document_input(request.data)
        except (ValueError, TypeError):
            return Response({'error': 'invalid_document_payload'}, status=400)
        expected = request.data.get('expected_revision')
        if expected is None:
            return Response({'error': 'expected_revision_required'}, status=428)
        if isinstance(expected, bool) or not str(expected).isdigit():
            return Response({'error': 'invalid_expected_revision'}, status=400)
        conference = lock_conference_for_write(pk, payload)
        if conference.lifecycle_state != 'open' and (request.method == 'DELETE' or set(payload) - {'expected_revision', 'is_invoiced'}):
            return Response({'error': 'event_is_sealed', 'state': conference.lifecycle_state}, status=409)
        from .models import TruckManifest
        if TruckManifest.objects.filter(conference=conference).exists() and (str(payload.get('is_audit', conference.is_audit)).lower() in {'true', '1'}) != conference.is_audit:
            return Response({'error': 'manifest_history_prevents_audit_conversion'}, status=409)
        if int(expected) != conference.revision:
            return Response({'error': 'document_changed', 'revision': conference.revision}, status=409)
        if 'is_audit' in payload and (str(payload['is_audit']).lower() in {'true', '1'}) != conference.is_audit:
            return Response({'error': 'use_reviewed_audit_conversion'}, status=409)
        if 'consumable_data' in payload and payload['consumable_data'] != conference.consumable_data:
            return Response({'error': 'use_consumable_commands'}, status=409)
        if request.method == 'DELETE' and conference.issued_deliveries.exists():
            return Response({'error': 'conference_has_saved_delivery_history'}, status=409)
        if conference.consumable_allocations.exists():
            if request.method == 'DELETE':
                return Response({'error': 'conference_has_consumable_history'}, status=409)
            if (str(payload.get('is_audit', conference.is_audit)).lower() in {'true', '1'}) != conference.is_audit:
                return Response({'error': 'consumable_history_prevents_audit_conversion'}, status=409)
        if conference.quantity_allocations.exists():
            if request.method == 'DELETE':
                return Response({'error': 'conference_has_quantity_history'}, status=409)
            if (str(payload.get('is_audit', conference.is_audit)).lower() in {'true', '1'}) != conference.is_audit:
                return Response({'error': 'quantity_history_prevents_audit_conversion'}, status=409)
        if conference.challan_documents.exists():
            if request.method == 'DELETE':
                return Response({'error': 'conference_has_document_history'}, status=409)
            for field in ('challan_assets', 'challan_number', 'approximate_value'):
                if field in payload:
                    current = getattr(conference, field)
                    same = ({int(v) for v in payload[field]} == set(current.values_list('pk', flat=True))) if field == 'challan_assets' and isinstance(payload[field], list) and all(str(v).isdigit() for v in payload[field]) else str(payload[field]) == str(current)
                    if field == 'approximate_value':
                        try:
                            same = payload[field] is None and current is None or Decimal(str(payload[field])) == Decimal(str(current))
                        except (InvalidOperation, ValueError, TypeError):
                            same = False
                    if not same:
                        return Response({'error': 'use_challan_document', 'field': field}, status=409)
        for field in ('assets', 'crosscheck_assets', 'staged_assets', 'requirements', 'challan_assets'):
            if field not in request.data:
                continue
            desired = payload.get(field)
            if not isinstance(desired, list) or any(not str(value).isdigit() for value in desired):
                return Response({'error': 'invalid_membership'}, status=400)
            if {int(value) for value in desired} != set(getattr(conference, field).values_list('pk', flat=True)):
                return Response({'error': 'use_asset_commands', 'field': field}, status=409)
        # Legacy full replacements cannot seize an asset held by another real event.
        incoming = request.data.get('assets', [])
        if not isinstance(incoming, list):
            incoming = request.data.getlist('assets') if hasattr(request.data, 'getlist') else []
        claimed = [int(value) for value in incoming if str(value).isdigit()]
        tracked = set(conference.quantity_allocations.values_list('asset_id', flat=True))
        claimed = [aid for aid in claimed if aid not in tracked]
        if conference.is_audit:
            claimed += list(conference.assets.values_list('pk', flat=True))
            claimed += list(conference.crosscheck_assets.values_list('pk', flat=True))
        holders = Conference.objects.filter(is_audit=False).exclude(pk=conference.pk).filter(
            Q(assets__in=claimed) | Q(crosscheck_assets__in=claimed)
        )
        will_be_audit = str(request.data.get('is_audit', conference.is_audit)).lower() in {'true', '1'}
        if will_be_audit != conference.is_audit and (conference.assets.exists() or conference.crosscheck_assets.exists() or conference.staged_assets.exists()):
            return Response({'error': 'audit_mode_change_requires_empty_custody'}, status=409)
        if not will_be_audit and holders.exists():
            return Response({'error': 'asset_held_by_other_event'}, status=409)

    if request.method == 'GET':
        serializer = ConferenceSerializer(conference)
        return Response(serializer.data)

    elif request.method == 'PUT':
        try:
            serializer = ConferenceSerializer(conference, data=payload)
            if serializer.is_valid():
                serializer.save()
                return Response(serializer.data)
            return Response(serializer.errors, status=400)
        except ValidationError as error:
            return Response(error.detail, status=400)
        except (APIException, SuspiciousOperation):
            raise
        except Exception as e:
            return Response({"error": str(e), "traceback": traceback.format_exc()}, status=500)
    
    elif request.method in ['PATCH', 'POST']:
        try:
            serializer = ConferenceSerializer(conference, data=payload, partial=True)
            if serializer.is_valid():
                serializer.save()
                return Response(serializer.data)
            return Response(serializer.errors, status=400)
        except ValidationError as error:
            return Response(error.detail, status=400)
        except (APIException, SuspiciousOperation):
            raise
        except Exception as e:
            return Response({"error": str(e), "traceback": traceback.format_exc()}, status=500)

    elif request.method == 'DELETE':
        from .models import ChallanNumberReservation
        if conference.reconciliation_targets.exists() or conference.lifecycle_history.exists() or conference.physical_movements.exists() or conference.incoming_physical_movements.exists():
            return Response({'error': 'event_has_protected_operational_history_use_archive'}, status=409)
        if not conference.is_audit and (conference.assets.exists() or conference.crosscheck_assets.exists() or conference.staged_assets.exists()):
            return Response({'error': 'return_and_verify_assets_before_deleting_event'}, status=409)
        unreserved_legacy_number = bool(conference.challan_number) and not ChallanNumberReservation.objects.filter(number=conference.challan_number, conference=conference).exists()
        if conference.challan_assets.exists() or conference.truck_challans.exists() or conference.subrental_tickets.exists() or unreserved_legacy_number or conference.approximate_value:
            return Response({'error': 'event_has_legacy_history_requiring_preservation'}, status=409)
        conference.delete()
        return Response(status=204)


@api_view(['GET'])
@permission_classes([WarehouseWriteAuthenticatedRead])
@transaction.atomic
def conference_custody_review(request, pk):
    """Consistent read-only proposals; no serializers, status writes or number allocation."""
    from .permissions import get_business_role, WAREHOUSE_ROLES
    from .custody import review_assets
    from django.db import connection
    import hashlib
    if connection.vendor == 'postgresql':
        with connection.cursor() as cursor:
            cursor.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    if get_business_role(request.user) not in WAREHOUSE_ROLES:
        return Response({'error': 'warehouse_review_role_required'}, status=403)
    conference = get_object_or_404(Conference, pk=pk)
    ids = set()
    for field in ('assets', 'crosscheck_assets', 'staged_assets', 'challan_assets', 'requirements'):
        ids.update(getattr(conference, field).values_list('pk', flat=True))
    rows = review_assets(ids)
    result = {'mode': 'preview_only', 'conference_id': conference.pk, 'name': conference.name,
              'revision': conference.revision, 'is_audit': conference.is_audit, 'rows': rows,
              'mismatch_count': sum(not row['status_matches'] for row in rows),
              'blocked_count': sum(bool(row['blockers']) for row in rows),
              'limitations': ['Historical, planning and audit entries do not prove current physical custody.',
                              'Dates and empty queues do not prove completed returns.',
                              'Proposals require physical verification and unchanged evidence before any reviewed repair.']}
    result['snapshot_sha256'] = hashlib.sha256(json.dumps(result, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return Response(result)
