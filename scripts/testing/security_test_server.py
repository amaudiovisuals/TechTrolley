"""Loopback, in-memory credentials/PDF/browser fixture. No project settings."""
import os,sys,tempfile
from pathlib import Path
from datetime import timedelta
from wsgiref.simple_server import make_server
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'backend'));os.environ.pop('DJANGO_SETTINGS_MODULE',None)
from django.conf import settings
with tempfile.TemporaryDirectory(prefix='tt-security-fixture-') as media:
    settings.configure(SECRET_KEY='synthetic-security-only',DEBUG=False,INSTALLED_APPS=['django.contrib.auth','django.contrib.contenttypes','django.contrib.sessions','rest_framework','rest_framework.authtoken','core'],DATABASES={'default':{'ENGINE':'django.db.backends.sqlite3','NAME':':memory:'}},ROOT_URLCONF=__name__,MIDDLEWARE=['django.contrib.sessions.middleware.SessionMiddleware','django.contrib.auth.middleware.AuthenticationMiddleware'],ALLOWED_HOSTS=['127.0.0.1'],MEDIA_ROOT=media,USE_TZ=True,DEFAULT_AUTO_FIELD='django.db.models.BigAutoField',PASSWORD_HASHERS=['django.contrib.auth.hashers.MD5PasswordHasher'],AUTH_PASSWORD_VALIDATORS=[{'NAME':'django.contrib.auth.password_validation.CommonPasswordValidator'},{'NAME':'django.contrib.auth.password_validation.NumericPasswordValidator'}],REST_FRAMEWORK={'DEFAULT_PERMISSION_CLASSES':['rest_framework.permissions.IsAuthenticated'],'DEFAULT_AUTHENTICATION_CLASSES':['core.authentication.ExpiringTokenAuthentication']})
    import django;django.setup()
    from django.core.management import call_command
    from django.core.handlers.wsgi import WSGIHandler
    from django.db import connection
    from django.urls import path,include
    from django.http import JsonResponse
    from django.contrib.auth.models import User
    from django.utils import timezone
    from rest_framework.authtoken.models import Token
    from core.models import Asset,Conference,CompanySettings,Employee,MovementReceipt
    assert connection.settings_dict['NAME']==':memory:';call_command('migrate',verbosity=0)
    actor=User.objects.create_user('security-admin',email='security-admin@example.test',password='Blue!Field-Maple-7832');actor.profile.role='admin';actor.profile.save();Token.objects.create(user=actor,key='synthetic-security-token')
    target=User.objects.create_user('security-tech',email='security-tech@example.test',password='Blue!Field-Maple-7832');Employee.objects.create(user=target,name='Security Technician',employee_id='SEC-TECH',email=target.email)
    CompanySettings.objects.create(name='Synthetic security fixture')
    root=Path(media);(root/'conference_pdfs').mkdir();(root/'conference_pdfs'/'private.pdf').write_bytes(b'%PDF-1.4\nSynthetic private file')
    event=Conference.objects.create(name='Private document event',start_date='2026-10-15',end_date='2026-10-16',pdf_document='conference_pdfs/private.pdf')
    asset=Asset.objects.create(sku='SEC-QR',alias_name='Security scanning fixture')
    def inspect(request):return JsonResponse({'actor_id':actor.pk,'event_id':event.pk,'asset_id':asset.pk,'tokens':Token.objects.filter(user=actor).count(),'target_tokens':Token.objects.filter(user=target).count(),'receipts':MovementReceipt.objects.count(),'staged':list(event.staged_assets.values_list('pk',flat=True))})
    def expire(request):Token.objects.filter(user=actor).update(created=timezone.now()-timedelta(hours=25));return JsonResponse({'expired':True})
    urlpatterns=[path('api/',include('core.urls')),path('_fixture/inspect/',inspect),path('_fixture/expire/',expire)]
    print('SYNTHETIC_SECURITY_READY',flush=True)
    with make_server('127.0.0.1',4350,WSGIHandler()) as server:server.serve_forever()
