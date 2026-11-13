"""Synthetic source/print fixtures; explicit migrated memory DB, no project settings."""
import os
import sys
import tempfile
import uuid
from datetime import date
from pathlib import Path
from wsgiref.simple_server import make_server

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend'))
os.environ.pop('DJANGO_SETTINGS_MODULE', None)
from django.conf import settings

with tempfile.TemporaryDirectory(prefix='tt-document-sources-') as media:
    settings.configure(SECRET_KEY='synthetic-sources-only', DEBUG=False,
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
    from core.models import (Asset, Conference, CompanySettings, SubrentalCompany, SubrentalTicket, SubrentalTicketItem,
                             ChallanDocument, ChallanRevision, ConsumableAllocation)
    from core.quantity_commands import execute_quantity_command
    from core.consumable_commands import execute_consumable_command
    from core.challan_documents import document_data
    assert connection.settings_dict['NAME'] == ':memory:'
    call_command('migrate', verbosity=0)
    user = User.objects.create(username='synthetic-source-admin', email='sources@example.test')
    user.profile.role = 'admin'; user.profile.save()
    Token.objects.create(user=user, key='synthetic-sources-token')
    CompanySettings.objects.create(name='Synthetic source company')
    bulk = Asset.objects.create(sku='BULK-100', alias_name='Bulk cable', type='Cables & Connectors', quantity=100, item_price=25)
    consume = Asset.objects.create(sku='TAPE-10', alias_name='Event tape', type='Consumables', quantity=10, item_price=10)
    supplier = SubrentalCompany.objects.create(name='Synthetic AM supplier')
    rental = Asset.objects.create(sku='RENT-20', alias_name='Rental speaker', quantity=20, subrental_company=supplier)
    event = Conference.objects.create(name='Synthetic source event', challan_number='SYNTHETIC-SOURCES',
        start_date=date.today(), end_date=date.today(), challan_date='2026-10-08', approximate_value=None)
    for action, quantity in [('stage', 6), ('dispatch', 6), ('return', 2)]:
        event.refresh_from_db()
        execute_quantity_command(user, event.pk, {'request_id': str(uuid.uuid4()), 'action': action,
            'expected_revision': event.revision, 'items': [{'asset_id': bulk.pk, 'quantity': quantity}]})
    for action, returned, confirmed in [('dispatch', None, False), ('settle', 3, True)]:
        event.refresh_from_db()
        execute_consumable_command(user, event.pk, {'request_id': str(uuid.uuid4()), 'action': action,
            'expected_revision': event.revision, 'items': [{'asset_id': consume.pk, 'requested': 8, 'returned': returned, 'confirmed': confirmed}]})
    # External rental is one ticket source, not a duplicate warehouse scan.
    ticket = SubrentalTicket.objects.create(company=supplier, conference=event)
    SubrentalTicketItem.objects.create(ticket=ticket, asset=rental, quantity=3, rental_price='12.50')
    legacy = Conference.objects.create(name='Legacy source review', challan_number='SYNTHETIC-LEGACY',
        consumable_data={str(consume.pk): {'requested': 8, 'status': 'settled'}}, approximate_value=None)

    def inspect(request):
        current_event = Conference.objects.get(pk=event.pk)
        document = ChallanDocument.objects.filter(conference=current_event, scope='master').first()
        return JsonResponse({'stock': Asset.objects.get(pk=bulk.pk).quantity, 'consumable_stock': Asset.objects.get(pk=consume.pk).quantity,
            'documents': ChallanDocument.objects.count(), 'revisions': ChallanRevision.objects.count(),
            'consumed': ConsumableAllocation.objects.get(conference=event).consumed,
            'document': document_data(document) if document else None, 'all_documents': [document_data(doc) for doc in current_event.challan_documents.order_by('scope')], 'manifest_entries': list(current_event.truck_manifest.entries.values('master_line_id', 'truck_id', 'quantity')) if hasattr(current_event, 'truck_manifest') else []})

    def change(request):
        if request.method != 'POST': return JsonResponse({'error': 'POST required'}, status=405)
        Asset.objects.filter(pk=bulk.pk).update(quantity=90, alias_name='Renamed bulk stock')
        Asset.objects.filter(pk=consume.pk).update(quantity=0, alias_name='Renamed tape stock', item_price=99)
        supplier.name = 'Renamed supplier'; supplier.save()
        event.billing_address = 'Renamed event billing'; event.save()
        return JsonResponse({'status': 'synthetic sources changed'})

    urlpatterns = [path('api/', include('core.urls')), path('_fixture/inspect/', inspect), path('_fixture/change/', change)]
    print('SYNTHETIC_MANIFEST_SERVER_READY', flush=True)
    with make_server('127.0.0.1', 4322, WSGIHandler()) as server: server.serve_forever()
