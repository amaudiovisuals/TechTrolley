"""Real App warehouse fixture: loopback, synthetic memory DB, no project settings."""
import os,sys,tempfile
from pathlib import Path
from wsgiref.simple_server import make_server
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'backend'))
os.environ.pop('DJANGO_SETTINGS_MODULE',None)
from django.conf import settings
with tempfile.TemporaryDirectory(prefix='tt-shared-quantity-') as media:
    settings.configure(SECRET_KEY='synthetic-shared-quantity-only',DEBUG=False,USE_TZ=True,
        INSTALLED_APPS=['django.contrib.auth','django.contrib.contenttypes','rest_framework','rest_framework.authtoken','core'],
        DATABASES={'default':{'ENGINE':'django.db.backends.sqlite3','NAME':':memory:'}},
        ROOT_URLCONF=__name__,MIDDLEWARE=[],ALLOWED_HOSTS=['127.0.0.1'],MEDIA_ROOT=media,
        DEFAULT_AUTO_FIELD='django.db.models.BigAutoField',
        REST_FRAMEWORK={'DEFAULT_PERMISSION_CLASSES':['rest_framework.permissions.IsAuthenticated'],
            'DEFAULT_AUTHENTICATION_CLASSES':['rest_framework.authentication.TokenAuthentication']})
    import django
    django.setup()
    from django.core.management import call_command
    from django.contrib.auth.models import User
    from django.core.handlers.wsgi import WSGIHandler
    from django.http import JsonResponse
    from django.urls import path,include
    from rest_framework.authtoken.models import Token
    from core.models import Asset,CompanySettings,Conference,SubrentalCompany,QuantityAllocation,ConsumableAllocation,ProgramDelivery,MovementReceipt
    call_command('migrate',verbosity=0)
    user=User.objects.create_user('quantity-admin',email='quantity@example.test',is_staff=False)
    user.profile.role='admin';user.profile.save();Token.objects.create(user=user,key='synthetic-warehouse-quantity-token')
    CompanySettings.objects.create(name='Pvt Ltd synthetic issuer')
    owner=SubrentalCompany.objects.create(name='AM synthetic shared owner',inventory_mode='shared_warehouse')
    bulk=Asset.objects.create(sku='AM-BULK',qr_code='AM-BULK',alias_name='Shared cable master',quantity=10,type='Cable',subrental_company=owner)
    consumer=Asset.objects.create(sku='AM-TAPE',qr_code='AM-TAPE',alias_name='Shared tape master',quantity=10,type='Consumables',subrental_company=owner)
    event=Conference.objects.create(name='Synthetic shared quantity event',association_name='Synthetic customer',challan_number='SYNTHETIC-QUANTITY')
    def inspect(request):
        bulk.refresh_from_db();consumer.refresh_from_db();event.refresh_from_db()
        allocation=QuantityAllocation.objects.filter(conference=event,asset=bulk).values().first()
        consumable=ConsumableAllocation.objects.filter(conference=event,asset=consumer).values().first()
        return JsonResponse({'stock':bulk.quantity,'bulk_id':bulk.pk,'bulk_records':Asset.objects.filter(sku='AM-BULK').count(),
            'consumable_stock':consumer.quantity,'owner_id':bulk.subrental_company_id,'allocation':allocation,'consumer':consumable,
            'packets':[p.snapshot for p in ProgramDelivery.objects.order_by('pk')], 'receipts':MovementReceipt.objects.count(), 'revision':event.revision})
    urlpatterns=[path('api/',include('core.urls')),path('_fixture/inspect/',inspect)]
    print('SYNTHETIC_WAREHOUSE_QUANTITY_READY',flush=True)
    with make_server('127.0.0.1',4372,WSGIHandler()) as server:server.serve_forever()
