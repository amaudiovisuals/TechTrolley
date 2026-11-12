"""Render a staging-only review packet. No installation, network or DB operations.

Strict non-secret inputs only. Paths describe a dedicated installation; renderer
never creates those paths or loads their contents. Output must be new/private.
"""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import re

FIELDS = {'hostname', 'root', 'revision', 'allowed_cidrs'}
OPTIONAL_FIELDS = {'public_https_port'}


def require(ok, message):
    if not ok:
        raise ValueError(message)


def validate(values):
    require(isinstance(values, dict) and FIELDS <= set(values) <= FIELDS | OPTIONAL_FIELDS,
            'Expected four non-secret staging fields and optional public_https_port')
    hostname = values['hostname']
    require(isinstance(hostname, str) and len(hostname) <= 253 and
            re.fullmatch(r'[a-z0-9]+(?:[.-][a-z0-9]+)*', hostname) and
            all(len(label) <= 63 for label in hostname.split('.')) and
            hostname.split('.')[0] in {'staging', 'test'} and '.' in hostname,
            'A distinct staging/test hostname is required')
    root = values['root']
    require(isinstance(root, str) and re.fullmatch(r'/[A-Za-z0-9_/-]+-staging', root) and
            len(Path(root).parts) >= 3 and str(Path(root)) == root and
            '..' not in Path(root).parts and len(root) < 65,
            'Use a short canonical absolute dedicated -staging directory')
    revision = values['revision']
    require(isinstance(revision, str) and re.fullmatch(r'[0-9a-f]{40}', revision), 'Full reviewed Git revision required')
    cidrs = values['allowed_cidrs']
    require(isinstance(cidrs, list) and 1 <= len(cidrs) <= 16, 'Explicit restricted client CIDRs required')
    for entry in cidrs:
        require(isinstance(entry, str) and len(entry) < 50, 'Invalid client CIDR')
        try:
            network = ipaddress.ip_network(entry, strict=True)
        except ValueError:
            raise ValueError('Use canonical client CIDRs') from None
        require(network.prefixlen >= (24 if network.version == 4 else 64) and
                not network.is_multicast and not network.is_unspecified,
                'Broad or non-client access ranges refused')
        require(str(network) == entry, 'Use canonical client CIDRs')
    require(len(set(cidrs)) == len(cidrs), 'Duplicate CIDRs refused')
    port = values.get('public_https_port', 443)
    require(type(port) is int and (port == 443 or 1024 <= port <= 65535),
            'Public HTTPS port must be443 or an integer1024..65535')
    return dict(values)


def authority(values):
    port = values.get('public_https_port', 443)
    return values['hostname'] + (':' + str(port) if port != 443 else '')


def nginx_config(values, *, listen='0.0.0.0:443', certificate=None, key=None):
    """Internal loopback test overrides are not CLI inputs or installer settings."""
    v = validate(values); root = v['root']; host = v['hostname']
    require(re.fullmatch(r'(?:0\.0\.0\.0:443|127\.0\.0\.1:[1-9][0-9]{3,4})', listen), 'Invalid listener')
    certificate = certificate or root + '/tls/fullchain.pem'
    key = key or root + '/tls/privkey.pem'
    for path in (certificate, key):
        require(re.fullmatch(r'/[A-Za-z0-9_./-]+', path) and '..' not in Path(path).parts, 'Unsafe certificate path')
    access = '\n'.join('        allow ' + c + ';' for c in v['allowed_cidrs'])
    # Use $uri rather than $request/$request_uri: never log query credentials.
    # Error logs remain private: upstream diagnostics can still include a URI.
    return f'''# Dedicated staging instance only. Not an include for production Nginx.
worker_processes 1;
pid {root}/run/proxy/nginx.pid;
error_log {root}/logs/nginx-error.log crit;
events {{ worker_connections 256; }}
http {{
    log_format minimal '$remote_addr $request_method $uri $status $body_bytes_sent';
    access_log {root}/logs/nginx-access.log minimal;
    server_tokens off;
    types {{ text/html html; application/javascript js; text/css css; image/png png; image/svg+xml svg; image/jpeg jpg jpeg; image/webp webp; image/x-icon ico; application/manifest+json webmanifest; }}
    default_type application/octet-stream;
    client_max_body_size 24m;
    client_body_timeout 30s;
    client_header_timeout 15s;
    send_timeout 30s;
    keepalive_timeout 15s;
    client_body_temp_path {root}/proxy-temp/client;
    proxy_temp_path {root}/proxy-temp/upstream;
    server {{
        listen {listen} ssl default_server;
        server_name {host};
        ssl_certificate {certificate};
        ssl_certificate_key {key};
        ssl_protocols TLSv1.2 TLSv1.3;
        if ($host != {host}) {{ return 421; }}
{access}
        deny all;
        root {root}/current/frontend/dist;
        autoindex off;
        add_header X-Content-Type-Options nosniff always;
        add_header Referrer-Policy same-origin always;
        add_header Strict-Transport-Security "max-age=3600" always;
        # No real_ip / Basic auth: only direct approved peers, app Token header intact.
        location = /api {{ return 404; }}
        location /api/ {{
            if (-f {root}/maintenance.flag) {{ return 503; }}
            proxy_pass http://unix:{root}/run/app/app.sock;
            proxy_http_version 1.1;
            proxy_set_header Host {authority(v)};
            proxy_set_header X-Forwarded-Proto https;
            proxy_set_header X-TT-Client-IP $remote_addr;
            proxy_set_header X-Forwarded-For "";
            proxy_set_header X-Real-IP "";
            proxy_set_header Forwarded "";
            proxy_set_header X-Forwarded-Host "";
            proxy_set_header Connection "";
            proxy_cache off;
            proxy_next_upstream off;
            proxy_connect_timeout 3s;
            proxy_read_timeout 60s;
            proxy_send_timeout 60s;
            proxy_request_buffering on;
            add_header Cache-Control no-store always;
            add_header X-Content-Type-Options nosniff always;
        }}
        location ^~ /assets/ {{
            alias {root}/immutable-assets/;
            disable_symlinks on;
            add_header Cache-Control "public, max-age=31536000, immutable";
            add_header X-Content-Type-Options nosniff always;
        }}
        location ~* ^/(?:media|admin|static|backend|frontend|scripts|docs|vendor)(?:/|$) {{ return 404; }}
        location ~ /\\. {{ return 404; }}
        location ~* \\.(?:py|pyc|sql|sqlite3?|dump|env|pem|key|map|log|tgz|tar|gz)$ {{ return 404; }}
        location = /sw.js {{ try_files $uri =404; add_header Cache-Control no-store always; add_header X-Content-Type-Options nosniff always; }}
        location = /index.html {{ add_header Cache-Control no-store always; }}
        location / {{
            if (-f {root}/maintenance.flag) {{ return 503; }}
            try_files $uri $uri/ /index.html;
            add_header Cache-Control no-cache always;
        }}
    }}
}}
'''


def render(values):
    v = validate(values); root = v['root']; revision = v['revision']
    release = root + '/releases/' + revision
    common = f'''NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
RestrictSUIDSGID=yes
LockPersonality=yes
UMask=0007
Restart=on-failure
RestartSec=3
TimeoutStopSec=45
'''
    app = f'''# REVIEW ONLY. Accounts/directories/environment/venv must already be reviewed.
[Unit]
Description=TechTrolley isolated staging application ({revision})
Requires=tt-staging-close.service
After=network.target tt-staging-close.service
OnFailure=tt-staging-close.service
[Service]
Type=simple
KillMode=mixed
MemoryHigh=1G
MemoryMax=1536M
CPUQuota=200%
TasksMax=128
LimitNOFILE=2048
User=tt-staging
Group=tt-staging-web
WorkingDirectory={release}/backend
EnvironmentFile=/etc/techtrolley-staging/runtime.env
Environment=PYTHONDONTWRITEBYTECODE=1
ExecStart={root}/venvs/{revision}/bin/python -m gunicorn --config {root}/config/gunicorn.conf.py config.wsgi:application
ReadWritePaths={root}/run/app {root}/private-media {root}/app-temp
Environment=TMPDIR={root}/app-temp
{common}[Install]
WantedBy=multi-user.target
'''
    proxy = f'''# REVIEW ONLY. Dedicated proxy; never replace the production nginx unit.
[Unit]
Description=TechTrolley isolated staging HTTPS proxy
Requires=tt-staging-close.service
After=network.target tt-staging-close.service
OnFailure=tt-staging-close.service
[Service]
Type=simple
MemoryMax=256M
CPUQuota=100%
TasksMax=64
LimitNOFILE=1024
User=tt-staging-proxy
Group=tt-staging-web
SupplementaryGroups=tt-staging-proxy
ExecStartPre=/usr/sbin/nginx -t -c {root}/config/nginx.conf
ExecStart=/usr/sbin/nginx -c {root}/config/nginx.conf -g "daemon off;"
ReadWritePaths={root}/run/proxy {root}/logs {root}/proxy-temp
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
{common}[Install]
WantedBy=multi-user.target
'''
    close = f'''# Fixed root-owned action: close ingress on every dependent service start.
[Unit]
Description=Close TechTrolley staging ingress for operator review
After=local-fs.target
Before=tt-staging-app.service tt-staging-proxy.service
[Service]
Type=oneshot
ExecStart=/usr/bin/touch {root}/maintenance.flag
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths={root}
UMask=0027
TimeoutStartSec=10
# Deliberately no RemainAfterExit: subsequent starts must run this again.
'''
    gunicorn = f'''# Private Unix socket is the ONLY ingress; proxy supplies sanitized headers.
bind = 'unix:{root}/run/app/app.sock'
workers = 2
threads = 2
worker_class = 'gthread'
timeout = 60
graceful_timeout = 30
keepalive = 5
umask = 0o007
accesslog = None
control_socket_disable = True
errorlog = '-'
capture_output = False
forwarded_allow_ips = ''
secure_scheme_headers = {{}}
limit_request_line = 4094
limit_request_fields = 60
limit_request_field_size = 8190
'''
    environment = f'''# NON-SECRET overlay only. Merge with the private environment after review.
DJANGO_ENV=staging
DJANGO_DEBUG=false
DJANGO_ALLOWED_HOSTS={v['hostname']}
TT_APP_ORIGIN=https://{authority(v)}
TT_INSTANCE_ID=staging-{revision[:12]}
TT_MEDIA_ROOT={root}/private-media
TT_STATIC_ROOT={root}/collected-static
TT_EXTERNAL_AI_ENABLED=false
TT_TRUST_PROXY=true
TT_PROXY_HEADER_SANITIZED=true
TT_PROXY_CLIENT_IP_FROM_UNIX=true
REVIEWED_RECONCILIATION_WRITES_ENABLED=false
REVIEWED_OWNERSHIP_WRITES_ENABLED=false
# Missing by design: NEW secret key, NEW _staging DB identity/password.
'''
    return {'nginx.conf': nginx_config(v), 'gunicorn.conf.py': gunicorn,
            'tt-staging-app.service': app, 'tt-staging-proxy.service': proxy,
            'tt-staging-close.service': close,
            'runtime-overlay.env.example': environment,
            'review.json': json.dumps({'format':'techtrolley-staging-review-1', 'inputs':v,
                                      'installation_performed':False, 'linux_verified':False}, indent=2)+'\n'}


def write_packet(values, output):
    files = render(values); output = Path(output)
    require(output.is_absolute() and not output.exists() and not output.is_symlink(), 'Fresh absolute output required')
    parent = output.parent
    require(parent.is_dir() and not parent.is_symlink() and parent.stat().st_mode & 0o077 == 0,
            'Private output parent required')
    source_root = Path(__file__).resolve().parents[2]
    require(output.resolve() == output and source_root not in output.parents and
            not any(p.name == '.git' for p in output.parents),
            'Output must be canonical and outside the project')
    require(parent.stat().st_uid == os.getuid(), 'Output parent must belong to the current user')
    output.mkdir(mode=0o700)
    for name, content in files.items():
        fd = os.open(output/name, os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as stream:
            stream.write(content)
    return output


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args=parser.parse_args()
    require(args.input.stat().st_size < 8192, 'Bounded non-secret input required')
    def pairs(items):
        result={}
        for key,value in items:
            require(key not in result, 'Duplicate input fields refused')
            result[key]=value
        return result
    values=json.loads(args.input.read_text(), object_pairs_hook=pairs)
    write_packet(values,args.output)
    print('Review packet written. No installation or server change performed.')


if __name__=='__main__':
    main()
