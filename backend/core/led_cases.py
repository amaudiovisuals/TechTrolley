"""Reviewed unit conversion. Retain old box/history; six new panels replace its stock count."""
from decimal import Decimal
import hashlib
from pathlib import Path
from uuid import UUID

from django.conf import settings
from django.db import connection, transaction, IntegrityError
from django.db.models import F, Q
from django.shortcuts import get_object_or_404
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .asset_commands import CommandError
from .models import Asset, LedCaseConversion, LedCasePanel
from .permissions import ADMIN_ROLES, WAREHOUSE_ROLES, get_business_role
from .reconciliation_commands import canonical, database_identity, digest

PROTOCOL = 'led-case-six-panels-1'


def panel_sku(source_id, slot):
    return f'LED-P2-{source_id}-P{slot}'


def snapshot(asset):
    from .models import Conference, CompanySettings
    links = Conference.objects.filter(Q(assets=asset) | Q(staged_assets=asset) | Q(crosscheck_assets=asset) | Q(requirements=asset) | Q(challan_assets=asset)).distinct().order_by('pk')
    return canonical({'asset': Asset.objects.filter(pk=asset.pk).values().get(),
        'events': list(links.values('id', 'revision', 'is_audit', 'lifecycle_state')),
        'staff': list(asset.staff_allocations.order_by('pk').values()),
        'physical_movements': list(asset.physical_movements.order_by('pk').values()),
        'children': list(asset.sub_assets.order_by('pk').values_list('pk', flat=True)),
        'quantity_allocations': list(asset.quantity_allocations.order_by('pk').values()),
        'consumable_allocations': list(asset.consumable_allocations.order_by('pk').values()),
        'tickets': list(asset.ticket_items.order_by('pk').values()),
        'issuer': list(CompanySettings.objects.order_by('pk').values()),
        'owner': {'id': asset.subrental_company_id, 'name': asset.subrental_company.name, 'mode': asset.subrental_company.inventory_mode} if asset.subrental_company_id else None})


def gate():
    if getattr(settings, 'LED_CASE_CONVERSION_WRITES_ENABLED', False) is not True:
        return 'conversion_writes_disabled'
    if not getattr(settings, 'LED_CASE_CONVERSION_INSTANCE_ID', ''):
        return 'conversion_instance_identity_required'
    name = str(connection.settings_dict['NAME'])
    if connection.vendor != 'postgresql' and not (connection.vendor == 'sqlite' and (name == ':memory:' or name.startswith('file:memorydb_'))):
        return 'business_sqlite_conversion_refused'
    return None


def prepare(asset):
    before = snapshot(asset)
    blocked = []
    from .custody import custody_state
    state = custody_state(asset)
    if asset.stock_kind != 'equipment' or hasattr(asset, 'led_case_conversion'):
        blocked.append('box_already_converted_or_not_box_stock')
    if asset.alias_name != 'LED WALL BOX P2' or asset.quantity != 1 or asset.quantity_tracking:
        blocked.append('requires_one_reviewed_normal_P2_box')
    if asset.is_temporary or asset.parent_asset_id or before['children'] or asset.type == 'Consumables':
        blocked.append('kit_or_temporary_source_requires_review')
    if asset.status != 'Available' or asset.flag or asset.condition != 'Good' or asset.assigned_to_id:
        blocked.append('box_must_be_available_and_healthy')
    if any(state[key] for key in ('active_event_ids', 'unchecked_event_ids', 'staged_event_ids', 'held_quantity', 'legacy_quantity_unknown', 'staff_issue_employee_ids')):
        blocked.append('close_existing_custody_before_conversion')
    if asset.requirement_conferences.filter(is_audit=False).exists() or before['quantity_allocations'] or before['consumable_allocations'] or before['tickets']:
        blocked.append('existing_reservations_or_quantity_history_require_review')
    if any(row['returned_at'] is None for row in before['staff']):
        blocked.append('outstanding_staff_issue')
    latest = {}
    for row in before['physical_movements']:
        latest[row['conference_id']] = row['action']
    if any(action not in {'verify_return', 'transfer_out', 'legacy_return_review'} for action in latest.values()):
        blocked.append('unresolved_physical_movement_history')
    if asset.subrental_company_id and asset.subrental_company.inventory_mode != 'shared_warehouse':
        blocked.append('supplier_must_be_shared_warehouse')
    tokens = {str(getattr(asset, field) or '').strip() for field in ('sku', 'qr_code', 'barcode', 'serial_number')} - {''}
    for token in tokens | {panel_sku(asset.pk, slot) for slot in range(1, 7)}:
        if Asset.objects.exclude(pk=asset.pk).filter(Q(sku__iexact=token) | Q(qr_code__iexact=token) | Q(barcode__iexact=token) | Q(serial_number__iexact=token)).exists():
            blocked.append('duplicate_box_or_generated_panel_identifier'); break
    cost = asset.item_price or Decimal('0')
    if cost < 0:
        blocked.append('negative_box_cost_requires_review')
    cents = int(cost * 100)
    panels = [{'slot': slot, 'sku': panel_sku(asset.pk, slot), 'quantity': 1,
               'owner_id': asset.subrental_company_id, 'unit_cost': str(Decimal(cents // 6 + (1 if slot <= cents % 6 else 0)) / 100)} for slot in range(1, 7)]
    database = {**database_identity(), 'conversion_instance_id': getattr(settings, 'LED_CASE_CONVERSION_INSTANCE_ID', ''),
                'conversion_source_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    review = {'protocol': PROTOCOL, 'database': database, 'before': before, 'panels': panels}
    return {'protocol': PROTOCOL, 'source_id': asset.pk, 'box_code': asset.sku, 'review_hash': digest(review),
        'blockers': blocked, 'write_gate': gate(), 'can_apply': not blocked and gate() is None,
        'before_box_stock': 1, 'after_panel_stock': 6, 'historical_box_stock_after': 0,
        'original_cost': str(cost), 'panels': panels,
        'notes': ['The original box ID, QR, metadata and program/paper history remain intact.',
                  'The box becomes a container/historical record, excluded from current stock totals.',
                  'All panels inherit the original owner. This conversion does not transfer ownership.',
                  'Temporarily number panels 1–6 within the case; keep that packing until individual labels are attached.',
                  'Box QR selection is online-only and requires reviewing the panels actually present.']}, before


def case_data(case):
    from .custody import available_quantity
    from .models import CompanySettings
    company = CompanySettings.objects.order_by('pk').first()
    return {'id': case.pk, 'source_id': case.source_asset_id, 'box_code': case.source_asset.sku,
        'request_id': str(case.request_id), 'actor': case.actor_label, 'created_at': case.created_at.isoformat(),
        'panels': [{'slot': row.slot, 'asset_id': row.asset_id, 'sku': row.asset.sku,
                    'owner_id': row.asset.subrental_company_id,
                    'owner_name': row.asset.subrental_company.name if row.asset.subrental_company_id else company.name if company else 'Main company',
                    'status': row.asset.status, 'available': available_quantity(row.asset)}
                   for row in case.panels.select_related('asset__subrental_company').order_by('slot')]}


@transaction.atomic
def convert(user, source_id, payload):
    if get_business_role(user) not in ADMIN_ROLES:
        raise CommandError('not_authorized', 403)
    if not isinstance(payload, dict) or set(payload) != {'request_id', 'review_hash', 'reason', 'confirmed_panel_count'} or type(payload['confirmed_panel_count']) is not int or payload['confirmed_panel_count'] != 6:
        raise CommandError('confirm_six_individual_normal_P2_panels', 400)
    try:
        request_id = UUID(str(payload['request_id']))
    except (ValueError, TypeError, AttributeError):
        raise CommandError('invalid_request_id', 400)
    if not isinstance(payload['reason'], str) or not 1 <= len(payload['reason'].strip()) <= 1000:
        raise CommandError('conversion_reason_required', 400)
    request_hash = digest({'source_id': source_id, **payload})
    # Lock the original asset first, consistent with warehouse movement commands.
    asset = get_object_or_404(Asset.objects.select_for_update(), pk=source_id)
    previous = LedCaseConversion.objects.filter(request_id=request_id).first()
    if previous:
        if previous.source_asset_id != source_id or previous.actor_id != user.pk or previous.request_hash != request_hash:
            raise CommandError('request_id_reused', 409)
        return {**case_data(previous), 'replayed': True}
    review, before = prepare(asset)
    if review['write_gate'] or review['blockers']:
        raise CommandError(review['write_gate'] or 'conversion_blocked', 409, review['blockers'])
    if payload['review_hash'] != review['review_hash']:
        raise CommandError('box_changed_reload_conversion_review', 409)
    case = LedCaseConversion.objects.create(source_asset=asset, request_id=request_id, request_hash=request_hash,
        actor=user, actor_label=user.get_username(), reason=payload['reason'].strip(), original_snapshot=before, review_hash=review['review_hash'])
    for panel in review['panels']:
        new = Asset.objects.create(stock_kind='led_panel', sku=panel['sku'], alias_name='LED WALL P2 PANEL',
            type=asset.type, quantity=1, purchased_date=asset.purchased_date, item_price=Decimal(panel['unit_cost']),
            depreciation_percentage=asset.depreciation_percentage, subrental_company=asset.subrental_company,
            description=f'Normal P2 LED panel. Original case: {asset.sku}. Temporary case position {panel["slot"]}/6. Individual QR label pending.')
        LedCasePanel.objects.create(case=case, asset=new, slot=panel['slot'])
    Asset.objects.filter(pk=asset.pk).update(stock_kind='led_case', custody_revision=F('custody_revision') + 1)
    return {**case_data(case), 'replayed': False}


@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
def conversion_review(request, pk):
    try:
        if get_business_role(request.user) not in ADMIN_ROLES:
            raise CommandError('not_authorized', 403)
        if request.method == 'POST':
            return Response(convert(request.user, pk, request.data))
        asset = get_object_or_404(Asset.objects.select_related('subrental_company'), pk=pk)
        return Response(prepare(asset)[0])
    except CommandError as error:
        return Response({'error': error.code, 'details': error.details}, status=error.status)
    except IntegrityError:
        return Response({'error': 'conversion_request_conflict_reload_same_request'}, status=409)
