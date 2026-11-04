"""Build/verify a complete exact-revision REVIEW bundle. No activation or DB access.

Build uses a fresh export and owns npm ci/typecheck/build. There is no dirty-tree
or skip-build CLI. Verify requires an independently trusted SHA256 and revision.
Archives are inspected fully before exclusive manual extraction; never extractall.
"""
import argparse
import ast
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = 'release-manifest.json'
FORMAT = 'techtrolley-review-bundle-1'
MAX_ARCHIVE = 50 * 1024 * 1024
MAX_TOTAL = 100 * 1024 * 1024
MAX_FILE = 10 * 1024 * 1024
MAX_FILES = 2000
STATIC_EXT = {'.html', '.js', '.css', '.png', '.svg', '.ico', '.xml', '.txt',
              '.webmanifest', '.woff', '.woff2', '.ttf', '.jpg', '.jpeg', '.webp', '.wasm'}
VALIDATION = {'run_backend_tests.py', 'run_postgres_tests.py', 'test_postgres_harness.py',
              'test_runtime_config.py', 'check_runtime_settings.py', 'check_gunicorn_runtime.py',
              'check_dependencies.py', 'test_dependency_guards.py', 'release_rehearsal_probe.py',
              'runtime-check-requirements.in', 'runtime-check-requirements.lock', 'check_packaged_release.py',
              'test_staging_config.py', 'check_staging_proxy.py', 'systemd_service_probe.py', 'systemd_service_checks.py', 'test_systemd_service_guards.py',
              'test_backup_media.py', 'backup_media_vm_probe.py'}
DOCS = {'docs/RELEASE_OPERATIONS.md', 'docs/RUNTIME_CONFIGURATION.md',
        'docs/SECURITY_RELEASE_CHECKLIST.md', 'docs/examples/staging.env.example',
        'docs/STAGING_OPERATIONS.md', 'docs/BACKUP_RECOVERY.md', 'docs/PHONE_STAGING_ACCESS.md'}
REQUIRED = {'backend/manage.py', 'backend/requirements.txt', 'backend/requirements.in',
            'backend/requirements.lock', 'backend/config/settings.py', 'backend/config/environment.py',
            'backend/config/wsgi.py', 'backend/config/asgi.py', 'backend/config/urls.py',
            'backend/core/models.py', 'backend/core/urls.py', 'backend/core/apps.py',
            'backend/core/migrations/__init__.py', 'frontend/package.json',
            'frontend/package-lock.json', 'frontend/.npmrc', 'frontend/tsconfig.json',
            'frontend/vite.config.ts', 'frontend/index.html', 'frontend/index.tsx',
            'frontend/App.tsx', 'frontend/sw.ts', 'frontend/vendor/xlsx-0.20.3.tgz',
            'frontend/vendor/sheetjs-provenance.json', 'scripts/deployment/release_bundle.py',
            'scripts/deployment/release_sandbox.py', 'scripts/deployment/staging_config.py', 'scripts/testing/run_postgres_tests.py',
            'scripts/testing/release_rehearsal_probe.py', 'scripts/testing/check_dependencies.py'} | DOCS
SECRET_SHAPES = re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|'
                           rb'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bAIza[0-9A-Za-z_-]{30,}\b')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()


def digest_map(values):
    return sha(encoded(values))


def safe_name(name):
    require(isinstance(name, str) and 0 < len(name) < 240, 'Invalid bundle path')
    require(not any(ord(c) < 32 or c in '\\:' for c in name), 'Invalid bundle path character')
    parts = PurePosixPath(name).parts
    require(not name.startswith('/') and '/'.join(parts) == name and
            all(p not in {'.', '..'} for p in parts), 'Noncanonical bundle path')
    return parts


def forbidden(name):
    parts = safe_name(name)
    return (any(p in {'node_modules', '__pycache__', 'venv', '.venv', 'data_dumps',
                     'legacy_backups', 'media', 'archive', '.git'} for p in parts)
            or any(p.startswith('.env') for p in parts)
            or PurePosixPath(name).suffix.lower() in
            {'.pem', '.key', '.sqlite', '.sqlite3', '.sql', '.dump', '.bak', '.pyc', '.pyo', '.xlsx', '.csv', '.map'})


def source_allowed(name):
    if forbidden(name):
        return False
    if name != 'frontend/.npmrc' and any(part.startswith('.') for part in PurePosixPath(name).parts):
        return False
    p = PurePosixPath(name)
    if name in DOCS or name in {'backend/manage.py', 'backend/requirements.txt',
                              'backend/requirements.in', 'backend/requirements.lock'}:
        return True
    if name.startswith(('backend/core/', 'backend/config/')):
        return p.suffix == '.py'
    if name.startswith('scripts/deployment/'):
        return p.parent.as_posix() == 'scripts/deployment' and p.name in {
            'prepare_release.py', 'release_bundle.py', 'release_sandbox.py', 'staging_config.py', 'backup_media.py'}
    if name.startswith('scripts/testing/'):
        return p.parent.as_posix() == 'scripts/testing' and p.name in VALIDATION
    if name in {'frontend/.npmrc', 'frontend/package.json', 'frontend/package-lock.json',
                'frontend/tailwind.config.cjs', 'frontend/postcss.config.cjs',
                'frontend/tsconfig.json', 'frontend/vendor/xlsx-0.20.3.tgz',
                'frontend/vendor/sheetjs-provenance.json'}:
        return True
    if p.parent.as_posix() == 'frontend':
        return p.suffix in {'.ts', '.tsx', '.css', '.html'}
    if name.startswith(('frontend/components/', 'frontend/state/')):
        return p.suffix in {'.ts', '.tsx', '.css'}
    if name.startswith('frontend/public/'):
        return p.suffix.lower() in STATIC_EXT - {'.js', '.wasm'}
    return False


def role(name):
    if name.startswith('frontend/dist/'):
        require(not forbidden(name) and PurePosixPath(name).suffix.lower() in STATIC_EXT,
                'Unexpected frontend build file')
        require(not any(part.startswith('.') for part in PurePosixPath(name).parts), 'Hidden frontend output refused')
        if name.startswith('frontend/dist/assets/'):
            require(re.fullmatch(r'frontend/dist/assets/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+', name)
                    is not None, 'Frontend chunks require immutable hashed names')
        return 'frontend-build'
    require(source_allowed(name), 'Path outside bundle source policy')
    return 'source'


def require_style_sources(files):
    # Preserve verification of historical CDN-based bundles while refusing an
    # incomplete new build-time styling source export.
    if b'"tailwindcss"' in files.get('frontend/package.json', b''):
        require({'frontend/index.css', 'frontend/tailwind.config.cjs',
                 'frontend/postcss.config.cjs'} <= files.keys(),
                'Build-time styling requires its CSS and exact configuration sources')


def strict_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'Duplicate JSON key')
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=pairs)


def migration_inventory(files):
    migrations = {}
    for name, data in files.items():
        p = PurePosixPath(name)
        if p.parent.as_posix() != 'backend/core/migrations' or not re.fullmatch(r'\d{4}_[A-Za-z0-9_]+\.py', p.name):
            continue
        tree = ast.parse(data, filename=name)
        cls = next((n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'Migration'), None)
        require(cls is not None, 'Migration class missing')
        deps = next((n.value for n in cls.body if isinstance(n, ast.Assign) and
                     any(isinstance(t, ast.Name) and t.id == 'dependencies' for t in n.targets)), None)
        require(isinstance(deps, (ast.List, ast.Tuple)), 'Static migration dependencies required')
        core = []
        for dep in deps.elts:
            if isinstance(dep, ast.Call):
                require(isinstance(dep.func, ast.Attribute) and dep.func.attr == 'swappable_dependency',
                        'Unsupported dynamic migration dependency')
                continue
            value = ast.literal_eval(dep)
            require(isinstance(value, tuple) and len(value) == 2, 'Invalid migration dependency')
            if value[0] == 'core':
                core.append(value[1])
        migrations[p.stem] = {'sha256': sha(data), 'dependencies': sorted(core)}
    require(migrations, 'Core migration inventory missing')
    referenced = {dep for item in migrations.values() for dep in item['dependencies']}
    require(referenced <= migrations.keys(), 'Missing core migration dependency')
    leaves = sorted(migrations.keys() - referenced)
    require(len(leaves) == 1, 'Exactly one core migration leaf is required')
    seen, visiting = set(), set()
    def visit(name):
        require(name not in visiting, 'Cyclic core migration dependencies')
        if name in seen:
            return
        visiting.add(name)
        for dep in migrations[name]['dependencies']:
            visit(dep)
        visiting.remove(name)
        seen.add(name)
    visit(leaves[0])
    require(seen == migrations.keys(), 'Disconnected core migration graph')
    return {'app': 'core', 'leaf': leaves[0], 'migrations': migrations,
            'migration_set_digest': digest_map(sorted(migrations)),
            'automatic_reverse_migration': False, 'automatic_database_restore': False}


def git(root, *args):
    return subprocess.check_output(['git', '--no-optional-locks', '-C', str(root), *args])


def clean_head(root, revision):
    require(re.fullmatch(r'[0-9a-f]{40}', revision) is not None, 'A full exact Git SHA is required')
    require(git(root, 'rev-parse', 'HEAD').decode().strip() == revision, 'Checkout/revision mismatch')
    require(not git(root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'),
            'Bundle requires a clean committed checkout; preserve the current work')


def snapshot(root, revision):
    root = Path(root).resolve()
    clean_head(root, revision)
    result = {}
    for line in git(root, 'ls-tree', '-rz', '--full-tree', revision).split(b'\0'):
        if not line:
            continue
        header, raw_name = line.split(b'\t', 1)
        mode, kind, oid = header.split()
        name = raw_name.decode('utf-8')
        require(mode in {b'100644', b'100755'} and kind == b'blob', 'Symlink/submodule source refused')
        require(not forbidden(name), 'Tracked private/generated file must be reviewed before packaging')
        if not source_allowed(name):
            continue
        path = root / name
        require(not any(p.is_symlink() for p in (path, *path.parents)), 'Symlink source path refused')
        data = path.read_bytes()
        require(len(data) <= MAX_FILE, 'Oversized source file')
        blob = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
        require(blob == oid.decode(), 'Working source differs from exact committed blob')
        if path.suffix in {'.py', '.ts', '.tsx', '.html', '.json', '.cjs', '.css'}:
            require(not SECRET_SHAPES.search(data), 'Possible credential in release source; private review required')
        result[name] = data
    require(REQUIRED <= result.keys(), 'Complete backend/frontend/validation/runbook source is required')
    require_style_sources(result)
    require(len(result) < MAX_FILES and sum(map(len, result.values())) <= MAX_TOTAL, 'Source inventory limit')
    clean_head(root, revision)
    return result


def build_frontend(export, log):
    require(sys.version_info[:2] == (3, 12), 'Build candidate requires Python3.12')
    node, npm = shutil.which('node'), shutil.which('npm')
    require(node and npm, 'Node/npm required')
    env = {'PATH': os.environ.get('PATH', os.defpath), 'PYTHONDONTWRITEBYTECODE': '1',
           'CI': 'true', 'NO_COLOR': '1'}
    node_version = subprocess.check_output([node, '--version'], env=env, text=True).strip()
    require(node_version.startswith('v24.'), 'Build candidate requires Node24')
    npm_version = subprocess.check_output([npm, '--version'], env=env, text=True).strip()
    # No inherited registry credentials, .env, DB settings, cloud/AI keys or npmrc.
    subprocess.run([sys.executable, str(export/'scripts/testing/check_dependencies.py'), '--installed'],
                   cwd=export, env=env, stdout=log, stderr=log, check=True, timeout=60)
    for name in ('npm-user.conf', 'npm-global.conf'):
        (export.parent/name).write_text('')
    base = [npm, '--userconfig=' + str(export.parent/'npm-user.conf'),
            '--globalconfig=' + str(export.parent/'npm-global.conf'), '--cache=' + str(export.parent/'npm-cache')]
    commands = [base + ['ci', '--ignore-scripts'], base + ['run', 'typecheck'], base + ['run', 'build']]
    for command in commands:
        subprocess.run(command, cwd=export/'frontend', env=env, stdout=log, stderr=log,
                       check=True, timeout=300)
    return {'python': sys.version.split()[0], 'node': node_version, 'npm': npm_version,
            'commands': ['npm ci --ignore-scripts', 'npm run typecheck', 'npm run build'],
            'fresh_export': True, 'inherited_private_environment': False}


def write_export(folder, files):
    for name, data in files.items():
        path = folder / name
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with path.open('xb') as stream:
            stream.write(data)
        path.chmod(0o600)


def validate_manifest(manifest, files, revision):
    require(re.fullmatch(r'[0-9a-f]{40}', revision) is not None, 'Exact bundle revision required')
    require(manifest.get('format') == FORMAT and manifest.get('revision') == revision,
            'Bundle format/revision mismatch')
    require(manifest.get('deployment_enabled') is False, 'Bundle is review-only')
    expected = manifest.get('files')
    require(isinstance(expected, dict) and set(expected) == set(files), 'Bundle file inventory mismatch')
    sources = {}
    for name, data in files.items():
        actual_role = role(name)
        require(expected[name] == {'role': actual_role, 'size': len(data), 'sha256': sha(data)},
                'Bundle file hash/role/size mismatch')
        if actual_role == 'source':
            sources[name] = data
    require(REQUIRED <= sources.keys(), 'Bundle missing required source')
    require_style_sources(sources)
    require({'frontend/dist/index.html', 'frontend/dist/sw.js'} <= files.keys(), 'Frontend shell/worker missing')
    require(manifest.get('schema') == migration_inventory(sources), 'Migration inventory mismatch')
    source_map = {n: sha(b) for n, b in sources.items()}
    frontend_map = {n: v for n, v in source_map.items() if n.startswith('frontend/')}
    build_map = {n: sha(b) for n, b in files.items() if n.startswith('frontend/dist/')}
    require(manifest.get('source_digest') == digest_map(source_map), 'Source digest mismatch')
    require(manifest.get('frontend_input_digest') == digest_map(frontend_map), 'Build input digest mismatch')
    require(manifest.get('frontend_output_digest') == digest_map(build_map), 'Build output digest mismatch')
    require(manifest.get('runtime_lock_sha256') == sha(sources['backend/requirements.lock']), 'Runtime lock mismatch')
    return manifest


def assemble(root, revision, output, *, builder=build_frontend):
    root = Path(root).resolve()
    output = Path(output).absolute()
    parent = output.parent.resolve()
    require(root != parent and root not in parent.parents, 'Bundle output must be outside checkout')
    require(parent.is_dir() and parent.stat().st_uid == os.getuid() and
            not stat.S_IMODE(parent.stat().st_mode) & 0o077, 'Output parent must be private0700 and owned')
    require(not output.exists() and not output.is_symlink(), 'Bundle output already exists')
    files = snapshot(root, revision)
    with tempfile.TemporaryDirectory(prefix='tt-release-build-') as temp:
        base = Path(temp).resolve()
        export = base / 'export'
        export.mkdir(mode=0o700)
        write_export(export, files)
        with (base/'build.log').open('wb') as log:
            try:
                build = builder(export, log)
            except Exception as error:
                # No source/private values echoed; log stays private for investigation.
                retained = parent / (output.name + '.failed-build.log')
                with retained.open('xb') as destination:
                    destination.write((base/'build.log').read_bytes())
                retained.chmod(0o600)
                raise ValueError('Fresh build failed; private build log retained') from error
        require(all((export/n).read_bytes() == data for n, data in files.items()), 'Build changed source/lock files')
        assets = {}
        dist = export / 'frontend/dist'
        require(dist.is_dir() and not dist.is_symlink(), 'Build output missing')
        for path in dist.rglob('*'):
            require(not path.is_symlink(), 'Build symlink refused')
            if path.is_file():
                name = path.relative_to(export).as_posix()
                role(name)
                data = path.read_bytes()
                require(len(data) <= MAX_FILE, 'Oversized build file')
                require(not SECRET_SHAPES.search(data), 'Possible credential in generated build')
                assets[name] = data
        # Re-read every exact committed source byte after building; never use old dist.
        require(snapshot(root, revision) == files, 'Source changed while building')
        payload = {**files, **assets}
        source_map = {n: sha(b) for n, b in files.items()}
        manifest = {'format': FORMAT, 'revision': revision, 'deployment_enabled': False,
                    'build': build, 'source_digest': digest_map(source_map),
                    'frontend_input_digest': digest_map({n: v for n, v in source_map.items() if n.startswith('frontend/')}),
                    'frontend_output_digest': digest_map({n: sha(b) for n, b in assets.items()}),
                    'runtime_lock_sha256': sha(files['backend/requirements.lock']),
                    'schema': migration_inventory(files),
                    'files': {n: {'role': role(n), 'size': len(b), 'sha256': sha(b)} for n, b in sorted(payload.items())},
                    'remaining_gates': ['Hosted/Linux/HTTPS and actual backup/media/device acceptance',
                                        'Reviewed tracking/credential cleanup', 'Explicit production release review'],
                    'automatic_database_restore': False, 'automatic_reverse_migration': False}
        validate_manifest(manifest, payload, revision)
        require(len(payload) + 1 <= MAX_FILES and sum(map(len, payload.values())) <= MAX_TOTAL, 'Bundle size limit')
        fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, 'wb') as raw:
                with gzip.GzipFile(fileobj=raw, mode='wb', filename='', mtime=0) as zipped:
                    with tarfile.open(fileobj=zipped, mode='w', format=tarfile.USTAR_FORMAT) as tar:
                        for name, data in [(MANIFEST, encoded(manifest)), *sorted(payload.items())]:
                            info = tarfile.TarInfo(name)
                            info.size, info.mode, info.mtime = len(data), 0o600, 0
                            tar.addfile(info, io.BytesIO(data))
                raw.flush()
                os.fsync(raw.fileno())
            require(output.stat().st_size <= MAX_ARCHIVE, 'Compressed bundle size limit')
            digest = sha(output.read_bytes())
            verify(output, digest, revision)
        except BaseException:
            output.unlink(missing_ok=True)
            raise
    return {'revision': revision, 'archive_sha256': digest, 'files': len(payload),
            'schema_leaf': manifest['schema']['leaf'], 'deployment_enabled': False}


def verify(archive, expected_sha256, revision):
    require(re.fullmatch(r'[0-9a-f]{64}', expected_sha256) is not None and
            re.fullmatch(r'[0-9a-f]{40}', revision) is not None, 'Trusted exact digest/revision required')
    archive = Path(archive)
    require(not archive.is_symlink() and archive.is_file() and archive.stat().st_size <= MAX_ARCHIVE,
            'Regular bounded archive required')
    with archive.open('rb') as stream:
        data = stream.read(MAX_ARCHIVE + 1)
    require(len(data) <= MAX_ARCHIVE, 'Compressed archive limit')
    require(sha(data) == expected_sha256, 'Archive SHA256 mismatch')
    files, folded, total = {}, set(), 0
    # Bound decompression before tarfile interprets extended/long-name metadata.
    raw_limit = MAX_TOTAL + MAX_FILES * 1024 + 10240
    with gzip.GzipFile(fileobj=io.BytesIO(data), mode='rb') as zipped:
        raw = zipped.read(raw_limit + 1)
    require(len(raw) <= raw_limit, 'Expanded tar stream limit')
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:') as tar:
        for member in tar:
            safe_name(member.name)
            require(member.isfile() and not member.issparse() and not member.pax_headers,
                    'Only plain regular archive files are accepted')
            require(member.mode == 0o600 and member.uid == member.gid == 0,
                    'Unexpected bundle ownership/permissions')
            require(member.name.casefold() not in folded, 'Duplicate/colliding archive path')
            folded.add(member.name.casefold())
            require(len(files) < MAX_FILES and 0 <= member.size <= MAX_FILE, 'Archive member limit')
            total += member.size
            require(total <= MAX_TOTAL, 'Expanded archive limit')
            content = tar.extractfile(member).read(MAX_FILE + 1)
            require(len(content) == member.size, 'Archive file size mismatch')
            files[member.name] = content
    require(MANIFEST in files and len(files[MANIFEST]) <= 1024 * 1024, 'Manifest missing/oversized')
    manifest = strict_json(files.pop(MANIFEST))
    validate_manifest(manifest, files, revision)
    return manifest, files


def verify_directory(folder, revision):
    folder = Path(folder).resolve()
    files, total = {}, 0
    for path in folder.rglob('*'):
        require(not path.is_symlink(), 'Extracted symlink refused')
        if path.is_file():
            name = path.relative_to(folder).as_posix()
            require(len(files) < MAX_FILES and path.stat().st_size <= MAX_FILE, 'Extracted file limit')
            files[name] = path.read_bytes()
            total += len(files[name])
            require(total <= MAX_TOTAL, 'Extracted total limit')
    require(MANIFEST in files, 'Extracted manifest missing')
    manifest = strict_json(files.pop(MANIFEST))
    validate_manifest(manifest, files, revision)
    return manifest


def extract(archive, expected_sha256, revision, destination):
    manifest, files = verify(archive, expected_sha256, revision)
    destination = Path(destination)
    require(not destination.exists() and not destination.is_symlink(), 'New extraction directory required')
    destination.mkdir(mode=0o700)
    try:
        write_export(destination, {MANIFEST: encoded(manifest), **files})
        verify_directory(destination, revision)
    except BaseException:
        shutil.rmtree(destination)
        raise
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    build = sub.add_parser('build')
    build.add_argument('--source-root', type=Path, default=ROOT)
    build.add_argument('--revision', required=True)
    build.add_argument('--output', required=True, type=Path)
    incoming = sub.add_parser('verify')
    incoming.add_argument('--archive', required=True, type=Path)
    incoming.add_argument('--sha256', required=True)
    incoming.add_argument('--revision', required=True)
    incoming.add_argument('--extract-to', type=Path)
    args = parser.parse_args()
    if args.command == 'build':
        result = assemble(args.source_root, args.revision, args.output)
    else:
        if args.extract_to:
            manifest = extract(args.archive, args.sha256, args.revision, args.extract_to)
        else:
            manifest, _ = verify(args.archive, args.sha256, args.revision)
        result = {'verified': True, 'revision': manifest['revision'], 'files': len(manifest['files']),
                  'schema_leaf': manifest['schema']['leaf'], 'deployment_enabled': False}
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
