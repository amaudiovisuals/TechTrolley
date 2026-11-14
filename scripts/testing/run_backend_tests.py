"""Run backend tests against disposable SQLite, without importing project settings.

Usage from the repository root: backend/venv/bin/python scripts/testing/run_backend_tests.py
Pass optional Django test labels as arguments. Never connects to business databases.
"""
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend'))
os.environ.pop('DJANGO_SETTINGS_MODULE', None)
from django.conf import settings

with tempfile.TemporaryDirectory(prefix='techtrolley-tests-') as media:
    settings.configure(
        SECRET_KEY='isolated-tests-only', DEBUG=False,
        INSTALLED_APPS=['django.contrib.auth', 'django.contrib.contenttypes',
                        'django.contrib.sessions', 'rest_framework',
                        'rest_framework.authtoken', 'core'],
        DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}},
        ROOT_URLCONF=__name__, MIDDLEWARE=[], ALLOWED_HOSTS=['testserver'],
        MEDIA_ROOT=media, MEDIA_URL='/media/', USE_TZ=True,
        DEFAULT_AUTO_FIELD='django.db.models.BigAutoField',
        PASSWORD_HASHERS=['django.contrib.auth.hashers.MD5PasswordHasher'],
        REST_FRAMEWORK={
            'DEFAULT_PARSER_CLASSES': ['core.upload_safety.BoundedJSONParser', 'core.upload_safety.BoundedFormParser', 'rest_framework.parsers.MultiPartParser'],
            'DEFAULT_PERMISSION_CLASSES': ['rest_framework.permissions.IsAuthenticated'],
            'DEFAULT_AUTHENTICATION_CLASSES': ['core.authentication.ExpiringTokenAuthentication'],
        },
    )
    import django
    django.setup()
    from django.urls import include, path
    urlpatterns = [path('api/', include('core.urls'))]
    from django.db import connection
    assert connection.settings_dict['NAME'] == ':memory:'
    if sys.argv[1:] == ['--check-schema']:
        from django.core.management import call_command
        call_command('check')
        call_command('makemigrations', 'core', check=True, dry_run=True, verbosity=1)
        call_command('migrate', interactive=False, verbosity=0)
        from core.models import Conference, MovementReceipt
        assert 'core_movementreceipt' in connection.introspection.table_names()
        event = Conference.objects.create(name='Disposable schema check')
        assert event.revision == 0 and MovementReceipt.objects.count() == 0
        print('Fresh in-memory migrations and model/migration consistency passed; no business database selected.')
        failures = 0
    else:
        from django.test.runner import DiscoverRunner
        failures = DiscoverRunner(verbosity=1).run_tests(sys.argv[1:] or ['core.tests', 'core.tests_step2', 'core.tests_step3', 'core.tests_step4', 'core.tests_step4b', 'core.tests_step4b2', 'core.tests_step4b3a', 'core.tests_step4b3b', 'core.tests_step4c', 'core.tests_step5a', 'core.tests_step5b', 'core.tests_step5c', 'core.tests_step5d', 'core.tests_step6a', 'core.tests_step6b', 'core.tests_step6c', 'core.tests_step6d', 'core.tests_step8b1', 'core.tests_step8b2', 'core.tests_step8b3', 'core.tests_step8b5', 'core.tests_step8b6', 'core.tests_offline_packages', 'core.tests_hotfix_inventory', 'core.tests_program_deliveries', 'core.tests_saved_contacts_and_origins', 'core.tests_led_cases', 'core.tests_quantity_transfers', 'core.tests_return_deliveries', 'core.tests_skip_packup', 'core.tests_demo_billing'])
sys.exit(bool(failures))
