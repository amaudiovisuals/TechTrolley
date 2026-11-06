"""Runtime settings. Secure modes require explicit private environment values."""
import os
from pathlib import Path
from django.core.exceptions import ImproperlyConfigured
from .environment import runtime_config, ConfigurationError, boolean

BASE_DIR = Path(__file__).resolve().parent.parent
try:
    globals().update(runtime_config(os.environ, BASE_DIR))
except ConfigurationError as error:
    raise ImproperlyConfigured(str(error)) from None

INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'rest_framework',
    'rest_framework.authtoken',
    'corsheaders',
    'core',
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'core.upload_safety.UploadLimitsMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'corsheaders.middleware.CorsMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF = 'config.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'config.wsgi.application'


AUTH_PASSWORD_VALIDATORS = [
    {'NAME':'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {'NAME':'django.contrib.auth.password_validation.MinimumLengthValidator'},
    {'NAME':'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME':'django.contrib.auth.password_validation.NumericPasswordValidator'},
]
LANGUAGE_CODE = 'en-us'
TIME_ZONE = 'UTC'
USE_I18N = True
USE_TZ = True
STATIC_URL = '/static/'
MEDIA_URL = '/media/'
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'
DATA_UPLOAD_MAX_MEMORY_SIZE = 10 * 1024 * 1024
FILE_UPLOAD_MAX_MEMORY_SIZE = 2 * 1024 * 1024
SESSION_COOKIE_AGE = 86400
SESSION_EXPIRE_AT_BROWSER_CLOSE = True
SESSION_SAVE_EVERY_REQUEST = False
REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': [
        'core.authentication.ExpiringTokenAuthentication',
        'rest_framework.authentication.SessionAuthentication',
    ],
    'DEFAULT_PARSER_CLASSES': ['core.upload_safety.BoundedJSONParser', 'core.upload_safety.BoundedFormParser', 'rest_framework.parsers.MultiPartParser'],
            'DEFAULT_PERMISSION_CLASSES': ['rest_framework.permissions.IsAuthenticated'],
}
# Independent gates remain off; runtime mode/instance does not enable reviews.
try:
    REVIEWED_RECONCILIATION_WRITES_ENABLED = boolean(os.environ, 'REVIEWED_RECONCILIATION_WRITES_ENABLED')
    REVIEWED_OWNERSHIP_WRITES_ENABLED = boolean(os.environ, 'REVIEWED_OWNERSHIP_WRITES_ENABLED')
    LED_CASE_CONVERSION_WRITES_ENABLED = boolean(os.environ, 'LED_CASE_CONVERSION_WRITES_ENABLED')
except ConfigurationError as error:
    raise ImproperlyConfigured(str(error)) from None
RECONCILIATION_INSTANCE_ID = os.getenv('RECONCILIATION_INSTANCE_ID', '')
OWNERSHIP_INSTANCE_ID = os.getenv('OWNERSHIP_INSTANCE_ID', '')
LED_CASE_CONVERSION_INSTANCE_ID = os.getenv('LED_CASE_CONVERSION_INSTANCE_ID', '')
