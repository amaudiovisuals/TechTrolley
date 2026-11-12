"""Activation/recovery REHEARSAL ONLY, inside the private PostgreSQL test harness.

No SSH, service manager, real web root, credential input, SQL mutation, reverse
migration or DB restore. Actual Linux service/proxy adapters remain a release gate.
The caller supplies fresh read-only observations from the guarded test connection.
"""
import contextlib
import fcntl
import json
import os
from pathlib import Path
import shutil
import stat
import uuid

from release_bundle import (MANIFEST, digest_map, encoded, require, sha,
                            strict_json, verify_directory)


def atomic_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.new')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(encoded(value))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


class RehearsalSite:
    def __init__(self, base, observation):
        self.base = Path(base).resolve()
        self.root = self.base/'release-site'
        self.observation = observation
        require(self.base.name.startswith('tt-pg-'), 'Only a private PostgreSQL test sandbox is allowed')
        for path in (self.base, self.base/'socket', self.base/'data', self.base/'control.json'):
            require(not path.is_symlink() and path.stat().st_uid == os.getuid() and
                    not stat.S_IMODE(path.stat().st_mode) & 0o077, 'Private test cluster ownership/mode required')
        control = strict_json((self.base/'control.json').read_bytes())
        require(control.get('protocol') == 'techtrolley-private-postgres-1', 'Unknown test cluster')
        self.nonce = control['nonce']
        if self.root.exists():
            require(not self.root.is_symlink() and self.root.stat().st_uid == os.getuid() and
                    not stat.S_IMODE(self.root.stat().st_mode) & 0o077, 'Private rehearsal site required')
            marker = strict_json((self.root/'instance.json').read_bytes())
            require(marker == {'rehearsal_only': True, 'cluster_nonce': self.nonce, 'base': str(self.base)},
                    'Rehearsal instance mismatch')
        self.observe()

    def observe(self):
        value = self.observation()
        require(value['database'] == 'tt_validation' and value['socket'] == str(self.base/'socket')
                and value['data_directory'] == str(self.base/'data') and value['listen_addresses'] == ''
                and value['cluster_nonce'] == self.nonce, 'Wrong rehearsal database/cluster')
        require(value['other_connections'] == 0, 'Quiesce other database connections before activation/recovery')
        require(value['unknown_migrations'] == [] and type(value['runtime_migrations_pending']) is int
                and value['runtime_migrations_pending'] >= 0, 'Unknown/inconsistent runtime migration state')
        require(isinstance(value['core_migrations'], list) and
                len(value['core_migrations']) == len(set(value['core_migrations'])), 'Invalid migration observation')
        return value

    @contextlib.contextmanager
    def locked(self):
        require(self.root.is_dir() and not self.root.is_symlink(), 'Rehearsal site not initialized')
        fd = os.open(self.root/'operation.lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield
        finally:
            os.close(fd)

    def load(self):
        path = self.root/'state.json'
        require(not path.is_symlink() and path.stat().st_size < 1024*1024, 'Invalid rehearsal state')
        state = strict_json(path.read_bytes())
        require(state['cluster_nonce'] == self.nonce, 'State cluster mismatch')
        current = self.root/'current'
        require(current.is_symlink(), 'Current pointer missing')
        target = os.readlink(current)
        require(target in {'releases/legacy-stub', 'releases/' + state['target_revision']},
                'Unrecognized current pointer')
        require(not (self.root/'releases').is_symlink() and
                current.resolve().parent == (self.root/'releases').resolve(), 'Pointer leaves rehearsal releases')
        return state

    def save(self, state, action):
        state['generation'] += 1
        state['journal'].append({'generation': state['generation'], 'action': action,
                                 'phase': state['phase'], 'maintenance': state['maintenance']})
        atomic_json(self.root/'state.json', state)

    def retain_assets(self, staged, manifest):
        """Rehearse the shared immutable /assets store required by the host adapter."""
        store = self.root/'asset-store'
        store.mkdir(exist_ok=True, mode=0o700)
        require(not store.is_symlink(), 'Asset store symlink refused')
        for name, entry in manifest['files'].items():
            if not name.startswith('frontend/dist/assets/'):
                continue
            target = store/name.removeprefix('frontend/dist/')
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            require(not target.parent.is_symlink() and not target.is_symlink(), 'Asset-store symlink refused')
            data = (staged/name).read_bytes()
            require(sha(data) == entry['sha256'], 'Staged asset changed')
            if target.exists():
                require(target.is_file() and target.read_bytes() == data, 'Immutable asset-name collision')
            else:
                fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, 'wb') as stream:
                    stream.write(data)
                    stream.flush()
                    os.fsync(stream.fileno())

    def initialize(self, artifact_root):
        require(not self.root.exists() and not self.root.is_symlink(), 'New rehearsal site required')
        artifact_root = Path(artifact_root).resolve()
        manifest = strict_json((artifact_root/MANIFEST).read_bytes())
        verify_directory(artifact_root, manifest['revision'])
        before = sorted(self.observe()['core_migrations'])
        require(set(before) <= manifest['schema']['migrations'].keys(), 'Candidate cannot explain current schema')
        self.root.mkdir(mode=0o700)
        atomic_json(self.root/'instance.json', {'rehearsal_only': True, 'cluster_nonce': self.nonce,
                                               'base': str(self.base)})
        (self.root/'releases').mkdir(mode=0o700)
        legacy = self.root/'releases/legacy-stub'
        legacy.mkdir(mode=0o700)
        (legacy/'README').write_text('Synthetic previous-pointer marker only; not old production code.\n')
        staged = self.root/'releases'/manifest['revision']
        shutil.copytree(artifact_root, staged, symlinks=True)
        staged.chmod(0o700)
        verify_directory(staged, manifest['revision'])
        self.retain_assets(staged, manifest)
        (self.root/'current').symlink_to('releases/legacy-stub')
        state = {'cluster_nonce': self.nonce, 'target_revision': manifest['revision'],
                 'before_core_migrations': before, 'target_core_migrations': sorted(manifest['schema']['migrations']),
                 'source_digest': manifest['source_digest'], 'phase': 'idle', 'maintenance': False,
                 'generation': 0, 'journal': [], 'automatic_restore': False, 'previous_code_is_stub': True}
        atomic_json(self.root/'state.json', state)
        return state

    def begin(self, before_dump):
        with self.locked():
            state = self.load()
            require(state['phase'] == 'idle', 'Activation already in progress')
            require(sorted(self.observe()['core_migrations']) == state['before_core_migrations'], 'Baseline schema changed')
            before_dump = Path(before_dump)
            require(before_dump == self.base/'synthetic-before.dump' and not before_dump.is_symlink()
                    and before_dump.is_file() and not stat.S_IMODE(before_dump.stat().st_mode) & 0o077,
                    'Private synthetic before-dump required')
            state.update(phase='awaiting-schema', maintenance=True, before_dump_sha256=sha(before_dump.read_bytes()))
            self.save(state, 'maintenance-before-any-schema-change')

    def abort_before_schema(self):
        with self.locked():
            state = self.load()
            require(state['phase'] == 'awaiting-schema' and
                    sorted(self.observe()['core_migrations']) == state['before_core_migrations'] and
                    os.readlink(self.root/'current') == 'releases/legacy-stub', 'Cannot abort after schema/pointer changes')
            state.update(phase='idle', maintenance=False)
            self.save(state, 'abort-before-schema-no-db-restore')

    def schema_ready(self):
        with self.locked():
            state = self.load()
            require(state['phase'] == 'awaiting-schema' and state['maintenance'], 'Schema transition not expected')
            observed = self.observe()
            require(sorted(observed['core_migrations']) == state['target_core_migrations']
                    and observed['runtime_migrations_pending'] == 0,
                    'Schema incomplete/unknown: keep maintenance; review and recover forward')
            state.update(phase='schema-ready')
            self.save(state, 'verified-target-schema')

    def restore_previous(self):
        with self.locked():
            state = self.load()
            require(sorted(self.observe()['core_migrations']) == state['before_core_migrations'],
                    'Old code/schema rollback refused after migrations; never restore DB automatically')
            raise ValueError('Previous code is only a synthetic stub; no validated rollback release exists')

    def publish(self, health):
        with self.locked():
            state = self.load()
            require(state['phase'] in {'schema-ready', 'recovery-required'} and state['maintenance'],
                    'Publish requires maintenance and reviewed forward recovery')
            observed = self.observe()
            require(sorted(observed['core_migrations']) == state['target_core_migrations'], 'Target schema changed')
            require(observed['runtime_migrations_pending'] == 0, 'Runtime migrations incomplete')
            staged = self.root/'releases'/state['target_revision']
            manifest = verify_directory(staged, state['target_revision'])
            require(manifest['source_digest'] == state['source_digest'], 'Staged release changed')
            self.retain_assets(staged, manifest)
            temporary = self.root/('current.' + uuid.uuid4().hex)
            try:
                temporary.symlink_to('releases/' + state['target_revision'])
                os.replace(temporary, self.root/'current')
                state.update(phase='recovery-required', maintenance=True)
                self.save(state, 'pointer-published-health-pending')
                result = health()
                require(result == {'healthy': True, 'revision': state['target_revision'],
                                   'migration_set_digest': digest_map(state['target_core_migrations'])},
                        'Health check failed: maintenance retained; recover forward')
                # A healthy response does not override a changed DB observation.
                final = self.observe()
                require(sorted(final['core_migrations']) == state['target_core_migrations']
                        and final['runtime_migrations_pending'] == 0, 'Schema changed during health check')
                state.update(phase='active', maintenance=False)
                self.save(state, 'healthy-release-accepted')
            finally:
                temporary.unlink(missing_ok=True)

    def enter_recovery(self):
        with self.locked():
            state = self.load()
            require(state['phase'] == 'active', 'Active release required')
            self.observe()
            state.update(phase='recovery-required', maintenance=True)
            self.save(state, 'maintenance-before-forward-recovery')
