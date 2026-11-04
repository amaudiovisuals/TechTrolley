"""Pure environment/release guards. No business database or project settings."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import sys
sys.dont_write_bytecode=True

ROOT=Path(__file__).resolve().parents[2]
def module(path,name):
    spec=importlib.util.spec_from_file_location(name,ROOT/path);loaded=importlib.util.module_from_spec(spec);spec.loader.exec_module(loaded);return loaded
cfg=module('backend/config/environment.py','runtime_environment')
release=module('scripts/deployment/prepare_release.py','release_candidate')

def env():
    return {'DJANGO_ENV':'staging','DJANGO_SECRET_KEY':'SyntheticTestOnly-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ-abcdefghijklmnopqrstuvwxyz',
        'DJANGO_ALLOWED_HOSTS':'staging.example.test','TT_APP_ORIGIN':'https://staging.example.test','TT_INSTANCE_ID':'staging-isolated-test',
        'TT_DB_NAME':'synthetic_staging','TT_DB_USER':'synthetic_role','TT_DB_PASSWORD':'synthetic-only-secret',
        'TT_DB_HOST':'127.0.0.1','TT_DB_PORT':'55439','TT_MEDIA_ROOT':'/tmp/tt-private-media','TT_STATIC_ROOT':'/tmp/tt-public-static'}

class RuntimeTests(unittest.TestCase):
    def test_secure_defaults_and_postgres_explicit_identity(self):
        value=cfg.runtime_config(env(),ROOT/'backend')
        self.assertFalse(value['DEBUG']);self.assertFalse(value['CORS_ALLOW_ALL_ORIGINS'])
        self.assertTrue(value['SESSION_COOKIE_SECURE']);self.assertTrue(value['SECURE_SSL_REDIRECT'])
        self.assertFalse(value['EXTERNAL_AI_ENABLED']);self.assertIsNone(value['SECURE_PROXY_SSL_HEADER'])
        self.assertEqual(value['DATABASES']['default']['NAME'],'synthetic_staging')
        self.assertFalse(value['DATABASES']['default']['ATOMIC_REQUESTS'])
    def test_missing_secure_inputs_never_fall_back(self):
        for key in env():
            if key=='DJANGO_ENV':continue
            values=env();del values[key]
            with self.subTest(key=key),self.assertRaises(cfg.ConfigurationError):cfg.runtime_config(values,ROOT/'backend')
    def test_production_uses_only_supplied_database_values(self):
        values=env();values.update(DJANGO_ENV='production',TT_DB_NAME='explicit_production')
        result=cfg.runtime_config(values,ROOT/'backend');self.assertEqual(result['DATABASES']['default']['NAME'],'explicit_production')
    def test_development_has_loopback_hosts_and_random_secret(self):
        one=cfg.runtime_config({},ROOT/'backend');two=cfg.runtime_config({},ROOT/'backend')
        self.assertEqual(one['DATABASES']['default']['ENGINE'],'django.db.backends.sqlite3')
        self.assertNotEqual(one['SECRET_KEY'],two['SECRET_KEY']);self.assertNotIn('*',one['ALLOWED_HOSTS'])
    def test_unknown_mode_and_loose_booleans_are_rejected(self):
        for values in [{'DJANGO_ENV':'prodution'},{'DJANGO_DEBUG':'yes'},{'TT_TRUST_PROXY':'1'}]:
            with self.assertRaises(cfg.ConfigurationError):cfg.runtime_config(values,ROOT/'backend')
    def test_weak_or_placeholder_secrets_are_rejected_without_echo(self):
        for key in ['short','x'*65,'django-insecure-'+'x1234567890'*8,'replace_me-'+'ab1234567890'*8]:
            values=env();values['DJANGO_SECRET_KEY']=key
            with self.assertRaises(cfg.ConfigurationError) as error:cfg.runtime_config(values,ROOT/'backend')
            self.assertNotIn(key,str(error.exception))
    def test_wildcard_suffix_url_and_empty_host_rejected(self):
        for hosts in ['*','.example.test','https://staging.example.test','staging.example.test:443','',',']:
            values=env();values['DJANGO_ALLOWED_HOSTS']=hosts
            with self.assertRaises(cfg.ConfigurationError):cfg.runtime_config(values,ROOT/'backend')
    def test_debug_and_shared_production_name_rejected_in_staging(self):
        for fields in [{'DJANGO_DEBUG':'true'},{'TT_DB_NAME':'techtrolley_prod'}]:
            values=env();values.update(fields)
            with self.assertRaises(cfg.ConfigurationError):cfg.runtime_config(values,ROOT/'backend')
    def test_insecure_credentialed_wildcard_or_path_origin_rejected(self):
        for origin in ['http://staging.example.test','https://*.example.test','https://u:p@staging.example.test','https://staging.example.test/path','https://staging.example.test?x=1','https://staging.example.test#x','https://staging.example.test:70000']:
            values=env();values['TT_APP_ORIGIN']=origin
            with self.assertRaises(cfg.ConfigurationError):cfg.runtime_config(values,ROOT/'backend')
    def test_origin_must_match_host_and_cors_csrf_are_exact(self):
        values=env();values['TT_APP_ORIGIN']='https://other.example.test'
        with self.assertRaises(cfg.ConfigurationError):cfg.runtime_config(values,ROOT/'backend')
        for key in ['DJANGO_CORS_ALLOWED_ORIGINS','DJANGO_CSRF_TRUSTED_ORIGINS']:
            values=env();values[key]='*'
            with self.assertRaises(cfg.ConfigurationError):cfg.runtime_config(values,ROOT/'backend')
    def test_remote_database_requires_verified_tls_and_ca(self):
        values=env();values['TT_DB_HOST']='database.example.test'
        with self.assertRaises(cfg.ConfigurationError):cfg.runtime_config(values,ROOT/'backend')
        values['TT_DB_SSLROOTCERT']='/tmp/tt-ca.crt'
        self.assertEqual(cfg.runtime_config(values,ROOT/'backend')['DATABASES']['default']['OPTIONS']['sslmode'],'verify-full')
        values['TT_DB_SSLMODE']='require'
        with self.assertRaises(cfg.ConfigurationError):cfg.runtime_config(values,ROOT/'backend')
    def test_invalid_database_identifiers_and_ports_are_rejected(self):
        for key,value in [('TT_DB_NAME','url://database'),('TT_DB_USER','name with spaces'),('TT_DB_PORT','0'),('TT_DB_PORT','65536'),('TT_DB_HOST','*')]:
            values=env();values[key]=value
            with self.assertRaises(cfg.ConfigurationError):cfg.runtime_config(values,ROOT/'backend')
    def test_proxy_headers_need_explicit_sanitizing_acknowledgement(self):
        values=env();values['TT_TRUST_PROXY']='true'
        with self.assertRaises(cfg.ConfigurationError):cfg.runtime_config(values,ROOT/'backend')
        values['TT_PROXY_HEADER_SANITIZED']='true';self.assertEqual(cfg.runtime_config(values,ROOT/'backend')['SECURE_PROXY_SSL_HEADER'],('HTTP_X_FORWARDED_PROTO','https'))
    def test_unix_client_identity_requires_sanitized_secure_proxy(self):
        values=env();values['TT_PROXY_CLIENT_IP_FROM_UNIX']='true'
        with self.assertRaises(cfg.ConfigurationError):cfg.runtime_config(values,ROOT/'backend')
        values.update(TT_TRUST_PROXY='true',TT_PROXY_HEADER_SANITIZED='true')
        self.assertTrue(cfg.runtime_config(values,ROOT/'backend')['PROXY_CLIENT_IP_FROM_UNIX'])
        values['DJANGO_ENV']='development'
        with self.assertRaises(cfg.ConfigurationError):cfg.runtime_config(values,ROOT/'backend')
    def test_unix_client_identity_is_off_by_default(self):
        self.assertFalse(cfg.runtime_config(env(),ROOT/'backend')['PROXY_CLIENT_IP_FROM_UNIX'])
    def test_staging_cannot_send_external_ai(self):
        values=env();values['TT_EXTERNAL_AI_ENABLED']='true'
        with self.assertRaises(cfg.ConfigurationError):cfg.runtime_config(values,ROOT/'backend')
    def test_private_media_and_static_roots_cannot_overlap(self):
        for media,static in [('relative','/tmp/public'),('/tmp/data','/tmp/data'),('/tmp/data','/tmp/data/public'),('/tmp/data/private','/tmp/data')]:
            values=env();values.update(TT_MEDIA_ROOT=media,TT_STATIC_ROOT=static)
            with self.assertRaises(cfg.ConfigurationError):cfg.runtime_config(values,ROOT/'backend')

class ReleaseTests(unittest.TestCase):
    revision='a'*40
    def setUp(self):
        self.folder=tempfile.TemporaryDirectory();self.addCleanup(self.folder.cleanup);self.root=Path(self.folder.name)
        self.paths=['backend/config/settings.py','backend/core/models.py', *release.REQUIRED_SOURCES, 'frontend/dist/index.html','frontend/dist/sw.js']
        for name in self.paths:
            p=self.root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('synthetic content')
        self.dirty=False;self.head=self.revision
    def git(self,root,*args):
        if args==('rev-parse','HEAD'):return self.head
        if args[0]=='status':return ' M changed' if self.dirty else ''
        if args==('ls-files',):return '\n'.join(self.paths)
        raise AssertionError(args)
    def test_exact_clean_candidate_records_hashes_without_deployment(self):
        result=release.candidate(self.root,self.revision,self.git)
        self.assertFalse(result['deployment_enabled']);self.assertFalse(result['business_operations_performed'])
        self.assertEqual(set(result['frontend_files_sha256']),{'index.html','sw.js'})
        self.assertEqual(len(result['backend_source_sha256']['backend/core/models.py']),64)
        self.assertTrue(set(release.REQUIRED_SOURCES).issubset(result['backend_source_sha256']))
    def test_short_or_wrong_revision_is_rejected(self):
        for revision in ['main','a'*7,'b'*40]:
            with self.assertRaises(ValueError):release.candidate(self.root,revision,self.git)
    def test_dirty_or_untracked_sources_are_rejected(self):
        self.dirty=True
        with self.assertRaises(ValueError):release.candidate(self.root,self.revision,self.git)
        self.dirty=False;(self.root/'backend/core/untracked.py').write_text('synthetic')
        with self.assertRaises(ValueError):release.candidate(self.root,self.revision,self.git)
    def test_missing_worker_and_private_build_files_are_rejected(self):
        (self.root/'frontend/dist/sw.js').unlink()
        with self.assertRaises(ValueError):release.candidate(self.root,self.revision,self.git)
        (self.root/'frontend/dist/sw.js').write_text('worker');(self.root/'frontend/dist/leak.pem').write_text('synthetic')
        with self.assertRaises(ValueError):release.candidate(self.root,self.revision,self.git)
    def test_source_or_build_symlink_is_rejected(self):
        path=self.root/'backend/core/models.py';path.unlink();path.symlink_to(self.root/'backend/manage.py')
        with self.assertRaises(ValueError):release.candidate(self.root,self.revision,self.git)
    def test_source_change_during_hashing_is_rejected(self):
        calls=0
        def git(root,*args):
            nonlocal calls
            if args[0]=='status':
                calls+=1
                if calls==2:return ' M changed'
            return self.git(root,*args)
        with self.assertRaises(ValueError):release.candidate(self.root,self.revision,git)

if __name__=='__main__':unittest.main(verbosity=2)
