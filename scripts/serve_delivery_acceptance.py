"""Loopback-only synthetic backend. Never imports project settings or business data."""
import os
import sys
from pathlib import Path

os.environ.pop('DJANGO_SETTINGS_MODULE', None)
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from django.conf import settings
settings.configure(
    SECRET_KEY='synthetic-delivery-browser-only', DEBUG=False, USE_TZ=True,
    DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}},
    INSTALLED_APPS=['django.contrib.auth', 'django.contrib.contenttypes', 'rest_framework', 'rest_framework.authtoken', 'core'],
    ROOT_URLCONF=__name__, DEFAULT_AUTO_FIELD='django.db.models.BigAutoField', MIDDLEWARE=[], ALLOWED_HOSTS=['127.0.0.1'],
    REST_FRAMEWORK={'DEFAULT_AUTHENTICATION_CLASSES': ['rest_framework.authentication.TokenAuthentication'],
                    'DEFAULT_PERMISSION_CLASSES': ['rest_framework.permissions.IsAuthenticated']},
)
import django
django.setup()
from django.core.management import call_command
from django.urls import path
from django.core.wsgi import get_wsgi_application
from django.contrib.auth.models import User
from rest_framework.authtoken.models import Token
from core import program_deliveries
from core.models import Asset, CompanySettings, Conference, SubrentalCompany, UserProfile
urlpatterns = [
    path('api/conferences/<int:pk>/deliveries/', program_deliveries.program_deliveries),
    path('api/conferences/<int:pk>/deliveries/preview/', program_deliveries.delivery_preview),
    path('api/conferences/<int:pk>/deliveries/<int:delivery_pk>/void/', program_deliveries.void_delivery),
]
call_command('migrate', verbosity=0)
for role in ['warehouse', 'accounts']:
    user = User.objects.create_user(f'synthetic-{role}')
    UserProfile.objects.filter(user=user).update(role='godown_incharge' if role == 'warehouse' else 'accounts')
    Token.objects.create(key=f'synthetic-{role}-only', user=user)
CompanySettings.objects.create(name='Pvt Ltd synthetic issuer', address='Warehouse test address')
supplier = SubrentalCompany.objects.create(name='AM synthetic supplier', address='Shared warehouse test address')
event = Conference.objects.create(name='Synthetic browser program', association_name='Synthetic customer', billing_address='Customer test address')
event.challan_assets.add(
    Asset.objects.create(sku='OWN-SPEAKER', alias_name='Owned speaker'),
    Asset.objects.create(sku='AM-M17', alias_name='Supplier MacBook', serial_number='M17-TEST', subrental_company=supplier),
)
application = get_wsgi_application()
def cors(environ, start_response):
    def start(status, headers, exc_info=None):
        headers += [('Access-Control-Allow-Origin', 'http://127.0.0.1:4667'), ('Access-Control-Allow-Headers', 'Content-Type, Authorization'), ('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')]
        return start_response(status, headers, exc_info)
    if environ['REQUEST_METHOD'] == 'OPTIONS':
        start('204 No Content', [])
        return [b'']
    return application(environ, start)
from wsgiref.simple_server import make_server
with make_server('127.0.0.1', 4668, cors) as server:
    print('SYNTHETIC_DELIVERY_READY', flush=True)
    server.serve_forever()
