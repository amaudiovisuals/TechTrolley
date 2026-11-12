"""Ephemeral loopback server for browser document tests; never imports project settings."""
import os
import sys
import tempfile
from pathlib import Path
from wsgiref.simple_server import make_server

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend'))
os.environ.pop('DJANGO_SETTINGS_MODULE', None)
from django.conf import settings

with tempfile.TemporaryDirectory(prefix='tt-document-browser-') as media:
    settings.configure(SECRET_KEY='synthetic-browser-only', DEBUG=False,
        INSTALLED_APPS=['django.contrib.auth', 'django.contrib.contenttypes', 'rest_framework', 'rest_framework.authtoken', 'core'],
        DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}},
        ROOT_URLCONF=__name__, MIDDLEWARE=[], ALLOWED_HOSTS=['127.0.0.1', 'localhost'],
        MEDIA_ROOT=media, USE_TZ=True, DEFAULT_AUTO_FIELD='django.db.models.BigAutoField',
        REST_FRAMEWORK={'DEFAULT_PERMISSION_CLASSES': ['rest_framework.permissions.IsAuthenticated'],
                        'DEFAULT_AUTHENTICATION_CLASSES': ['rest_framework.authentication.TokenAuthentication']})
    import django
    django.setup()
    from django.core.management import call_command
    from django.contrib.auth.models import User
    from django.http import JsonResponse
    from django.urls import include, path
    from django.db import connection
    from django.core.handlers.wsgi import WSGIHandler
    from rest_framework.authtoken.models import Token
    from core.models import Asset, Conference, SubrentalCompany, SubrentalTicket, SubrentalTicketItem, ChallanDocument, ChallanRevision, MovementReceipt
    assert connection.settings_dict['NAME'] == ':memory:'
    call_command('migrate', verbosity=0)
    user = User.objects.create(username='isolated-browser-admin')
    user.profile.role = 'admin'; user.profile.save()
    Token.objects.create(user=user, key='synthetic-document-token')
    stock = Asset.objects.create(sku='SYNTHETIC-STOCK', alias_name='Owned cable', quantity=100, item_price=50)
    rental = Asset.objects.create(sku='SYNTHETIC-RENTAL', alias_name='Rental speaker', quantity=5)
    supplier = SubrentalCompany.objects.create(name='Synthetic AM supplier')
    event = Conference.objects.create(name='Synthetic document event', challan_number='SYNTHETIC-001', billing_address='Original billing', challan_date='2026-10-08')
    rental.subrental_company = supplier; rental.save()
    event.challan_assets.add(stock)
    ticket = SubrentalTicket.objects.create(conference=event, company=supplier)
    SubrentalTicketItem.objects.create(ticket=ticket, asset=rental, quantity=5, rental_price='12.50')

    def inspect(request):
        return JsonResponse({'asset_count': Asset.objects.count(), 'stock_quantity': Asset.objects.get(pk=stock.pk).quantity,
                             'documents': ChallanDocument.objects.count(), 'revisions': ChallanRevision.objects.count(), 'receipts': MovementReceipt.objects.count()})

    def change(request):
        if request.method != 'POST':
            return JsonResponse({'error': 'POST required'}, status=405)
        stock.alias_name = 'Changed inventory cable'; stock.item_price = 999; stock.save()
        supplier.name = 'Changed supplier'; supplier.save()
        event.billing_address = 'Changed billing'; event.save()
        return JsonResponse({'status': 'synthetic data changed'})

    urlpatterns = [path('api/', include('core.urls')), path('_fixture/inspect/', inspect), path('_fixture/change/', change)]
    print('SYNTHETIC_DOCUMENT_SERVER_READY', flush=True)
    with make_server('127.0.0.1', 4314, WSGIHandler()) as server:
        server.serve_forever()
