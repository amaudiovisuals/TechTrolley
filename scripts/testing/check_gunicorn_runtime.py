"""Run candidate Gunicorn/real WSGI over a private Unix socket; DB access refused.

Synthetic staging configuration only. No TCP listener or existing service is used.
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]


def main():
    with tempfile.TemporaryDirectory(prefix='tt-gunicorn-', dir='/private/tmp' if sys.platform == 'darwin' else None) as folder:
        base = Path(folder)
        address = base / 'server.sock'
        (base / 'guarded_wsgi.py').write_text(
            "from unittest.mock import patch\n"
            "def refuse(*args, **kwargs):\n"
            "    from pathlib import Path\n"
            "    Path(__file__).with_suffix('.db-attempt').touch()\n"
            "    raise AssertionError('Business/test DB connections forbidden')\n"
            "guard = patch('django.db.backends.base.base.BaseDatabaseWrapper.ensure_connection', side_effect=refuse)\n"
            "guard.start()\n"
            "from config.wsgi import application\n")
        env = {'PATH': os.defpath, 'PYTHONDONTWRITEBYTECODE': '1',
               'PYTHONPATH': str(base) + os.pathsep + str(ROOT / 'backend'),
               'DJANGO_ENV': 'staging',
               'DJANGO_SECRET_KEY': 'SyntheticRuntimeCheck-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ-abcdefghijklmnopqrstuvwxyz',
               'DJANGO_ALLOWED_HOSTS': 'staging.example.test', 'TT_APP_ORIGIN': 'https://staging.example.test',
               'TT_INSTANCE_ID': 'gunicorn-runtime-check', 'TT_DB_NAME': 'synthetic_staging',
               'TT_DB_USER': 'synthetic_role', 'TT_DB_PASSWORD': 'synthetic-only',
               'TT_DB_HOST': '127.0.0.1', 'TT_DB_PORT': '1',
               'TT_MEDIA_ROOT': str(base / 'private-media'), 'TT_STATIC_ROOT': str(base / 'public-static'),
               'TT_TRUST_PROXY': 'true', 'TT_PROXY_HEADER_SANITIZED': 'true'}
        with (base / 'gunicorn.log').open('wb') as log:
            process = subprocess.Popen([sys.executable, '-m', 'gunicorn', '--bind', 'unix:' + str(address),
                                        '--workers', '1', '--threads', '2', 'guarded_wsgi:application'],
                                       cwd=base, env=env, stdout=log, stderr=log)
            try:
                def request(path='/', host='staging.example.test', secure=True):
                    with socket.socket(socket.AF_UNIX) as client:
                        client.settimeout(3)
                        client.connect(str(address))
                        headers = 'X-Forwarded-Proto: https\r\n' if secure else ''
                        client.sendall(('GET ' + path + ' HTTP/1.1\r\nHost: ' + host + '\r\n' + headers + 'Connection: close\r\n\r\n').encode())
                        response = b''
                        while True:
                            data = client.recv(65536)
                            if not data:
                                break
                            response += data
                        return response
                deadline = time.monotonic() + 15
                while not address.exists() and process.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.05)
                assert address.exists(), (base / 'gunicorn.log').read_text()
                response = request()
                assert response.startswith(b'HTTP/1.1 200'), response[:500]
                assert b'Strict-Transport-Security: max-age=3600' in response
                assert b'X-Content-Type-Options: nosniff' in response
                assert request('/admin/login/').startswith(b'HTTP/1.1 404')
                assert request('/media/conference_pdfs/private.pdf').startswith(b'HTTP/1.1 404')
                assert request(host='foreign.example.test').startswith(b'HTTP/1.1 400')
                assert request(secure=False).startswith(b'HTTP/1.1 301')
                assert not (base / 'guarded_wsgi.db-attempt').exists()
                print(json.dumps({'passed': 8, 'actual_gunicorn_wsgi': True, 'business_database_used': False,
                                  'database_connections_refused': True, 'tcp_listener': False,
                                  'actual_linux_proxy_tls_verified': False}, indent=2))
            finally:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


if __name__ == '__main__':
    main()
