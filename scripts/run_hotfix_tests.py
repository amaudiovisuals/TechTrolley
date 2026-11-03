"""Run inventory contract tests against a disposable database, without project settings."""
import os
import sys
from pathlib import Path

os.environ.pop('DJANGO_SETTINGS_MODULE', None)
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from django.conf import settings
settings.configure(
    SECRET_KEY='synthetic-inventory-tests-only', DEBUG=False, USE_TZ=True,
    DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}},
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
from core import views
urlpatterns = [
    path('api/assets/', views.asset_list),
    path('api/assets/<int:pk>/assign-quantity/', views.asset_assign_quantity),
    path('api/upload-assets/', views.bulk_upload_assets),
    path('api/download-template/', views.download_asset_template),
    path('api/export-inventory/', views.export_inventory),
]
from django.test.runner import DiscoverRunner
raise SystemExit(bool(DiscoverRunner(verbosity=2).run_tests(['core.tests_hotfix_inventory'])))
