"""Disposable HTTP fixture for the actual contact picker and transfer challan UI."""
import os
import sys
import tempfile
from pathlib import Path
from uuid import uuid4
from wsgiref.simple_server import make_server

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'backend'))
os.environ.pop('DJANGO_SETTINGS_MODULE', None)
from django.conf import settings

with tempfile.TemporaryDirectory(prefix='tt-contacts-transfers-') as media:
    settings.configure(SECRET_KEY='synthetic-contacts-only', DEBUG=False, USE_TZ=True,
        INSTALLED_APPS=['django.contrib.auth', 'django.contrib.contenttypes', 'rest_framework', 'rest_framework.authtoken', 'core'],
        DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}},
        ROOT_URLCONF=__name__, MIDDLEWARE=[], ALLOWED_HOSTS=['127.0.0.1'], MEDIA_ROOT=media,
        DEFAULT_AUTO_FIELD='django.db.models.BigAutoField',
        REST_FRAMEWORK={'DEFAULT_PERMISSION_CLASSES': ['rest_framework.permissions.IsAuthenticated'],
                       'DEFAULT_AUTHENTICATION_CLASSES': ['rest_framework.authentication.TokenAuthentication']})
    import django
    django.setup()
    from django.core.management import call_command
    from django.contrib.auth.models import User
    from django.core.handlers.wsgi import WSGIHandler
    from django.http import JsonResponse
    from django.urls import path, include
    from rest_framework.authtoken.models import Token
    from core.models import Asset, CompanySettings, Conference, SubrentalCompany, TruckChallan, SavedCustomer, SavedVenue, ChallanDocument, ChallanLine
    from core.asset_commands import execute_command
    from core.challan_documents import capture_header

    call_command('migrate', verbosity=0)
    user = User.objects.create_user('contact-admin', email='contacts@example.test', is_staff=True)
    user.profile.role = 'admin'; user.profile.save()
    Token.objects.create(user=user, key='synthetic-contacts-transfer-token')
    CompanySettings.objects.create(name='Synthetic Pvt Ltd', address='Synthetic godown road')
    owner = SubrentalCompany.objects.create(name='Synthetic AM', inventory_mode='shared_warehouse')
    moved = Asset.objects.create(sku='MOVED-PHYSICAL', alias_name='Transferred speaker', quantity=1, subrental_company=owner)
    kept = Asset.objects.create(sku='KEPT-PHYSICAL', alias_name='Remaining mixer', quantity=1)
    source = Conference.objects.create(name='Source venue program', association_name='Source customer', billing_address='Source billing', transport_address='Source venue\n' + 'Full source road ' * 12)
    target = Conference.objects.create(name='Target venue program', association_name='Target customer', billing_address='Target billing', transport_address='Target venue road')
    truck = TruckChallan.objects.create(conference=source, truck_number=1, label='Truck 1', challan_number='SYNTHETIC-TRUCK')
    for action in ['stage', 'dispatch']:
        execute_command(user, source.pk, {'request_id': str(uuid4()), 'action': action, 'asset_ids': [moved.pk, kept.pk], 'source': 'fixture'})
    source.refresh_from_db()
    document = ChallanDocument.objects.create(conference=source, scope='master', state='issued', number='SYNTHETIC-SOURCE', header=capture_header(source))
    for i, asset in enumerate([moved, kept]):
        ChallanLine.objects.create(document=document, asset=asset, supplier=asset.subrental_company,
            source_kind='supplier' if asset.subrental_company_id else 'owned', quantity=1, unit_value=0, position=i,
            snapshot={'sku': asset.sku, 'alias_name': asset.alias_name, 'supplier_name': owner.name if asset.subrental_company_id else ''})

    def inspect(request):
        source.refresh_from_db(); target.refresh_from_db(); document.refresh_from_db()
        return JsonResponse({'source_id': source.pk, 'target_id': target.pk, 'moved_id': moved.pk,
            'source_address': source.transport_address, 'source_assets': list(source.assets.values_list('pk', flat=True)),
            'target_assets': list(target.assets.values_list('pk', flat=True)), 'source_header': document.header,
            'customers': list(SavedCustomer.objects.values()), 'venues': list(SavedVenue.objects.values())})

    urlpatterns = [path('api/', include('core.urls')), path('_fixture/inspect/', inspect)]
    print('SYNTHETIC_CONTACTS_TRANSFER_READY', flush=True)
    with make_server('127.0.0.1', 4382, WSGIHandler()) as server:
        server.serve_forever()
