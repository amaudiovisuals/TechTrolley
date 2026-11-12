# Runtime configuration and release candidates

Current checkpoint: Step8B5 (runtime foundation from8B1). Local code/tests only. The live service has
not received these changes. **Do not pull this version onto a running server and
restart it without preparing its private environment first:** secure startup now
refuses missing configuration. No real secret was rotated by editing the source.

## Local development

The existing launchers explicitly set `DJANGO_ENV=development` and retain local
SQLite. Default hosts are localhost/127.0.0.1/IPv6 loopback/testserver; CORS allows
the two localhost frontend origins. A fresh process generates a random development
signing key unless a private `DJANGO_SECRET_KEY` is supplied. Development sessions
can therefore expire across restarts; this does not expire DRF API tokens.

WSGI/ASGI entry points require an explicitly set mode. Directly running `manage.py
runserver` without a mode is no longer a supported launcher; use the documented
scripts. Tests use their isolated runners, not a development/business database.
No `.env` file is automatically loaded. A protected service manager/environment file
must supply secure-mode values; do not put real secrets in this repository.

## Staging/production inputs

Use the [non-secret staging template](examples/staging.env.example) as a field list.
Its signing-key placeholder is intentionally rejected. Choose a distinct database,
role, origin and storage paths for staging; no such server/database was provisioned.

| Variable | Contract |
|---|---|
| `DJANGO_ENV` | Exactly development, staging or production; typos refuse |
| `DJANGO_SECRET_KEY` | Private random value, at least50 characters/eight distinct characters; no insecure/common example prefix |
| `DJANGO_DEBUG` | Optional strict true/false; true refused in staging/production |
| `DJANGO_ALLOWED_HOSTS` | Required comma-separated exact hosts/IPs; no wildcard, suffix, URL or port |
| `TT_APP_ORIGIN` | One exact HTTPS origin whose hostname is in allowed hosts |
| `TT_INSTANCE_ID` | Required explicit unique operational instance identifier; does not enable reviewed writes |
| `TT_DB_NAME`, `TT_DB_USER`, `TT_DB_PASSWORD`, `TT_DB_HOST`, `TT_DB_PORT` | All required in secure modes; PostgreSQL only, no production/default credential fallback |
| `TT_DB_NAME` in staging | Must end in `_staging`; copying the live production name is refused |
| `TT_DB_SSLMODE`, `TT_DB_SSLROOTCERT` | Remote DB requires verify-full and an absolute CA path; loopback/Unix socket defaults prefer |
| `TT_MEDIA_ROOT`, `TT_STATIC_ROOT` | Required separate absolute paths, neither nested in the other |
| `DJANGO_CORS_ALLOWED_ORIGINS`, `DJANGO_CSRF_TRUSTED_ORIGINS` | Optional explicit HTTPS lists; default current app origin; wildcards/credentials/paths refused |
| `TT_TRUST_PROXY`, `TT_PROXY_HEADER_SANITIZED` | Strict booleans, default false; both true required to trust X-Forwarded-Proto in secure mode |
| `TT_EXTERNAL_AI_ENABLED` | Default off in production; cannot be enabled in staging; local rule engine remains available |
| Reviewed-write gates and their existing instance IDs | Independent, default off; configuring runtime mode/instance does not enable them |

Only trust forwarded HTTPS after the proxy strips client-supplied headers, sets its
own value and the backend socket is inaccessible to clients. Otherwise leave trust
off. Real proxy/TLS/network/database roles and CA files still need review on staging.
`ATOMIC_REQUESTS` stays false: operational commands have short explicit transactions,
and read-only repeatable snapshots need their own first-statement boundary.

Secure defaults enable HTTPS redirects, secure/HttpOnly cookies, SameSite Lax,
nosniff, same-origin referrer policy and DENY framing. HSTS is one hour for this
host; includeSubDomains/preload remain false until domain-wide TLS is reviewed.
Django reports security.W005/W021 for those two deliberate limits; they are not
silenced. No other deployment-check findings were accepted in the synthetic smoke.
This is not a recommendation to preload an unverified staging or parent domain.
The24-hour session age/browser-close policy stays; saving unchanged sessions on
every request is disabled. Cookie settings do not establish DRF token expiry.

External email uses the dummy backend; no mail/activation delivery is configured.
AI keys remain backend-only: the frontend build no longer loads/injects GEMINI keys.
The actual server endpoint ignores inherited keys when external AI is disabled.
Do not name any private credential with Vite's public `VITE_` prefix.

## What this does not finish

[Step8B2](investigations/2026-10-15/STEP_8B2.md) adds24-hour token expiry,
server logout, validated password/reset flows, private event PDF downloads and QR
label escaping. The current single-token-per-user design makes API logout affect
all devices sharing that login. Password changes require a fresh login; durable
work stays on the device. These changes remain local, with no real token rotation.

[Step8B3](investigations/2026-10-15/STEP_8B3.md) adds database-backed credential
budgets (migration0066), bounded JSON/form/file/ZIP/image parsing, reviewed older
email-scoped work copying and atomic administrator-only create-only inventory
imports. Generic Django admin routing is development-only. Secure workers must
share the fixed private signing key and primary DB. The limiter ignores forwarded
IP headers; proxy peers share a budget until actual client-address handling is
reviewed.503 fails closed if the security table/storage is unavailable.

8B4 updates the local candidate to Django6.0.9/DRF3.17.2/Requests2.34.2 and one
23-package hash-checked application/validation lock; Gunicorn26.2.0 passed real WSGI
smoke over a private Unix socket with DB access refused. The installed app venv and
production were not upgraded. [Current checkpoint](investigations/2026-10-15/STEP_8B4.md).
Use Python3.12 and `backend/requirements.txt` in a fresh environment; the old test
pins are historical. Source/history cleanup and real credential rotation remain
separate [reviewed operations](SECURITY_RELEASE_CHECKLIST.md). Full release/activation
and controlled Linux/HTTPS staging must still be rehearsed. Actual proxy request/time/disk limits,
raw media denial, backup/restore and phone/Safari/PWA/offline checks remain. Public
media aliases must be removed; app-level guards cannot protect independent hosting.
Production credentials/API tokens/history must be reviewed and rotated separately;
removing literals from current source does not erase Git history or revoke access.

## Release preparation — current8B5

The workflow now builds a **complete review bundle**, rather than the old metadata
and frontend-only candidate. It still has no SSH/SCP, server secret, pull/reset,
automatic live migration/restart or deployment. The workflow has not run on GitHub;
Ubuntu/PostgreSQL binary/action/runtime behavior remains an acceptance gate.

`release_bundle.py build --revision <full-SHA> --output <new-private-archive>`
requires a clean exact checkout and rejects tracked private/generated paths. It
compares source to committed blob bytes, exports only allowed backend/frontend/
schema/dependency/validation/runbook files, performs its own fresh npm ci/typecheck/
build with no inherited private config, and rechecks source identity. It never
packages an old checkout dist. Source/build/schema/lock hashes share one manifest.
All artifacts say deployment_enabled=false. The dirty project is correctly refused.

Incoming verification requires an independently trusted archive SHA256 and full
revision. It rejects traversal, links/devices, duplicate/case-colliding paths,
unsupported members/modes, hidden/private/source-map output, oversized compressed/
expanded streams and mismatched inventories/hashes. Extraction is exclusive/private.
The payload carries locked installation inputs, not an OS image or installed venv.

`check_packaged_release.py` verifies/extracts the actual bundle and runs its own
backend/schema/dependency/runtime/private-PG contracts. A new release-only mode
rehearses failure/recovery on the packaged backend and synthetic PostgreSQL data.
The sandbox checks the cluster/instance/nonce, quiescence, all-runtime migration
history plus the exact core inventory, staged bytes and revision/schema-bound
health. Its private pointer/journal/asset store never control a real service.

The previous-code directory is an explicit test stub. No validated production
rollback artifact, Linux worker restart or Nginx/TLS routing is claimed. Recovery
refuses automatic old-schema rollback/DB restore; maintenance stays until an
explicit verified forward retry. Existing hash-named browser assets are retained
in the rehearsal store and collisions refuse activation. The actual host must
implement that mapping and prove it with the workers/proxy/devices before release.

Use [release operations](RELEASE_OPERATIONS.md) for the full preflight, maintenance,
backup/media, activation/failure matrix and candidate commands. `prepare_release.py`
remains a historical metadata helper, not the complete bundle path or a deploy tool.
Do not reset/bulk-add the owner working tree to make packaging pass.

Official references:
[Django deployment settings](https://docs.djangoproject.com/en/6.0/howto/deployment/checklist/),
[Django proxy trust](https://docs.djangoproject.com/en/6.0/ref/settings/#secure-proxy-ssl-header).


## Step 8B4 dependency/release guard

`backend/requirements.in` lists direct dependencies; `backend/requirements.lock`
pins their full runtime graph with publisher artifact SHA256 hashes. The app and
validation wrapper manifests use that same lock with hash checking. Operational
CLI/Windows helpers were separated from the app runtime. Never upgrade the running
service venv in place from the old broad manifest.

Run `scripts/testing/check_dependencies.py --installed` in the candidate Python3.12
venv, then pip check and the isolated suites. It verifies exact lock agreement,
vendored XLSX identity/SHA256/SHA512 and normal npm peer policy. It does not query
advisories; final registry evidence is time-bound and must be refreshed for release.
The release metadata requires the direct/runtime locks and vendor archive/provenance
alongside backend source. This still does not package or activate the complete backend.


## Step8B6 private Unix proxy identity

`TT_PROXY_CLIENT_IP_FROM_UNIX` defaults to false. Enable it only with secure mode,
`TT_TRUST_PROXY=true`, `TT_PROXY_HEADER_SANITIZED=true` and a filesystem-restricted
Unix Gunicorn socket behind the reviewed proxy. Only empty Unix REMOTE_ADDR may
use the proxy-overwritten X-TT-Client-IP for credential peer budgets. TCP peers
cannot supply their own identity; malformed/missing/chain input remains in the
shared unknown-peer bucket. Account/actor budgets are unchanged. This avoids
sharing every staff member's peer limit when using the Unix socket. It does not
trust arbitrary X-Forwarded-For, Forwarded or X-Real-IP headers.

[Staging operations](STAGING_OPERATIONS.md) defines the proposed services, direct
CIDR restriction, TLS/header policy, permissions and maintenance/cache rules.
Only production EC2 is available; the packet is for a proposed separate dedicated
staging installation and must not replace the current server's Nginx/service.
Local proxy checks do not certify Linux/systemd, real storage recovery or phones.


## Local VM forwarded HTTPS port — Step8B7

The staging renderer optionally accepts integer `public_https_port` (default443;
otherwise1024..65535). It pins TT_APP_ORIGIN and the proxy's upstream Host to the
same reviewed authority, while retaining guest Nginx443. This supports a local
127.0.0.1:24443 SSH forward without broad CORS or arbitrary forwarded-host trust.
[Staging operations](STAGING_OPERATIONS.md) describes the owner-selected private
Linux VM. Existing default443 packets remain byte-identical to8B6.


## Actual disposable service runtime — Step8B8

Seven-file staging packets now include a fixed root close-ingress oneshot. App
and proxy start/failure close maintenance; health checks never automatically open
it. Exact Python environments live outside the verified package at
`S/venvs/<fullSHA>`, source at `S/releases/<fullSHA>`. Gunicorn control sockets are
disabled, systemd uses master-led graceful stop and explicit memory/CPU/task/file
limits. Actual nonroot users, read-only release mount namespace, private media/TLS/
environment/socket permissions and restricted PostgreSQL runtime role were checked
in the disposable Ubuntu VM. Reboot/crash/persistence acceptance used synthetic
records only. See [operations](STAGING_OPERATIONS.md); this does not certify real
phones, production backups, load capacity or live deployment.
