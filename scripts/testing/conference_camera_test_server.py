"""Disposable loopback App/DRF camera fixture; no project settings or business DB."""
import os
import sys
import tempfile
from pathlib import Path
from wsgiref.simple_server import make_server

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'backend'))
os.environ.pop('DJANGO_SETTINGS_MODULE', None)
from django.conf import settings

with tempfile.TemporaryDirectory(prefix='tt-conference-camera-') as media:
    settings.configure(
        SECRET_KEY='synthetic-camera-routing-only', DEBUG=False,
        INSTALLED_APPS=['django.contrib.auth', 'django.contrib.contenttypes',
                        'rest_framework', 'rest_framework.authtoken', 'core'],
        DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}},
        ROOT_URLCONF=__name__, MIDDLEWARE=[], ALLOWED_HOSTS=['127.0.0.1'],
        MEDIA_ROOT=media, USE_TZ=True, DEFAULT_AUTO_FIELD='django.db.models.BigAutoField',
        REST_FRAMEWORK={'DEFAULT_PERMISSION_CLASSES': ['rest_framework.permissions.IsAuthenticated'],
                        'DEFAULT_AUTHENTICATION_CLASSES': ['rest_framework.authentication.TokenAuthentication']})
    import django
    django.setup()
    from django.contrib.auth.models import User
    from django.core.handlers.wsgi import WSGIHandler
    from django.core.management import call_command
    from django.db import connection
    from django.http import JsonResponse
    from django.urls import include, path
    from rest_framework.authtoken.models import Token
    from core.models import Asset, CompanySettings, Conference, MovementReceipt

    assert connection.settings_dict['NAME'] == ':memory:'
    call_command('migrate', verbosity=0)
    actor = User.objects.create_user('camera-routing-admin', email='routing@example.test', is_staff=True)
    actor.profile.role = 'admin'
    actor.profile.save()
    Token.objects.create(user=actor, key='synthetic-camera-routing-token')
    CompanySettings.objects.create(name='Synthetic conference camera fixture')
    asset = Asset.objects.create(sku='ROUTING-CABLE-01', barcode='ROUTING-QR-01', alias_name='Routing cable', quantity=1)
    event = Conference.objects.create(name='Synthetic camera routing event', challan_number='CAMERA-ROUTING')

    def inspect(request):
        event.refresh_from_db()
        asset.refresh_from_db()
        return JsonResponse({'staged': list(event.staged_assets.values_list('pk', flat=True)),
                             'dispatched': list(event.assets.values_list('pk', flat=True)),
                             'crosscheck': list(event.crosscheck_assets.values_list('pk', flat=True)),
                             'actions': [result['action'] for result in MovementReceipt.objects.order_by('pk').values_list('result', flat=True)],
                             'revision': event.revision})

    urlpatterns = [path('api/', include('core.urls')), path('_fixture/inspect/', inspect)]
    print('SYNTHETIC_CONFERENCE_CAMERA_READY', flush=True)
    with make_server('127.0.0.1', 4362, WSGIHandler()) as server:
        server.serve_forever()
