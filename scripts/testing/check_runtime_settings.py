"""Exercise actual secure settings/middleware with synthetic env; DB access refused."""
import json
import os
from pathlib import Path
import sys
import subprocess
from unittest.mock import patch
sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'backend'))
for entry in ('config.wsgi','config.asgi'):
    code="from unittest.mock import patch\nimport importlib\nwith patch('django.db.backends.base.base.BaseDatabaseWrapper.ensure_connection',side_effect=AssertionError('No database allowed')):\n    importlib.import_module("+repr(entry)+")\n"
    result=subprocess.run([sys.executable,'-c',code],env={'PYTHONPATH':str(ROOT/'backend'),'PYTHONDONTWRITEBYTECODE':'1'},capture_output=True,text=True)
    assert result.returncode and 'Set DJANGO_ENV explicitly' in result.stderr
os.environ.clear()
os.environ.update({
    'DJANGO_SETTINGS_MODULE':'config.settings','DJANGO_ENV':'staging',
    'DJANGO_SECRET_KEY':'SyntheticRuntimeCheck-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ-abcdefghijklmnopqrstuvwxyz',
    'DJANGO_ALLOWED_HOSTS':'staging.example.test','TT_APP_ORIGIN':'https://staging.example.test',
    'TT_INSTANCE_ID':'staging-runtime-check','TT_DB_NAME':'synthetic_staging',
    'TT_DB_USER':'synthetic_role','TT_DB_PASSWORD':'synthetic-only',
    'TT_DB_HOST':'127.0.0.1','TT_DB_PORT':'1','TT_MEDIA_ROOT':'/tmp/tt-private-media',
    'TT_STATIC_ROOT':'/tmp/tt-public-static',
})
with patch('django.db.backends.base.base.BaseDatabaseWrapper.ensure_connection',side_effect=AssertionError('Runtime smoke must never connect to a database')) as connect:
    import django
    django.setup()
    from django.conf import settings
    from django.core.checks import run_checks
    from django.test import Client
    findings=run_checks(include_deployment_checks=True)
    assert {f.id for f in findings}<={'security.W005','security.W021'},[(f.id,f.msg) for f in findings]
    client=Client()
    response=client.get('/',HTTP_HOST='staging.example.test',secure=True)
    assert response.status_code==200 and response['Strict-Transport-Security']=='max-age=3600'
    assert response['X-Frame-Options']=='DENY' and response['X-Content-Type-Options']=='nosniff'
    assert client.get('/',HTTP_HOST='other.example.test',secure=True).status_code==400
    assert client.get('/',HTTP_HOST='staging.example.test',HTTP_X_FORWARDED_PROTO='https').status_code==301
    response=client.options('/api/login/',HTTP_HOST='staging.example.test',secure=True,HTTP_ORIGIN='https://staging.example.test',HTTP_ACCESS_CONTROL_REQUEST_METHOD='POST')
    assert response['Access-Control-Allow-Origin']=='https://staging.example.test'
    response=client.options('/api/login/',HTTP_HOST='staging.example.test',secure=True,HTTP_ORIGIN='https://foreign.example.test',HTTP_ACCESS_CONTROL_REQUEST_METHOD='POST')
    assert 'Access-Control-Allow-Origin' not in response
    assert not settings.REVIEWED_OWNERSHIP_WRITES_ENABLED and not settings.REVIEWED_RECONCILIATION_WRITES_ENABLED
    assert not settings.EXTERNAL_AI_ENABLED and not settings.CORS_ALLOW_ALL_ORIGINS
    assert settings.REST_FRAMEWORK['DEFAULT_AUTHENTICATION_CLASSES'][0] == 'core.authentication.ExpiringTokenAuthentication'
    for debug in (False, True):
        from django.test import override_settings
        with override_settings(DEBUG=debug):
            assert client.get('/media/conference_pdfs/private.pdf', HTTP_HOST='staging.example.test', secure=True).status_code == 404
    from django.urls import resolve
    assert resolve('/api/public-logo/').url_name == 'public_logo'
    assert client.get('/admin/login/', HTTP_HOST='staging.example.test', secure=True).status_code == 404
    connect.assert_not_called()
print(json.dumps({'passed':15,'environment':'Actual Django secure settings/security+cors middleware; synthetic staging values; all DB access refused',
    'business_database_used':False,'deployment_warnings':[f.id for f in findings],
    'warning_reason':'HSTS covers this host for one hour; includeSubDomains/preload require separate domain-wide review.'},indent=2))
