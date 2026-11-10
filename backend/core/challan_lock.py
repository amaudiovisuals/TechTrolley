"""The paperwork deadline is independent of physical returns and completion."""
from datetime import date, timedelta
from zoneinfo import ZoneInfo

from django.utils import timezone

from .asset_commands import CommandError
from .permissions import is_business_administrator


INDIA = ZoneInfo('Asia/Kolkata')


def lock_on(event):
    # Staff have seven full local calendar days after the event's last day.
    grace = timedelta(days=8)
    return event.end_date + grace if event.end_date and event.end_date <= date.max - grace else None


def challans_locked(event):
    deadline = lock_on(event)
    return deadline is not None and timezone.localdate(timezone=INDIA) >= deadline


def require_challan_edit(event, user=None, *, correction=False, reason='', require_open=False):
    locked = challans_locked(event)
    can_correct = correction and is_business_administrator(user)
    if require_open and not (locked and can_correct):
        from .event_lifecycle import require_open_event
        require_open_event(event)
    if not locked:
        return False
    if not can_correct:
        raise CommandError('challan_edit_window_closed')
    if not reason.strip():
        raise CommandError('locked_challan_requires_admin_correction_reason')
    return True
