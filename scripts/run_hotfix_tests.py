"""Run inventory contract tests against a disposable database, without project settings."""
import os
import sys
from pathlib import Path

os.environ.pop('DJANGO_SETTINGS_MODULE', None)
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from django.conf import settings
test_databases = {'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}}
postgres_name = os.environ.get('TT_TEST_POSTGRES_NAME')
if postgres_name:
    import re
    if not re.fullmatch(r'codex_delivery_acceptance_[a-z0-9_]{1,30}', postgres_name):
        raise SystemExit('Refusing an unrecognized disposable test database name.')
    test_databases = {'default': {'ENGINE': 'django.db.backends.postgresql', 'NAME': 'postgres', 'USER': 'postgres',
                                  'HOST': os.environ.get('TT_TEST_POSTGRES_HOST', ''),
                                  'PASSWORD': os.environ.get('TT_TEST_POSTGRES_PASSWORD', ''),
                                  'TEST': {'NAME': postgres_name}}}
settings.configure(
    SECRET_KEY='synthetic-inventory-tests-only', DEBUG=False, USE_TZ=True,
    DATABASES=test_databases,
    INSTALLED_APPS=['django.contrib.auth', 'django.contrib.contenttypes', 'django.contrib.sessions',
                    'rest_framework', 'rest_framework.authtoken', 'core'],
    ROOT_URLCONF=__name__, DEFAULT_AUTO_FIELD='django.db.models.BigAutoField',
    MIDDLEWARE=[], ALLOWED_HOSTS=['testserver'],
    REST_FRAMEWORK={'DEFAULT_AUTHENTICATION_CLASSES': ['rest_framework.authentication.TokenAuthentication'],
                    'DEFAULT_PERMISSION_CLASSES': ['rest_framework.permissions.IsAuthenticated']},
)
import django
django.setup()
from django.urls import path
from core import views, program_deliveries, conference_views
urlpatterns = [
    path('api/conferences/<int:pk>/', conference_views.conference_detail),
    path('api/conferences/<int:pk>/deliveries/', program_deliveries.program_deliveries),
    path('api/conferences/<int:pk>/deliveries/preview/', program_deliveries.delivery_preview),
    path('api/conferences/<int:pk>/deliveries/<int:delivery_pk>/void/', program_deliveries.void_delivery),
    path('api/assets/', views.asset_list),
    path('api/assets/<int:pk>/assign-quantity/', views.asset_assign_quantity),
    path('api/upload-assets/', views.bulk_upload_assets),
    path('api/download-template/', views.download_asset_template),
    path('api/export-inventory/', views.export_inventory),
]
from django.test.runner import DiscoverRunner
if '--check-migrations' in sys.argv:
    from django.core.management import call_command
    call_command('makemigrations', 'core', check=True, dry_run=True, verbosity=1)
else:
    raise SystemExit(bool(DiscoverRunner(verbosity=2).run_tests(['core.tests_hotfix_inventory', 'core.tests_program_deliveries'])))
