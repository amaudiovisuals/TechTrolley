"""Credential-budget peer identity. Trust only the explicit private Unix ingress.

Nginx must overwrite X-TT-Client-IP, ignore forwarded chains and deny all direct
application access. Filesystem socket access is part of the trust boundary.
"""
import ipaddress
from django.conf import settings


def credential_peer(meta):
    direct = meta.get('REMOTE_ADDR', '')
    raw = direct
    if getattr(settings, 'PROXY_CLIENT_IP_FROM_UNIX', False) and direct in ('', None):
        raw = meta.get('HTTP_X_TT_CLIENT_IP', '')
    if not isinstance(raw, str):
        return 'unknown-peer'
    try:
        return str(ipaddress.ip_address(raw))
    except (ValueError, TypeError):
        return 'unknown-peer'
