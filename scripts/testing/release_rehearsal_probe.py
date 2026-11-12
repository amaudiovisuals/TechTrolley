"""Fault injection on the PACKAGED backend and fresh private PostgreSQL only.

Loaded exclusively by run_postgres_tests.py --mode release, after verified bundle
extraction. Previous code is an explicit stub, not a claimed production rollback.
"""
import json
from pathlib import Path
import sys
import uuid


class ReleaseExercise:
    def __init__(self, artifact_root, base):
        self.root, self.base = Path(artifact_root), Path(base)
        sys.path.insert(0, str(self.root/'scripts/deployment'))
        from release_bundle import MANIFEST, strict_json
        from release_sandbox import RehearsalSite
        self.Site = RehearsalSite
        self.manifest = strict_json((self.root/MANIFEST).read_bytes())
        self.site = RehearsalSite(self.base, self.observe)
        self.checks = []

    def observe(self):
        from django.db import connection
        from django.db.migrations.loader import MigrationLoader
        loader = MigrationLoader(connection)
        loader.check_consistent_history(connection)
        known, applied = set(loader.graph.nodes), set(loader.applied_migrations)
        with connection.cursor() as cursor:
            cursor.execute('SHOW data_directory')
            data = str(Path(cursor.fetchone()[0]).resolve())
            cursor.execute('SHOW listen_addresses')
            listen = cursor.fetchone()[0]
            cursor.execute('SELECT current_database(), current_setting(%s)', ['application_name'])
            database, nonce = cursor.fetchone()
            cursor.execute('SELECT name FROM django_migrations WHERE app=%s ORDER BY name', ['core'])
            schema = [row[0] for row in cursor.fetchall()]
            cursor.execute('SELECT COUNT(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()')
            others = cursor.fetchone()[0]
        return {'database': database, 'socket': connection.settings_dict['HOST'],
                'data_directory': data, 'listen_addresses': listen, 'cluster_nonce': nonce,
                'core_migrations': schema, 'other_connections': others,
                'unknown_migrations': sorted(applied - known), 'runtime_migrations_pending': len(known - applied)}

    def before_upgrade(self, before_dump):
        state = self.site.initialize(self.root)
        old_asset = self.site.root/'asset-store/assets/previous-abcdefgh.js'
        old_asset.parent.mkdir(exist_ok=True, mode=0o700)
        old_asset.write_bytes(b'synthetic old-tab immutable chunk')
        assert state['before_core_migrations'][-1].startswith('0053_')
        self.checks.append('Verified complete artifact staged privately; baseline is actual0053 with explicit old-code stub')
        import psycopg2
        # An extra real connection must prevent beginning the operation.
        extra = psycopg2.connect(dbname='tt_validation', user='tt_test_owner',
                                 host=str(self.base/'socket'), port=55439, connect_timeout=3)
        try:
            try:
                self.site.begin(before_dump)
            except ValueError:
                pass
            else:
                raise AssertionError('Concurrent connection was not refused')
        finally:
            extra.close()
        self.checks.append('Actual second PostgreSQL connection blocks activation before maintenance/schema changes')
        self.site.begin(before_dump)
        assert self.site.load()['maintenance']
        self.site.abort_before_schema()
        assert not self.site.load()['maintenance']
        self.checks.append('Injected pre-migration failure aborts without pointer change or database restore')
        self.site.begin(before_dump)
        assert self.site.load()['maintenance']
        self.checks.append('Maintenance state persists before actual0053-to0066 migration')

    def health(self):
        from release_bundle import digest_map, verify_directory
        active = verify_directory(self.site.root/'current', self.manifest['revision'])
        observed = self.observe()
        return {'healthy': True, 'revision': active['revision'],
                'migration_set_digest': digest_map(sorted(observed['core_migrations']))}

    def after_upgrade(self):
        self.site = self.Site(self.base, self.observe)  # process restart boundary
        assert self.site.load()['maintenance']
        self.site.schema_ready()
        self.checks.append('Restart reloads maintenance; target schema is matched against all packaged migration names')
        try:
            self.site.restore_previous()
        except ValueError:
            pass
        else:
            raise AssertionError('Unsafe old-code/schema rollback accepted')
        assert self.site.load()['maintenance']
        self.checks.append('Rollback to0053 is refused after actual0066; no reverse migration or DB restore')
        try:
            self.site.publish(lambda: {'healthy': False})
        except ValueError:
            pass
        else:
            raise AssertionError('Unhealthy release opened maintenance')
        assert self.site.load()['phase'] == 'recovery-required' and self.site.load()['maintenance']
        self.checks.append('Injected post-pointer health failure leaves candidate pointer and maintenance/recovery journal')
        self.site = self.Site(self.base, self.observe)
        self.site.publish(self.health)
        assert self.site.load()['phase'] == 'active' and not self.site.load()['maintenance']
        self.checks.append('Restart and explicit forward retry accept verified candidate without rewinding database')
        assert (self.site.root/'asset-store/assets/previous-abcdefgh.js').read_bytes() == b'synthetic old-tab immutable chunk'
        self.checks.append('Previous hashed browser chunk remains available in immutable asset store after pointer activation')
        from django.contrib.auth.models import User
        from core.asset_commands import execute_command
        from core.models import Asset, Conference, MovementReceipt, PhysicalMovement
        actor = User.objects.create_user('synthetic-release-operator')
        actor.profile.role = 'admin'
        actor.profile.save()
        asset = Asset.objects.create(sku='RELEASE-PRESERVED-SCAN', quantity=1)
        event = Conference.objects.create(name='Synthetic release operation')
        command = {'request_id': str(uuid.uuid4()), 'action': 'stage', 'asset_ids': [asset.pk]}
        execute_command(actor, event.pk, command)
        def snapshot():
            asset.refresh_from_db()
            return json.dumps({'asset': {'id': asset.pk, 'sku': asset.sku, 'status': asset.status},
                               'event_staged': list(event.staged_assets.values_list('pk', flat=True)),
                               'receipts': list(MovementReceipt.objects.filter(actor=actor).values()),
                               'movements': list(PhysicalMovement.objects.filter(receipt__actor=actor).values())},
                              sort_keys=True, default=str)
        before = snapshot()
        self.site.enter_recovery()
        self.site = self.Site(self.base, self.observe)
        self.site.publish(self.health)
        assert snapshot() == before
        self.checks.append('A real atomic scan and its original IDs/receipt survive maintenance/restart/forward recovery byte-for-byte')
        result = execute_command(actor, event.pk, command)
        assert result['replayed'] and snapshot() == before
        assert MovementReceipt.objects.filter(actor=actor, request_id=command['request_id']).count() == 1
        self.checks.append('Original scan UUID retries as replay after recovery with one receipt and no extra movement')
        from rest_framework.test import APIClient
        client = APIClient()
        client.force_authenticate(actor)
        assert client.get('/api/assets/?all=true').status_code == 200
        self.checks.append('Packaged application authenticated inventory read works against recovered private database')
        return {'passed': len(self.checks), 'checks': self.checks, 'artifact_revision': self.manifest['revision'],
                'actual_packaged_backend': True, 'actual_postgresql': True, 'previous_code_is_stub': True,
                'production_service_switch_or_proxy_tested': False, 'business_database_used': False,
                'automatic_database_restore': False, 'automatic_reverse_migration': False,
                'post_release_scan_request_id': command['request_id'],
                'post_release_scan_receipts': 1, 'final_state': self.site.load()}
