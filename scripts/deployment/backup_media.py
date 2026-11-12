"""Read-only integrity contract for a PRIVATE database + media backup directory.

No DB connection, dump, restore, archive extraction, encryption or service changes.
The manifest's independently supplied digest is required for verification. It
binds bytes and recorded capture assertions; it cannot prove those assertions or
authenticate the source/operator. Only a separate restore can establish recovery.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import uuid

FORMAT = 'techtrolley-db-media-1'
MAX_MANIFEST = 32 * 1024 * 1024
MAX_FILES = 100000
MAX_BYTES = 1024 ** 4
META = {'snapshot_id', 'source_instance', 'database', 'source_code_revision',
        'schema_leaf', 'capture_started_utc', 'capture_completed_utc',
        'writers_quiesced', 'synthetic_only'}


def require(ok, message):
    if not ok:
        raise ValueError(message)


def encoded(value):
    return (json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')) + '\n').encode()


def strict_json(raw):
    def pairs(items):
        value = {}
        for key, item in items:
            require(key not in value, 'Duplicate JSON key')
            value[key] = item
        return value
    return json.loads(raw, object_pairs_hook=pairs)


def relative(value):
    require(isinstance(value, str) and 0 < len(value) <= 1024 and
            '\\' not in value and not any(ord(c) < 32 for c in value), 'Unsafe media path')
    path = PurePosixPath(value)
    require(not path.is_absolute() and str(path) == value and
            not any(p in {'.', '..'} for p in path.parts) and value != '.', 'Unsafe media path')
    return value


def private(info, directory=False):
    require(info.st_uid == os.geteuid() and info.st_mode & 0o077 == 0,
            'Backup entries must be private and owned by the checking user')
    require(stat.S_ISDIR(info.st_mode) if directory else
            stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
            'Only real directories and single-link regular files are accepted')


def file_info(path, *, limit=MAX_BYTES):
    # Parent directory is validated separately. Never follow a leaf symlink.
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno()); private(before)
        require(before.st_size <= limit, 'Backup entry exceeds size limit')
        digest = hashlib.sha256()
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
        after = os.fstat(stream.fileno())
        require((before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
                (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns),
                'Backup file changed while reading')
        return {'bytes': before.st_size, 'sha256': digest.hexdigest()}


def root_path(root):
    root = Path(root)
    require(root.is_absolute() and root == root.resolve(), 'Canonical absolute backup path required')
    private(root.lstat(), directory=True)
    return root


def media_inventory(root):
    root = root_path(root)
    require(not (root/'media').is_symlink(), 'Media directory symlink refused')
    private((root/'media').lstat(), directory=True)
    result = {}; total = 0
    for directory, folders, files in os.walk(root/'media', followlinks=False):
        private(Path(directory).lstat(), directory=True)
        for name in folders:
            private((Path(directory)/name).lstat(), directory=True)
        for name in files:
            path = Path(directory)/name
            value = relative(path.relative_to(root/'media').as_posix())
            require(len(result) < MAX_FILES, 'Too many media files')
            result[value] = file_info(path); total += result[value]['bytes']
            require(total <= MAX_BYTES, 'Media inventory exceeds size limit')
    return dict(sorted(result.items()))


def metadata(value):
    require(isinstance(value, dict) and set(value) == META, 'Exact capture metadata required')
    require(str(uuid.UUID(value['snapshot_id'])) == value['snapshot_id'], 'Canonical snapshot UUID required')
    for key in ['source_instance', 'database']:
        require(isinstance(value[key], str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}', value[key]),
                'Explicit source identity required')
    require(re.fullmatch(r'[0-9a-f]{40}', value['source_code_revision']) is not None, 'Full source code revision required')
    require(re.fullmatch(r'\d{4}_[a-z0-9_]+', value['schema_leaf']) is not None, 'Schema leaf required')
    require(value['writers_quiesced'] is True and type(value['synthetic_only']) is bool,
            'Recorded quiesced capture scope required')
    times = []
    for name in ['capture_started_utc', 'capture_completed_utc']:
        require(isinstance(value[name], str) and value[name].endswith('Z'), 'UTC capture timestamp required')
        times.append(datetime.datetime.fromisoformat(value[name].removesuffix('Z') + '+00:00'))
    require(times[0] <= times[1], 'Capture timestamps reversed')
    return value


def references(values):
    require(isinstance(values, list) and len(values) <= MAX_FILES, 'Bounded DB file-reference list required')
    result = []; keys = set()
    for value in values:
        require(isinstance(value, dict) and set(value) == {'model', 'pk', 'field', 'path'}, 'Exact DB file reference required')
        require(all(isinstance(v, str) and 0 < len(v) <= 1024 for v in value.values()), 'Invalid DB file reference')
        relative(value['path']); key = (value['model'], value['pk'], value['field'])
        require(key not in keys, 'Duplicate DB file reference'); keys.add(key); result.append(value)
    return sorted(result, key=lambda v: (v['model'], v['pk'], v['field']))


def describe(root, capture, refs):
    """Inspect already-copied private files; caller records provenance separately."""
    root = root_path(root); capture = metadata(capture); refs = references(refs)
    require({p.name for p in root.iterdir()} <= {'database.dump', 'media', 'manifest.json'}, 'Unexpected backup entry')
    dump = file_info(root/'database.dump')
    # Magic is only a format check; pg_restore must subsequently verify/restore it.
    with (root/'database.dump').open('rb') as stream:
        require(stream.read(5) == b'PGDMP', 'PostgreSQL custom dump required')
    files = media_inventory(root)
    require(all(r['path'] in files for r in refs), 'Database references missing media')
    return {'format': FORMAT, 'capture': capture, 'database_dump': dump,
            'media_files': files, 'database_file_references': refs}


def verify(root, trusted_manifest_sha256):
    root = root_path(root)
    require(isinstance(trusted_manifest_sha256, str) and re.fullmatch(r'[0-9a-f]{64}', trusted_manifest_sha256),
            'Independently trusted manifest SHA256 required')
    manifest_file = root/'manifest.json'; file_info(manifest_file, limit=MAX_MANIFEST)
    raw = manifest_file.read_bytes()
    require(hashlib.sha256(raw).hexdigest() == trusted_manifest_sha256, 'Manifest digest mismatch')
    manifest = strict_json(raw)
    require(isinstance(manifest, dict) and set(manifest) ==
            {'format', 'capture', 'database_dump', 'media_files', 'database_file_references'} and
            manifest['format'] == FORMAT, 'Unknown backup manifest')
    actual = describe(root, manifest['capture'], manifest['database_file_references'])
    require(actual == manifest, 'Database/media contents do not match manifest')
    return {'integrity_verified': True, 'restore_performed': False,
            'source_assertions_independently_proven': False,
            'snapshot_id': manifest['capture']['snapshot_id'],
            'synthetic_only': manifest['capture']['synthetic_only'],
            'media_files': len(manifest['media_files']),
            'referenced_files': len({r['path'] for r in manifest['database_file_references']}),
            'unreferenced_files': len(set(manifest['media_files']) - {r['path'] for r in manifest['database_file_references']})}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backup-directory', type=Path, required=True)
    parser.add_argument('--trusted-manifest-sha256', required=True)
    args = parser.parse_args()
    print(json.dumps(verify(args.backup_directory, args.trusted_manifest_sha256), indent=2))


if __name__ == '__main__':
    main()
