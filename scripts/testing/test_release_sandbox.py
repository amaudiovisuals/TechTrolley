"""Fault/concurrency guards for rehearsal pointers; no database is selected here."""
import copy
import fcntl
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'deployment'))
import release_bundle as bundle
import release_sandbox as sandbox
from test_release_bundle import make_checkout, fixture_build


class SiteTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='tt-pg-');self.addCleanup(self.temp.cleanup)
        self.base=Path(self.temp.name).resolve()
        for name in ['socket','data']:(self.base/name).mkdir(mode=0o700)
        control=self.base/'control.json';control.write_text(json.dumps({'protocol':'techtrolley-private-postgres-1','nonce':'synthetic-nonce'}));control.chmod(0o600)
        self.value={'database':'tt_validation','socket':str(self.base/'socket'),'data_directory':str(self.base/'data'),
                    'listen_addresses':'','cluster_nonce':'synthetic-nonce','core_migrations':['0001_initial'],
                    'other_connections':0,'unknown_migrations':[],'runtime_migrations_pending':1}
        root=self.base/'checkout';self.revision=make_checkout(root)
        archive=self.base/'review.tar.gz';result=bundle.assemble(root,self.revision,archive,builder=fixture_build)
        self.artifact=self.base/'incoming';bundle.extract(archive,result['archive_sha256'],self.revision,self.artifact)
        self.site=sandbox.RehearsalSite(self.base,self.observe);self.site.initialize(self.artifact)
        self.dump=self.base/'synthetic-before.dump';self.dump.write_bytes(b'synthetic-only-dump');self.dump.chmod(0o600)

    def observe(self):return copy.deepcopy(self.value)
    def target(self):
        self.value['core_migrations']=['0001_initial','0066_target'];self.value['runtime_migrations_pending']=0
    def healthy(self):return {'healthy':True,'revision':self.revision,'migration_set_digest':bundle.digest_map(sorted(self.value['core_migrations']))}
    def ready(self):self.site.begin(self.dump);self.target();self.site.schema_ready()

    def test_successful_publish_points_to_complete_verified_release(self):
        self.ready();self.site.publish(self.healthy);state=self.site.load()
        self.assertEqual(state['phase'],'active');self.assertFalse(state['maintenance'])
        self.assertEqual((self.site.root/'current/backend/core/models.py').read_bytes(),(self.artifact/'backend/core/models.py').read_bytes())

    def test_before_schema_failure_can_abort_without_restoring_data(self):
        self.site.begin(self.dump);self.site.abort_before_schema()
        self.assertEqual(os.readlink(self.site.root/'current'),'releases/legacy-stub')
        self.assertFalse(self.site.load()['maintenance']);self.assertFalse(self.site.load()['automatic_restore'])

    def test_abort_after_schema_change_refused_and_maintenance_retained(self):
        self.site.begin(self.dump);self.target()
        with self.assertRaises(ValueError):self.site.abort_before_schema()
        self.assertTrue(self.site.load()['maintenance'])

    def test_partial_target_schema_refused(self):
        self.site.begin(self.dump)
        with self.assertRaises(ValueError):self.site.schema_ready()
        self.assertTrue(self.site.load()['maintenance'])

    def test_unknown_framework_migration_refused(self):
        self.value['unknown_migrations']=[['auth','9999_unrecognized']]
        with self.assertRaises(ValueError):self.site.begin(self.dump)
        self.assertEqual(self.site.load()['phase'],'idle')

    def test_pending_framework_migrations_refuse_schema_ready(self):
        self.site.begin(self.dump);self.target();self.value['runtime_migrations_pending']=1
        with self.assertRaises(ValueError):self.site.schema_ready()
        self.assertTrue(self.site.load()['maintenance'])

    def test_old_code_rollback_after_upgrade_refused(self):
        self.ready()
        with self.assertRaisesRegex(ValueError,'rollback refused'):self.site.restore_previous()
        self.assertTrue(self.site.load()['maintenance'])

    def test_stub_is_never_treated_as_validated_rollback_release(self):
        with self.assertRaisesRegex(ValueError,'synthetic stub'):self.site.restore_previous()

    def test_failed_health_keeps_candidate_pointer_and_maintenance(self):
        self.ready()
        with self.assertRaisesRegex(ValueError,'Health check failed'):self.site.publish(lambda:{'healthy':False})
        self.assertTrue(self.site.load()['maintenance']);self.assertEqual(self.site.load()['phase'],'recovery-required')
        self.assertEqual(os.readlink(self.site.root/'current'),'releases/'+self.revision)

    def test_health_exception_keeps_maintenance(self):
        self.ready()
        def fail():raise RuntimeError('injected health exception')
        with self.assertRaises(RuntimeError):self.site.publish(fail)
        self.assertTrue(self.site.load()['maintenance'])

    def test_wrong_revision_health_refused(self):
        self.ready()
        with self.assertRaises(ValueError):self.site.publish(lambda:{**self.healthy(),'revision':'f'*40})
        self.assertTrue(self.site.load()['maintenance'])

    def test_crash_after_pointer_before_journal_can_recover_forward(self):
        self.ready();original=sandbox.atomic_json
        def crash(path,value):
            if value.get('phase')=='recovery-required':raise RuntimeError('injected crash')
            original(path,value)
        with patch.object(sandbox,'atomic_json',side_effect=crash):
            with self.assertRaises(RuntimeError):self.site.publish(self.healthy)
        reopened=sandbox.RehearsalSite(self.base,self.observe)
        self.assertTrue(reopened.load()['maintenance']);reopened.publish(self.healthy)
        self.assertEqual(reopened.load()['phase'],'active')

    def test_restart_after_health_failure_requires_explicit_forward_retry(self):
        self.ready()
        with self.assertRaises(ValueError):self.site.publish(lambda:{})
        reopened=sandbox.RehearsalSite(self.base,self.observe)
        self.assertTrue(reopened.load()['maintenance']);reopened.publish(self.healthy)
        self.assertFalse(reopened.load()['maintenance'])

    def test_active_release_recovery_never_changes_schema_observation(self):
        self.ready();self.site.publish(self.healthy);before=copy.deepcopy(self.value)
        self.site.enter_recovery();self.site.publish(self.healthy)
        self.assertEqual(self.value,before)

    def test_schema_change_during_health_cannot_open_maintenance(self):
        self.ready()
        def changing():
            result=self.healthy();self.value['core_migrations'].append('9999_changed');return result
        with self.assertRaises(ValueError):self.site.publish(changing)
        self.assertTrue(self.site.load()['maintenance'])

    def test_tampered_staged_backend_refused_before_pointer_switch(self):
        self.ready();(self.site.root/'releases'/self.revision/'backend/core/models.py').write_text('tampered')
        with self.assertRaises(ValueError):self.site.publish(self.healthy)
        self.assertEqual(os.readlink(self.site.root/'current'),'releases/legacy-stub')

    def test_old_hashed_assets_survive_pointer_changes_and_recovery(self):
        old=self.site.root/'asset-store/assets/old-abcdefgh.js';old.write_bytes(b'old tab chunk')
        self.ready();self.site.publish(self.healthy);self.site.enter_recovery();self.site.publish(self.healthy)
        self.assertEqual(old.read_bytes(),b'old tab chunk')
        self.assertEqual((self.site.root/'asset-store/assets/bundle-fixture0001.js').read_bytes(),b'fixture chunk')

    def test_immutable_asset_collision_blocks_publish(self):
        self.ready();asset=self.site.root/'asset-store/assets/bundle-fixture0001.js';asset.write_bytes(b'collision')
        with self.assertRaisesRegex(ValueError,'asset-name collision'):self.site.publish(self.healthy)
        self.assertEqual(os.readlink(self.site.root/'current'),'releases/legacy-stub')
        self.assertTrue(self.site.load()['maintenance'])

    def test_extra_connection_blocks_begin_and_publish(self):
        self.value['other_connections']=1
        with self.assertRaises(ValueError):self.site.begin(self.dump)
        self.value['other_connections']=0;self.ready();self.value['other_connections']=1
        with self.assertRaises(ValueError):self.site.publish(self.healthy)
        self.assertTrue(self.site.load()['maintenance'])

    def test_wrong_database_socket_cluster_or_tcp_refused(self):
        for name,value in [('database','techtrolley_prod'),('socket','127.0.0.1'),('data_directory','/tmp/other'),('cluster_nonce','wrong'),('listen_addresses','localhost')]:
            original=self.value[name];self.value[name]=value
            with self.assertRaises(ValueError):self.site.begin(self.dump)
            self.value[name]=original

    def test_nonprivate_cluster_and_unrelated_path_refused(self):
        self.base.chmod(0o755)
        with self.assertRaises(ValueError):sandbox.RehearsalSite(self.base,self.observe)
        with tempfile.TemporaryDirectory(prefix='unrelated-') as folder:
            with self.assertRaises(ValueError):sandbox.RehearsalSite(folder,self.observe)

    def test_missing_or_public_backup_refused(self):
        with self.assertRaises(ValueError):self.site.begin(self.base/'other.dump')
        self.dump.chmod(0o644)
        with self.assertRaises(ValueError):self.site.begin(self.dump)

    def test_double_begin_or_double_accept_refused(self):
        self.site.begin(self.dump)
        with self.assertRaises(ValueError):self.site.begin(self.dump)
        self.target();self.site.schema_ready();self.site.publish(self.healthy)
        with self.assertRaises(ValueError):self.site.publish(self.healthy)

    def test_concurrent_operator_lock_blocks_second_action(self):
        path=self.site.root/'operation.lock'
        with path.open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):self.site.begin(self.dump)
        self.assertEqual(self.site.load()['phase'],'idle')

    def test_external_pointer_or_replaced_instance_refused(self):
        current=self.site.root/'current';current.unlink();current.symlink_to('/tmp')
        with self.assertRaises(ValueError):self.site.begin(self.dump)
        current.unlink();current.symlink_to('releases/legacy-stub')
        marker=self.site.root/'instance.json';marker.write_text('{}')
        with self.assertRaises(ValueError):sandbox.RehearsalSite(self.base,self.observe)


if __name__=='__main__':unittest.main(verbosity=2)
