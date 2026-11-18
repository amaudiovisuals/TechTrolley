"""Reviewed corrections of working drafts; issued paper and warehouse custody stay fixed."""
import hashlib
import json
from decimal import Decimal, ROUND_HALF_UP

from django.db import transaction

from .asset_commands import CommandError
from .challan_documents import document_data
from .challan_lock import challans_locked
from .inventory_ownership import warehouse_managed
from .models import Asset, Conference, ChallanDocument, ChallanLine, ChallanRevision, MovementReceipt
from .permissions import is_business_administrator


def individual_source(asset):
    return (asset.quantity == 1 and not asset.quantity_tracking and asset.type != 'Consumables'
            and warehouse_managed(asset))


@transaction.atomic
def correct_unit_draft(actor, event_id, document_id, *, expected_event_revision,
                       expected_document_revision, expected_quantities, request_id, reason):
    if not is_business_administrator(actor):
        raise CommandError('not_authorized', 403)
    if not reason.strip() or not expected_quantities:
        raise CommandError('unit_draft_review_required', 400)
    fingerprint = hashlib.sha256(json.dumps({
        'operation': 'correct_unit_draft', 'event_id': event_id, 'document_id': str(document_id),
        'event_revision': expected_event_revision, 'document_revision': expected_document_revision,
        'quantities': expected_quantities, 'reason': reason,
    }, sort_keys=True).encode()).hexdigest()
    receipt = MovementReceipt.objects.filter(actor=actor, request_id=request_id).first()
    if receipt:
        if receipt.payload_hash != fingerprint:
            raise CommandError('request_id_reused')
        return {**receipt.result, 'replayed': True}
    from .event_lifecycle import referenced_asset_ids
    ids = set(referenced_asset_ids(event_id)) | set(ChallanLine.objects.filter(document_id=document_id).values_list('asset_id', flat=True))
    list(Asset.objects.select_for_update().filter(pk__in=ids).order_by('pk'))
    event = Conference.objects.select_for_update().get(pk=event_id)
    document = ChallanDocument.objects.select_for_update().get(pk=document_id, conference=event)
    receipt = MovementReceipt.objects.filter(actor=actor, request_id=request_id).first()
    if receipt:
        if receipt.payload_hash != fingerprint:
            raise CommandError('request_id_reused')
        return {**receipt.result, 'replayed': True}
    if event.revision != expected_event_revision:
        raise CommandError('event_changed')
    if document.revision != expected_document_revision:
        raise CommandError('document_changed')
    if (event.is_audit or event.lifecycle_state != 'open' or challans_locked(event)
            or document.state != 'draft' or document.scope != 'master'
            or document.provenance == 'reviewed_legacy_archive'
            or document.history.filter(snapshot__state='issued').exists()
            or event.truck_challans.exists() or event.issued_deliveries.exists()):
        raise CommandError('unit_draft_requires_unissued_master')
    before = document_data(document)
    prior = document.history.filter(revision=document.revision).first()
    if not prior or prior.snapshot != before:
        raise CommandError('unit_draft_history_requires_review')
    lines = list(document.lines.select_related('asset__subrental_company'))
    affected = {str(line.pk): line for line in lines if line.asset_id and not line.ticket_item_id
                and line.quantity > 1 and individual_source(line.asset)}
    if {key: line.quantity for key, line in affected.items()} != expected_quantities:
        raise CommandError('unit_draft_review_changed')
    for line in affected.values():
        line.quantity = line.asset.quantity
    ChallanLine.objects.bulk_update(affected.values(), ['quantity'])
    document.total_override = None  # Recalculate from the corrected lines; preserve each rate and the discount.
    document.revision += 1
    document.save(update_fields=['total_override', 'revision'])
    document._prefetched_objects_cache = {}
    after = document_data(document)
    ChallanRevision.objects.create(document=document, revision=document.revision, actor=actor,
                                   reason=reason, snapshot=after)
    event.save(update_fields=['revision'])
    total = sum(Decimal(line['unit_value']) * line['quantity'] for line in after['lines'])
    result = {'document_id': str(document.pk), 'conference_id': event.pk, 'revision': document.revision,
              'corrected_lines': len(affected), 'units': sum(line['quantity'] for line in after['lines']),
              'row_total': str(total), 'grand_total': str((total * (Decimal('.4') if document.header.get('discount_60') else 1)).quantize(Decimal('.01'), rounding=ROUND_HALF_UP)),
              'replayed': False}
    MovementReceipt.objects.create(actor=actor, request_id=request_id, payload_hash=fingerprint, result=result)
    return result
