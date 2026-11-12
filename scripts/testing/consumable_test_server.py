"""Disposable consumable HTTP fixtures. No project settings or business DB access."""
import os
import sys
import tempfile
from datetime import date
from pathlib import Path
from wsgiref.simple_server import make_server

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend'))
os.environ.pop('DJANGO_SETTINGS_MODULE', None)
from django.conf import settings

with tempfile.TemporaryDirectory(prefix='tt-consumable-browser-') as media:
    settings.configure(SECRET_KEY='synthetic-consumable-browser-only', DEBUG=False,
        INSTALLED_APPS=['django.contrib.auth', 'django.contrib.contenttypes', 'rest_framework', 'rest_framework.authtoken', 'core'],
        DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}},
        ROOT_URLCONF=__name__, MIDDLEWARE=[], ALLOWED_HOSTS=['127.0.0.1', 'localhost'], MEDIA_ROOT=media, USE_TZ=True,
        DEFAULT_AUTO_FIELD='django.db.models.BigAutoField', REST_FRAMEWORK={'DEFAULT_PERMISSION_CLASSES': ['rest_framework.permissions.IsAuthenticated'],
            'DEFAULT_AUTHENTICATION_CLASSES': ['rest_framework.authentication.TokenAuthentication']})
    import django
    django.setup()
    from django.core.management import call_command
    from django.contrib.auth.models import User
    from django.http import JsonResponse
    from django.urls import path, include
    from django.db import connection
    from django.core.handlers.wsgi import WSGIHandler
    from rest_framework.authtoken.models import Token
    from core.models import Asset, Conference, ConsumableMovement, CompanySettings, Employee
    assert connection.settings_dict['NAME'] == ':memory:'
    call_command('migrate', verbosity=0)
    user = User.objects.create(username='synthetic-consume', email='synthetic-consume@example.test')
    user.profile.role = 'godown_incharge'; user.profile.save()
    Token.objects.create(user=user, key='synthetic-consumable-token')
    CompanySettings.objects.create(name='Synthetic company')
    stock = Asset.objects.create(sku='CONSUME-10', alias_name='Synthetic tape stock', type='Consumables', quantity=10)
    event = Conference.objects.create(name='Synthetic consumable event', challan_number='SYNTHETIC-CONSUME', start_date=date.today(), end_date=date.today())
    for role in ('admin', 'boss', 'technician'):
        actor = User.objects.create(username=f'synthetic-{role}', email=f'{role}@example.test')
        actor.profile.role = role; actor.profile.save()
        Token.objects.create(user=actor, key=f'synthetic-{role}-token')
        if role == 'technician':
            employee = Employee.objects.create(name='Synthetic technician', employee_id='SYNTHETIC-TECH',
                department='Synthetic warehouse', email=actor.email, phone='0000000000')
            event.assigned_employees.add(employee)

    def inspect(request):
        event.refresh_from_db()
        return JsonResponse({'stock': Asset.objects.get(pk=stock.pk).quantity, 'vehicle': event.vehicle_number,
            'movements': ConsumableMovement.objects.count(), 'settlements': ConsumableMovement.objects.filter(action='settle').count(),
            'data': event.consumable_data})

    urlpatterns = [path('api/', include('core.urls')), path('_fixture/inspect/', inspect)]
    print('SYNTHETIC_CONSUMABLE_SERVER_READY', flush=True)
    with make_server('127.0.0.1', 4318, WSGIHandler()) as server: server.serve_forever()
