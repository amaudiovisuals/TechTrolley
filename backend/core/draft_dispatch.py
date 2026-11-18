"""Add newly dispatched physical equipment to an open, unissued master draft."""

from datetime import date
from decimal import Decimal, ROUND_HALF_UP
from uuid import uuid5

from django.utils import timezone

from .challan_documents import document_data
from .challan_lock import INDIA, challans_locked
from .dispatch_origins import event_origins
from .inventory_ownership import warehouse_managed
from .models import ChallanDocument, ChallanLine, ChallanRevision


def draft_unit_value(asset):
    """Match the existing challan's financial-year depreciation calculation."""
    if asset.stock_kind == 'led_panel':
        return Decimal(asset.current_value)
    value = asset.item_price or Decimal('0')
    rate = asset.depreciation_percentage or Decimal('0')
    purchased = asset.purchased_date or (asset.created_at.date() if asset.created_at else None)
    if not purchased or rate <= 0:
        return value.quantize(Decimal('.01'), rounding=ROUND_HALF_UP)
    today = timezone.localdate(timezone=INDIA)
    first_year = purchased.year if purchased.month >= 4 else purchased.year - 1
    last_year = today.year if today.month >= 4 else today.year - 1
    for year in range(first_year, last_year + 1):
        effective = rate / 2 if year == first_year and purchased >= date(year, 10, 4) else rate
        value *= 1 - effective / 100
    return value.quantize(Decimal('.01'), rounding=ROUND_HALF_UP)


def append_dispatched_units(event, actor, asset_ids, *, reason='Newly dispatched equipment added to the unissued challan draft'):
    """Caller holds the event and affected assets in a movement transaction."""
    if event.is_audit or event.lifecycle_state != 'open' or challans_locked(event):
        return []
    if event.truck_challans.exists() or event.issued_deliveries.exists():
        return []
    document = ChallanDocument.objects.select_for_update().filter(conference=event, scope='master').first()
    if (not document or document.state != 'draft' or document.provenance == 'reviewed_legacy_archive'
            or document.history.filter(snapshot__state='issued').exists()):
        return []
    represented = set(document.lines.values_list('asset_id', flat=True))
    candidates = event.challan_assets.filter(pk__in=set(asset_ids) - represented).select_related('subrental_company').order_by('pk')
    position = max(document.lines.values_list('position', flat=True), default=-1) + 1
    rows = []
    for asset in candidates:
        if (not warehouse_managed(asset) or asset.type == 'Consumables'
                or asset.quantity_tracking or asset.quantity != 1):
            continue
        rows.append(ChallanLine(
            id=uuid5(document.pk, f'dispatched-unit-{asset.pk}'), document=document,
            asset=asset, supplier_id=asset.subrental_company_id,
            source_kind='supplier' if asset.subrental_company_id else 'owned',
            quantity=1, unit_value=draft_unit_value(asset), position=position,
            snapshot={
                'sku': asset.sku or '', 'alias_name': asset.alias_name or '',
                'serial_number': asset.serial_number or '', 'description': asset.description or '',
                'type': asset.type or '', 'mac_address': asset.mac_address or '',
                'imei_number_1': asset.imei_number_1 or '', 'imei_number_2': asset.imei_number_2 or '',
                'supplier_name': asset.subrental_company.name if asset.subrental_company_id else '',
            },
        ))
        position += 1
    if not rows:
        return []
    ChallanLine.objects.bulk_create(rows)
    document.header = {**document.header, 'dispatch_origins': event_origins(event)}
    document.revision += 1
    document.save(update_fields=['header', 'revision'])
    document._prefetched_objects_cache = {}
    ChallanRevision.objects.create(
        document=document, revision=document.revision, actor=actor, reason=reason, snapshot=document_data(document),
    )
    event.save(update_fields=['revision'])
    return [row.asset_id for row in rows]
