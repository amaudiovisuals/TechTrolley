"""Staging-only renderer guard tests; no server/DB/service operations."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'deployment'))
import staging_config as config


def values():
    return {'hostname':'staging.example.test','root':'/srv/techtrolley-staging',
            'revision':'a'*40,'allowed_cidrs':['192.0.2.4/32','2001:db8::4/128']}


class StagingTests(unittest.TestCase):
    def test_render_complete_without_installation_or_secrets(self):
        packet=config.render(values()); self.assertEqual(len(packet),7)
        review=json.loads(packet['review.json']); self.assertFalse(review['installation_performed'])
        self.assertFalse(review['linux_verified'])
        self.assertNotIn('TT_DB_PASSWORD=',packet['runtime-overlay.env.example'])
        self.assertNotIn('DJANGO_SECRET_KEY=',packet['runtime-overlay.env.example'])

    def test_unknown_or_missing_fields_refused(self):
        for field in values():
            v=values(); del v[field]
            with self.assertRaises(ValueError): config.render(v)
        v=values();v['password']='not-accepted'
        with self.assertRaises(ValueError):config.render(v)

    def test_production_host_and_injection_refused(self):
        for host in ['techtrolley.amaudiovisuals.com','localhost','*.example.com','staging.x;return 200;',
                     'staging.x\ninclude secret;','staging..x','Staging.example.com','staging.'+'a'*64+'.test']:
            v=values();v['hostname']=host
            with self.subTest(host=host),self.assertRaises(ValueError):config.render(v)

    def test_unsafe_root_refused(self):
        for root in ['/','/srv/prod','relative-staging','/srv/../a-staging','/srv/a-staging/',
                     '/srv/a-staging;','/srv/a staging','/srv/'+'a'*80+'-staging']:
            v=values();v['root']=root
            with self.subTest(root=root),self.assertRaises(ValueError):config.render(v)

    def test_short_ref_and_injected_revision_refused(self):
        for revision in ['main','a'*7,'g'*40,'a'*40+'\n']:
            v=values();v['revision']=revision
            with self.assertRaises(ValueError):config.render(v)

    def test_broad_noncanonical_duplicate_access_refused(self):
        for ranges in [[],['0.0.0.0/0'],['::/0'],['192.0.2.1/24'],['224.0.0.0/24'],
                       ['192.0.2.1/32']*2,['192.0.2.1/32; deny all;'],['::/32']]:
            v=values();v['allowed_cidrs']=ranges
            with self.subTest(ranges=ranges),self.assertRaises(ValueError):config.render(v)

    def test_immutable_exact_release_and_unix_only_process(self):
        p=config.render(values()); app=p['tt-staging-app.service'];g=p['gunicorn.conf.py']
        self.assertIn('/venvs/'+'a'*40+'/bin/python',app)
        self.assertNotIn('/current/',app); self.assertIn("bind = 'unix:",g)
        self.assertIn('secure_scheme_headers = {}',g);self.assertIn("forwarded_allow_ips = ''",g)
        self.assertNotIn('migrate',app);self.assertNotIn('git ',app)

    def test_separate_unprivileged_service_users_and_write_areas(self):
        p=config.render(values());a=p['tt-staging-app.service'];n=p['tt-staging-proxy.service']
        self.assertIn('User=tt-staging\n',a);self.assertIn('User=tt-staging-proxy\n',n)
        self.assertIn('/run/app ',a); self.assertIn('/run/proxy ',n)
        self.assertIn('ProtectSystem=strict',a);self.assertIn('ProtectSystem=strict',n)
        self.assertNotIn('private-media',n)

    def test_proxy_header_and_no_retry_contract(self):
        n=config.render(values())['nginx.conf']
        for clause in ['proxy_set_header X-TT-Client-IP $remote_addr;', 'proxy_next_upstream off;',
                       'proxy_cache off;', 'deny all;', 'proxy_set_header X-Forwarded-For "";',
                       'proxy_set_header Forwarded "";', 'maintenance.flag', 'client_max_body_size 24m;']:
            self.assertIn(clause,n)
        self.assertNotIn('auth_basic',n);self.assertNotIn('set_real_ip_from',n)
        self.assertNotIn('$request_uri',n);self.assertNotIn('$request ',n)

    def test_forwarded_public_https_port_matches_origin_and_pinned_host(self):
        for port in [443,24443,65535]:
            v=values();v['public_https_port']=port;p=config.render(v)
            host='staging.example.test'+(':'+str(port) if port!=443 else '')
            self.assertIn('TT_APP_ORIGIN=https://'+host+'\n',p['runtime-overlay.env.example'])
            self.assertIn('proxy_set_header Host '+host+';',p['nginx.conf'])
            self.assertIn('listen 0.0.0.0:443 ssl',p['nginx.conf'])
            self.assertNotIn('proxy_set_header Host $http_host',p['nginx.conf'])

    def test_unsafe_public_https_ports_refused(self):
        for port in [True,False,None,'24443',80,0,-1,1023,65536,'443;include bad;']:
            v=values();v['public_https_port']=port
            with self.subTest(port=port),self.assertRaises(ValueError):config.render(v)

    def test_every_start_and_failure_closes_ingress_without_auto_open(self):
        p=config.render(values())
        for name in ['tt-staging-app.service','tt-staging-proxy.service']:
            self.assertIn('Requires=tt-staging-close.service',p[name])
            self.assertIn('OnFailure=tt-staging-close.service',p[name])
        gate=p['tt-staging-close.service']
        self.assertIn('Type=oneshot',gate)
        self.assertIn('ExecStart=/usr/bin/touch /srv/techtrolley-staging/maintenance.flag',gate)
        self.assertNotIn('RemainAfterExit=yes',gate)
        self.assertNotIn('/bin/sh',gate)
        self.assertNotIn('ExecStart=',p['runtime-overlay.env.example'])

    def test_resource_bounds_and_master_led_graceful_shutdown(self):
        p=config.render(values());a=p['tt-staging-app.service'];n=p['tt-staging-proxy.service']
        self.assertIn('KillMode=mixed',a)
        self.assertIn('MemoryMax=1536M',a);self.assertIn('TasksMax=128',a)
        self.assertIn('MemoryMax=256M',n);self.assertIn('TasksMax=64',n)
        self.assertIn('control_socket_disable = True',p['gunicorn.conf.py'])

    def test_private_exclusive_output(self):
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory).resolve();os.chmod(base,0o700);dest=base/'packet'
            config.write_packet(values(),dest)
            self.assertEqual(dest.stat().st_mode & 0o777,0o700)
            self.assertTrue(all(p.stat().st_mode & 0o777==0o600 for p in dest.iterdir()))
            with self.assertRaises(ValueError):config.write_packet(values(),dest)

    def test_public_or_symlink_parent_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory).resolve();os.chmod(base,0o755)
            with self.assertRaises(ValueError):config.write_packet(values(),base/'packet')
            os.chmod(base,0o700);(base/'alias').symlink_to(base,target_is_directory=True)
            with self.assertRaises(ValueError):config.write_packet(values(),base/'alias'/'packet')

    def test_invalid_test_listener_and_certificate_injection_refused(self):
        for kwargs in [{'listen':'0.0.0.0:9999'},{'certificate':'/tmp/a;foo.pem'},{'key':'/tmp/../bad.key'}]:
            with self.assertRaises(ValueError):config.nginx_config(values(),**kwargs)


if __name__=='__main__':unittest.main()
