"""Synthetic HTTP/permission/drain/reboot checks for the sentinel-guarded local VM.

No host or credentials accepted. Must run as root inside the previously installed
private VM. Saved API tokens/passwords remain in its private check directory.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import http.client
import json
import os
from pathlib import Path
import pwd
import signal
import socket
import ssl
import subprocess
import sys
import time
import uuid

from systemd_service_probe import ROOT,STATE,guard,config_env,django_code,run,write


def load_state():return json.loads((STATE/'identity.json').read_text())
def source():return Path(load_state()['source'])
def record(checks,label,ok):
    if not ok:raise AssertionError(label)
    checks.append(label)


def request(path='/',method='GET',payload=None,token=None):
    context=ssl.create_default_context(cafile=str(ROOT/'tls/fullchain.pem'))
    body=json.dumps(payload).encode() if payload is not None else b''
    headers={'Host':'staging.example.test:24443','Connection':'close'}
    if payload is not None:headers.update({'Content-Type':'application/json','Content-Length':str(len(body))})
    if token:headers['Authorization']='Token '+token
    with socket.create_connection(('127.0.0.1',443),timeout=10) as raw:
        with context.wrap_socket(raw,server_hostname='staging.example.test') as client:
            client.sendall((method+' '+path+' HTTP/1.1\r\n'+''.join(k+': '+v+'\r\n' for k,v in headers.items())+'\r\n').encode()+body)
            response=http.client.HTTPResponse(client,method=method);response.begin()
            return response.status,dict((k.lower(),v) for k,v in response.getheaders()),response.read()


def data(response):
    if response[0]!=200:raise AssertionError('Unexpected synthetic API HTTP status '+str(response[0]))
    return json.loads(response[2])


def ready():
    for n in range(100):
        path=ROOT/'run/app/app.sock'
        try:
            with socket.socket(socket.AF_UNIX) as client:
                client.settimeout(1);client.connect(str(path))
                client.sendall(b'GET / HTTP/1.1\r\nHost: staging.example.test:24443\r\nX-Forwarded-Proto: https\r\nConnection: close\r\n\r\n')
                if client.recv(4096).startswith(b'HTTP/1.1 200'):return
        except OSError:pass
        time.sleep(.1)
    raise AssertionError('Synthetic WSGI readiness failed')


def open_reviewed_gate():
    identity=load_state();require=__import__('systemd_service_probe').require
    code="""import django;django.setup()
from django.db import connection
from django.db.migrations.loader import MigrationLoader
loader=MigrationLoader(connection);loader.check_consistent_history(connection)
assert set(loader.applied_migrations)==set(loader.graph.nodes)
with connection.cursor() as c:
 c.execute('SHOW listen_addresses');assert c.fetchone()[0]==''
 c.execute('SELECT current_database()');assert c.fetchone()[0]=='tt_service_staging'
"""
    django_code(source(),code,STATE/'migration.env')
    observed=subprocess.check_output(['runuser','-u','tt-staging-db','--','/usr/lib/postgresql/16/bin/psql','-h',str(ROOT/'run/db'),'-p','55441','-d','tt_service_staging','-At','-c','SHOW data_directory'],text=True).strip()
    require(observed==str(ROOT/'database'),'Unexpected private cluster directory')
    sys.path.insert(0,str(source()/'scripts/deployment'));import release_bundle
    release_bundle.verify_directory(source(),identity['revision'])
    ready();require((ROOT/'maintenance.flag').exists(),'Gate must already be closed')
    (ROOT/'maintenance.flag').unlink()  # Explicit privileged test-operator step, never service health auto-open.


def wait_closed_https():
    for n in range(50):
        try:
            response=request('/api/assets/')
        except ConnectionRefusedError:
            time.sleep(.1);continue
        if response[0]!=503:raise AssertionError('Ingress reopened during proxy startup')
        return response
    raise AssertionError('HTTPS proxy did not become ready')


def fixture():
    if (STATE/'fixture.json').exists():
        # Allow retry only after a pre-open failure, before any tested write.
        code="import django;django.setup();import json;from pathlib import Path;from core.models import MovementReceipt,ChallanDocument;f=json.loads(Path('/var/lib/tt-service-checks/fixture.json').read_text());assert not MovementReceipt.objects.filter(actor_id=f['actor_id']).exists() and not ChallanDocument.objects.filter(conference_id=f['event_id']).exists()"
        django_code(source(),code,STATE/'migration.env');fix_media_owner();return
    code="""import django;django.setup()
import json,secrets
from pathlib import Path
from django.contrib.auth.models import User
from core.models import Asset,Conference
from django.core.files.base import ContentFile
assert not User.objects.exclude(username__startswith='vm-service-admin').exists()
assert not Asset.objects.exclude(sku__startswith='VM-SERVICE').exists()
suffix=secrets.token_hex(4)
password=secrets.token_urlsafe(30)
u=User.objects.create_user('vm-service-admin-'+suffix,email='vm-service-'+suffix+'@example.test',password=password)
u.profile.role='admin';u.profile.save()
a=Asset.objects.create(sku='VM-SERVICE-CABLE-'+suffix,quantity=1)
e=Conference.objects.create(name='Synthetic service restart',challan_number='VM-8B8-'+suffix)
e.pdf_document.save('vm-service.pdf',ContentFile(b'%PDF-1.4\\nSynthetic private PDF\\n%%EOF'),save=True)
p=Path('/var/lib/tt-service-checks/fixture.json');p.write_text(json.dumps({'email':u.email,'password':password,'actor_id':u.pk,'asset_id':a.pk,'event_id':e.pk,'number':e.challan_number}));p.chmod(0o600)
"""
    django_code(source(),code,STATE/'migration.env');fix_media_owner()


def fix_media_owner():
    user=pwd.getpwnam('tt-staging')
    for directory,folders,files in os.walk(ROOT/'private-media'):
        os.chown(directory,user.pw_uid,user.pw_gid);Path(directory).chmod(0o700)
        for name in files:
            path=Path(directory)/name
            if path.is_symlink():raise AssertionError('Synthetic media symlink refused')
            os.chown(path,user.pw_uid,user.pw_gid);path.chmod(0o600)


def root_db():
    env=config_env(STATE/'migration.env')
    sys.path.insert(0,str(ROOT/'venvs'/source().name/'lib/python3.12/site-packages'))
    import psycopg2
    return psycopg2.connect(dbname=env['TT_DB_NAME'],user=env['TT_DB_USER'],password=env['TT_DB_PASSWORD'],host=env['TT_DB_HOST'],port=env['TT_DB_PORT'])


def replay_and_verify(checks,phase):
    state=json.loads((STATE/'api-state.json').read_text());f=json.loads((STATE/'fixture.json').read_text());token=state['token']
    read=data(request(f"/api/conferences/{f['event_id']}/challan-documents/master/",token=token))
    record(checks,phase+'_manual_challan_exactly_retained',read['document']==state['document'])
    replay=data(request(f"/api/conferences/{f['event_id']}/asset-commands/",'POST',state['command'],token))
    record(checks,phase+'_original_scan_uuid_replays_once',replay['replayed'] is True)
    with root_db() as db,db.cursor() as cursor:
        cursor.execute('SELECT count(*) FROM core_movementreceipt WHERE actor_id=%s AND request_id=%s',[f['actor_id'],state['command']['request_id']])
        record(checks,phase+'_single_original_receipt',cursor.fetchone()[0]==1)
        cursor.execute('SELECT count(*) FROM core_conference_staged_assets WHERE conference_id=%s AND asset_id=%s',[f['event_id'],f['asset_id']])
        record(checks,phase+'_original_asset_relation_retained',cursor.fetchone()[0]==1)


def baseline():
    checks=[];run('systemctl','start','tt-staging-app.service','tt-staging-proxy.service');ready()
    record(checks,'initial_start_closes_maintenance',request('/api/assets/')[0]==503 and (ROOT/'maintenance.flag').exists())
    for user,path in [('tt-staging',ROOT/'config/nginx.conf'),('tt-staging',ROOT/'maintenance.flag'),('tt-staging-proxy',ROOT/'run/app'),('tt-staging-proxy',ROOT/'current')]:
        record(checks,'cannot_write_'+user+'_'+path.name,subprocess.run(['runuser','-u',user,'--','test','-w',str(path)]).returncode!=0)
    for user,path in [('tt-staging-proxy',ROOT/'private-media'),('tt-staging-proxy',Path('/etc/techtrolley-staging/runtime.env')),('tt-staging',ROOT/'tls/privkey.pem')]:
        record(checks,'cannot_read_'+user+'_'+path.name,subprocess.run(['runuser','-u',user,'--','test','-r',str(path)]).returncode!=0)
    record(checks,'app_can_write_private_media',subprocess.run(['runuser','-u','tt-staging','--','test','-w',str(ROOT/'private-media')]).returncode==0)
    for service,expected in [('tt-staging-app',1536*1024**2),('tt-staging-proxy',256*1024**2)]:
        value=subprocess.check_output(['systemctl','show',service,'-p','MemoryMax','--value'],text=True).strip()
        record(checks,service+'_memory_bound_effective',int(value)==expected)
    record(checks,'master_led_graceful_stop_mode',subprocess.check_output(['systemctl','show','tt-staging-app','-p','KillMode','--value'],text=True).strip()=='mixed')
    fixture();open_reviewed_gate()
    f=json.loads((STATE/'fixture.json').read_text());token=data(request('/api/login/','POST',{'email':f['email'],'password':f['password']}))['token']
    record(checks,'actual_systemd_https_login_and_token_read',request('/api/assets/',token=token)[0]==200)
    record(checks,'anonymous_private_pdf_denied',request(f"/api/conferences/{f['event_id']}/download-pdf/")[0] in {401,403})
    pdf=request(f"/api/conferences/{f['event_id']}/download-pdf/",token=token)
    record(checks,'authenticated_pdf_allowed_private_cache',pdf[0]==200 and pdf[2].startswith(b'%PDF') and 'no-store' in pdf[1].get('cache-control',''))
    record(checks,'raw_storage_admin_source_denied',all(request(p)[0]==404 for p in ['/media/conference_pdfs/vm-service.pdf','/admin/','/.env','/backend/config/settings.py']))
    line={'id':str(uuid.uuid4()),'asset_id':None,'ticket_item_id':None,'supplier_id':None,'source_kind':'manual',
          'snapshot':{'alias_name':'Manual cable retained through restart','sku':'MANUAL-VM','serial_number':'-'},'quantity':2,'unit_value':'12.50'}
    event_revision=data(request(f"/api/conferences/{f['event_id']}/",token=token))['revision']
    payload={'request_id':str(uuid.uuid4()),'expected_revision':0,'expected_event_revision':event_revision,'lines':[line],
             'number':f['number'],'total_override':None,'document_date':'2026-10-16','state':'draft','correction_reason':''}
    document=data(request(f"/api/conferences/{f['event_id']}/challan-documents/master/",'PUT',payload,token))['document']
    command={'request_id':str(uuid.uuid4()),'action':'stage','asset_ids':[f['asset_id']]}
    write(STATE/'api-state.json',json.dumps({'token':token,'document':document,'command':command})+'\n',0o600)
    # Deliberately block an actual write on a row lock, then gracefully stop its
    # master while the worker is in flight. No test endpoint or WSGI wrapper.
    lock=root_db();lock.autocommit=False
    with lock.cursor() as cursor:cursor.execute('SELECT id FROM core_asset WHERE id=%s FOR UPDATE',[f['asset_id']])
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending=pool.submit(request,f"/api/conferences/{f['event_id']}/asset-commands/",'POST',command,token)
            observed=False
            for n in range(100):
                with root_db() as db,db.cursor() as cursor:
                    cursor.execute("SELECT count(*) FROM pg_stat_activity WHERE usename='tt_stage_app' AND wait_event_type='Lock'")
                    observed=cursor.fetchone()[0]>0
                if observed:break
                time.sleep(.05)
            record(checks,'real_inflight_scan_observed_waiting_on_row_lock',observed)
            run('systemctl','start','tt-staging-close.service')
            record(checks,'new_requests_blocked_before_worker_drain',request('/api/assets/',token=token)[0]==503)
            stop=subprocess.Popen(['systemctl','stop','tt-staging-app.service'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            for n in range(100):
                if subprocess.check_output(['systemctl','show','tt-staging-app','-p','ActiveState','--value'],text=True).strip()=='deactivating':break
                time.sleep(.02)
            lock.commit();response=pending.result(timeout=15);stop.wait(timeout=20)
            record(checks,'graceful_master_stop_finishes_inflight_scan',response[0]==200 and stop.returncode==0)
    finally:lock.close()
    run('systemctl','start','tt-staging-app.service');ready()
    record(checks,'application_restart_stays_closed_until_operator_review',request('/api/assets/',token=token)[0]==503)
    open_reviewed_gate();replay_and_verify(checks,'restart')
    # Least-privilege runtime can read/write application data but cannot add schema.
    env=config_env('/etc/techtrolley-staging/runtime.env')
    import psycopg2
    db=psycopg2.connect(dbname=env['TT_DB_NAME'],user=env['TT_DB_USER'],password=env['TT_DB_PASSWORD'],host=env['TT_DB_HOST'],port=env['TT_DB_PORT'])
    try:
        with db.cursor() as c:
            c.execute("SELECT has_schema_privilege(current_user,'public','CREATE'), rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user")
            record(checks,'runtime_database_has_no_ddl_or_role_privileges',c.fetchone()==(False,False,False,False))
    finally:db.close()
    run('systemctl','restart','tt-staging-proxy.service')
    record(checks,'proxy_restart_closes_existing_api_access',wait_closed_https()[0]==503)
    run('systemctl','enable','tt-staging-db.service','tt-staging-app.service','tt-staging-proxy.service',capture_output=True)
    open_reviewed_gate()
    record(checks,'pre_reboot_api_open_only_after_review',request('/api/assets/',token=token)[0]==200)
    write(STATE/'before-reboot.json',json.dumps({'boot_id':Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'checks':checks},indent=2)+'\n',0o600)
    return checks


def after_reboot():
    before=json.loads((STATE/'before-reboot.json').read_text());checks=[]
    record(checks,'actual_guest_boot_id_changed',Path('/proc/sys/kernel/random/boot_id').read_text().strip()!=before['boot_id'])
    ready()
    record(checks,'booted_systemd_services_active',all(subprocess.run(['systemctl','is-active','--quiet',s]).returncode==0 for s in ['tt-staging-db','tt-staging-app','tt-staging-proxy']))
    record(checks,'reboot_never_automatically_reopens_ingress',request('/api/assets/')[0]==503 and (ROOT/'maintenance.flag').exists())
    open_reviewed_gate();replay_and_verify(checks,'reboot')
    pid=int(subprocess.check_output(['systemctl','show','tt-staging-app','-p','MainPID','--value'],text=True))
    status=Path('/proc/'+str(pid)+'/status').read_text()
    record(checks,'application_runs_unprivileged_with_no_new_privileges',
           'NoNewPrivs:\t1' in status and 'Uid:\t'+str(pwd.getpwnam('tt-staging').pw_uid) in status)
    mounts=[]
    for line in Path('/proc/'+str(pid)+'/mountinfo').read_text().splitlines():
        fields=line.split();mounts.append((Path(fields[4]),set(fields[5].split(','))))
    def readonly(path):
        options=max((m for m in mounts if m[0]==path or m[0] in path.parents),key=lambda m:len(m[0].parts))[1]
        return 'ro' in options
    record(checks,'actual_unit_mount_namespace_keeps_release_readonly',readonly(source()))
    record(checks,'actual_unit_mount_namespace_keeps_private_media_writable',not readonly(ROOT/'private-media'))
    os.kill(pid,signal.SIGKILL)  # Disposable service only; exercise its failure gate/restart.
    changed=False
    for n in range(150):
        new=int(subprocess.check_output(['systemctl','show','tt-staging-app','-p','MainPID','--value'],text=True).strip() or '0')
        changed=new>0 and new!=pid
        if changed and (ROOT/'maintenance.flag').exists():break
        time.sleep(.05)
    record(checks,'unexpected_master_failure_restarts_with_new_pid',changed)
    ready()
    record(checks,'automatic_restart_remains_closed',request('/api/assets/')[0]==503 and (ROOT/'maintenance.flag').exists())
    open_reviewed_gate();replay_and_verify(checks,'failure_recovery')
    run('systemctl','start','tt-staging-close.service');run('systemctl','stop','tt-staging-app.service','tt-staging-proxy.service','tt-staging-db.service')
    record(checks,'all_test_services_stopped_with_maintenance_retained',all(subprocess.run(['systemctl','is-active','--quiet',s]).returncode!=0 for s in ['tt-staging-db','tt-staging-app','tt-staging-proxy']) and (ROOT/'maintenance.flag').exists())
    result={'passed':len(before['checks'])+len(checks),'checks':before['checks']+checks,'actual_systemd_services':True,
            'actual_app_https_postgresql':True,'actual_guest_reboot':True,'all_test_services_stopped':True,'business_data_used':False,
            'staff_phone_offline_or_production_certification':False}
    write(STATE/'results.json',json.dumps(result,indent=2)+'\n',0o600);return result


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--vm-nonce',required=True)
    parser.add_argument('--phase',choices=['baseline','after-reboot'],required=True);args=parser.parse_args();guard(args.vm_nonce)
    os.umask(0o077)
    print(json.dumps({'baseline_checks':len(baseline()),'reboot_pending':True} if args.phase=='baseline' else after_reboot(),indent=2))


if __name__=='__main__':main()
