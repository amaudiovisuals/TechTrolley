"""Disposable loopback fixture for actual browser custody-review acceptance."""
import os
import sys
import tempfile
from pathlib import Path
from wsgiref.simple_server import make_server
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend'))
os.environ.pop('DJANGO_SETTINGS_MODULE', None)
from django.conf import settings
with tempfile.TemporaryDirectory(prefix='tt-custody-browser-') as media:
    settings.configure(SECRET_KEY='synthetic-custody-only', DEBUG=False,
        INSTALLED_APPS=['django.contrib.auth','django.contrib.contenttypes','rest_framework','rest_framework.authtoken','core'],
        DATABASES={'default': {'ENGINE':'django.db.backends.sqlite3','NAME':':memory:'}},
        ROOT_URLCONF=__name__, MIDDLEWARE=[], ALLOWED_HOSTS=['127.0.0.1','localhost'],
        MEDIA_ROOT=media, USE_TZ=True, DEFAULT_AUTO_FIELD='django.db.models.BigAutoField',
        REST_FRAMEWORK={'DEFAULT_PERMISSION_CLASSES':['rest_framework.permissions.IsAuthenticated'],
                        'DEFAULT_AUTHENTICATION_CLASSES':['rest_framework.authentication.TokenAuthentication']})
    import django
    django.setup()
    from django.core.management import call_command
    from django.contrib.auth.models import User
    from django.http import JsonResponse
    from django.urls import include,path
    from django.db import connection
    from django.core.handlers.wsgi import WSGIHandler
    from rest_framework.authtoken.models import Token
    from core.models import Asset,Conference,CompanySettings,MovementReceipt,ChallanNumberReservation,ChallanDocument
    assert connection.settings_dict['NAME']==':memory:'
    call_command('migrate',verbosity=0)
    user=User.objects.create_user('custody-browser',email='custody@example.test')
    user.profile.role='admin';user.profile.save()
    Token.objects.create(user=user,key='synthetic-custody-token')
    CompanySettings.objects.create(name='Synthetic custody tests')
    real=Conference.objects.create(name='Current physical event',start_date='2026-10-13',end_date='2026-10-15')
    audit=Conference.objects.create(name='Audit review fixture',is_audit=True,start_date='2026-10-13',end_date='2026-10-15')
    stale=Asset.objects.create(sku='AUDIT-STALE',alias_name='Historical device')
    held=Asset.objects.create(sku='AUDIT-HELD',alias_name='Currently held device')
    health=Asset.objects.create(sku='AUDIT-MISSING',alias_name='Restricted device',flag='Missing')
    real.assets.add(held)
    audit.challan_assets.add(stale,held,health)
    Asset.objects.filter(pk=stale.pk).update(status='Crosscheck')
    def inspect(request):
        return JsonResponse({'asset_states':list(Asset.objects.order_by('pk').values('id','status','flag','assigned_to_id')),
                             'event_revisions':list(Conference.objects.order_by('pk').values('id','revision')),
                             'receipts':MovementReceipt.objects.count(),'documents':ChallanDocument.objects.count(),
                             'numbers':ChallanNumberReservation.objects.count()})
    urlpatterns=[path('api/',include('core.urls')),path('_fixture/inspect/',inspect)]
    print('SYNTHETIC_CUSTODY_SERVER_READY',flush=True)
    with make_server('127.0.0.1',4324,WSGIHandler()) as server:server.serve_forever()
