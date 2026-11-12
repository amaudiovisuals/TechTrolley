"""Offline release checks for the single runtime lock and publisher XLSX archive.

No installation, registry query, settings import or database access. --installed
also checks the selected Python environment against every runtime pin.
"""
import argparse
import base64
import hashlib
import io
import json
from importlib.metadata import version
from pathlib import Path
import re
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[2]


def check(root=ROOT, installed=False):
    root = Path(root)
    lock = (root / 'backend/requirements.lock').read_text()
    pins = {}
    current = None
    hashes = {}
    for line in lock.splitlines():
        line = line.strip().rstrip('\\').strip()
        if not line or line.startswith('#'):
            continue
        pin = re.fullmatch(r'([A-Za-z0-9_.-]+)==([A-Za-z0-9_.]+)', line)
        if pin:
            current = pin[1].lower().replace('_', '-')
            assert current not in pins, 'Duplicate runtime package'
            pins[current] = pin[2]
            hashes[current] = []
        else:
            assert current and re.fullmatch(r'--hash=sha256:[0-9a-f]{64}', line), 'Unexpected runtime lock directive'
            hashes[current].append(line)
    assert pins and all(hashes.values()), 'Each exact runtime pin needs artifact hashes'
    direct = (root / 'backend/requirements.in').read_text()
    for line in direct.splitlines():
        if not line or line.startswith('#'):
            continue
        name, value = line.split('==')
        assert pins.get(name.lower().replace('_', '-')) == value, 'Direct runtime pin drift'
    wrappers = {
        'backend/requirements.txt': ['--require-hashes', '-r requirements.lock'],
        'scripts/testing/runtime-check-requirements.lock': ['--require-hashes', '-r ../../backend/requirements.lock'],
        'scripts/testing/runtime-check-requirements.in': ['-r ../../backend/requirements.in'],
    }
    for name, expected in wrappers.items():
        lines = [s.strip() for s in (root / name).read_text().splitlines() if s.strip() and not s.startswith('#')]
        assert lines == expected, 'Runtime installation/validation lock drift'
    manifest = json.loads((root / 'frontend/package.json').read_text())
    npm = json.loads((root / 'frontend/package-lock.json').read_text())['packages']
    assert all(not key or key.startswith('node_modules/') for key in npm), 'Nonportable npm lock path'
    for group in ('dependencies', 'devDependencies'):
        assert manifest[group] == npm[''][group], 'Frontend manifest/lock drift'
        for name, pin in manifest[group].items():
            actual = npm['node_modules/' + name]
            if name == 'xlsx':
                assert pin == 'file:vendor/xlsx-0.20.3.tgz' and actual['version'] == '0.20.3'
            else:
                assert re.fullmatch(r'\d+\.\d+\.\d+', pin) and pin == actual['version'], 'Frontend direct dependencies must be exact'
    peer_options = [s.strip() for s in (root / 'frontend/.npmrc').read_text().splitlines()
                    if s.strip() and not s.lstrip().startswith('#')]
    assert peer_options == ['legacy-peer-deps=false'], 'Unexpected npm install policy'
    assert 'sharp' in manifest['devDependencies'] and 'sharp' not in manifest['dependencies']
    for name in ('workbox-core', 'workbox-precaching', 'workbox-routing', 'workbox-strategies', 'workbox-expiration'):
        assert name in manifest['dependencies'], 'Worker import must be declared directly'
    provenance = json.loads((root / 'frontend/vendor/sheetjs-provenance.json').read_text())
    archive = (root / 'frontend/vendor/xlsx-0.20.3.tgz').read_bytes()
    assert provenance['source'] == 'https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz'
    assert hashlib.sha256(archive).hexdigest() == provenance['sha256'], 'Publisher archive SHA256 drift'
    integrity = 'sha512-' + base64.b64encode(hashlib.sha512(archive).digest()).decode()
    assert integrity == provenance['integrity'] == npm['node_modules/xlsx']['integrity'], 'Publisher archive npm integrity drift'
    with tarfile.open(fileobj=io.BytesIO(archive)) as contents:
        assert all(m.isfile() and m.name.startswith('package/') and '..' not in Path(m.name).parts for m in contents), 'Unsafe publisher archive member'
        package = json.load(contents.extractfile('package/package.json'))
        assert package['name'] == 'xlsx' and package['version'] == '0.20.3' and package['license'] == 'Apache-2.0'
        assert not any(x in package.get('scripts', {}) for x in ('preinstall', 'install', 'postinstall')), 'Unexpected publisher install script'
    if installed:
        assert sys.version_info[:2] == (3, 12), 'Candidate baseline requires Python3.12'
        for name, pin in pins.items():
            assert version(name) == pin, 'Installed runtime differs: ' + name
    return {'runtime_packages': len(pins), 'runtime_artifact_hashes': sum(map(len, hashes.values())),
            'frontend_direct_packages': sum(len(manifest[x]) for x in ('dependencies', 'devDependencies')),
            'publisher_archive_verified': True, 'installed_runtime_checked': installed,
            'business_database_used': False, 'registry_access': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--installed', action='store_true')
    args = parser.parse_args()
    print(json.dumps(check(installed=args.installed), indent=2))
