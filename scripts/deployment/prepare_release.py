"""Create review metadata for a clean exact Git revision and built frontend.

No deployment, SSH, migrations, source reset or business data operations.
"""
import argparse
import hashlib
import json
import os
import platform
from importlib.metadata import version
from pathlib import Path
import re
import subprocess

ROOT=Path(__file__).resolve().parents[2]
REQUIRED_SOURCES = ['backend/manage.py', 'backend/requirements.txt',
    'backend/requirements.in', 'backend/requirements.lock', 'frontend/package.json',
    'frontend/package-lock.json', 'frontend/vite.config.ts',
    'frontend/vendor/xlsx-0.20.3.tgz', 'frontend/vendor/sheetjs-provenance.json']


def git(root,*args):
    return subprocess.check_output(['git','-C',str(root),*args],text=True).strip()


def candidate(root,revision,git_read=git):
    root=Path(root).resolve()
    if not re.fullmatch(r'[0-9a-f]{40}',revision):raise ValueError('An exact full Git commit is required')
    if git_read(root,'rev-parse','HEAD')!=revision:raise ValueError('Checkout does not match the requested revision')
    if git_read(root,'status','--porcelain','--untracked-files=normal'):raise ValueError('Candidate requires a clean committed source tree')
    tracked=set(git_read(root,'ls-files').splitlines())
    source={}
    for area in ['backend/config','backend/core']:
        for path in sorted((root/area).rglob('*.py')):
            name=path.relative_to(root).as_posix()
            if path.is_symlink() or name not in tracked:raise ValueError('Backend source is not a regular tracked file')
            source[name]=hashlib.sha256(path.read_bytes()).hexdigest()
    for name in REQUIRED_SOURCES:
        path=root/name
        if name not in tracked or not path.is_file() or path.is_symlink():raise ValueError('Required tracked release source is missing')
        source[name]=hashlib.sha256(path.read_bytes()).hexdigest()
    if not source or not (root/'backend/core/models.py').is_file():raise ValueError('Backend source is incomplete')
    dist=root/'frontend/dist';assets={}
    if dist.is_symlink():raise ValueError('Symlink build directories are refused')
    if not (dist/'index.html').is_file() or not (dist/'sw.js').is_file():raise ValueError('A fresh complete frontend build is required')
    for path in sorted(dist.rglob('*')):
        if path.is_symlink():raise ValueError('Symlinks are refused in release output')
        if not path.is_file():continue
        name=path.relative_to(dist).as_posix()
        if any(part.startswith('.') for part in Path(name).parts) or path.suffix.lower() in {'.pem','.key','.sqlite3','.sql','.dump','.bak','.xlsx','.csv','.map'}:
            raise ValueError('Unexpected private/source file in frontend build')
        assets[name]=hashlib.sha256(path.read_bytes()).hexdigest()
    # Read identity again after hashing; concurrent source edits cannot pass.
    if git_read(root,'status','--porcelain','--untracked-files=normal') or git_read(root,'rev-parse','HEAD')!=revision:
        raise ValueError('Source changed while preparing candidate')
    return {'format':'techtrolley-release-candidate-1','revision':revision,
        'deployment_enabled':False,'business_operations_performed':False,
        'backend_source_sha256':source,'frontend_files_sha256':assets,
        'remaining_gates':['Private PDF/upload and password/token protections','Dependency/security review and credential rotation',
            'Controlled HTTPS staging and actual Linux/runtime/backup acceptance','Real phones/PWA/offline and C72 scope',
            'Reviewed activation/migration/recovery procedure and explicit production release review']}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--revision',required=True)
    parser.add_argument('--output',required=True,type=Path)
    parser.add_argument('--source-root',type=Path,default=ROOT)
    args=parser.parse_args()
    result=candidate(args.source_root,args.revision)
    result['toolchain']={'python':platform.python_version(),'django':version('Django'),'node':subprocess.check_output(['node','--version'],text=True).strip()}
    target=args.output.resolve();root=args.source_root.resolve()
    if root==target or root in target.parents:raise ValueError('Candidate metadata output must be outside the source tree')
    fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as output:json.dump(result,output,indent=2);output.write('\n')
    print('Review metadata created; deployment remains disabled.')


if __name__=='__main__':main()
