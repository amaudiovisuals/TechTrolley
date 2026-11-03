"""Apply/reverse/reapply the additive migration on a restored private DB only."""
import os
import re
import sys

source_path, database = sys.argv[1:]
if not re.fullmatch(r'codex_delivery_restore_[a-z0-9_]+', database):
    raise SystemExit('Refusing a database outside the disposable restoration namespace.')
os.environ.pop('DJANGO_SETTINGS_MODULE', None)
sys.path.insert(0, source_path)
from django.conf import settings
settings.configure(SECRET_KEY='isolated-schema-restoration-rehearsal', USE_TZ=True,
    INSTALLED_APPS=['django.contrib.auth', 'django.contrib.contenttypes', 'django.contrib.sessions',
                    'rest_framework', 'rest_framework.authtoken', 'core'],
    DATABASES={'default': {'ENGINE': 'django.db.backends.postgresql', 'NAME': database, 'USER': 'postgres'}},
    DEFAULT_AUTO_FIELD='django.db.models.BigAutoField')
import django
django.setup()
from django.db import connection
from django.db.migrations.executor import MigrationExecutor

def existing_counts():
    tables = [name for name in connection.introspection.table_names() if name not in {'core_programdelivery', 'django_migrations'}]
    with connection.cursor() as cursor:
        counts = {}
        for table in tables:
            cursor.execute('SELECT COUNT(*) FROM ' + connection.ops.quote_name(table))
            counts[table] = cursor.fetchone()[0]
        digests = {}
        for table in ['core_asset', 'core_companysettings', 'core_conference']:
            cursor.execute('SELECT md5(COALESCE(string_agg(row_to_json(t)::text, \'\' ORDER BY id), \'\')) FROM ' + connection.ops.quote_name(table) + ' t')
            digests[table] = cursor.fetchone()[0]
    return counts, digests

before = existing_counts()
forward = ('core', '0054_program_delivery_documents')
backward = ('core', '0053_alter_userprofile_role')
executor = MigrationExecutor(connection)
plan = executor.migration_plan([forward])
assert [(m.app_label, m.name, back) for m, back in plan] == [('core', forward[1], False)], 'Unexpected restored migration plan'
executor.migrate([forward])
assert existing_counts() == before, 'Existing restored data changed during additive migration'
with connection.cursor() as cursor:
    cursor.execute('SELECT COUNT(*) FROM core_programdelivery')
    assert cursor.fetchone()[0] == 0
executor = MigrationExecutor(connection)
executor.migrate([backward])
assert 'core_programdelivery' not in connection.introspection.table_names()
assert existing_counts() == before, 'Existing restored data changed during reverse rehearsal'
executor = MigrationExecutor(connection)
executor.migrate([forward])
assert existing_counts() == before, 'Existing restored data changed during reapply rehearsal'
print(f'Restored backup and migration forward/reverse/reapply verified; {len(before[0])} existing table counts and inventory/company/program fingerprints preserved.')
