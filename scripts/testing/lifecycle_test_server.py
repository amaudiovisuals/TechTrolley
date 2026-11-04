"""Loopback-only in-memory lifecycle browser fixture; no project settings imported."""
import os,sys,tempfile,uuid
from pathlib import Path
from wsgiref.simple_server import make_server
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'backend'));os.environ.pop('DJANGO_SETTINGS_MODULE',None)
from django.conf import settings
with tempfile.TemporaryDirectory(prefix='tt-lifecycle-browser-') as media:
    settings.configure(SECRET_KEY='synthetic-lifecycle-only',DEBUG=False,INSTALLED_APPS=['django.contrib.auth','django.contrib.contenttypes','django.contrib.sessions','rest_framework','rest_framework.authtoken','core'],DATABASES={'default':{'ENGINE':'django.db.backends.sqlite3','NAME':':memory:'}},ROOT_URLCONF=__name__,MIDDLEWARE=[],ALLOWED_HOSTS=['127.0.0.1'],MEDIA_ROOT=media,USE_TZ=True,DEFAULT_AUTO_FIELD='django.db.models.BigAutoField',PASSWORD_HASHERS=['django.contrib.auth.hashers.MD5PasswordHasher'],REST_FRAMEWORK={'DEFAULT_PERMISSION_CLASSES':['rest_framework.permissions.IsAuthenticated'],'DEFAULT_AUTHENTICATION_CLASSES':['rest_framework.authentication.TokenAuthentication']})
    import django;django.setup()
    from django.core.management import call_command
    from django.core.handlers.wsgi import WSGIHandler
    from django.db import connection
    from django.urls import path,include
    from django.http import JsonResponse
    from django.contrib.auth.models import User
    from rest_framework.authtoken.models import Token
    from core.models import Asset,Conference,CompanySettings,PhysicalMovement,EventLifecycleHistory,ChallanDocument,ChallanLine,MovementReceipt
    from core.asset_commands import execute_command
    from core.event_lifecycle import build_review,execute_lifecycle_command
    assert connection.settings_dict['NAME']==':memory:';call_command('migrate',verbosity=0)
    actor=User.objects.create_user('lifecycle-browser',email='lifecycle-browser@example.test');actor.profile.role='admin';actor.profile.save()
    Token.objects.create(user=actor,key='synthetic-lifecycle-token');CompanySettings.objects.create(name='Synthetic lifecycle test')
    def event(name):return Conference.objects.create(name=name,start_date='2020-01-01',end_date='2020-01-02')
    ready=event('Ready returned event');device=Asset.objects.create(sku='RETURNED-DEVICE',alias_name='Returned projector')
    pending=event('Warehouse pending event');unchecked=Asset.objects.create(sku='UNCHECKED-DEVICE',alias_name='Unchecked monitor')
    legacy=event('Legacy unverified event');old=Asset.objects.create(sku='LEGACY-DEVICE',alias_name='Old documentary device');legacy.challan_assets.add(old)
    lost=event('Lost receipt event');stale=event('Stale review event');late=event('Late review event')
    def move(target,asset,action):return execute_command(actor,target.pk,{'request_id':str(uuid.uuid4()),'action':action,'asset_ids':[asset.pk],'source':'synthetic-browser'})
    for action in ('stage','dispatch','return','verify_return'):move(ready,device,action)
    for action in ('stage','dispatch','return'):move(pending,unchecked,action)
    doc=ChallanDocument.objects.create(conference=ready,scope='master',number='SYNTHETIC-PRESERVED',state='issued',document_date='2026-10-14')
    ChallanLine.objects.create(document=doc,source_kind='manual',snapshot={'alias_name':'Manual documentary row'},quantity=2,unit_value='10.50',position=0)
    def inspect(request):return JsonResponse({'events':list(Conference.objects.order_by('pk').values('id','name','revision','lifecycle_state','completed_at','completed_by_id','archived_at','archived_by_id')),'history':list(EventLifecycleHistory.objects.order_by('pk').values('conference_id','action','reason','before_state','after_state')),'stock':list(Asset.objects.order_by('pk').values('id','quantity','status')),'physical_movements':PhysicalMovement.objects.count(),'receipts':MovementReceipt.objects.count(),'documents':ChallanDocument.objects.count(),'lines':ChallanLine.objects.count()})
    def verify(request):move(pending,unchecked,'verify_return');return JsonResponse({'verified':True})
    def compete(request):stale.name='Stale review renamed';stale.save();return JsonResponse({'changed':True})
    def role(request):actor.profile.role=request.GET.get('role','admin');actor.profile.save();return JsonResponse({'role':actor.profile.role})
    def reopen(request):
        current=Conference.objects.get(pk=lost.pk);r=build_review(current)
        execute_lifecycle_command(actor,current.pk,{'request_id':str(uuid.uuid4()),'action':'reopen','expected_revision':r['revision'],'expected_snapshot_sha256':r['snapshot_sha256'],'reason':'Synthetic later authorized reopening','confirmed':True})
        return JsonResponse({'reopened':True})
    urlpatterns=[path('api/',include('core.urls')),path('_fixture/inspect/',inspect),path('_fixture/verify/',verify),path('_fixture/compete/',compete),path('_fixture/role/',role),path('_fixture/reopen/',reopen)]
    print('SYNTHETIC_LIFECYCLE_READY',flush=True)
    with make_server('127.0.0.1',4328,WSGIHandler()) as server:server.serve_forever()
