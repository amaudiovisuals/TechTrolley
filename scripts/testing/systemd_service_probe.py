"""Disposable LOCAL VM service exercise, never a production installer.

Requires Linux root, the exact local-vm sentinel/nonce, no business data permission,
and an independently verified review bundle. Fixed new names/paths, offline wheels
only. Does not accept a host, DSN, existing credentials or arbitrary service name.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import grp
import secrets
import shutil
import socket
import ssl
import subprocess
import sys
import time

ROOT=Path('/srv/techtrolley-staging')
STATE=Path('/var/lib/tt-service-checks')
DBBIN=Path('/usr/lib/postgresql/16/bin')


def require(ok,message):
    if not ok:raise ValueError(message)


def guard(nonce):
    require(sys.platform=='linux' and os.geteuid()==0,'Only Linux root inside the disposable local VM is supported')
    sentinel=Path('/etc/techtrolley-local-vm.json')
    require(sentinel.is_file() and not sentinel.is_symlink() and sentinel.stat().st_uid==0 and
            sentinel.stat().st_mode & 0o077==0,'Private local VM identity required')
    identity=json.loads(sentinel.read_text())
    require(identity.get('protocol')=='tt-local-synthetic-vm-1' and identity.get('nonce')==nonce and
            identity.get('business_data_allowed') is False,'Wrong VM identity or data boundary')


def run(*args,**kwargs):
    return subprocess.run(list(map(str,args)),check=True,**kwargs)


def write(path,data,mode=0o640,group='root'):
    path=Path(path);require(not path.is_symlink(),'Symlink output refused')
    path.write_text(data);os.chown(path,0,grp.getgrnam(group).gr_gid);path.chmod(mode)


def mkdir(path,mode=0o750,user='root',group='tt-staging-web'):
    path=Path(path);path.mkdir(mode=mode,parents=True,exist_ok=True)
    require(not path.is_symlink(),'Symlink directory refused')
    os.chown(path,pwd.getpwnam(user).pw_uid,grp.getgrnam(group).gr_gid);path.chmod(mode)


def config_env(path):
    return dict(line.split('=',1) for line in Path(path).read_text().splitlines() if line and not line.startswith('#'))


def django_code(source,code,envfile):
    env={'PATH':os.defpath,'PYTHONDONTWRITEBYTECODE':'1',**config_env(envfile), 'DJANGO_SETTINGS_MODULE':'config.settings',
         'PYTHONPATH':str(source/'backend')}
    try:
        return run(ROOT/'venvs'/source.name/'bin/python','-c',code,env=env,cwd=source/'backend',capture_output=True,text=True)
    except subprocess.CalledProcessError as error:
        sys.stderr.write(error.stderr or 'Private VM Django check failed')
        raise


def configure(source):
    sys.path.insert(0,str(source/'scripts/deployment'))
    import staging_config
    revision=json.loads((source/'release-manifest.json').read_text())['revision']
    values={'hostname':'staging.example.test','root':str(ROOT),'revision':revision,
            'allowed_cidrs':['127.0.0.1/32'],'public_https_port':24443}
    packet=staging_config.render(values)
    for name in ['nginx.conf','gunicorn.conf.py']:write(ROOT/'config'/name,packet[name],group='tt-staging-web')
    for name in ['tt-staging-app.service','tt-staging-proxy.service','tt-staging-close.service']:
        write(Path('/etc/systemd/system')/name,packet[name],mode=0o644)
    run('systemd-analyze','verify','--man=no',*[str(Path('/etc/systemd/system')/n) for n in
        ['tt-staging-app.service','tt-staging-proxy.service','tt-staging-close.service','tt-staging-db.service']],capture_output=True)
    run('systemctl','daemon-reload')
    return packet


def install(archive,digest,revision,wheels):
    require(not ROOT.exists() and not STATE.exists(),'Fresh VM site/check directory required; no overlay or reset')
    for name in ['tt-staging','tt-staging-proxy','tt-staging-db']:
        try:pwd.getpwnam(name)
        except KeyError:pass
        else:raise ValueError('Test account already exists')
    sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'deployment'))
    import release_bundle as bundle
    # Verify trusted package before creating accounts, folders or changing services.
    manifest,_=bundle.verify(archive,digest,revision)
    require(manifest['schema']['leaf']=='0066_credential_attempt','Unexpected synthetic schema')
    require(wheels.is_dir() and not wheels.is_symlink() and len(list(wheels.glob('*.whl')))==23,'Reviewed offline wheel directory required')
    os.umask(0o077);run('groupadd','--system','tt-staging-web')
    for name in ['tt-staging','tt-staging-proxy','tt-staging-db']:
        run('useradd','--system','--user-group','--no-create-home','--shell','/usr/sbin/nologin',name)
    run('usermod','-a','-G','tt-staging-web','tt-staging')
    run('usermod','-a','-G','tt-staging-web','tt-staging-proxy')
    run('usermod','-a','-G','tt-staging-web','tt-staging-db')
    mkdir(ROOT);mkdir(STATE,0o700,group='root')
    for name in ['releases','venvs','config','run','collected-static','immutable-assets']:mkdir(ROOT/name)
    mkdir(ROOT/'run/app',user='tt-staging');mkdir(ROOT/'private-media',0o700,user='tt-staging',group='tt-staging')
    mkdir(ROOT/'app-temp',0o700,user='tt-staging',group='tt-staging')
    mkdir(ROOT/'run/proxy',0o700,user='tt-staging-proxy',group='tt-staging-proxy')
    for name in ['logs','proxy-temp','proxy-temp/client','proxy-temp/upstream']:
        mkdir(ROOT/name,0o700,user='tt-staging-proxy',group='tt-staging-proxy')
    mkdir(ROOT/'tls',group='tt-staging-proxy')
    mkdir(ROOT/'database',0o700,user='tt-staging-db',group='tt-staging-db')
    mkdir(ROOT/'run/db',user='tt-staging-db')
    source=ROOT/'releases'/revision;bundle.extract(archive,digest,revision,source)
    venv=ROOT/'venvs'/revision
    run('/usr/bin/python3.12','-m','venv',venv,capture_output=True)
    run(ROOT/'venvs'/source.name/'bin/python','-m','pip','install','--no-index','--find-links',wheels,'--require-hashes','-r',source/'backend/requirements.txt',capture_output=True)
    for directory,folders,files in [*os.walk(source),*os.walk(venv)]:
        path=Path(directory);os.chown(path,0,grp.getgrnam('tt-staging-web').gr_gid);path.chmod(0o750)
        for name in files:
            p=path/name
            if p.is_symlink():continue
            old=p.stat().st_mode;os.chown(p,0,grp.getgrnam('tt-staging-web').gr_gid);p.chmod(0o640 | (old & 0o110))
    (ROOT/'current').symlink_to('releases/'+revision,target_is_directory=True)
    for p in (source/'frontend/dist/assets').iterdir():
        require(p.is_file() and not p.is_symlink(),'Only regular hashed assets accepted')
        shutil.copyfile(p,ROOT/'immutable-assets'/p.name);os.chown(ROOT/'immutable-assets'/p.name,0,grp.getgrnam('tt-staging-web').gr_gid);(ROOT/'immutable-assets'/p.name).chmod(0o640)
    run('runuser','-u','tt-staging-db','--',DBBIN/'initdb','-D',ROOT/'database','--auth-local=peer','--auth-host=scram-sha-256',capture_output=True)
    with (ROOT/'database/postgresql.conf').open('a') as out:
        out.write("\nlisten_addresses = ''\nport = 55441\nunix_socket_directories = '"+str(ROOT/ 'run/db')+"'\nunix_socket_permissions = 0770\n")
    # Admin socket uses peer identity; application/migrator require independent passwords.
    hba=ROOT/'database/pg_hba.conf';hba.write_text('local all tt-staging-db peer\nlocal all all scram-sha-256\n')
    write(Path('/etc/systemd/system/tt-staging-db.service'),f'''[Unit]
Description=Disposable local-only synthetic staging PostgreSQL
After=local-fs.target
[Service]
Type=simple
User=tt-staging-db
Group=tt-staging-web
ExecStart={DBBIN}/postgres -D {ROOT}/database
KillSignal=SIGINT
TimeoutStopSec=45
MemoryMax=768M
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths={ROOT}/database {ROOT}/run/db
[Install]
WantedBy=multi-user.target
''',0o644)
    run('systemctl','daemon-reload');run('systemctl','start','tt-staging-db.service')
    admin=['runuser','-u','tt-staging-db','--',str(DBBIN/'psql'),'-h',str(ROOT/'run/db'),'-p','55441','-d','postgres','-v','ON_ERROR_STOP=1']
    for attempt in range(50):
        ready=subprocess.run([str(DBBIN/'pg_isready'),'-h',str(ROOT/'run/db'),'-p','55441'],capture_output=True)
        if ready.returncode==0:break
        time.sleep(.1)
    app_password=secrets.token_urlsafe(36);migration_password=secrets.token_urlsafe(36)
    # Token URL-safe passwords contain no SQL quoting or interpolation characters.
    sql=("CREATE ROLE tt_stage_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '"+app_password+"';\n"
         "CREATE ROLE tt_stage_migrate LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '"+migration_password+"';\n"
         "GRANT pg_read_all_stats TO tt_stage_migrate;\nCREATE DATABASE tt_service_staging OWNER tt_stage_migrate;\n")
    run(*admin,input=sql,text=True,capture_output=True)
    mkdir(Path('/etc/techtrolley-staging'),0o700,group='root')
    env={'PATH':os.defpath,'DJANGO_ENV':'staging','DJANGO_DEBUG':'false','DJANGO_SECRET_KEY':secrets.token_urlsafe(64),
         'DJANGO_ALLOWED_HOSTS':'staging.example.test','TT_APP_ORIGIN':'https://staging.example.test:24443',
         'TT_INSTANCE_ID':'local-systemd-synthetic-8b8','TT_DB_NAME':'tt_service_staging','TT_DB_USER':'tt_stage_app',
         'TT_DB_PASSWORD':app_password,'TT_DB_HOST':str(ROOT/'run/db'),'TT_DB_PORT':'55441',
         'TT_MEDIA_ROOT':str(ROOT/'private-media'),'TT_STATIC_ROOT':str(ROOT/'collected-static'),
         'TT_EXTERNAL_AI_ENABLED':'false','TT_TRUST_PROXY':'true','TT_PROXY_HEADER_SANITIZED':'true','TT_PROXY_CLIENT_IP_FROM_UNIX':'true'}
    envfile=Path('/etc/techtrolley-staging/runtime.env');write(envfile,''.join(k+'='+v+'\n' for k,v in env.items()),0o600)
    migration_env={**env,'TT_DB_USER':'tt_stage_migrate','TT_DB_PASSWORD':migration_password}
    write(STATE/'migration.env',''.join(k+'='+v+'\n' for k,v in migration_env.items()),0o600)
    django_code(source,"import django;django.setup();from django.core.management import call_command;call_command('migrate',verbosity=0,interactive=False)",STATE/'migration.env')
    grants="GRANT CONNECT ON DATABASE tt_service_staging TO tt_stage_app;"
    run(*admin,input=grants,text=True,capture_output=True)
    dbadmin=[*admin];dbadmin[dbadmin.index('postgres')]='tt_service_staging'
    run(*dbadmin,input='GRANT USAGE ON SCHEMA public TO tt_stage_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO tt_stage_app; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO tt_stage_app;',text=True,capture_output=True)
    tlsconfig='[req]\ndistinguished_name=dn\nx509_extensions=v3\n[dn]\n[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n'
    write(STATE/'tls.conf',tlsconfig,0o600)
    run('openssl','req','-config',STATE/'tls.conf','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=staging.example.test','-addext','subjectAltName=DNS:staging.example.test','-keyout',ROOT/'tls/privkey.pem','-out',ROOT/'tls/fullchain.pem',capture_output=True)
    for name in ['privkey.pem','fullchain.pem']:
        path=ROOT/'tls'/name;os.chown(path,0,grp.getgrnam('tt-staging-proxy').gr_gid);path.chmod(0o640)
    packet=configure(source)
    write(STATE/'identity.json',json.dumps({'revision':revision,'archive_sha256':digest,'source':str(source),'synthetic_only':True,'database':'tt_service_staging'},indent=2)+'\n',0o600)
    return source


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--vm-nonce',required=True)
    parser.add_argument('--archive',type=Path,required=True);parser.add_argument('--sha256',required=True)
    parser.add_argument('--revision',required=True);parser.add_argument('--wheels',type=Path,required=True)
    args=parser.parse_args();guard(args.vm_nonce)
    source=install(args.archive,args.sha256,args.revision,args.wheels)
    print(json.dumps({'installed_in_disposable_vm':True,'production_installer':False,'revision':args.revision,
                      'services_not_opened_automatically':True,'source':str(source)}))


if __name__=='__main__':main()
