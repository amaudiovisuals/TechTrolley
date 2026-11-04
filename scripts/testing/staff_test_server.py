"""Disposable staff browser fixture; imports no project settings/business database."""
import os,sys,tempfile,uuid
from pathlib import Path
from wsgiref.simple_server import make_server
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'backend'));os.environ.pop('DJANGO_SETTINGS_MODULE',None)
from django.conf import settings
with tempfile.TemporaryDirectory(prefix='tt-staff-browser-') as media:
    settings.configure(SECRET_KEY='staff-browser-only',DEBUG=False,INSTALLED_APPS=['django.contrib.auth','django.contrib.contenttypes','rest_framework','rest_framework.authtoken','core'],DATABASES={'default':{'ENGINE':'django.db.backends.sqlite3','NAME':':memory:'}},ROOT_URLCONF=__name__,MIDDLEWARE=[],ALLOWED_HOSTS=['127.0.0.1','localhost'],MEDIA_ROOT=media,USE_TZ=True,DEFAULT_AUTO_FIELD='django.db.models.BigAutoField',REST_FRAMEWORK={'DEFAULT_PERMISSION_CLASSES':['rest_framework.permissions.IsAuthenticated'],'DEFAULT_AUTHENTICATION_CLASSES':['rest_framework.authentication.TokenAuthentication']})
    import django;django.setup()
    from django.core.management import call_command
    from django.contrib.auth.models import User
    from django.http import JsonResponse
    from django.urls import path,include
    from django.db import connection
    from django.core.handlers.wsgi import WSGIHandler
    from rest_framework.authtoken.models import Token
    from core.models import Asset,Employee,Conference,SubrentalCompany,StaffAllocation,MovementReceipt,EmployeeIdentityHistory,CompanySettings
    from core.staff_commands import execute_staff_command
    assert connection.settings_dict['NAME']==':memory:';call_command('migrate',verbosity=0)
    actor=User.objects.create_user('staff-browser',email='staff-browser@example.test');actor.profile.role='admin';actor.profile.save()
    Token.objects.create(user=actor,key='synthetic-staff-token')
    login=User.objects.create_user('system-only',email='system-only@example.test')
    CompanySettings.objects.create(name='Synthetic staff test')
    employees=[Employee.objects.create(name=f'Staff {i}',employee_id=f'STAFF-{i}',email=f'staff-{i}@example.test',department='Ops',phone='-') for i in range(1,6)]
    supplier=SubrentalCompany.objects.create(name='Synthetic supplier')
    def operation(asset,employee,action='issue'):
        asset.refresh_from_db();return execute_staff_command(actor,{'request_id':str(uuid.uuid4()),'action':action,'employee_id':employee.pk,'items':[{'asset_id':asset.pk,'expected_revision':asset.staff_revision,'expected_employee_id':asset.assigned_to_id}],'reason':'Synthetic verified handover'})
    labels=['Issued laptop','Issued phone','Supplier tablet','Issued projector','Issued camera','Issued monitor','Legacy camera']
    for i,label in enumerate(labels):
        asset=Asset.objects.create(sku=f'ISSUED-{i}',alias_name=label,type='Laptops' if i==0 else 'Smartphones' if i in (1,2) else 'Other',subrental_company=supplier if i==2 else None)
        employee=employees[i%5]
        if i==6:asset.assigned_to=employee;asset.save()
        else:operation(asset,employee)
    phone=Asset.objects.create(sku='AVAILABLE-PHONE',alias_name='Available phone',type='Smartphones',subrental_company=supplier)
    lost=Asset.objects.create(sku='AVAILABLE-LAPTOP',alias_name='Available laptop',type='Laptops')
    conflict=Asset.objects.create(sku='CONFLICT-DEVICE',alias_name='Conflict device',type='Other')
    packed=Asset.objects.create(sku='PACKED',alias_name='Packed device');event=Conference.objects.create(name='Packing fixture');event.staged_assets.add(packed)
    for i in range(55):Asset.objects.create(sku=f'OTHER-{i}',alias_name=f'Other inventory {i}')
    def inspect(request):
        return JsonResponse({'assets':list(Asset.objects.order_by('pk').values('id','alias_name','assigned_to_id','staff_revision','status','quantity')),
            'employees':list(Employee.objects.order_by('pk').values('id','name','employee_id','user_id')),
            'allocations':list(StaffAllocation.objects.order_by('asset_id','issued_at').values('asset_id','employee_id','issued_at','returned_at','provenance')),
            'receipts':MovementReceipt.objects.count(),'identity_history':EmployeeIdentityHistory.objects.count(),
            'login':{'id':login.pk,'role':User.objects.get(pk=login.pk).profile.role,'superuser':User.objects.get(pk=login.pk).is_superuser}})
    def compete(request):
        operation(conflict,employees[1]);return JsonResponse({'status':'competing staff issue saved'})
    def role(request):
        actor.profile.role=request.GET.get('role','admin');actor.profile.save();return JsonResponse({'role':actor.profile.role})
    urlpatterns=[path('api/',include('core.urls')),path('_fixture/inspect/',inspect),path('_fixture/compete/',compete),path('_fixture/role/',role)]
    print('SYNTHETIC_STAFF_SERVER_READY',flush=True)
    with make_server('127.0.0.1',4326,WSGIHandler()) as server:server.serve_forever()
