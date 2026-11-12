"""Disposable real-App fixture for partial reusable quantity venue transfers."""
import os,sys,tempfile
from pathlib import Path
from uuid import uuid4
from wsgiref.simple_server import make_server
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'backend'))
os.environ.pop('DJANGO_SETTINGS_MODULE',None)
from django.conf import settings
with tempfile.TemporaryDirectory(prefix='tt-quantity-transfers-') as media:
    settings.configure(SECRET_KEY='synthetic-transfers-only',DEBUG=False,USE_TZ=True,
        INSTALLED_APPS=['django.contrib.auth','django.contrib.contenttypes','rest_framework','rest_framework.authtoken','core'],
        DATABASES={'default':{'ENGINE':'django.db.backends.sqlite3','NAME':':memory:'}},
        ROOT_URLCONF=__name__,MIDDLEWARE=[],ALLOWED_HOSTS=['127.0.0.1'],MEDIA_ROOT=media,DEFAULT_AUTO_FIELD='django.db.models.BigAutoField',
        REST_FRAMEWORK={'DEFAULT_PERMISSION_CLASSES':['rest_framework.permissions.IsAuthenticated'],'DEFAULT_AUTHENTICATION_CLASSES':['rest_framework.authentication.TokenAuthentication']})
    import django
    django.setup()
    from django.core.management import call_command
    from django.contrib.auth.models import User
    from django.core.handlers.wsgi import WSGIHandler
    from django.http import JsonResponse
    from django.urls import path,include
    from rest_framework.authtoken.models import Token
    from core.models import Asset,CompanySettings,Conference,SubrentalCompany,QuantityAllocation,QuantityMovement,MovementReceipt,ProgramDelivery
    from core.quantity_commands import execute_quantity_command,outstanding
    from core.tests_program_deliveries import reviewed
    call_command('migrate',verbosity=0)
    user=User.objects.create_user('transfer-admin',email='transfer@example.test',is_staff=False);user.profile.role='admin';user.profile.save()
    Token.objects.create(user=user,key='synthetic-quantity-transfer-token')
    CompanySettings.objects.create(name='Synthetic Pvt Ltd',address='Synthetic godown road',gst_number='PVT-GST')
    owner=SubrentalCompany.objects.create(name='Synthetic AM',address='Synthetic supplier road',gst_number='AM-GST',inventory_mode='shared_warehouse')
    bulk=Asset.objects.create(sku='TRANSFER-CABLE',qr_code='TRANSFER-CABLE',alias_name='Transfer cable master',quantity=100,type='Cable',subrental_company=owner)
    source=Conference.objects.create(name='Quantity source A',association_name='Customer A',transport_address='Venue A\n'+'Full source road '*12)
    target=Conference.objects.create(name='Quantity target B',association_name='Customer B',transport_address='Venue B road')
    for action in ['stage','dispatch']:
        source.refresh_from_db();execute_quantity_command(user,source.pk,{'request_id':str(uuid4()),'action':action,'expected_revision':source.revision,'items':[{'asset_id':bulk.pk,'quantity':20}]})
    source.refresh_from_db();doc=reviewed(source,[bulk]);doc.lines.update(quantity=20)
    def inspect(request):
        source.refresh_from_db();target.refresh_from_db();bulk.refresh_from_db();doc.refresh_from_db()
        return JsonResponse({'source_id':source.pk,'target_id':target.pk,'stock':bulk.quantity,'available':bulk.quantity-outstanding(bulk),
            'bulk_id':bulk.pk,'owner_id':bulk.subrental_company_id,'records':Asset.objects.filter(sku=bulk.sku).count(),
            'source_address':source.transport_address,'source':QuantityAllocation.objects.get(conference=source,asset=bulk).dispatched,
            'target':QuantityAllocation.objects.filter(conference=target,asset=bulk).values().first(),
            'source_document_quantity':doc.lines.get().quantity,'transfers':QuantityMovement.objects.filter(action='transfer_in').count(),
            'packets':[p.snapshot for p in ProgramDelivery.objects.order_by('pk')]})
    urlpatterns=[path('api/',include('core.urls')),path('_fixture/inspect/',inspect)]
    print('SYNTHETIC_QUANTITY_TRANSFER_READY',flush=True)
    with make_server('127.0.0.1',4412,WSGIHandler()) as server:server.serve_forever()
