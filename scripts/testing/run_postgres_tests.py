"""Create a private PostgreSQL cluster, test/rehearse, and stop it in finally.

No existing database/URL/settings/credentials are accepted. Requires local PostgreSQL
binaries and an isolated Python with the test dependencies. No system service,
TCP listener, business records or production connection is involved.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import signal
import stat
import subprocess
import sys
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[2]
DATABASES = {'postgres', 'tt_validation', 'tt_validation_tests', 'tt_restore'}
ROLE = 'tt_test_owner'
TEST_LABELS = ['core.tests', 'core.tests_step2', 'core.tests_step3', 'core.tests_step4',
               'core.tests_step4b', 'core.tests_step4b2', 'core.tests_step4b3a',
               'core.tests_step4b3b', 'core.tests_step4c', 'core.tests_step5a',
               'core.tests_step5b', 'core.tests_step5c', 'core.tests_step5d',
               'core.tests_step6a', 'core.tests_step6b', 'core.tests_step6c', 'core.tests_step6d', 'core.tests_step8b1', 'core.tests_step8b2', 'core.tests_step8b3', 'core.tests_step8b5', 'core.tests_step8b6', 'core.tests_offline_packages', 'core.tests_hotfix_inventory', 'core.tests_program_deliveries', 'core.tests_saved_contacts_and_origins', 'core.tests_led_cases', 'core.tests_quantity_transfers']


def clean_environment():
    return {k: v for k, v in os.environ.items()
            if not k.startswith('PG') and k not in {
                'DJANGO_SETTINGS_MODULE', 'DJANGO_ENV', 'DATABASE_URL',
                'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GROQ_API_KEY'}}


def run(command, **kwargs):
    return subprocess.run([str(part) for part in command], check=True,
                          env=clean_environment(), **kwargs)


def verify_test_connection(connection, base):
    try:
        name=connection.settings_dict['NAME']
        maintenance=connection.alias=='__no_db__' and name is None
        if connection.vendor!='postgresql' or (name not in DATABASES and not maintenance):
            raise RuntimeError('Unexpected validation database')
        if connection.settings_dict['HOST']!=str(base/'socket'):
            raise RuntimeError('Only the private test Unix socket is allowed')
        with connection.cursor() as cursor:
            cursor.execute('SHOW data_directory')
            if Path(cursor.fetchone()[0]).resolve()!=(base/'data').resolve():
                raise RuntimeError('Connected to a different PostgreSQL cluster')
            cursor.execute('SHOW listen_addresses')
            if cursor.fetchone()[0]!='':
                raise RuntimeError('The test server must have no TCP listener')
            cursor.execute('SELECT current_database()')
            if cursor.fetchone()[0] != ('postgres' if maintenance else name):
                raise RuntimeError('Connected to a different validation database')
    except Exception:
        connection.close()
        raise


def worker(control_file):
    # Control comes only from a new private cluster made by this harness.
    control_file = Path(control_file).resolve()
    base = control_file.parent
    if not base.name.startswith('tt-pg-') or control_file.name != 'control.json':
        raise RuntimeError('Not a private test-cluster control file')
    for path in (base, control_file, base / 'socket', base / 'data'):
        info = path.stat()
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
            raise RuntimeError('Test cluster must be owned by the current user and private')
    packet = json.loads(control_file.read_text())
    if packet.get('protocol') != 'techtrolley-private-postgres-1':
        raise RuntimeError('Unknown test-cluster protocol')
    pg_bin = Path(packet['pg_bin']).resolve()
    sys.path.insert(0, str(ROOT / 'backend'))
    os.environ.pop('DJANGO_SETTINGS_MODULE', None)
    from django.conf import settings
    settings.configure(
        SECRET_KEY='isolated-postgres-tests-only', DEBUG=False,
        INSTALLED_APPS=['django.contrib.auth', 'django.contrib.contenttypes',
                        'django.contrib.sessions', 'rest_framework',
                        'rest_framework.authtoken', 'core'],
        DATABASES={'default': {'ENGINE': 'django.db.backends.postgresql',
            'NAME': 'tt_validation', 'USER': ROLE, 'HOST': str(base / 'socket'),
            'PORT': '55439', 'PASSWORD': '', 'CONN_MAX_AGE': 0,
            'OPTIONS': {'connect_timeout': 5, 'application_name': packet['nonce'],
                        'options': '-c statement_timeout=30000 -c lock_timeout=15000'},
            'TEST': {'NAME': 'tt_validation_tests'}}},
        ROOT_URLCONF=__name__, MIDDLEWARE=[], ALLOWED_HOSTS=['testserver'],
        MEDIA_ROOT=str(base / 'media'), MEDIA_URL='/media/', USE_TZ=True,
        DEFAULT_AUTO_FIELD='django.db.models.BigAutoField',
        PASSWORD_HASHERS=['django.contrib.auth.hashers.MD5PasswordHasher'],
        REST_FRAMEWORK={'DEFAULT_PARSER_CLASSES': ['core.upload_safety.BoundedJSONParser', 'core.upload_safety.BoundedFormParser', 'rest_framework.parsers.MultiPartParser'],
            'DEFAULT_PERMISSION_CLASSES': ['rest_framework.permissions.IsAuthenticated'],
                        'DEFAULT_AUTHENTICATION_CLASSES': ['core.authentication.ExpiringTokenAuthentication']},
    )
    # Check the main, migration and every race-thread connection before writes.
    from django.db.backends.signals import connection_created
    def guard(sender, connection, **kwargs):
        verify_test_connection(connection, base)
    connection_created.connect(guard, weak=False)
    import django
    django.setup()
    from django.urls import include, path
    global urlpatterns
    urlpatterns = [path('api/', include('core.urls'))]
    from django.db import connection
    from django.core.management import call_command
    connection.ensure_connection()
    with connection.cursor() as cursor:
        cursor.execute('SELECT version()')
        postgres_version = cursor.fetchone()[0]
    summary = {'protocol': packet['protocol'], 'python': sys.version.split()[0],
               'django': django.get_version(), 'postgresql': postgres_version,
               'business_database_used': False, 'tcp_listener': False,
               'private_cluster_identity_checked_on_every_connection': True}
    if packet['mode'] in {'all', 'rehearsal', 'release'}:
        summary['rehearsal'] = rehearse(pg_bin, base, release_probe=packet['mode'] == 'release', production_baseline=packet.get('baseline') == 'production_0054')
    if packet['mode'] in {'all', 'tests'}:
        from django.test.runner import DiscoverRunner
        class RecordedRunner(DiscoverRunner):
            def run_suite(self, suite, **kwargs):
                result = super().run_suite(suite, **kwargs)
                summary['tests'] = {'found': result.testsRun, 'passed': result.testsRun-len(result.failures)-len(result.errors)-len(result.skipped),
                    'failures': len(result.failures), 'errors': len(result.errors), 'skipped': len(result.skipped),
                    'skip_reasons': [reason for _, reason in result.skipped]}
                return result
        failures = RecordedRunner(verbosity=2, interactive=False).run_tests(packet['labels'] or TEST_LABELS)
    else:
        failures = 0
    summary['success'] = not bool(failures)
    (base / 'results.json').write_text(json.dumps(summary, indent=2)+'\n')
    connection.close()
    return bool(failures)


def rehearse(pg_bin, base, release_probe=False, production_baseline=False):
    """Synthetic 0053 -> latest plus restore of both before/after dumps."""
    from django.db import connection
    from django.db.migrations.executor import MigrationExecutor
    from django.core.management import call_command
    executor = MigrationExecutor(connection)
    old = ('core', '0053_alter_userprofile_role')
    if old not in executor.loader.graph.nodes:
        # Find the exact historical filename instead of assuming a suffix.
        old = next(node for node in executor.loader.graph.nodes if node[0]=='core' and node[1].startswith('0053_'))
    executor.migrate([old])
    if production_baseline:
        old = ('core', '0054_program_delivery_documents')
        executor = MigrationExecutor(connection)
        executor.migrate([old])
    state = executor.loader.project_state([old]).apps
    Asset, Event = state.get_model('core','Asset'), state.get_model('core','Conference')
    Supplier = state.get_model('core','SubrentalCompany')
    Ticket, Item = state.get_model('core','SubrentalTicket'), state.get_model('core','SubrentalTicketItem')
    supplier = Supplier.objects.create(name='Synthetic shared-owner candidate')
    owned = Asset.objects.create(sku='RESTORE-OWNED',alias_name='Original QR',barcode='RESTORE-QR',quantity=1,status='In Use')
    rental = Asset.objects.create(sku='RESTORE-SUPPLIER',quantity=8,subrental_company=supplier)
    event = Event.objects.create(name='Synthetic legacy event',challan_number='LEGACY-PAPER',flag_log=[{'asset_id':owned.pk,'flag':'Test inspection note','stage':'Packup'}])
    event.assets.add(owned);event.challan_assets.add(owned)
    ticket = Ticket.objects.create(company=supplier,conference=event)
    Item.objects.create(ticket=ticket,asset=rental,quantity=3,rental_price='10.25')
    old_packet = None
    if production_baseline:
        import uuid
        Packet = state.get_model('core', 'ProgramDelivery')
        old_packet = Packet.objects.create(conference=event, request_key=uuid.uuid4(), request_hash='synthetic-preupgrade',
            reference='Preupgrade delivery', issued_by='Recorded operator',
            snapshot={'version': 1, 'customer_document': {'number': 'OLD-OUT', 'rows': []},
                      'supplier_documents': [{'number': 'OLD-SUPPLIER', 'rows': []}]})
    def snapshot():
        # Compare every original column, relation and table, using historical models.
        data={}
        for model in state.get_models(include_auto_created=True):
            if model._meta.app_label!='core':continue
            fields=[field.attname for field in model._meta.local_fields]
            if fields:
                data[model._meta.db_table]=list(model.objects.order_by(model._meta.pk.attname).values(*fields))
        return json.dumps(data,sort_keys=True,default=str)
    before=snapshot()
    def dump(name):
        path=base/name
        run([pg_bin/'pg_dump','--host',base/'socket','--port','55439','--username',ROLE,
             '--dbname','tt_validation','--format=custom','--no-owner','--file',path],stdout=subprocess.DEVNULL)
        path.chmod(0o600)
        return path
    old_dump=dump('synthetic-before.dump')
    probe = None
    if release_probe:
        from release_rehearsal_probe import ReleaseExercise
        probe = ReleaseExercise(ROOT, base)
        probe.before_upgrade(old_dump)
    call_command('migrate',interactive=False,verbosity=0)
    call_command('makemigrations','core',check=True,dry_run=True,verbosity=1)
    assert snapshot()==before,'Original legacy columns or relations changed during upgrade'
    from core.models import (Asset as CurrentAsset, Conference, SubrentalCompany,
        MovementReceipt, SupplierBalance, SupplierMovement, OwnershipHistory, StaffAllocation, ChallanDocument, CredentialAttempt)
    assert CurrentAsset.objects.get(pk=owned.pk).status=='In Use'
    assert CurrentAsset.objects.get(pk=owned.pk).ownership_revision==0
    assert SubrentalCompany.objects.get(pk=supplier.pk).inventory_mode=='unreviewed'
    assert Conference.objects.get(pk=event.pk).lifecycle_state=='open'
    for model in (MovementReceipt,SupplierBalance,SupplierMovement,OwnershipHistory,StaffAllocation,ChallanDocument,CredentialAttempt):
        assert model.objects.count()==0,'Migration invented operational history'
    new_dump=dump('synthetic-after.dump')
    activation = probe.after_upgrade() if probe else None
    connection.close()
    # Separate restore DB; never overwrite the upgrade DB or any configured app DB.
    restores=[]
    latest = next(node[1] for node in MigrationExecutor(connection).loader.graph.leaf_nodes() if node[0] == 'core')
    for archive,expected_migration in [(old_dump,old[1]),(new_dump,latest)]:
        run([pg_bin/'createdb','--host',base/'socket','--port','55439','--username',ROLE,'tt_restore'],stdout=subprocess.DEVNULL)
        run([pg_bin/'pg_restore','--host',base/'socket','--port','55439','--username',ROLE,
             '--dbname','tt_restore','--no-owner','--exit-on-error','--single-transaction',archive],stdout=subprocess.DEVNULL)
        import psycopg2
        with psycopg2.connect(host=str(base/'socket'),port=55439,user=ROLE,dbname='tt_restore') as restored:
            with restored.cursor() as cursor:
                cursor.execute('SHOW data_directory');assert Path(cursor.fetchone()[0]).resolve()==(base/'data').resolve()
                cursor.execute('SELECT name FROM django_migrations WHERE app=%s ORDER BY id DESC LIMIT 1',['core'])
                assert cursor.fetchone()[0]==expected_migration
                cursor.execute('SELECT id, sku, quantity FROM core_asset ORDER BY id');assert cursor.fetchall()==[(owned.pk,'RESTORE-OWNED',1),(rental.pk,'RESTORE-SUPPLIER',8)]
                cursor.execute('SELECT COUNT(*) FROM core_conference_assets');assert cursor.fetchone()[0]==1
                cursor.execute('SELECT challan_number, flag_log FROM core_conference WHERE id=%s',[event.pk]);assert cursor.fetchone()==('LEGACY-PAPER',event.flag_log)
                if old_packet is not None:
                    cursor.execute('SELECT id, snapshot, reference FROM core_programdelivery WHERE id=%s', [old_packet.pk])
                    assert cursor.fetchone() == (old_packet.pk, old_packet.snapshot, old_packet.reference)
        restored.close()
        run([pg_bin/'dropdb','--host',base/'socket','--port','55439','--username',ROLE,'tt_restore'],stdout=subprocess.DEVNULL)
        restores.append(expected_migration)
    return {'synthetic_records_only':True,'from_migration':old[1],'to_migration':latest,
        'production_delivery_snapshot_preserved':old_packet is not None,
        'all_original_core_columns_relations_unchanged':True,'no_operational_history_backfilled':True,
        'restored_migration_versions':restores,'restore_is_business_backup_certification':False,
        'dump_sha256':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in [old_dump,new_dump]},
        **({'activation_rehearsal': activation} if activation else {})}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pg-bin',type=Path)
    parser.add_argument('--mode',choices=['all','tests','rehearsal','release'],default='all')
    parser.add_argument('--baseline', choices=['audit_0053', 'production_0054'], default='audit_0053')
    parser.add_argument('--worker',type=Path,help=argparse.SUPPRESS)
    parser.add_argument('labels',nargs='*')
    args=parser.parse_args()
    if args.worker:return worker(args.worker)
    if not args.pg_bin:parser.error('--pg-bin is required; no existing database connection is accepted')
    pg_bin=args.pg_bin.resolve()
    for name in ['initdb','pg_ctl','createdb','dropdb','pg_dump','pg_restore']:
        if not (pg_bin/name).is_file():parser.error('Missing PostgreSQL binary: '+name)
    base=Path(tempfile.mkdtemp(prefix='tt-pg-')).resolve();base.chmod(0o700)
    (base/'socket').mkdir(mode=0o700);(base/'media').mkdir(mode=0o700)
    control=base/'control.json'
    control.write_text(json.dumps({'protocol':'techtrolley-private-postgres-1','nonce':str(uuid.uuid4()),
        'pg_bin':str(pg_bin),'mode':args.mode,'labels':args.labels,'baseline':args.baseline})+'\n');control.chmod(0o600)
    print('Private test cluster artifacts:',base,flush=True)
    started=False
    def interrupted(signum,frame):raise KeyboardInterrupt
    signal.signal(signal.SIGTERM,interrupted)
    try:
        with (base/'initdb.log').open('w') as output:
            run([pg_bin/'initdb','--pgdata',base/'data','--username',ROLE,'--auth=trust','--encoding=UTF8','--no-locale'],stdout=output,stderr=subprocess.STDOUT)
        options="-k {} -p 55439 -c listen_addresses='' -c unix_socket_permissions=0700".format(shlex.quote(str(base/'socket')))
        started=True
        run([pg_bin/'pg_ctl','-D',base/'data','-l',base/'postgres.log','-o',options,'-w','start'],stdout=subprocess.DEVNULL)
        run([pg_bin/'createdb','--host',base/'socket','--port','55439','--username',ROLE,'tt_validation'])
        result=subprocess.run([sys.executable,str(Path(__file__).resolve()),'--worker',str(control)],env=clean_environment(),timeout=600)
        return result.returncode
    finally:
        if started and (base/'data'/'postmaster.pid').exists():
            run([pg_bin/'pg_ctl','-D',base/'data','-m','fast','-w','stop'],stdout=subprocess.DEVNULL)
            (base/'stopped.json').write_text(json.dumps({'stopped':True,'business_database_used':False})+'\n')
        print('Private artifacts retained; no system service or TCP listener:',base,flush=True)


if __name__=='__main__':
    sys.exit(main())
