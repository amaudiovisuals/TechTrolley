"""Pure status policy: no database, mutation, or inferred historical completion."""
RESTRICTED_STATUSES = {'Missing', 'Damaged', 'On Service', 'Expired'}
FLAG_STATUS = {'Missing': 'Missing', 'Expired': 'Expired', 'On Service': 'On Service', 'Required Service': 'On Service'}


def derive_status(asset, custody, preserve_unproved_custody=False):
    # A movement/removal is never a maintenance resolution.
    if asset.get('flag') in FLAG_STATUS:
        return FLAG_STATUS[asset['flag']]
    if asset.get('condition') == 'Damaged':
        return 'Damaged'
    if asset.get('status') in RESTRICTED_STATUSES:
        return asset['status']
    if custody.get('staff_issue_employee_ids'):
        return 'In Use'
    if custody['quantity_stock']:
        if custody['legacy_quantity_unknown']:
            if custody['active_event_ids']:
                return 'In Use'
            if custody['unchecked_event_ids']:
                return 'Crosscheck'
            # Do not invent a historical stock balance or release an old lock.
            return asset['status']
        held = custody['held_quantity']
        if preserve_unproved_custody and not held and not custody['active_event_ids'] and not custody['unchecked_event_ids'] and asset.get('status') in {'In Use', 'Crosscheck'}:
            return asset['status']
        if held > 0 and held >= asset['quantity']:
            return 'Crosscheck' if custody['unchecked_quantity'] else 'In Use'
        if asset.get('assigned_to_id'):
            return 'In Use'
        return 'Available'
    if custody['active_event_ids']:
        return 'In Use'
    if custody['unchecked_event_ids']:
        return 'Crosscheck'
    if asset.get('assigned_to_id'):
        return 'In Use'
    if preserve_unproved_custody and asset.get('status') in {'In Use', 'Crosscheck'}:
        return asset['status']
    return 'Available'
