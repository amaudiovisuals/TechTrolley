"""Reject changed dependency artifacts before release; no installs or DB access."""
import json
from pathlib import Path
import shutil
import tempfile
import unittest

import check_dependencies as guard


class DependencyGuards(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory(prefix='tt-dependency-guards-')
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        for name in ['backend/requirements.in', 'backend/requirements.lock', 'backend/requirements.txt',
                     'scripts/testing/runtime-check-requirements.in', 'scripts/testing/runtime-check-requirements.lock',
                     'frontend/package.json', 'frontend/package-lock.json', 'frontend/.npmrc',
                     'frontend/vendor/xlsx-0.20.3.tgz', 'frontend/vendor/sheetjs-provenance.json']:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(guard.ROOT / name, target)

    def change_json(self, name, change):
        path = self.root / name
        value = json.loads(path.read_text())
        change(value)
        path.write_text(json.dumps(value))

    def reject(self):
        with self.assertRaises(AssertionError):
            guard.check(self.root)

    def test_current_artifacts_verify_offline(self):
        result = guard.check(self.root)
        self.assertEqual(result['runtime_packages'], 23)
        self.assertFalse(result['business_database_used'])

    def test_corrupt_publisher_archive_refused(self):
        path = self.root / 'frontend/vendor/xlsx-0.20.3.tgz'
        path.write_bytes(path.read_bytes() + b'changed')
        self.reject()

    def test_manifest_drift_refused(self):
        self.change_json('frontend/package.json', lambda d: d['dependencies'].update(react='19.0.0'))
        self.reject()

    def test_peer_bypass_refused(self):
        (self.root / 'frontend/.npmrc').write_text('legacy-peer-deps=true\n')
        self.reject()

    def test_appended_peer_bypass_refused(self):
        (self.root / 'frontend/.npmrc').write_text('legacy-peer-deps=false\nlegacy-peer-deps=true\n')
        self.reject()

    def test_nonportable_lock_refused(self):
        self.change_json('frontend/package-lock.json', lambda d: d['packages'].update({'../../outside': {}}))
        self.reject()

    def test_runtime_validation_cannot_use_separate_old_lock(self):
        (self.root / 'scripts/testing/runtime-check-requirements.lock').write_text('Django==6.0.2\n')
        self.reject()

    def test_runtime_direct_drift_refused(self):
        path = self.root / 'backend/requirements.in'
        path.write_text(path.read_text().replace('Django==6.0.9', 'Django==6.0.2'))
        self.reject()

    def test_missing_hashes_refused(self):
        path = self.root / 'backend/requirements.lock'
        path.write_text('Django==6.0.9\n')
        self.reject()

    def test_lock_integrity_drift_refused(self):
        self.change_json('frontend/package-lock.json', lambda d: d['packages']['node_modules/xlsx'].update(integrity='sha512-changed'))
        self.reject()


if __name__ == '__main__':
    unittest.main()
