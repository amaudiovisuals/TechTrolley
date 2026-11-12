"""Paired DB/media restore exercise ONLY in the existing sentinel-guarded local VM.

No host/DSN/backup input. Source is the prior synthetic service fixture. Target is
a new private cluster and database; no overlay, business data or production path.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import time
import uuid

from systemd_service_probe import (ROOT, STATE, DBBIN, guard, require, run, mkdir,
                                   write, config_env, django_code)
try:
    import backup_media
except ModuleNotFoundError:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'deployment'))
    import backup_media

RECOVERY = Path('/srv/techtrolley-recovery-staging')


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')


def record(checks, label, ok):
    require(ok, label); checks.append(label)


def admin(socket, port, database, *arguments, **kwargs):
    return run('runuser', '-u', 'tt-staging-db', '--', DBBIN/'psql', '-h', socket,
               '-p', str(port), '-d', database, '-v', 'ON_ERROR_STOP=1', *arguments,
               capture_output=True, text=True, **kwargs)


def wait_pg(socket, port):
    for attempt in range(100):
        if subprocess.run([str(DBBIN/'pg_isready'), '-h', str(socket), '-p', str(port)],
                          capture_output=True).returncode == 0:
            return
        time.sleep(.1)
    raise AssertionError('Private synthetic PostgreSQL did not become ready')


def table_snapshot(env):
    import psycopg2
    from psycopg2 import sql
    result = {'tables': {}, 'sequences': {}}
    with psycopg2.connect(dbname=env['TT_DB_NAME'], user=env['TT_DB_USER'],
                          password=env['TT_DB_PASSWORD'], host=env['TT_DB_HOST'],
                          port=env['TT_DB_PORT']) as db, db.cursor() as c:
        c.execute('SHOW listen_addresses'); require(c.fetchone()[0] == '', 'Unexpected TCP source')
        c.execute("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
        tables = [r[0] for r in c.fetchall()]
        for name in tables:
            c.execute(sql.SQL('SELECT row_to_json(t)::text FROM public.{} t ORDER BY row_to_json(t)::text').format(sql.Identifier(name)))
            digest = hashlib.sha256(); count = 0
            for row in c:
                digest.update(row[0].encode() + b'\n'); count += 1
            result['tables'][name] = {'rows': count, 'sha256': digest.hexdigest()}
        c.execute("SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")
        for name, in c.fetchall():
            c.execute(sql.SQL('SELECT last_value, is_called FROM public.{}').format(sql.Identifier(name)))
            result['sequences'][name] = list(c.fetchone())
    return result


def restore_snapshot(socket, port):
    # Peer admin observes the new cluster only; JSON contains hashes/counts, no rows.
    code = """import json,hashlib,psycopg2
from psycopg2 import sql
out={'tables':{},'sequences':{}}
with psycopg2.connect(dbname='tt_restore_staging',user='tt-staging-db',host=SOCKET,port=PORT) as db,db.cursor() as c:
 c.execute('SHOW data_directory');assert c.fetchone()[0]==DATA
 c.execute('SHOW listen_addresses');assert c.fetchone()[0]==''
 c.execute("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
 for name, in c.fetchall():
  c.execute(sql.SQL('SELECT row_to_json(t)::text FROM public.{} t ORDER BY row_to_json(t)::text').format(sql.Identifier(name)))
  h=hashlib.sha256();n=0
  for row in c:h.update(row[0].encode()+b'\\n');n+=1
  out['tables'][name]={'rows':n,'sha256':h.hexdigest()}
 c.execute("SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")
 for name, in c.fetchall():
  c.execute(sql.SQL('SELECT last_value,is_called FROM public.{}').format(sql.Identifier(name)));out['sequences'][name]=list(c.fetchone())
print(json.dumps(out))
""".replace('SOCKET', repr(str(socket))).replace('PORT', repr(port)).replace('DATA', repr(str(RECOVERY/'database')))
    # Use system Python with installed validation dependency path, never credentials in argv.
    revision = json.loads((STATE/'identity.json').read_text())['revision']
    site = str(ROOT/'venvs'/revision/'lib/python3.12/site-packages')
    result = run('runuser', '-u', 'tt-staging-db', '--', '/usr/bin/python3.12', '-c',
                 "import sys;sys.path.insert(0," + repr(site) + ");" + code,
                 capture_output=True, text=True)
    return json.loads(result.stdout)


def exercise(nonce):
    guard(nonce); os.umask(0o077); checks = []; target_started = False
    require(not RECOVERY.exists() and not RECOVERY.is_symlink(), 'New recovery directory required; no overlay/reset')
    identity = json.loads((STATE/'identity.json').read_text())
    require(identity['synthetic_only'] is True and identity['database'] == 'tt_service_staging', 'Synthetic service source required')
    source = Path(identity['source'])
    require(source == ROOT/'releases'/identity['revision'] and not source.is_symlink(), 'Pinned service source required')
    sys.path.insert(0, str(source/'scripts/deployment'))
    import release_bundle
    release_bundle.verify_directory(source, identity['revision'])
    sys.path.insert(0, str(ROOT/'venvs'/identity['revision']/'lib/python3.12/site-packages'))
    require((ROOT/'maintenance.flag').is_file(), 'Maintenance must already be closed')
    run('systemctl', 'start', 'tt-staging-close.service')
    run('systemctl', 'stop', 'tt-staging-app.service', 'tt-staging-proxy.service')
    record(checks, 'source_app_proxy_stopped_and_maintenance_closed', all(
        subprocess.run(['systemctl', 'is-active', '--quiet', s]).returncode != 0
        for s in ['tt-staging-app', 'tt-staging-proxy']) and (ROOT/'maintenance.flag').exists())
    mkdir(RECOVERY); mkdir(RECOVERY/'backup', 0o700, group='root')
    mkdir(RECOVERY/'backup/media', 0o700, group='root')
    mkdir(RECOVERY/'database', 0o700, user='tt-staging-db', group='tt-staging-db')
    mkdir(RECOVERY/'run-db', 0o750, user='tt-staging-db')
    socket = RECOVERY/'run-db'; port = 55443; backup = RECOVERY/'backup'
    try:
        run('systemctl', 'start', 'tt-staging-db.service'); wait_pg(ROOT/'run/db', 55441)
        env = config_env(STATE/'migration.env')
        require(env['TT_DB_NAME'] == 'tt_service_staging' and env['TT_DB_HOST'] == str(ROOT/'run/db') and
                env['TT_DB_PORT'] == '55441', 'Fixed synthetic source connection required')
        data_directory = admin(ROOT/'run/db', 55441, 'tt_service_staging', '-At', '-c', 'SHOW data_directory').stdout.strip()
        record(checks, 'source_cluster_identity_checked_with_peer_admin', data_directory == str(ROOT/'database'))
        observed = admin(ROOT/'run/db', 55441, 'tt_service_staging', '-At', '-c',
                         'SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()').stdout.strip()
        record(checks, 'source_has_no_other_database_connections', observed == '0')
        start = utc(); before = table_snapshot(env)
        code = """import django;django.setup()
import json
from django.apps import apps
from django.db.models import FileField
from django.contrib.auth.models import User
from core.models import Asset
assert not User.objects.exclude(username__startswith='vm-service-admin').exists()
assert not Asset.objects.exclude(sku__startswith='VM-SERVICE').exists()
refs=[]
for model in apps.get_models():
 for field in model._meta.fields:
  if isinstance(field,FileField):
   for pk,name in model.objects.values_list('pk',field.name):
    if name:refs.append({'model':model._meta.label_lower,'pk':str(pk),'field':field.name,'path':name})
print(json.dumps(refs))
"""
        refs = json.loads(django_code(source, code, STATE/'migration.env').stdout)
        record(checks, 'all_registered_file_fields_enumerated_from_synthetic_database', len(refs) > 0)
        # All private media, including unused historical files; never delete orphans.
        for directory, folders, files in os.walk(ROOT/'private-media', followlinks=False):
            require(not Path(directory).is_symlink(), 'Source media directory symlink refused')
            for name in folders:
                require(not (Path(directory)/name).is_symlink(), 'Source media directory symlink refused')
            dest = backup/'media'/Path(directory).relative_to(ROOT/'private-media')
            dest.mkdir(parents=True, exist_ok=True, mode=0o700); dest.chmod(0o700)
            for name in files:
                p = Path(directory)/name
                require(p.is_file() and not p.is_symlink() and p.stat().st_nlink == 1, 'Only regular synthetic source media')
                shutil.copyfile(p, dest/name); (dest/name).chmod(0o600)
        dump = run('runuser', '-u', 'tt-staging-db', '--', DBBIN/'pg_dump', '-h', ROOT/'run/db',
                   '-p', '55441', '-d', 'tt_service_staging', '--format=custom', '--no-privileges', capture_output=True)
        require(not dump.stderr.strip(), 'Review synthetic pg_dump warnings before proceeding')
        (backup/'database.dump').write_bytes(dump.stdout); (backup/'database.dump').chmod(0o600)
        capture = {'snapshot_id': str(uuid.uuid4()), 'source_instance': env['TT_INSTANCE_ID'],
                   'database': env['TT_DB_NAME'], 'source_code_revision': identity['revision'],
                   'schema_leaf': '0066_credential_attempt', 'capture_started_utc': start,
                   'capture_completed_utc': utc(), 'writers_quiesced': True, 'synthetic_only': True}
        manifest = backup_media.describe(backup, capture, refs)
        raw = backup_media.encoded(manifest); write(backup/'manifest.json', raw.decode(), 0o600)
        trusted = hashlib.sha256(raw).hexdigest(); integrity = backup_media.verify(backup, trusted)
        record(checks, 'paired_database_and_all_media_manifest_verified', integrity['integrity_verified'])
        write(RECOVERY/'source-snapshot.json', json.dumps(before, sort_keys=True), 0o600)
        run('runuser', '-u', 'tt-staging-db', '--', DBBIN/'initdb', '-D', RECOVERY/'database',
            '--auth-local=peer', '--auth-host=scram-sha-256', capture_output=True)
        with (RECOVERY/'database/postgresql.conf').open('a') as out:
            out.write("\nlisten_addresses=''\nport=55443\nunix_socket_directories='" + str(socket) + "'\nunix_socket_permissions=0770\n")
        (RECOVERY/'database/pg_hba.conf').write_text('local all tt-staging-db peer\nlocal all all scram-sha-256\n')
        run('runuser', '-u', 'tt-staging-db', '--', DBBIN/'pg_ctl', '-D', RECOVERY/'database',
            '-l', RECOVERY/'database/server.log', '-w', 'start', capture_output=True); target_started = True
        admin(socket, port, 'postgres', input='CREATE DATABASE tt_restore_staging;')
        # stdin carries private dump bytes; no --clean/--create, no source mutations.
        run('runuser', '-u', 'tt-staging-db', '--', DBBIN/'pg_restore', '-h', socket,
            '-p', str(port), '-d', 'tt_restore_staging', '--no-owner', '--no-privileges',
            '--exit-on-error', '--single-transaction', input=dump.stdout, capture_output=True)
        restored = restore_snapshot(socket, port)
        record(checks, 'all_restored_table_counts_and_content_hashes_equal_source', restored['tables'] == before['tables'])
        record(checks, 'all_restored_sequence_values_equal_source', restored['sequences'] == before['sequences'])
        shutil.copytree(backup/'media', RECOVERY/'restored-media')
        for directory, folders, files in os.walk(RECOVERY/'restored-media'):
            Path(directory).chmod(0o700)
            for name in files: (Path(directory)/name).chmod(0o600)
        # Inventory restored bytes in a separate private verification layout.
        restored_layout = RECOVERY/'restored-layout'; restored_layout.mkdir(mode=0o700)
        (RECOVERY/'restored-media').rename(restored_layout/'media')
        record(checks, 'all_restored_media_bytes_match_full_backup_inventory',
               backup_media.media_inventory(restored_layout) == manifest['media_files'])
        password = secrets.token_urlsafe(36)
        admin(socket, port, 'tt_restore_staging', input="CREATE ROLE tt_restore_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '"+password+"'; GRANT CONNECT ON DATABASE tt_restore_staging TO tt_restore_app; GRANT USAGE ON SCHEMA public TO tt_restore_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO tt_restore_app; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO tt_restore_app;")
        target_env = {**config_env('/etc/techtrolley-staging/runtime.env'), 'TT_DB_NAME': 'tt_restore_staging',
                      'TT_DB_USER': 'tt_restore_app', 'TT_DB_PASSWORD': password, 'TT_DB_HOST': str(socket),
                      'TT_DB_PORT': str(port), 'TT_MEDIA_ROOT': str(restored_layout/'media'),
                      'TT_INSTANCE_ID': 'local-synthetic-media-restore-8b9'}
        envfile = RECOVERY/'restore.env'; write(envfile, ''.join(k+'='+v+'\n' for k,v in target_env.items()), 0o600)
        smoke = """import django;django.setup()
import json
from pathlib import Path
from django.db import connection
from django.db.migrations.loader import MigrationLoader
from rest_framework.test import APIClient
from core.models import MovementReceipt
loader=MigrationLoader(connection);loader.check_consistent_history(connection)
assert set(loader.applied_migrations)==set(loader.graph.nodes)
with connection.cursor() as c:
 c.execute('SELECT current_database()');assert c.fetchone()[0]=='tt_restore_staging'
 c.execute('SHOW listen_addresses');assert c.fetchone()[0]==''
 c.execute("SELECT has_schema_privilege(current_user,'public','CREATE'),rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user");assert c.fetchone()==(False,False,False,False)
state=json.loads(Path('/var/lib/tt-service-checks/api-state.json').read_text());fixture=json.loads(Path('/var/lib/tt-service-checks/fixture.json').read_text())
client=APIClient();kwargs={'secure':True,'HTTP_HOST':'staging.example.test:24443'}
path=f"/api/conferences/{fixture['event_id']}/download-pdf/"
assert client.get(path,**kwargs).status_code in {401,403}
client.credentials(HTTP_AUTHORIZATION='Token '+state['token'])
pdf=client.get(path,**kwargs);assert pdf.status_code==200 and 'no-store' in pdf['Cache-Control']
assert b''.join(pdf.streaming_content).startswith(b'%PDF')
doc=client.get(f"/api/conferences/{fixture['event_id']}/challan-documents/master/",**kwargs)
assert doc.status_code==200 and doc.json()['document']==state['document']
replay=client.post(f"/api/conferences/{fixture['event_id']}/asset-commands/",state['command'],format='json',**kwargs)
assert replay.status_code==200 and replay.json()['replayed'] is True
assert MovementReceipt.objects.filter(actor_id=fixture['actor_id'],request_id=state['command']['request_id']).count()==1
print(json.dumps({'checks':['restored_complete_schema_and_fixed_private_target','restored_runtime_denied_ddl_and_role_privileges','restored_pdf_anonymous_denied','restored_pdf_authenticated_bytes_and_private_cache','restored_manual_challan_exact','restored_original_scan_uuid_replays_once']}))
"""
        outcome = json.loads(django_code(source, smoke, envfile).stdout); checks.extend(outcome['checks'])
        record(checks, 'original_source_database_tables_sequences_unchanged', table_snapshot(env) == before)
        record(checks, 'backup_bytes_unchanged_after_restore_and_smoke', backup_media.verify(backup, trusted) == integrity)
        release_bundle.verify_directory(source, identity['revision'])
        record(checks, 'original_verified_package_unchanged', True)
        result = {'passed': len(checks), 'checks': checks, 'synthetic_only': True, 'business_data_used': False,
                  'source_service_revision': identity['revision'], 'manifest_sha256': trusted,
                  'source_tables': len(before['tables']), 'source_sequences': len(before['sequences']),
                  'media_files': integrity['media_files'], 'referenced_files': integrity['referenced_files'],
                  'unreferenced_files': integrity['unreferenced_files'], 'real_business_recovery_certified': False,
                  'http_proxy_or_phone_test': False, 'duration_seconds': None}
    finally:
        if target_started:
            run('runuser', '-u', 'tt-staging-db', '--', DBBIN/'pg_ctl', '-D', RECOVERY/'database', '-m', 'fast', '-w', 'stop', capture_output=True)
        run('systemctl', 'stop', 'tt-staging-db.service')
        require((ROOT/'maintenance.flag').exists(), 'Maintenance must remain closed')
    record(checks, 'both_private_source_and_restore_clusters_stopped',
           subprocess.run(['systemctl', 'is-active', '--quiet', 'tt-staging-db']).returncode != 0 and
           subprocess.run(['runuser', '-u', 'tt-staging-db', '--', str(DBBIN/'pg_ctl'), '-D', str(RECOVERY/'database'), 'status'], capture_output=True).returncode == 3)
    result['passed'] = len(checks); result['all_test_clusters_stopped'] = True
    write(RECOVERY/'results.json', json.dumps(result, indent=2)+'\n', 0o600)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('--vm-nonce', required=True)
    args = parser.parse_args(); start = time.monotonic(); result = exercise(args.vm_nonce)
    result['duration_seconds'] = round(time.monotonic()-start, 3)
    write(RECOVERY/'results.json', json.dumps(result, indent=2)+'\n', 0o600)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
