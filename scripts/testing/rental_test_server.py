"""Synthetic loopback supplier fixture; no project settings or business DB."""
import os,sys,tempfile
from pathlib import Path
from wsgiref.simple_server import make_server
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'backend'));os.environ.pop('DJANGO_SETTINGS_MODULE',None)
from django.conf import settings
with tempfile.TemporaryDirectory(prefix='tt-supplier-fixture-') as media:
    settings.configure(SECRET_KEY='synthetic-supplier-only',DEBUG=False,INSTALLED_APPS=['django.contrib.auth','django.contrib.contenttypes','django.contrib.sessions','rest_framework','rest_framework.authtoken','core'],DATABASES={'default':{'ENGINE':'django.db.backends.sqlite3','NAME':':memory:'}},ROOT_URLCONF=__name__,MIDDLEWARE=[],ALLOWED_HOSTS=['127.0.0.1'],MEDIA_ROOT=media,USE_TZ=True,DEFAULT_AUTO_FIELD='django.db.models.BigAutoField',PASSWORD_HASHERS=['django.contrib.auth.hashers.MD5PasswordHasher'],REST_FRAMEWORK={'DEFAULT_PERMISSION_CLASSES':['rest_framework.permissions.IsAuthenticated'],'DEFAULT_AUTHENTICATION_CLASSES':['rest_framework.authentication.TokenAuthentication']})
    import django;django.setup()
    from django.core.management import call_command
    from django.core.handlers.wsgi import WSGIHandler
    from django.db import connection
    from django.urls import path,include
    from django.http import JsonResponse
    from django.contrib.auth.models import User
    from rest_framework.authtoken.models import Token
    from core.models import Asset,Conference,CompanySettings,SubrentalCompany,SubrentalTicket,SubrentalTicketItem,SupplierChange,MovementReceipt,ChallanDocument,ChallanLine
    assert connection.settings_dict['NAME']==':memory:';call_command('migrate',verbosity=0)
    actor=User.objects.create_user('supplier-browser',email='supplier-browser@example.test');actor.profile.role='admin';actor.profile.save();Token.objects.create(user=actor,key='synthetic-supplier-token');CompanySettings.objects.create(name='Synthetic supplier fixture')
    other_actor=User.objects.create_user('other-supplier-browser',email='other-supplier@example.test');other_actor.profile.role='admin';other_actor.profile.save();Token.objects.create(user=other_actor,key='synthetic-other-supplier-token')
    company=SubrentalCompany.objects.create(name='AM Audiovisuals',inventory_mode='external_supplier');event=Conference.objects.create(name='Supplier save fixture',start_date='2026-10-14',end_date='2026-10-15');ticket=SubrentalTicket.objects.create(company=company,conference=event)
    shared=Asset.objects.create(sku='IDLE-SUPPLIER-QR',alias_name='Idle shared warehouse device',subrental_company=company)
    for number in range(51): Asset.objects.create(sku=f'COMPANY-STOCK-{number:02}',alias_name=f'Supplier warehouse stock {number:02}',subrental_company=company)
    owned=Asset.objects.create(sku='MAIN-QR',alias_name='Owned stock device')
    temp=Asset.objects.create(sku='EDIT-ROW',alias_name='Editable rental row',quantity=5,is_temporary=True,subrental_company=company)
    item=SubrentalTicketItem.objects.create(ticket=ticket,asset=temp,quantity=2,rental_price=10)
    doc=ChallanDocument.objects.create(conference=event,scope='master',number='PRESERVED-MANUAL',state='issued');ChallanLine.objects.create(document=doc,source_kind='manual',snapshot={'alias_name':'Preserved manual supplier note'},quantity=2,unit_value=20,position=0)
    import uuid
    from core.supplier_commands import execute_supplier_command
    from core.models import SupplierMovement,SupplierBalance
    from core.supplier_balances import balance_data
    from core.event_lifecycle import build_review
    catalogue=Asset.objects.create(sku='RENTAL-PACKAGE',alias_name='Recorded rental package',quantity=10,subrental_company=company)
    execute_supplier_command(actor,{'request_id':str(uuid.uuid4()),'action':'add_item','conference_id':event.pk,'expected_revision':event.revision,'reason':'Synthetic confirmed order','data':{'ticket_id':ticket.pk,'asset_id':catalogue.pk,'quantity':5,'rental_price':12.5}})
    def inspect(request):return JsonResponse({'supplier_movements':SupplierMovement.objects.count(),'balances':[{'item_id':i.pk,**balance_data(i)} for i in ticket.items.all()],'can_complete':build_review(Conference.objects.get(pk=event.pk))['can_complete'],'events':list(Conference.objects.order_by('pk').values('id','name','revision')),'items':list(SubrentalTicketItem.objects.order_by('pk').values('id','ticket_id','asset_id','quantity','rental_price')),'assets':list(Asset.objects.order_by('pk').values('id','sku','alias_name','quantity','subrental_company_id')),'changes':SupplierChange.objects.count(),'receipts':MovementReceipt.objects.count(),'documents':list(ChallanDocument.objects.values('number','revision','state')),'lines':list(ChallanLine.objects.values('snapshot','quantity','unit_value'))})
    def compete(request):event.refresh_from_db();event.name='Supplier save fixture';event.save();return JsonResponse({'changed':True})
    def later(request):item.refresh_from_db();item.rental_price=77;item.save();event.refresh_from_db();event.save();return JsonResponse({'changed':True})
    def role(request):actor.profile.role=request.GET.get('role','admin');actor.profile.save();return JsonResponse({'role':actor.profile.role})
    urlpatterns=[path('api/',include('core.urls')),path('_fixture/inspect/',inspect),path('_fixture/compete/',compete),path('_fixture/later/',later),path('_fixture/role/',role)]
    print('SYNTHETIC_RENTAL_READY',flush=True)
    with make_server('127.0.0.1',4340,WSGIHandler()) as server:server.serve_forever()
