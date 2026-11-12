"""Verify and test the incoming PACKAGE, with no business connection/config input.

Requires the reviewed archive SHA/full revision and private PostgreSQL binaries.
Creates an exclusive private report directory, runs extracted validation scripts,
retains synthetic evidence, and confirms package files did not change during tests.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'deployment'))
from release_bundle import extract, require, verify_directory


def check(archive, digest, revision, pg_bin, output):
    output = Path(output)
    require(not output.exists() and not output.is_symlink(), 'A new private report directory is required')
    output.mkdir(mode=0o700)
    extracted = output/'extracted'
    report = {'revision': revision, 'archive_sha256': digest, 'deployment_enabled': False,
              'business_database_used': False, 'checks': [], 'passed': False}
    try:
        manifest = extract(archive, digest, revision, extracted)
        require(sys.version_info[:2] == (3, 12), 'Packaged validation requires Python3.12')
        pg_bin = Path(pg_bin).resolve()
        # No inherited TT_*, PG*, DJANGO_*, provider keys, email settings or .env.
        env = {'PATH': os.environ.get('PATH', os.defpath), 'PYTHONDONTWRITEBYTECODE': '1'}
        runner = extracted/'scripts/testing'
        commands = [
            ('dependencies', [runner/'check_dependencies.py', '--installed']),
            ('pip-check', ['-m', 'pip', 'check']),
            ('dependency-guards', [runner/'test_dependency_guards.py']),
            ('postgres-guards', [runner/'test_postgres_harness.py']),
            ('runtime-config', [runner/'test_runtime_config.py']),
            ('staging-config', [runner/'test_staging_config.py']),
            ('service-guards', [runner/'test_systemd_service_guards.py']),
            ('backup-media-guards', [runner/'test_backup_media.py']),
            ('runtime-settings', [runner/'check_runtime_settings.py']),
            ('gunicorn', [runner/'check_gunicorn_runtime.py']),
            ('sqlite', [runner/'run_backend_tests.py']),
            ('schema', [runner/'run_backend_tests.py', '--check-schema']),
            ('postgres-release', [runner/'run_postgres_tests.py', '--pg-bin', pg_bin, '--mode', 'release']),
            ('postgres-tests', [runner/'run_postgres_tests.py', '--pg-bin', pg_bin, '--mode', 'tests']),
        ]
        for name, arguments in commands:
            log = output/(name+'.log')
            with log.open('xb') as stream:
                result = subprocess.run([sys.executable, *map(str, arguments)], cwd=extracted,
                                        env=env, stdout=stream, stderr=stream, timeout=900)
            log.chmod(0o600)
            entry = {'name': name, 'returncode': result.returncode,
                     'log_sha256': hashlib.sha256(log.read_bytes()).hexdigest()}
            report['checks'].append(entry)
            require(result.returncode == 0, 'Packaged check failed: '+name+'; see private log')
            if name.startswith('postgres-') and name != 'postgres-guards':
                found = re.search(r'^Private test cluster artifacts: (.+)$', log.read_text(), re.M)
                require(found is not None, 'Private PostgreSQL evidence missing')
                cluster = Path(found[1])
                require(cluster.name.startswith('tt-pg-') and not cluster.is_symlink(), 'Unexpected cluster evidence')
                entry['results'] = json.loads((cluster/'results.json').read_text())
                entry['cluster_path'] = str(cluster)
                entry['stopped'] = json.loads((cluster/'stopped.json').read_text())['stopped']
                require(entry['stopped'] is True, 'Private PostgreSQL cluster did not stop')
        verify_directory(extracted, revision)
        report.update(passed=True, packaged_files_unchanged=True, files=len(manifest['files']),
                      core_migration_leaf=manifest['schema']['leaf'], build=manifest['build'])
    finally:
        fd = os.open(output/'report.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as stream:
            json.dump(report, stream, indent=2)
            stream.write('\n')
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--revision', required=True)
    parser.add_argument('--pg-bin', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    result = check(args.archive, args.sha256, args.revision, args.pg_bin, args.output_dir)
    print(json.dumps({'passed': result['passed'], 'checks': len(result['checks']),
                      'files': result['files'], 'deployment_enabled': False}, indent=2))


if __name__ == '__main__':
    main()
