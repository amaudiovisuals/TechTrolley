"""Synthetic source/print fixtures; explicit migrated memory DB, no project settings."""
import os
import sys
import tempfile
import uuid
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
    config = CompanySettings.objects.create(name='AM Audiovisuals Pvt Ltd')
    bulk = Asset.objects.create(sku='BULK-100', alias_name='Shared cable', type='Cables & Connectors', quantity=100, item_price=25)
    consume = Asset.objects.create(sku='TAPE-10', alias_name='Shared tape', type='Consumables', quantity=10, item_price=10)
    owner = SubrentalCompany.objects.create(name='AM Audiovisuals', inventory_mode='shared_warehouse')
    bulk.subrental_company = owner; bulk.item_price = '12.50'; bulk.save()
    consume.subrental_company = owner; consume.item_price = '2.50'; consume.save()
    owned = Asset.objects.create(sku='PVT-UNIT', alias_name='Owned device', item_price=20)
    supplier = SubrentalCompany.objects.create(name='External rental company', inventory_mode='external_supplier')
    rental = Asset.objects.create(sku='RENT-20', alias_name='Rental speaker', quantity=20, subrental_company=supplier)
    event = Conference.objects.create(name='Synthetic source event', challan_number='SYNTHETIC-SOURCES',
        start_date='2026-10-09', end_date='2026-10-10', challan_date='2026-10-08', approximate_value=None)
    for action, quantity in [('stage', 6), ('dispatch', 6), ('return', 2)]:
        event.refresh_from_db()
        execute_quantity_command(user, event.pk, {'request_id': str(uuid.uuid4()), 'action': action,
            'expected_revision': event.revision, 'items': [{'asset_id': bulk.pk, 'quantity': quantity}]})
    for action, returned, confirmed in [('dispatch', None, False), ('settle', 1, True)]:
        event.refresh_from_db()
        execute_consumable_command(user, event.pk, {'request_id': str(uuid.uuid4()), 'action': action,
            'expected_revision': event.revision, 'items': [{'asset_id': consume.pk, 'requested': 4, 'returned': returned, 'confirmed': confirmed}]})
    # This fixture models a distinct external rental order, not a second
    # warehouse scan of the same source. Mixed references are now rejected.
    ticket = SubrentalTicket.objects.create(company=supplier, conference=event)
    item = SubrentalTicketItem.objects.create(ticket=ticket, asset=rental, quantity=3, rental_price='10.00')
    legacy = Conference.objects.create(name='Legacy source review', challan_number='SYNTHETIC-LEGACY',
        consumable_data={str(consume.pk): {'requested': 4, 'status': 'settled'}}, approximate_value=None)

    from core.challan_documents import save_document, capture_header
    from core.models import ChallanLine
    event.challan_assets.add(owned)
    def source(asset, quantity, value, ticket_item=None):
        return {'id': str(uuid.uuid4()), 'asset_id': asset.pk, 'supplier_id': asset.subrental_company_id,
            'ticket_item_id': ticket_item.pk if ticket_item else None,
            'source_kind': 'supplier' if asset.subrental_company_id else 'owned',
            'snapshot': {'alias_name': asset.alias_name, 'sku': asset.sku, 'type': asset.type, 'supplier_name': ''},
            'quantity': quantity, 'unit_value': value, 'position': 0}
    lines = [source(bulk, 6, '12.50'), source(owned, 1, '20.00'), source(consume, 4, '2.50'), source(rental, 3, '10.00', item),
        {'id': str(uuid.uuid4()), 'asset_id': None, 'supplier_id': None, 'ticket_item_id': None, 'source_kind': 'manual',
         'snapshot': {'alias_name': 'Manual owner row'}, 'quantity': 2, 'unit_value': '0.25', 'position': 0}]
    for i, line in enumerate(lines): line['position'] = i
    event.refresh_from_db()
    save_document(user, event.pk, 'master', {'request_id': str(uuid.uuid4()), 'expected_revision': 0,
        'expected_event_revision': event.revision, 'number': event.challan_number, 'state': 'issued', 'document_date': '2026-10-14',
        'total_override': None, 'correction_reason': '', 'lines': lines})
    conflict = Conference.objects.create(name='Overlapping source review', challan_number='OVERLAP-ONLY', approximate_value=None)
    conflict.challan_assets.add(rental)
    bad_ticket = SubrentalTicket.objects.create(company=supplier, conference=conflict)
    SubrentalTicketItem.objects.create(ticket=bad_ticket, asset=rental, quantity=2, rental_price=10)
    old_event = Conference.objects.create(name='Old flat document', challan_number='OLD-FLAT', approximate_value=None)
    old_doc = ChallanDocument.objects.create(conference=old_event, scope='master', number='OLD-FLAT', header=capture_header(old_event, owner_sections_version=None))
    ChallanLine.objects.create(document=old_doc, asset=owned, source_kind='owned', snapshot={'alias_name': 'Old flat row'}, quantity=1, unit_value=20, position=0)

    def inspect(request):
        document = ChallanDocument.objects.filter(conference=event, scope='master').first()
        return JsonResponse({'stock': Asset.objects.get(pk=bulk.pk).quantity, 'consumable_stock': Asset.objects.get(pk=consume.pk).quantity,
            'documents': ChallanDocument.objects.count(), 'old_header': ChallanDocument.objects.get(pk=old_doc.pk).header, 'revisions': ChallanRevision.objects.count(),
            'consumed': ConsumableAllocation.objects.get(conference=event).consumed,
            'document': document_data(document) if document else None})

    def change(request):
        if request.method != 'POST': return JsonResponse({'error': 'POST required'}, status=405)
        Asset.objects.filter(pk=bulk.pk).update(quantity=90, alias_name='Renamed bulk stock')
        Asset.objects.filter(pk=consume.pk).update(quantity=0, alias_name='Renamed tape stock', item_price=99)
        supplier.name = 'Renamed external supplier'; supplier.save()
        owner.name = 'Renamed AM owner'; owner.save()
        config.name = 'Renamed issuer'; config.save()
        event.billing_address = 'Renamed event billing'; event.save()
        return JsonResponse({'status': 'synthetic sources changed'})

    urlpatterns = [path('api/', include('core.urls')), path('_fixture/inspect/', inspect), path('_fixture/change/', change)]
    print('SYNTHETIC_OWNER_SERVER_READY', flush=True)
    with make_server('127.0.0.1', 4336, WSGIHandler()) as server: server.serve_forever()
