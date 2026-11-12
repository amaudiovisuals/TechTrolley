"""
ASGI config for config project.

It exposes the ASGI callable as a module-level variable named ``application``.

For more information on this file, see
https://docs.djangoproject.com/en/6.0/howto/deployment/asgi/
"""

import os

from django.core.asgi import get_asgi_application

from django.core.exceptions import ImproperlyConfigured
if 'DJANGO_ENV' not in os.environ:
    raise ImproperlyConfigured('Set DJANGO_ENV explicitly before starting WSGI/ASGI')
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')

application = get_asgi_application()
