"""Locked compare-and-write for legacy document replacements."""
from django.db.models import Q
from .models import Asset, Conference

RELATIONS = {'assets', 'crosscheck_assets', 'staged_assets', 'challan_assets', 'requirements', 'assigned_employees'}


def lock_conference_for_write(pk, payload):
    # Asset-first lock order matches movement commands. Revision mismatch is checked
    # after acquiring the conference lock, before any serializer/membership mutation.
    current_ids = Asset.objects.filter(Q(assigned_conferences__pk=pk) | Q(crosscheck_conferences__pk=pk)).values_list('pk', flat=True)
    ids = set(current_ids)
    from .event_lifecycle import referenced_asset_ids
    ids.update(referenced_asset_ids(pk))
    ids.update(Asset.objects.filter(quantity_allocations__conference_id=pk).values_list('pk', flat=True))
    ids.update(Asset.objects.filter(consumable_allocations__conference_id=pk).values_list('pk', flat=True))
    for field in RELATIONS - {'assigned_employees'}:
        raw = payload.get(field, [])
        if isinstance(raw, str):
            try:
                import json
                raw = json.loads(raw)
            except (ValueError, TypeError):
                raw = []
        if isinstance(raw, list):
            ids.update(int(value) for value in raw if str(value).isdigit())
    list(Asset.objects.select_for_update().filter(pk__in=ids).order_by('pk'))
    return Conference.objects.select_for_update().get(pk=pk)
