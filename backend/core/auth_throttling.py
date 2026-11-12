"""Shared credential-attempt budgets. No local cache or arbitrary forwarded-header trust."""
import hashlib
import hmac
import math
from collections.abc import Mapping
from datetime import timedelta
from django.conf import settings
from django.db import DatabaseError, IntegrityError, transaction
from django.utils import timezone
from rest_framework.exceptions import APIException
from rest_framework.throttling import BaseThrottle
from .models import CredentialAttempt
from .proxy_identity import credential_peer


class CredentialBudgetUnavailable(APIException):
    status_code = 503
    default_detail = 'Sign-in protection is unavailable. Please retry later.'
    default_code = 'credential_protection_unavailable'


def consume(scope, identity, limit, seconds, now=None):
    now = now or timezone.now()
    key = hmac.new(settings.SECRET_KEY.encode(), f'{scope}\0{identity}'.encode(), hashlib.sha256).hexdigest()
    with transaction.atomic():
        # A savepoint contains the unique-key race; the outer transaction remains
        # usable when another worker creates this same budget first.
        try:
            with transaction.atomic():
                CredentialAttempt.objects.create(key=key, expires_at=now+timedelta(seconds=seconds), attempts=0)
        except IntegrityError:
            pass
        bucket = CredentialAttempt.objects.select_for_update().get(pk=key)
        if bucket.expires_at <= now:
            bucket.expires_at = now + timedelta(seconds=seconds)
            bucket.attempts = 0
        if bucket.attempts >= limit:
            return max(1, math.ceil((bucket.expires_at-now).total_seconds()))
        bucket.attempts += 1
        bucket.save(update_fields=['expires_at','attempts'])
        return 0


class CredentialThrottle(BaseThrottle):
    def allow_request(self, request, view):
        address = credential_peer(request.META)
        self.delay = 0
        try:
            self.delay = consume('credential-peer', address, 60, 60)
            if self.delay: return False
            if isinstance(self, LoginAttemptThrottle):
                data = request.data
                email = data.get('email') if isinstance(data,Mapping) else None
                # Malformed input still spends the peer budget; do not grow the
                # DB with arbitrary oversized account identifiers.
                if not isinstance(email,str) or not email.strip() or len(email)>254: return True
                scope, identity = 'credential-login', email.strip().casefold()
            else:
                scope, identity = 'credential-password-approval', str(request.user.pk)
            self.delay = consume(scope, identity, 10, 300)
            return not self.delay
        except DatabaseError:
            raise CredentialBudgetUnavailable from None

    def wait(self): return self.delay


class LoginAttemptThrottle(CredentialThrottle):
    pass


class PasswordAttemptThrottle(CredentialThrottle):
    pass
