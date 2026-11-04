"""
WSGI config for config project.

It exposes the WSGI callable as a module-level variable named ``application``.

For more information on this file, see
https://docs.djangoproject.com/en/6.0/howto/deployment/wsgi/
"""

import os

from django.core.wsgi import get_wsgi_application

from django.core.exceptions import ImproperlyConfigured
if 'DJANGO_ENV' not in os.environ:
    raise ImproperlyConfigured('Set DJANGO_ENV explicitly before starting WSGI/ASGI')
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')

application = get_wsgi_application()
