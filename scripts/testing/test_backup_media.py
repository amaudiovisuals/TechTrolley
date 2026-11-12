"""Synthetic filesystem integrity/refusal tests; no DB, network or services."""
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import uuid
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'deployment'))
import backup_media as backup
import backup_media_vm_probe as vm_probe


class BackupMediaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='tt-backup-contract-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve(); self.root.chmod(0o700)
        (self.root/'media').mkdir(mode=0o700)
        self.put('database.dump', b'PGDMP synthetic format fixture, not a restorable dump')
        self.put('media/document.pdf', b'%PDF-1.4 synthetic')
        self.put('media/retained-unused.png', b'preserve unreferenced bytes too')
        self.capture = {'snapshot_id': str(uuid.uuid4()), 'source_instance': 'synthetic-capture',
                        'database': 'tt_synthetic', 'source_code_revision': 'a'*40,
                        'schema_leaf': '0066_credential_attempt', 'capture_started_utc': '2026-10-16T07:00:00Z',
                        'capture_completed_utc': '2026-10-16T07:01:00Z', 'writers_quiesced': True,
                        'synthetic_only': True}
        self.refs = [{'model': 'core.conference', 'pk': '1', 'field': 'pdf_document', 'path': 'document.pdf'}]
        self.seal()

    def put(self, name, value):
        path = self.root/name; path.write_bytes(value); path.chmod(0o600)

    def seal(self):
        manifest = backup.describe(self.root, self.capture, self.refs)
        self.put('manifest.json', backup.encoded(manifest))
        self.digest = hashlib.sha256((self.root/'manifest.json').read_bytes()).hexdigest()

    def verify(self):
        return backup.verify(self.root, self.digest)

    def refused(self):
        with self.assertRaises((ValueError, OSError, TypeError)):
            self.verify()

    def test_valid_pair_includes_unreferenced_media_without_mutation(self):
        before = {str(p): (p.stat().st_size, p.stat().st_mtime_ns, p.read_bytes()) for p in self.root.rglob('*') if p.is_file()}
        result = self.verify()
        self.assertTrue(result['integrity_verified']); self.assertFalse(result['restore_performed'])
        self.assertFalse(result['source_assertions_independently_proven'])
        self.assertEqual((result['media_files'], result['referenced_files'], result['unreferenced_files']), (2, 1, 1))
        after = {str(p): (p.stat().st_size, p.stat().st_mtime_ns, p.read_bytes()) for p in self.root.rglob('*') if p.is_file()}
        self.assertEqual(before, after)

    def test_wrong_trusted_digest_refused(self):
        self.digest = '0'*64; self.refused()

    def test_missing_reference_refused_before_manifest(self):
        with self.assertRaises(ValueError): backup.describe(self.root, self.capture, [{**self.refs[0], 'path': 'missing.pdf'}])

    def test_changed_referenced_media_refused(self):
        self.put('media/document.pdf', b'changed'); self.refused()

    def test_changed_unreferenced_media_refused(self):
        self.put('media/retained-unused.png', b'changed'); self.refused()

    def test_removed_media_refused(self):
        (self.root/'media/document.pdf').unlink(); self.refused()

    def test_extra_media_refused(self):
        self.put('media/unrecorded.pdf', b'extra'); self.refused()

    def test_changed_dump_refused(self):
        self.put('database.dump', b'PGDMP changed'); self.refused()

    def test_wrong_dump_format_refused_even_before_manifest(self):
        self.put('database.dump', b'not a custom dump')
        with self.assertRaises(ValueError): self.seal()

    def test_leaf_symlink_refused(self):
        (self.root/'media/document.pdf').unlink()
        (self.root/'media/document.pdf').symlink_to(self.root/'database.dump'); self.refused()

    def test_directory_symlink_refused(self):
        (self.root/'media/external').symlink_to(self.root, target_is_directory=True); self.refused()

    def test_hardlink_refused(self):
        os.link(self.root/'media/document.pdf', self.root/'media/second.pdf'); self.refused()

    def test_fifo_refused_without_blocking(self):
        os.mkfifo(self.root/'media/pipe', 0o600); self.refused()

    def test_public_file_or_directory_refused(self):
        for path in [self.root, self.root/'media', self.root/'media/document.pdf', self.root/'manifest.json']:
            mode = path.stat().st_mode & 0o777; path.chmod(mode | 0o044)
            self.refused(); path.chmod(mode)

    def test_paths_cannot_escape_or_alias(self):
        for name in ['../outside', '/absolute', './document.pdf', 'a//b', 'a/../b', 'a\\b', 'a\x00b', '.', 'a/']:
            with self.subTest(name=name), self.assertRaises(ValueError): backup.relative(name)

    def test_unquiesced_and_reversed_capture_refused(self):
        for change in [{'writers_quiesced': False}, {'writers_quiesced': 'true'}, {'synthetic_only': 1},
                       {'capture_completed_utc': '2026-10-15T00:00:00Z'}, {'source_code_revision': 'main'}]:
            with self.subTest(change=change), self.assertRaises(ValueError): backup.metadata({**self.capture, **change})

    def test_duplicate_json_and_duplicate_reference_refused(self):
        with self.assertRaises(ValueError): backup.strict_json(b'{"format":1,"format":2}')
        with self.assertRaises(ValueError): backup.references(self.refs + self.refs)

    def test_extra_root_entry_and_manifest_symlink_refused(self):
        self.put('unexpected.env', b'unexpected'); self.refused(); (self.root/'unexpected.env').unlink()
        (self.root/'manifest.json').unlink(); (self.root/'manifest.json').symlink_to(self.root/'database.dump'); self.refused()

    def test_bounded_manifest_refused(self):
        self.put('manifest.json', b' '*(backup.MAX_MANIFEST+1)); self.refused()

    def test_unicode_nested_media_paths_supported(self):
        (self.root/'media/cables').mkdir(mode=0o700)
        self.put('media/cables/label space é.pdf', b'synthetic unicode media')
        self.refs.append({'model': 'core.asset', 'pk': '9', 'field': 'qr_code', 'path': 'cables/label space é.pdf'})
        self.seal(); self.assertEqual(self.verify()['referenced_files'], 2)

    def test_vm_restore_guard_refuses_before_paths_or_commands(self):
        with patch.object(vm_probe, 'guard', side_effect=ValueError('Wrong VM')), patch.object(vm_probe, 'run') as command, patch.object(vm_probe, 'RECOVERY') as path:
            with self.assertRaises(ValueError): vm_probe.exercise('wrong-identity')
            path.exists.assert_not_called(); command.assert_not_called()

    def test_vm_restore_refuses_existing_target_without_overlay(self):
        path = Mock(); path.exists.return_value = True
        with patch.object(vm_probe, 'guard'), patch.object(vm_probe, 'RECOVERY', path), patch.object(vm_probe, 'run') as command:
            with self.assertRaises(ValueError): vm_probe.exercise('synthetic-identity')
            command.assert_not_called()


if __name__ == '__main__':
    unittest.main()
