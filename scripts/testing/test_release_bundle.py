"""Real clean Git fixtures and hostile archives; no project commit or DB access."""
import gzip
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'deployment'))
import release_bundle as bundle


def fixture_build(export, log):
    dist = export/'frontend/dist'
    dist.mkdir()
    (dist/'index.html').write_text('fresh fixture build')
    (dist/'sw.js').write_text('fixture worker')
    (dist/'assets').mkdir()
    (dist/'assets/bundle-fixture0001.js').write_text('fixture chunk')
    return {'fixture_only': True, 'fresh_export': True}


def git(root, *args):
    env = {'PATH': os.environ.get('PATH', os.defpath), 'GIT_CONFIG_NOSYSTEM': '1',
           'GIT_CONFIG_GLOBAL': '/dev/null'}
    return subprocess.check_output(['git', '-C', str(root), *args], env=env, stderr=subprocess.DEVNULL).decode().strip()


def commit(root):
    git(root, 'add', '.')
    git(root, '-c', 'user.name=Synthetic fixture', '-c', 'user.email=fixture@example.test',
        '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Synthetic release fixture only')
    return git(root, 'rev-parse', 'HEAD')



def make_checkout(root):
    root.mkdir(mode=0o700)
    for name in bundle.REQUIRED:
        p = root/name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text('synthetic fixture source\n')
    (root/'backend/core/migrations/0001_initial.py').write_text('class Migration:\n dependencies=[]\n')
    (root/'backend/core/migrations/0066_target.py').write_text("class Migration:\n dependencies=[('core','0001_initial')]\n")
    (root/'.gitignore').write_text('frontend/dist/\n.env\n*.pem\n')
    git(root, 'init', '-q', '--object-format=sha1')
    return commit(root)


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='tt-bundle-tests-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.root = self.base/'checkout'
        self.revision = make_checkout(self.root)
        self.archive = self.base/'review.tar.gz'

    def build(self, builder=fixture_build):
        return bundle.assemble(self.root, self.revision, self.archive, builder=builder)

    def unpack(self):
        result = self.build()
        manifest, files = bundle.verify(self.archive, result['archive_sha256'], self.revision)
        return result, manifest, files

    def rewrite(self, change):
        self.build()
        with tarfile.open(self.archive, 'r:gz') as tar:
            members = [(m, tar.extractfile(m).read()) for m in tar]
        change(members)
        out = self.base/'changed.tar.gz'
        with tarfile.open(out, 'w:gz', format=tarfile.USTAR_FORMAT) as tar:
            for member, content in members:
                member.size = len(content)
                tar.addfile(member, io.BytesIO(content))
        return out

    def reject_archive(self, change, expected=None):
        out = self.rewrite(change)
        with self.assertRaises((ValueError, tarfile.TarError)):
            bundle.verify(out, expected or bundle.sha(out.read_bytes()), self.revision)

    def test_complete_bundle_roundtrip_and_private_modes(self):
        result, manifest, files = self.unpack()
        self.assertEqual(manifest['schema']['leaf'], '0066_target')
        self.assertFalse(manifest['deployment_enabled'])
        target = self.base/'incoming'
        bundle.extract(self.archive, result['archive_sha256'], self.revision, target)
        self.assertEqual((target/'frontend/dist/index.html').read_text(), 'fresh fixture build')
        self.assertEqual(self.archive.stat().st_mode & 0o777, 0o600)
        self.assertEqual(target.stat().st_mode & 0o777, 0o700)
        self.assertEqual(set(files), set(manifest['files']))

    def test_stale_ignored_dist_and_private_files_never_copied(self):
        p = self.root/'frontend/dist';p.mkdir();(p/'index.html').write_text('STALE')
        (self.root/'.env').write_text('PRIVATE_IGNORE_MARKER')
        (self.root/'key.pem').write_text('PRIVATE_IGNORE_MARKER')
        _, _, files = self.unpack()
        self.assertEqual(files['frontend/dist/index.html'], b'fresh fixture build')
        self.assertFalse(any(b'PRIVATE_IGNORE_MARKER' in data for data in files.values()))

    def test_dirty_checkout_refused(self):
        (self.root/'backend/core/models.py').write_text('changed')
        with self.assertRaisesRegex(ValueError, 'clean committed'):
            self.build()
        self.assertFalse(self.archive.exists())

    def test_untracked_source_refused(self):
        (self.root/'backend/core/new.py').write_text('new')
        with self.assertRaises(ValueError):self.build()

    def test_short_or_wrong_revision_refused(self):
        for revision in ['main', self.revision[:7], 'f'*40]:
            with self.assertRaises(ValueError):bundle.assemble(self.root, revision, self.archive, builder=fixture_build)

    def test_source_content_checked_even_with_assume_unchanged(self):
        git(self.root, 'update-index', '--assume-unchanged', 'backend/core/models.py')
        (self.root/'backend/core/models.py').write_text('hidden edit')
        with self.assertRaisesRegex(ValueError, 'committed blob'):self.build()

    def test_tracked_private_or_generated_file_refused(self):
        (self.root/'backend/db.sqlite3').write_text('fake database marker')
        self.revision = commit(self.root)
        with self.assertRaisesRegex(ValueError, 'private/generated'):self.build()

    def test_tracked_symlink_refused(self):
        (self.root/'backend/core/link.py').symlink_to('models.py')
        self.revision = commit(self.root)
        with self.assertRaisesRegex(ValueError, 'Symlink/submodule'):self.build()

    def test_missing_required_backend_file_refused(self):
        (self.root/'backend/config/wsgi.py').unlink();self.revision=commit(self.root)
        with self.assertRaisesRegex(ValueError, 'Complete backend'):self.build()

    def test_new_commit_during_build_refused(self):
        def changing(export, log):
            (self.root/'backend/core/models.py').write_text('new version')
            commit(self.root)
            return fixture_build(export, log)
        with self.assertRaises(ValueError):self.build(changing)
        self.assertFalse(self.archive.exists())

    def test_build_mutating_exported_lock_refused(self):
        def changing(export, log):
            (export/'frontend/package-lock.json').write_text('changed')
            return fixture_build(export, log)
        with self.assertRaisesRegex(ValueError, 'changed source/lock'):self.build(changing)

    def test_failed_build_retains_private_log_not_bundle(self):
        def failing(export, log):
            log.write(b'synthetic build failure');log.flush();raise RuntimeError('synthetic')
        with self.assertRaisesRegex(ValueError, 'Fresh build failed'):self.build(failing)
        self.assertFalse(self.archive.exists())
        self.assertEqual((self.base/'review.tar.gz.failed-build.log').stat().st_mode&0o777,0o600)

    def test_existing_output_never_overwritten(self):
        self.archive.write_bytes(b'KEEP')
        with self.assertRaises(ValueError):self.build()
        self.assertEqual(self.archive.read_bytes(),b'KEEP')

    def test_output_inside_checkout_or_nonprivate_parent_refused(self):
        with self.assertRaises(ValueError):bundle.assemble(self.root,self.revision,self.root/'bundle.tar.gz',builder=fixture_build)
        self.base.chmod(0o755)
        with self.assertRaises(ValueError):self.build()

    def test_archive_hash_and_revision_required(self):
        result, _, _=self.unpack()
        for digest,revision in [('0'*64,self.revision),(result['archive_sha256'],'e'*40),('bad',self.revision)]:
            with self.assertRaises(ValueError):bundle.verify(self.archive,digest,revision)

    def test_tampered_payload_hash_refused(self):
        self.reject_archive(lambda m:m.__setitem__(1,(m[1][0],b'changed')))

    def test_parent_path_refused_before_extraction(self):
        out=self.rewrite(lambda m:setattr(m[1][0],'name','../outside.py'))
        dest=self.base/'incoming'
        with self.assertRaises(ValueError):bundle.extract(out,bundle.sha(out.read_bytes()),self.revision,dest)
        self.assertFalse(dest.exists());self.assertFalse((self.base/'outside.py').exists())

    def test_absolute_backslash_and_control_paths_refused(self):
        for name in ['/absolute.py','backend\\escape.py','backend/../outside.py','backend/line\n.py']:
            with self.assertRaises(ValueError):bundle.safe_name(name)

    def test_link_member_refused(self):
        def change(m):m[1][0].type=tarfile.SYMTYPE;m[1][0].linkname='/outside'
        self.reject_archive(change)

    def test_duplicate_and_case_colliding_members_refused(self):
        def change(m):
            extra=tarfile.TarInfo(m[1][0].name.upper());extra.mode=0o600;m.append((extra,b'collision'))
        self.reject_archive(change)

    def test_private_member_and_source_maps_refused(self):
        def change(m):m[1][0].name='frontend/dist/secrets.json'
        self.reject_archive(change)
        with self.assertRaises(ValueError):bundle.role('frontend/dist/code.js.map')
        with self.assertRaises(ValueError):bundle.role('frontend/dist/.private.html')
        self.assertFalse(bundle.source_allowed('frontend/public/.private.txt'))

    def test_local_style_sources_and_font_outputs_are_bounded(self):
        for name in ('frontend/tailwind.config.cjs', 'frontend/postcss.config.cjs'):
            self.assertTrue(bundle.source_allowed(name))
        self.assertFalse(bundle.source_allowed('frontend/arbitrary.cjs'))
        self.assertEqual(bundle.role('frontend/dist/assets/fa-solid-900-fixture0001.ttf'), 'frontend-build')
        with self.assertRaises(ValueError):bundle.role('frontend/dist/assets/unhashed.ttf')
        with self.assertRaises(ValueError):bundle.role('frontend/dist/assets/.private.ttf')
        files = {'frontend/package.json': b'{"devDependencies":{"tailwindcss":"3.4.17"}}'}
        with self.assertRaisesRegex(ValueError, 'Build-time styling'):bundle.require_style_sources(files)
        files.update({name: b'fixture' for name in ('frontend/index.css', 'frontend/tailwind.config.cjs', 'frontend/postcss.config.cjs')})
        bundle.require_style_sources(files)
        bundle.require_style_sources({'frontend/package.json': b'{"dependencies":{}}'})

    def test_unexpected_permissions_refused(self):
        self.reject_archive(lambda m:setattr(m[1][0],'mode',0o777))

    def test_expansion_and_file_count_limits(self):
        result=self.build()
        with patch.object(bundle,'MAX_TOTAL',1):
            with self.assertRaises(ValueError):bundle.verify(self.archive,result['archive_sha256'],self.revision)
        with patch.object(bundle,'MAX_FILES',1):
            with self.assertRaises(ValueError):bundle.verify(self.archive,result['archive_sha256'],self.revision)

    def test_gzip_stream_bound_before_tar_metadata(self):
        out=self.base/'bomb.tar.gz';out.write_bytes(gzip.compress(b'x'*50000))
        with patch.object(bundle,'MAX_TOTAL',1),patch.object(bundle,'MAX_FILES',1):
            with self.assertRaisesRegex(ValueError,'Expanded tar stream'):bundle.verify(out,bundle.sha(out.read_bytes()),self.revision)

    def test_duplicate_json_key_refused(self):
        with self.assertRaisesRegex(ValueError,'Duplicate JSON'):bundle.strict_json(b'{"revision":1,"revision":2}')

    def test_unlisted_file_after_extraction_refused(self):
        result=self.build();dest=self.base/'incoming';bundle.extract(self.archive,result['archive_sha256'],self.revision,dest)
        (dest/'unexpected.json').write_text('{}')
        with self.assertRaises(ValueError):bundle.verify_directory(dest,self.revision)

    def test_migration_missing_parent_cycle_and_multiple_leaves_refused(self):
        for files in [
          {'backend/core/migrations/0001_a.py':b"class Migration:\n dependencies=[('core','missing')]"},
          {'backend/core/migrations/0001_a.py':b"class Migration:\n dependencies=[('core','0001_a')]"},
          {'backend/core/migrations/0001_a.py':b'class Migration:\n dependencies=[]','backend/core/migrations/0002_b.py':b'class Migration:\n dependencies=[]'}]:
            with self.assertRaises(ValueError):bundle.migration_inventory(files)


if __name__=='__main__':unittest.main(verbosity=2)
