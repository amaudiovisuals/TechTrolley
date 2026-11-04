"""Bound the existing shared per-user API token without changing operation IDs."""
from datetime import timedelta
from django.utils import timezone
from rest_framework.authentication import TokenAuthentication
from rest_framework.exceptions import AuthenticationFailed

TOKEN_LIFETIME = timedelta(hours=24)


def token_is_current(token):
    now = timezone.now()
    return now - TOKEN_LIFETIME < token.created <= now + timedelta(seconds=60)


class ExpiringTokenAuthentication(TokenAuthentication):
    def authenticate_credentials(self, key):
        user, token = super().authenticate_credentials(key)
        if not token_is_current(token):
            raise AuthenticationFailed('Login expired. Sign in again; saved work is retained.')
        return user, token
