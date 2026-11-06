"""Synthetic migrated box/panel HTTP fixture; never uses project settings or business DB."""
import os, sys, tempfile
from pathlib import Path
from uuid import uuid4
from wsgiref.simple_server import make_server
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'backend'))
os.environ.pop('DJANGO_SETTINGS_MODULE',None)
from django.conf import settings
with tempfile.TemporaryDirectory(prefix='tt-led-case-') as media:
    settings.configure(SECRET_KEY='synthetic-led-case-only', DEBUG=False, USE_TZ=True,
        INSTALLED_APPS=['django.contrib.auth','django.contrib.contenttypes','rest_framework','rest_framework.authtoken','core'],
        DATABASES={'default':{'ENGINE':'django.db.backends.sqlite3','NAME':':memory:'}},
        ROOT_URLCONF=__name__, MIDDLEWARE=[], ALLOWED_HOSTS=['127.0.0.1'], MEDIA_ROOT=media,
        DEFAULT_AUTO_FIELD='django.db.models.BigAutoField', LED_CASE_CONVERSION_WRITES_ENABLED=True, LED_CASE_CONVERSION_INSTANCE_ID='isolated-browser-fixture',
        REST_FRAMEWORK={'DEFAULT_PERMISSION_CLASSES':['rest_framework.permissions.IsAuthenticated'], 'DEFAULT_AUTHENTICATION_CLASSES':['rest_framework.authentication.TokenAuthentication']})
    import django;django.setup()
    from django.core.management import call_command
    from django.contrib.auth.models import User
    from django.core.handlers.wsgi import WSGIHandler
    from django.http import JsonResponse
    from django.urls import path,include
    from rest_framework.authtoken.models import Token
    from core.models import Asset,CompanySettings,Conference,SubrentalCompany,LedCasePanel,LedCaseConversion,ProgramDelivery,MovementReceipt
    from core.led_cases import prepare,convert
    from core.inventory_ownership import inventory_summary
    call_command('migrate',verbosity=0)
    user=User.objects.create_user('led-admin',email='led@example.test',is_staff=True);user.profile.role='admin';user.profile.save()
    Token.objects.create(user=user,key='synthetic-led-case-token')
    CompanySettings.objects.create(name='Synthetic Pvt Ltd',address='Synthetic Pvt godown')
    owner=SubrentalCompany.objects.create(name='Synthetic AM',address='Synthetic AM godown',inventory_mode='shared_warehouse')
    box=Asset.objects.create(sku='P2-BOX-CODE',qr_code='OLD-P2-QR',alias_name='LED WALL BOX P2')
    review,_=prepare(box)
    convert(user,box.pk,{'request_id':str(uuid4()),'review_hash':review['review_hash'],'reason':'Six synthetic normal P2 panels physically confirmed','confirmed_panel_count':6})
    panels=list(LedCasePanel.objects.filter(case__source_asset=box).order_by('slot'))
    Asset.objects.filter(pk__in=[p.asset_id for p in panels[2:]]).update(subrental_company=owner)
    event=Conference.objects.create(name='Synthetic LED event',association_name='Synthetic customer',billing_address='Customer address',transport_address='Original venue address')
    target=Conference.objects.create(name='LED destination program',association_name='Next customer',billing_address='Next customer address',transport_address='Next venue address')
    def inspect(request):
        event.refresh_from_db();target.refresh_from_db()
        return JsonResponse({'source_id':box.pk,'panel_ids':[p.asset_id for p in panels], 'event_id':event.pk,'target_id':target.pk,
            'staged':list(event.staged_assets.values_list('pk',flat=True)), 'active':list(event.assets.values_list('pk',flat=True)),
            'unchecked':list(event.crosscheck_assets.values_list('pk',flat=True)), 'target_active':list(target.assets.values_list('pk',flat=True)),
            'stock':inventory_summary(),'conversions':LedCaseConversion.objects.count(),'panels':LedCasePanel.objects.count(),
            'receipts':MovementReceipt.objects.count(),'packets':[p.snapshot for p in ProgramDelivery.objects.order_by('pk')]})
    urlpatterns=[path('api/',include('core.urls')),path('_fixture/inspect/',inspect)]
    print('SYNTHETIC_LED_CASE_READY',flush=True)
    with make_server('127.0.0.1',4402,WSGIHandler()) as server:server.serve_forever()
