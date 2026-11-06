"""Shared custody/status derivation; observations/plans/document history are separate."""
from .custody_policy import derive_status, RESTRICTED_STATUSES


def current_conference_name(asset):
    if hasattr(asset, 'annotated_conference'):
        return asset.annotated_conference
    conference = (
        asset.assigned_conferences.filter(is_audit=False).order_by('pk').first()
        or asset.crosscheck_conferences.filter(is_audit=False).order_by('pk').first()
    )
    return conference.name if conference else None


def asset_fields(asset):
    return {field: getattr(asset, field) for field in ('id', 'status', 'flag', 'condition', 'assigned_to_id', 'quantity', 'quantity_tracking', 'type', 'staff_revision')}


def custody_state(asset):
    from .models import Conference
    from django.db.models import Q
    if not asset.pk:
        return {'active_event_ids': [], 'unchecked_event_ids': [], 'audit_event_ids': [],
                'staged_event_ids': [], 'quantity_stock': asset.quantity_tracking or asset.quantity != 1 or asset.type == 'Consumables',
                'legacy_quantity_unknown': False, 'held_quantity': 0, 'unchecked_quantity': 0}
    active = list(Conference.objects.filter(is_audit=False, assets=asset).order_by('pk').values_list('pk', flat=True))
    unchecked = list(Conference.objects.filter(is_audit=False, crosscheck_assets=asset).order_by('pk').values_list('pk', flat=True))
    staged = list(Conference.objects.filter(is_audit=False, staged_assets=asset).order_by('pk').values_list('pk', flat=True))
    audits = list(Conference.objects.filter(is_audit=True).filter(Q(assets=asset) | Q(crosscheck_assets=asset) | Q(staged_assets=asset)).order_by('pk').distinct().values_list('pk', flat=True))
    bulk = asset.quantity_tracking or asset.quantity != 1 or asset.type == 'Consumables'
    held, unchecked_quantity, unknown = 0, 0, False
    if bulk and asset.type == 'Consumables':
        from .consumable_commands import legacy_usage
        allocations = list(asset.consumable_allocations.all())
        held = sum(row.requested for row in allocations if row.state != 'settled')
        unknown = legacy_usage(asset)
    elif bulk:
        allocations = list(asset.quantity_allocations.all())
        tracked = {row.conference_id for row in allocations}
        unknown = bool((set(active) | set(unchecked) | set(staged)) - tracked)
        held = sum(row.reserved + row.dispatched + row.awaiting_verification for row in allocations)
        unchecked_quantity = sum(row.awaiting_verification for row in allocations)
    staff_ids = list(asset.staff_allocations.filter(returned_at__isnull=True).order_by('employee_id').values_list('employee_id',flat=True))
    return {'active_event_ids': active, 'unchecked_event_ids': unchecked, 'audit_event_ids': audits, 'staff_issue_employee_ids':staff_ids,
            'staged_event_ids': staged, 'quantity_stock': bulk, 'legacy_quantity_unknown': unknown,
            'held_quantity': held, 'unchecked_quantity': unchecked_quantity}


def derived_status(asset, preserve_unproved_custody=False):
    return derive_status(asset_fields(asset), custody_state(asset), preserve_unproved_custody)


def available_quantity(asset):
    if asset.stock_kind == 'led_case':
        return 0
    if asset.flag or asset.condition == 'Damaged' or asset.status in RESTRICTED_STATUSES or asset.assigned_to_id:
        return 0
    staff_open = asset.annotated_staff_open if hasattr(asset,'annotated_staff_open') else asset.staff_allocations.filter(returned_at__isnull=True).exists()
    if staff_open:
        return 0
    bulk = asset.quantity_tracking or asset.quantity != 1 or asset.type == 'Consumables'
    if not bulk:
        if asset.status in {'In Use', 'Crosscheck'}:
            return 0
        # Inventory already annotates real custody. Reuse it on the hot list path.
        if hasattr(asset, 'annotated_conference'):
            return 0 if asset.annotated_conference is not None else asset.quantity
        from .models import Conference
        from django.db.models import Q
        held = Conference.objects.filter(is_audit=False).filter(Q(assets=asset) | Q(crosscheck_assets=asset)).exists()
        return 0 if held else asset.quantity
    state = custody_state(asset)
    if state['legacy_quantity_unknown']:
        return 0
    if not state['held_quantity'] and not state['active_event_ids'] and not state['unchecked_event_ids'] and asset.status in {'In Use', 'Crosscheck'}:
        return 0  # Unproved old lock; a metadata edit is not a quantity return.
    return max(0, asset.quantity - state['held_quantity'])


def synchronize_statuses(asset_ids):
    """Used inside authorized mutations. Does not resolve flags or remove history.

    Callers own asset-first locking/transaction boundaries. Not a backfill operation.
    """
    from .models import Asset
    changes = []
    for asset in Asset.objects.filter(pk__in=asset_ids).order_by('pk'):
        expected = derived_status(asset)
        if expected != asset.status:
            from django.db.models import F
            Asset.objects.filter(pk=asset.pk).update(status=expected, custody_revision=F('custody_revision') + 1)
            changes.append({'asset_id': asset.pk, 'before': asset.status, 'after': expected})
    return changes


def review_assets(asset_ids):
    """Read-only proposals, with no claim that physical returns were completed."""
    from .models import Asset
    import hashlib
    import json
    rows = []
    for asset in Asset.objects.filter(pk__in=asset_ids).order_by('pk'):
        fields, state = asset_fields(asset), custody_state(asset)
        expected = derive_status(fields, state)
        blockers = []
        if state.get('staff_issue_employee_ids') and state['staff_issue_employee_ids'] != [asset.assigned_to_id]:
            blockers.append('staff_history_disagrees_with_custodian')
        if state['legacy_quantity_unknown']:
            blockers.append('unknown_legacy_quantity')
        if not state['quantity_stock'] and len(set(state['active_event_ids']) | set(state['unchecked_event_ids'])) > 1:
            blockers.append('multiple_event_holders')
        if asset.assigned_to_id and (state['active_event_ids'] or state['unchecked_event_ids']):
            blockers.append('staff_and_event_custody_overlap')
        if set(state['active_event_ids']) & set(state['unchecked_event_ids']):
            blockers.append('active_and_unchecked_overlap')
        if state['quantity_stock'] and state['held_quantity'] > asset.quantity:
            blockers.append('held_quantity_exceeds_stock')
        if asset.status != expected:
            blockers.append('physical_custody_confirmation_required')
        snapshot = {'asset': fields, 'custody': state}
        rows.append({'asset_id': asset.pk, 'label': asset.alias_name or asset.sku or f'Item {asset.pk}',
                     'stored_status': asset.status, 'expected_status': expected,
                     'status_matches': asset.status == expected, 'blockers': blockers,
                     'evidence': snapshot, 'evidence_sha256': hashlib.sha256(json.dumps(snapshot, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
                     'automatic_apply_allowed': False})
    return rows
