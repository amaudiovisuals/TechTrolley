"""Loopback-only synthetic bulk server. Never imports business project settings."""
import os
import sys
import tempfile
from datetime import date
from pathlib import Path
from wsgiref.simple_server import make_server

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend'))
os.environ.pop('DJANGO_SETTINGS_MODULE', None)
from django.conf import settings

with tempfile.TemporaryDirectory(prefix='tt-quantity-browser-') as media:
    settings.configure(SECRET_KEY='synthetic-quantity-browser-only', DEBUG=False,
        INSTALLED_APPS=['django.contrib.auth', 'django.contrib.contenttypes', 'rest_framework', 'rest_framework.authtoken', 'core'],
        DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}},
        ROOT_URLCONF=__name__, MIDDLEWARE=[], ALLOWED_HOSTS=['127.0.0.1', 'localhost'],
        MEDIA_ROOT=media, USE_TZ=True, DEFAULT_AUTO_FIELD='django.db.models.BigAutoField',
        REST_FRAMEWORK={'DEFAULT_PERMISSION_CLASSES': ['rest_framework.permissions.IsAuthenticated'],
                        'DEFAULT_AUTHENTICATION_CLASSES': ['rest_framework.authentication.TokenAuthentication']})
    import django
    django.setup()
    from django.core.management import call_command
    from django.contrib.auth.models import User
    from django.http import JsonResponse
    from django.urls import include, path
    from django.db import connection
    from django.core.handlers.wsgi import WSGIHandler
    from rest_framework.authtoken.models import Token
    from core.models import Asset, Conference, QuantityMovement, MovementReceipt, CompanySettings
    from core.tests_program_deliveries import reviewed
    assert connection.settings_dict['NAME'] == ':memory:'
    call_command('migrate', verbosity=0)
    user = User.objects.create(username='synthetic-bulk-admin', email='synthetic-bulk@example.test')
    user.profile.role = 'godown_incharge'; user.profile.save()
    Token.objects.create(user=user, key='synthetic-bulk-token')
    CompanySettings.objects.create(name='Synthetic company')
    bulk = Asset.objects.create(sku='BULK-10', alias_name='Synthetic cable stock', type='Cable', quantity=10)
    physical = Asset.objects.create(sku='PHYSICAL-1', alias_name='Synthetic speaker', quantity=1)
    event = Conference.objects.create(name='Synthetic bulk event', challan_number='SYNTHETIC-BULK', start_date=date.today(), end_date=date.today())
    document = reviewed(event, [])

    def inspect(request):
        return JsonResponse({'asset_count': Asset.objects.count(), 'stock': Asset.objects.get(pk=bulk.pk).quantity,
            'unchecked_ids': list(event.crosscheck_assets.values_list('pk', flat=True)), 'draft_asset_ids': list(document.lines.values_list('asset_id', flat=True)), 'movements': QuantityMovement.objects.count(), 'receipts': MovementReceipt.objects.count(),
            'allocation': list(event.quantity_allocations.values('reserved', 'dispatched', 'awaiting_verification', 'dispatched_total', 'verified_total'))})

    def hold_crosscheck(request):
        other = Conference.objects.create(name='Previous venue program')
        other.crosscheck_assets.add(physical)
        return JsonResponse({'ok': True})

    urlpatterns = [path('api/', include('core.urls')), path('_fixture/inspect/', inspect), path('_fixture/hold-crosscheck/', hold_crosscheck)]
    print('SYNTHETIC_QUANTITY_SERVER_READY', flush=True)
    with make_server('127.0.0.1', 4316, WSGIHandler()) as server:
        server.serve_forever()
