"""Disposable loopback repair fixture. No project settings, business DB or secrets."""
import os,sys,tempfile,uuid
from pathlib import Path
from wsgiref.simple_server import make_server
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'backend'));os.environ.pop('DJANGO_SETTINGS_MODULE',None)
from django.conf import settings
with tempfile.TemporaryDirectory(prefix='tt-reconciliation-browser-') as media:
    settings.configure(SECRET_KEY='synthetic-reconciliation-only',DEBUG=False,INSTALLED_APPS=['django.contrib.auth','django.contrib.contenttypes','django.contrib.sessions','rest_framework','rest_framework.authtoken','core'],DATABASES={'default':{'ENGINE':'django.db.backends.sqlite3','NAME':':memory:'}},ROOT_URLCONF=__name__,MIDDLEWARE=[],ALLOWED_HOSTS=['127.0.0.1'],MEDIA_ROOT=media,USE_TZ=True,DEFAULT_AUTO_FIELD='django.db.models.BigAutoField',PASSWORD_HASHERS=['django.contrib.auth.hashers.MD5PasswordHasher'],REVIEWED_RECONCILIATION_WRITES_ENABLED=True,RECONCILIATION_INSTANCE_ID='synthetic-browser-step5d',REST_FRAMEWORK={'DEFAULT_PERMISSION_CLASSES':['rest_framework.permissions.IsAuthenticated'],'DEFAULT_AUTHENTICATION_CLASSES':['rest_framework.authentication.TokenAuthentication']})
    import django;django.setup()
    from django.core.management import call_command
    from django.core.handlers.wsgi import WSGIHandler
    from django.db import connection
    from django.urls import path,include
    from django.http import JsonResponse
    from django.contrib.auth.models import User
    from rest_framework.authtoken.models import Token
    from core.models import Asset,Conference,CompanySettings,ReconciliationHistory,PreservedAuditObservation,PhysicalMovement,ChallanDocument,ChallanLine,MovementReceipt
    assert connection.settings_dict['NAME']==':memory:';call_command('migrate',verbosity=0)
    actor=User.objects.create_user('review-browser',email='review-browser@example.test');actor.profile.role='admin';actor.profile.save();Token.objects.create(user=actor,key='synthetic-review-token');CompanySettings.objects.create(name='Synthetic reconciliation test')
    def event(name,**extra):return Conference.objects.create(name=name,start_date='2020-01-01',end_date='2020-01-02',**extra)
    audit=event('Audit reconciliation fixture',is_audit=True);real=event('Actual holder fixture');legacy=event('Legacy return fixture');stale=event('Stale repair fixture');lost=event('Lost repair fixture');disabled=event('Disabled repair fixture')
    held=Asset.objects.create(sku='REAL-HELD',alias_name='Actually deployed device',serial_number='SERIAL-REAL');ghost=Asset.objects.create(sku='WAREHOUSE-GHOST',alias_name='Warehouse ghost device',serial_number='SERIAL-GHOST');unselected=Asset.objects.create(sku='UNSELECTED-GHOST',alias_name='Unselected ghost device');old=Asset.objects.create(sku='LEGACY-RETURN',alias_name='Legacy returned projector');changed=Asset.objects.create(sku='STALE-GHOST',alias_name='Stale ghost device');unknown=Asset.objects.create(sku='LOST-GHOST',alias_name='Lost ghost device');off=Asset.objects.create(sku='DISABLED-GHOST',alias_name='Disabled ghost device')
    real.assets.add(held);audit.assets.add(held);audit.crosscheck_assets.add(held);audit.staged_assets.add(held,ghost,unselected);audit.challan_assets.add(held,ghost,unselected);legacy.challan_assets.add(old);stale.challan_assets.add(changed);lost.challan_assets.add(unknown);disabled.challan_assets.add(off)
    Asset.objects.filter(pk__in=[held.pk,ghost.pk,unselected.pk,old.pk,changed.pk,unknown.pk,off.pk]).update(status='Crosscheck')
    doc=ChallanDocument.objects.create(conference=audit,scope='master',number='AUDIT-PAPER-PRESERVED',state='issued',document_date='2026-10-14');ChallanLine.objects.create(document=doc,source_kind='manual',snapshot={'alias_name':'Preserved manual row'},quantity=2,unit_value='12.50',position=0)
    def inspect(request):return JsonResponse({'events':list(Conference.objects.order_by('pk').values('id','name','revision','is_audit','lifecycle_state')),'assets':list(Asset.objects.order_by('pk').values('id','status','quantity','flag','custody_revision','description')),'real_holders':list(real.assets.values_list('pk',flat=True)),'history':list(ReconciliationHistory.objects.order_by('created_at').values('id','action','reason','reverses_id')),'observations':PreservedAuditObservation.objects.count(),'physical':list(PhysicalMovement.objects.order_by('pk').values('asset_id','conference_id','action','snapshot')),'documents':ChallanDocument.objects.count(),'lines':ChallanLine.objects.count(),'receipts':MovementReceipt.objects.count()})
    def metadata(request):changed.refresh_from_db();changed.description='Changed after browser review';changed.save();return JsonResponse({'changed':True})
    def later(request):unknown.refresh_from_db();unknown.description='Later actual current metadata';unknown.save();return JsonResponse({'changed':True})
    def role(request):actor.profile.role=request.GET.get('role','admin');actor.profile.save();return JsonResponse({'role':actor.profile.role})
    def gate(request):settings.REVIEWED_RECONCILIATION_WRITES_ENABLED=request.GET.get('enabled')=='true';return JsonResponse({'enabled':settings.REVIEWED_RECONCILIATION_WRITES_ENABLED})
    urlpatterns=[path('api/',include('core.urls')),path('_fixture/inspect/',inspect),path('_fixture/metadata/',metadata),path('_fixture/later/',later),path('_fixture/role/',role),path('_fixture/gate/',gate)]
    print('SYNTHETIC_RECONCILIATION_READY',flush=True)
    with make_server('127.0.0.1',4332,WSGIHandler()) as server:server.serve_forever()
