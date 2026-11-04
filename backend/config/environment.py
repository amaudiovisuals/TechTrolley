"""Pure runtime configuration. No environment file loading or database connection."""
import ipaddress
import re
import secrets
from pathlib import Path
from urllib.parse import urlsplit


class ConfigurationError(ValueError):
    pass


def boolean(env, name, default=False):
    value=env.get(name, 'true' if default else 'false').lower()
    if value not in {'true','false'}:
        raise ConfigurationError(name+' must be true or false')
    return value=='true'


def required(env, name):
    value=env.get(name,'')
    if not isinstance(value,str) or not value.strip():
        raise ConfigurationError(name+' is required')
    return value


def host(value):
    if not value or value != value.strip() or value.startswith('.') or '*' in value:
        raise ConfigurationError('ALLOWED_HOSTS must contain exact hostnames or IP addresses')
    try:
        ipaddress.ip_address(value.strip('[]'))
    except ValueError:
        if not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?',value) or '..' in value:
            raise ConfigurationError('ALLOWED_HOSTS must contain exact hostnames or IP addresses')
    return value.lower()


def origins(value, secure):
    result=[]
    for entry in value.split(','):
        entry=entry.strip()
        try:parsed=urlsplit(entry);port=parsed.port
        except ValueError:raise ConfigurationError('Origin must be a valid scheme://host[:port]')
        if parsed.scheme not in ({'https'} if secure else {'http','https'}) or not parsed.hostname or parsed.username or parsed.password or parsed.path not in {'','/'} or parsed.query or parsed.fragment:
            raise ConfigurationError('Origin must be an exact '+('HTTPS ' if secure else '')+'scheme://host[:port]')
        host(parsed.hostname)
        if port is not None and not 1<=port<=65535:raise ConfigurationError('Origin port is invalid')
        normalized=entry.rstrip('/')
        if normalized not in result:result.append(normalized)
    return result


def runtime_config(env, base_dir):
    mode=env.get('DJANGO_ENV','development')
    if mode not in {'development','staging','production'}:
        raise ConfigurationError('DJANGO_ENV must be development, staging or production')
    secure=mode!='development'
    key=required(env,'DJANGO_SECRET_KEY') if secure else env.get('DJANGO_SECRET_KEY') or secrets.token_urlsafe(48)
    if len(key)<50 or len(set(key))<8 or key.startswith('django-insecure-') or any(word in key.lower() for word in ('replace_me','change_me','example_secret')):
        raise ConfigurationError('DJANGO_SECRET_KEY must be a strong private value of at least 50 characters')
    if secure and boolean(env,'DJANGO_DEBUG'):
        raise ConfigurationError('DJANGO_DEBUG cannot be enabled outside development')
    hosts=[host(item.strip()) for item in (required(env,'DJANGO_ALLOWED_HOSTS') if secure else env.get('DJANGO_ALLOWED_HOSTS','localhost,127.0.0.1,[::1],testserver')).split(',')]
    instance=required(env,'TT_INSTANCE_ID') if secure else env.get('TT_INSTANCE_ID','local-development')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}',instance):
        raise ConfigurationError('TT_INSTANCE_ID must be an explicit instance identifier')
    origin_list=origins(required(env,'TT_APP_ORIGIN'),True) if secure else origins(env.get('TT_APP_ORIGIN','http://localhost:3000'),False)
    if len(origin_list)!=1 or urlsplit(origin_list[0]).hostname.lower() not in [h.strip('[]') for h in hosts]:
        raise ConfigurationError('TT_APP_ORIGIN must match an exact allowed host')
    if secure:
        db={name:required(env,'TT_DB_'+name.upper()) for name in ('name','user','password','host','port')}
        for field in ('name','user'):
            if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,62}',db[field]):
                raise ConfigurationError('TT_DB_'+field.upper()+' must be an explicit database identifier')
        if mode=='staging' and not db['name'].endswith('_staging'):
            raise ConfigurationError('Staging requires a dedicated TT_DB_NAME ending in _staging')
        if not db['port'].isdigit() or not 1<=int(db['port'])<=65535:
            raise ConfigurationError('TT_DB_PORT must be a valid port')
        if not db['host'].startswith('/'):
            host(db['host'])
        local=db['host'] in {'localhost','127.0.0.1','::1'} or db['host'].startswith('/')
        sslmode=env.get('TT_DB_SSLMODE','prefer' if local else 'verify-full')
        if sslmode not in {'disable','prefer','require','verify-ca','verify-full'} or not local and sslmode!='verify-full':
            raise ConfigurationError('Remote PostgreSQL requires verify-full TLS')
        options={'sslmode':sslmode,'connect_timeout':5}
        if not local:
            options['sslrootcert']=required(env,'TT_DB_SSLROOTCERT')
            if not Path(options['sslrootcert']).is_absolute():raise ConfigurationError('TT_DB_SSLROOTCERT must be an absolute CA path')
        database={'ENGINE':'django.db.backends.postgresql',**{k.upper():v for k,v in db.items()},'OPTIONS':options,'ATOMIC_REQUESTS':False}
    else:
        database={'ENGINE':'django.db.backends.sqlite3','NAME':Path(base_dir)/'db.sqlite3','ATOMIC_REQUESTS':False}
    cors=origins(env.get('DJANGO_CORS_ALLOWED_ORIGINS',','.join(origin_list) if secure else 'http://localhost:3000,http://127.0.0.1:3000'),secure)
    csrf=origins(env.get('DJANGO_CSRF_TRUSTED_ORIGINS',','.join(origin_list) if secure else 'http://localhost:3000,http://127.0.0.1:3000'),secure)
    trust_proxy=boolean(env,'TT_TRUST_PROXY')
    if trust_proxy and (not secure or not boolean(env,'TT_PROXY_HEADER_SANITIZED')):
        raise ConfigurationError('Trusted proxy requires secure mode and TT_PROXY_HEADER_SANITIZED=true')
    unix_client_ip=boolean(env,'TT_PROXY_CLIENT_IP_FROM_UNIX')
    if unix_client_ip and not trust_proxy:
        raise ConfigurationError('Unix proxy client identity requires explicit sanitized trusted proxy mode')
    external_ai=boolean(env,'TT_EXTERNAL_AI_ENABLED',not secure)
    if mode=='staging' and external_ai:raise ConfigurationError('External AI is disabled in staging')
    if secure:
        media_root=Path(required(env,'TT_MEDIA_ROOT'))
        static_root=Path(required(env,'TT_STATIC_ROOT'))
        if not media_root.is_absolute() or not static_root.is_absolute() or media_root==static_root or media_root in static_root.parents or static_root in media_root.parents:
            raise ConfigurationError('TT_MEDIA_ROOT and TT_STATIC_ROOT require separate absolute directories')
    else:
        media_root=Path(base_dir)/'media';static_root=Path(base_dir)/'static'
    return {
        'RUNTIME_ENVIRONMENT':mode,'RUNTIME_INSTANCE_ID':instance,'APP_ORIGIN':origin_list[0],
        'SECRET_KEY':key,'DEBUG':boolean(env,'DJANGO_DEBUG',not secure),
        'ALLOWED_HOSTS':hosts,'DATABASES':{'default':database},
        'CORS_ALLOW_ALL_ORIGINS':False,'CORS_ALLOWED_ORIGINS':cors,'CORS_ALLOW_CREDENTIALS':False,
        'CSRF_TRUSTED_ORIGINS':csrf,'SESSION_COOKIE_SECURE':secure,'CSRF_COOKIE_SECURE':secure,
        'SESSION_COOKIE_HTTPONLY':True,'CSRF_COOKIE_HTTPONLY':True,'SESSION_COOKIE_SAMESITE':'Lax','CSRF_COOKIE_SAMESITE':'Lax',
        'SECURE_SSL_REDIRECT':secure,'SECURE_PROXY_SSL_HEADER':('HTTP_X_FORWARDED_PROTO','https') if trust_proxy else None,
        'SECURE_HSTS_SECONDS':3600 if secure else 0,'SECURE_HSTS_INCLUDE_SUBDOMAINS':False,'SECURE_HSTS_PRELOAD':False,
        'SECURE_CONTENT_TYPE_NOSNIFF':True,'SECURE_REFERRER_POLICY':'same-origin','X_FRAME_OPTIONS':'DENY',
        'MEDIA_ROOT':media_root,'STATIC_ROOT':static_root,'EXTERNAL_AI_ENABLED':external_ai,
        'PROXY_CLIENT_IP_FROM_UNIX':unix_client_ip,
        'EMAIL_BACKEND':'django.core.mail.backends.dummy.EmailBackend',
    }
