"""Actual loopback TLS Nginx -> private Unix Gunicorn -> guarded Django checks.

Synthetic files/credentials only. Every DB connection is refused. No downloads,
SSH, system installation, existing service changes or business DB inputs accepted.
Requires separately reviewed Nginx/OpenSSL executables. Linux/systemd not certified.
"""
import argparse
import http.client
import json
import os
from pathlib import Path
import signal
import socket
import ssl
import subprocess
import sys
import time

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts/deployment'))
import staging_config


def check(nginx, openssl, output):
    output=Path(output)
    staging_config.require(output.is_absolute() and output.resolve()==output and not output.exists(), 'Fresh canonical output required')
    staging_config.require(output.parent.is_dir() and output.parent.stat().st_mode & 0o077==0 and
                           output.parent.stat().st_uid==os.getuid() and ROOT not in output.parents,
                           'Owned private parent outside checkout required')
    output.mkdir(mode=0o700)
    site=output/'site-staging';site.mkdir(mode=0o700)
    for name in ['run/app','run/proxy','logs','proxy-temp/client','proxy-temp/upstream','private-media','collected-static','app-temp',
                 'immutable-assets','tls','config','releases/one/frontend/dist','releases/two/frontend/dist']:
        (site/name).mkdir(mode=0o700,parents=True,exist_ok=True)
    old=site/'releases/one/frontend/dist';new=site/'releases/two/frontend/dist'
    (old/'index.html').write_text('<html>synthetic old shell</html>')
    (new/'index.html').write_text('<html>synthetic new shell</html>')
    for folder in [old,new]:
        (folder/'sw.js').write_text('// synthetic worker policy probe')
        (folder/'manifest.webmanifest').write_text('{"name":"synthetic"}')
    (site/'immutable-assets/old-aaaaaaaa.js').write_text('synthetic old chunk')
    (site/'immutable-assets/new-bbbbbbbb.js').write_text('synthetic new chunk')
    # Even a bad/manual asset-store insertion may not be followed to private storage.
    private=site/'private-media/private.pdf';private.write_text('private synthetic marker')
    (site/'immutable-assets/leak-cccccccc.js').symlink_to(private)
    (site/'current').symlink_to(old.parents[1],target_is_directory=True)
    cert=site/'tls/fullchain.pem';key=site/'tls/privkey.pem'
    tls_config=site/'tls/request.conf'
    tls_config.write_text('[req]\ndistinguished_name=dn\nx509_extensions=v3\n[dn]\n[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n')
    with (output/'tls-generation.log').open('wb') as log:
        subprocess.run([str(openssl),'req','-config',str(tls_config),'-x509','-newkey','rsa:2048','-nodes','-days','1',
                        '-subj','/CN=staging.example.test','-addext','subjectAltName=DNS:staging.example.test',
                        '-keyout',str(key),'-out',str(cert)],stdout=log,stderr=log,check=True)
    os.chmod(key,0o600)
    wrapper=output/'guarded_proxy_wsgi.py'
    wrapper.write_text('''from unittest.mock import patch
from pathlib import Path
import json

def refuse(*args, **kwargs):
    Path(__file__).with_suffix('.db-attempt').touch()
    raise AssertionError('All database connections forbidden')
guard = patch('django.db.backends.base.base.BaseDatabaseWrapper.ensure_connection', side_effect=refuse)
guard.start()
from config.wsgi import application as actual_application
from core.proxy_identity import credential_peer

def application(environ, start_response):
    if environ.get('PATH_INFO') == '/api/__proxy_probe__':
        marker=Path(__file__).with_suffix('.calls')
        with marker.open('a') as stream: stream.write('called\\n')
        body=json.dumps({'peer':credential_peer(environ), 'direct':environ.get('REMOTE_ADDR'),
            'authorization':environ.get('HTTP_AUTHORIZATION'), 'proto':environ.get('HTTP_X_FORWARDED_PROTO'),
            'xff':environ.get('HTTP_X_FORWARDED_FOR'), 'real':environ.get('HTTP_X_REAL_IP'),
            'forwarded':environ.get('HTTP_FORWARDED'), 'host':environ.get('HTTP_HOST'),
            'method':environ['REQUEST_METHOD']}).encode()
        start_response('200 OK',[('Content-Type','application/json'),('Content-Length',str(len(body)))])
        return [body]
    return actual_application(environ,start_response)
''')
    values={'hostname':'staging.example.test','root':str(site),'revision':'a'*40,'allowed_cidrs':['192.0.2.4/32'],'public_https_port':24443}
    packet=staging_config.render(values)
    (site/'config/gunicorn.conf.py').write_text(packet['gunicorn.conf.py'])
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1',0));port=reservation.getsockname()[1]
    conf=site/'config/nginx.conf'
    conf.write_text(staging_config.nginx_config(values,listen='127.0.0.1:'+str(port)))
    env={'PATH':os.defpath,'PYTHONDONTWRITEBYTECODE':'1','PYTHONPATH':str(output)+os.pathsep+str(ROOT/'backend'),
         'DJANGO_ENV':'staging','DJANGO_SECRET_KEY':'SyntheticProxyTest-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ-abcdefghijklmnopqrstuvwxyz',
         'DJANGO_ALLOWED_HOSTS':'staging.example.test','TT_APP_ORIGIN':'https://staging.example.test:24443',
         'TT_INSTANCE_ID':'proxy-isolated-test','TT_DB_NAME':'synthetic_staging','TT_DB_USER':'synthetic_role',
         'TT_DB_PASSWORD':'synthetic-only','TT_DB_HOST':'127.0.0.1','TT_DB_PORT':'1',
         'TT_MEDIA_ROOT':str(site/'private-media'),'TT_STATIC_ROOT':str(site/'collected-static'),
         'TT_TRUST_PROXY':'true','TT_PROXY_HEADER_SANITIZED':'true','TT_PROXY_CLIENT_IP_FROM_UNIX':'true'}
    context=ssl.create_default_context(cafile=str(cert))
    checks=[];processes=[]
    def record(label, condition):
        if not condition:raise AssertionError(label)
        checks.append(label)
    def request(path='/',method='GET',headers=None,body=b''):
        values={'Host':'staging.example.test:24443','Connection':'close',**(headers or {})}
        if body:values['Content-Length']=str(len(body))
        with socket.create_connection(('127.0.0.1',port),timeout=3) as raw:
            with context.wrap_socket(raw,server_hostname='staging.example.test') as client:
                client.sendall((method+' '+path+' HTTP/1.1\r\n'+''.join(k+': '+v+'\r\n' for k,v in values.items())+'\r\n').encode()+body)
                response=http.client.HTTPResponse(client,method=method);response.begin()
                return response.status,dict((k.lower(),v) for k,v in response.getheaders()),response.read()
    def await_status(expected):
        deadline=time.monotonic()+10
        while time.monotonic()<deadline:
            try:
                response=request('/api/__proxy_probe__')
                if response[0]==expected:return response
            except (OSError, http.client.HTTPException):pass
            if any(p.poll() is not None for p in processes):break
            time.sleep(0.05)
        raise AssertionError('Private proxy readiness failed; inspect private logs')
    try:
        with (output/'process.log').open('wb') as log:
            subprocess.run([str(nginx),'-t','-c',str(conf)],stdout=log,stderr=log,check=True)
            app=subprocess.Popen([sys.executable,'-m','gunicorn','--config',str(site/'config/gunicorn.conf.py'),
                                  '--workers','1','guarded_proxy_wsgi:application'],cwd=output,env=env,stdout=log,stderr=log)
            processes.append(app)
            deadline=time.monotonic()+15
            while not (site/'run/app/app.sock').exists() and app.poll() is None and time.monotonic()<deadline:time.sleep(0.05)
            record('actual_private_unix_socket', (site/'run/app/app.sock').is_socket())
            proxy=subprocess.Popen([str(nginx),'-c',str(conf),'-g','daemon off;'],env={'PATH':os.defpath},stdout=log,stderr=log)
            processes.append(proxy)
            record('unapproved_peer_api_denied',await_status(403)[0]==403)
            record('spoofed_forwarded_headers_cannot_bypass_access',request('/api/__proxy_probe__',headers={'X-Forwarded-For':'192.0.2.4','X-Real-IP':'192.0.2.4','X-TT-Client-IP':'192.0.2.4'})[0]==403)
            record('unapproved_peer_assets_denied',request('/assets/old-aaaaaaaa.js')[0]==403)
            values['allowed_cidrs']=['127.0.0.1/32'];conf.write_text(staging_config.nginx_config(values,listen='127.0.0.1:'+str(port)))
            subprocess.run([str(nginx),'-t','-c',str(conf)],stdout=log,stderr=log,check=True)
            def child_pids(parent):
                # A new worker answering once does not mean the old access policy
                # has drained. Read PID/PPID only, never other process arguments.
                listing=subprocess.check_output(['/bin/ps','-A','-o','pid=,ppid='],text=True)
                pairs=[line.split() for line in listing.splitlines()]
                return {int(pid) for pid,ppid in pairs if int(ppid)==parent}
            old_workers=child_pids(proxy.pid)
            record('previous_nginx_worker_generation_observed',bool(old_workers))
            proxy.send_signal(signal.SIGHUP)
            deadline=time.monotonic()+10
            while old_workers & child_pids(proxy.pid) and time.monotonic()<deadline:
                if proxy.poll() is not None:raise AssertionError('Private proxy exited during reload')
                time.sleep(0.05)
            record('previous_nginx_workers_drained_before_allow_checks',not old_workers & child_pids(proxy.pid))
            record('approved_peer_can_reach_proxy',await_status(200)[0]==200)
            response=request('/api/__proxy_probe__?token=synthetic-query-secret',headers={'Authorization':'Token synthetic-browser-token',
                'X-Forwarded-Proto':'http','X-Forwarded-For':'198.51.100.1','X-Real-IP':'198.51.100.2',
                'Forwarded':'for=198.51.100.3;proto=http','X-TT-Client-IP':'198.51.100.4'})
            data=json.loads(response[2])
            record('tls_certificate_and_hostname_verified',response[0]==200)
            record('proxy_client_identity_overwrites_browser_header',data['peer']=='127.0.0.1' and data['direct'] in {'',None})
            record('forwarded_chains_stripped_and_https_overwritten',data['proto']=='https' and all(data[k] in {'',None} for k in ['xff','real','forwarded']))
            record('reviewed_public_port_pinned_in_upstream_host',data['host']=='staging.example.test:24443')
            trusted=request('/api/unknown-path/',method='OPTIONS',headers={'Origin':'https://staging.example.test:24443','Access-Control-Request-Method':'GET'})
            record('real_django_cors_accepts_exact_forwarded_port_origin',trusted[0]==200 and trusted[1].get('access-control-allow-origin')=='https://staging.example.test:24443')
            wrong=request('/api/unknown-path/',method='OPTIONS',headers={'Origin':'https://staging.example.test','Access-Control-Request-Method':'GET'})
            record('real_django_cors_rejects_different_origin_port','access-control-allow-origin' not in wrong[1])
            record('application_token_preserved',data['authorization']=='Token synthetic-browser-token')
            record('api_never_cached',response[1].get('cache-control')=='no-store')
            record('foreign_host_refused',request(headers={'Host':'foreign.example.test'})[0]==421)
            record('real_django_api_unknown_path_404',request('/api/unknown-path/')[0]==404)
            record('real_django_private_pdf_anonymous_denied',request('/api/conferences/1/download-pdf/')[0] in {401,403})
            private_paths=['/media/private.pdf','/admin/login/','/.env','/backend/config/settings.py','/frontend/package.json','/scripts/testing/check.py','/anything.sql','/assets/missing-xxxxxxxx.js']
            record('private_source_and_missing_asset_have_no_spa_fallback',all(request(path)[0]==404 for path in private_paths))
            record('missing_asset_not_cached_immutable', 'immutable' not in request('/assets/missing-xxxxxxxx.js')[1].get('cache-control',''))
            record('asset_symlink_to_private_storage_denied',request('/assets/leak-cccccccc.js')[0] in {403,404})
            old_asset=request('/assets/old-aaaaaaaa.js')
            record('old_chunk_immutable_and_javascript_type',old_asset[0]==200 and old_asset[2]==b'synthetic old chunk' and 'immutable' in old_asset[1].get('cache-control','') and old_asset[1].get('content-type')=='application/javascript')
            record('shell_and_worker_revalidated',request('/')[1].get('cache-control')=='no-store' and request('/sw.js')[1].get('cache-control')=='no-store')
            record('spa_deep_link_returns_current_shell',request('/conferences/123')[2]==(old/'index.html').read_bytes())
            maintenance=site/'maintenance.flag';maintenance.touch()
            calls=output/'guarded_proxy_wsgi.calls';before=calls.read_bytes()
            record('maintenance_blocks_every_api_method',all(request('/api/__proxy_probe__',method=method)[0]==503 for method in ['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']))
            record('maintenance_never_forwards_to_application',calls.read_bytes()==before)
            record('maintenance_blocks_spa_but_preserves_cached_chunks',request('/conferences/123')[0]==503 and request('/assets/old-aaaaaaaa.js')[0]==200)
            temporary=site/'next';temporary.symlink_to(new.parents[1],target_is_directory=True);os.replace(temporary,site/'current')
            maintenance.unlink()
            record('new_shell_and_old_cached_chunk_coexist',request('/')[2]==new.joinpath('index.html').read_bytes() and request('/assets/old-aaaaaaaa.js')[2]==old_asset[2])
            record('proxy_body_limit_refuses_before_upstream',request('/api/__proxy_probe__',method='POST',headers={'Content-Length':str(25*1024*1024)})[0]==413)
            record('all_business_and_test_database_connections_refused',not wrapper.with_suffix('.db-attempt').exists())
            access=(site/'logs/nginx-access.log').read_text()
            record('access_log_omits_queries_and_authorization', 'synthetic-query-secret' not in access and 'synthetic-browser-token' not in access and '__proxy_probe__' in access)
    finally:
        for process in reversed(processes):
            process.terminate()
            try:process.wait(timeout=10)
            except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
        (output/'stopped.json').write_text(json.dumps({'all_child_processes_stopped':all(p.poll() is not None for p in processes)})+'\n')
    result={'passed':len(checks),'checks':checks,'actual_tls_nginx_gunicorn_django':True,
            'tls_ca_and_hostname_verified':True,'reviewed_external_https_port':24443,'business_database_used':False,'database_connections_refused':True,
            'systemd_linux_verified':False,'real_phone_or_offline_acceptance':False,'fixture_assets_only':True,
            'all_child_processes_stopped':all(p.poll() is not None for p in processes)}
    (output/'results.json').write_text(json.dumps(result,indent=2)+'\n')
    # Logs, generated certificate/key and fixture files remain private to this user.
    for directory, folders, files in os.walk(output):
        os.chmod(directory,0o700)
        for name in files:
            path=Path(directory)/name
            if not path.is_symlink():os.chmod(path,0o600)
    print(json.dumps(result,indent=2));return result


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--nginx-bin',required=True,type=Path)
    parser.add_argument('--openssl-bin',required=True,type=Path)
    parser.add_argument('--output',required=True,type=Path)
    args=parser.parse_args()
    for binary in [args.nginx_bin,args.openssl_bin]:
        staging_config.require(binary.is_absolute() and binary.is_file() and os.access(binary,os.X_OK),'Reviewed executable paths required')
    check(args.nginx_bin,args.openssl_bin,args.output)
