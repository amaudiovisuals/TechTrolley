# Restricted staging operations — Step8B8

**Latest — Step8B29,3November:** [Current status and remaining work](CURRENT_STATUS.md)
is the starting page. Both-phone ordinary offline flow is recorded; owner now
confirms iPhone Safari Inventory visible. Five remaining groups are reconciled;
next is device lifecycle test preparation. No new phone action, live connection,
fixture or deployment in this review. Older checkpoint instructions below are
historical. [Review](investigations/2026-11-03/STEP_8B29.md).


**Latest recovery checkpoint: Step8B9.** A separate synthetic paired DB/media
restore passed18 checks;22 integrity/refusal tests are added to the packaged
validator (now14 groups). See [recovery](BACKUP_RECOVERY.md) and the conditional
[phone HTTPS/access plan](PHONE_STAGING_ACCESS.md). No real backup export or
phone-facing listener was enabled. The seven-file service design below remains
unchanged from8B8; actual phone/network inputs and business recovery remain open.

**Executed locally,16October2026.** The owner-selected disposable Linux VM passed
44 actual systemd/HTTPS/PostgreSQL permission, drain, restart, reboot and crash
recovery checks using synthetic records. Production EC2 and GitHub are unchanged.
There is no staff-facing staging URL. The original8B6 environment proposal below
is retained as history; the owner subsequently selected a local VM. Do not install
this standalone packet over production Nginx.

## Original8B6 environment proposal (historical)

Use a **separate temporary Linux server** for staging, with a new private database,
synthetic warehouse records and its own restricted HTTPS hostname. Size, OS,
provider/cost, access method and lifetime need review before provisioning. This is
a proposal, not authorization to buy/create a server. A separate local Linux VM
could establish runtime behavior first, but phone access still needs reviewed TLS
and networking. Neither runtime currently exists on this Mac.

A same-EC2 staging installation shares the live machine's CPU/memory/disk, network,
privileges and failure domain. It needs a separately designed resource/access and
virtual-host plan after capacity/backup review. **The standalone Nginx packet binds
443 and would conflict with the existing service. It is not a production Nginx
include and is not suitable for simply copying onto that EC2.** Do not stop, replace,
reload or edit the existing service to make this example fit.

## Concrete review packet

`scripts/deployment/staging_config.py` renders seven private files: standalone
`nginx.conf`, `gunicorn.conf.py`, three dedicated systemd units (app, proxy and close-ingress), a non-secret runtime
overlay and `review.json`. It does not install, connect, restart, migrate or activate.
Inputs accept hostname, dedicated root, full revision, restricted CIDRs and an
optional reviewed public HTTPS port;
no database identity/password or key contents are accepted. A syntactically valid
revision is not proof of a real reviewed release: independently match the complete
verified bundle/manifest and trusted archive digest before using it.

Example **synthetic review inputs**, not a real hostname, release or access grant:

```json
{
  "hostname": "staging.example.test",
  "root": "/srv/techtrolley-staging",
  "revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "allowed_cidrs": ["192.0.2.4/32"]
}
```

Developer-only rendering, into a new directory under an existing private0700
parent outside the project:

```sh
PYTHONDONTWRITEBYTECODE=1 /absolute/candidate/python \
  scripts/deployment/staging_config.py \
  --input /absolute/private/review-input.json \
  --output /absolute/private/new-staging-packet
```

No actual host/origin/IP/revision values have been selected. The file is a packet
for review, not an instruction for the owner to execute on production.

## Layout and permissions to verify on Linux

For the proposed dedicated root `S=/srv/techtrolley-staging`:

| Path | Purpose and required control |
| --- | --- |
| `S/releases/<fullSHA>/backend`, `frontend/dist`; `S/venvs/<fullSHA>` | Exact verified code, fresh per-release Python3.12 venv/hash-checked lock, frontend from matching archive. Operator/root owned and read-only to service users. No source, environment or backups under the public frontend root. |
| `S/current` | Operator-owned atomic symlink to verified release. Nginx reads its frontend only. Gunicorn's unit pins the exact release path, so a pointer swap does not update running workers. |
| `S/immutable-assets` | Operator-owned regular hashed build files from every supported release, readable by proxy, no symlinks/overwrites/collisions. Publish chunks before shell; preserve old names/bytes. Never use this as an upload directory. |
| `S/config`, `S/maintenance.flag` | Operator controlled. Both application and proxy may read; neither may rewrite configs or remove maintenance. Flag must exist before first start. |
| `S/run/app` | App owned,0750, group `tt-staging-web`; socket0660. Proxy can connect, cannot create/replace the socket. No public Gunicorn port. |
| `S/run/proxy`, `S/logs`, `S/proxy-temp` | Proxy owned/private; separate from the app's writable paths. Bound temp/log disk use, rotate private logs and reserve capacity before testing. |
| `S/private-media`, `S/app-temp` | App owned0700; proxy user cannot read. Real uploads/PDFs remain outside all frontend/static roots. |
| `S/collected-static` | Separate from media/frontend; not publicly routed in this packet. Generic admin is not exposed. |
| `S/tls` | Certificate/key for the reviewed origin; private key readable only by operator/proxy role. Do not store key in the repository/archive or shared asset group. |
| `/etc/techtrolley-staging/runtime.env` | Operator/root owned0600. New random signing key, new `_staging` DB/name/least-privilege role/password, explicit paths/origin. Root systemd manager reads EnvironmentFile; never use live credentials or source this example into a shell. |

The app user is `tt-staging`; the proxy is `tt-staging-proxy`; their shared socket/
read-only web group is `tt-staging-web`. Proxy TLS access uses its separate
`tt-staging-proxy` supplementary group. Directory creation, ownership, ACLs,
symlink containment and native dependencies must be checked on the actual host;
the renderer does not apply permissions. Proposed systemd protection makes the
filesystem read-only except the explicitly separate runtime areas. Actual
`systemd-analyze verify`, cgroup/resource limits, journal privacy, stop/drain,
reboot behavior and file-access tests as both users remain open.

## Ingress and client identity contract

Only explicitly approved **direct client/VPN CIDRs** may access staging, including
assets/API. Use a VPN or reviewed equivalent for changing phone IPs. Do not open the
CIDRs to the world for convenience. No HTTP Basic gate is added because the app
already uses the Authorization header for its Token authentication.

The dedicated Nginx listens on HTTPS only; exact Host is required. It overwrites
Host, HTTPS and `X-TT-Client-IP` from its direct `$remote_addr`, removes forwarded
chains and does not enable real-IP rewriting. The app's Unix socket is the only
upstream. Gunicorn does not interpret arbitrary forwarded scheme headers.

`TT_PROXY_CLIENT_IP_FROM_UNIX=true` is **off by default** and requires the existing
explicit secure/sanitized-proxy acknowledgement. Only an empty Unix `REMOTE_ADDR`
may use this one sanitized header for the credential peer budget. A TCP peer,
including localhost, cannot select another address with that header. Missing,
malformed or chained values use the shared `unknown-peer` budget; account/actor
budgets remain shared across workers. Filesystem access to the Unix socket is a
trusted boundary: another allowed local process could forge this header. Do not
expose the socket or enable this with an unsanitized proxy. A future load balancer/
CDN changes direct peer identity and requires a new reviewed trust design.

## Maintenance, private files and caches

All `/api/` requests/methods return503 while the operator flag exists, without
forwarding to Django. UI/deep-link entry is blocked; existing hashed chunks can
still load. This flag **does not drain already-running requests, kill workers or
pause background jobs**. Close ingress, drain/stop all writers, verify no other DB
connections and capture/verify backup before any schema change. Never migrate
while active retries or another writer can still reach the database.

`/media`, `/admin`, source folders, dotfiles, dumps/keys/maps and missing assets
cannot become SPA responses. PDFs use the authenticated application endpoint;
public-logo policy remains in Django. Private file tests here use anonymous
requests and synthetic files; role-specific real HTTPS acceptance is still required.
API is not cached and upstream retries are disabled. Request bodies cap at24MiB;
application-specific smaller JSON/file limits still apply. Header/body/read/send
limits are explicit, but actual disk quotas/timeouts/load need host testing.

Successful hashed assets are immutable for a year; **404 assets are not marked
immutable**. Shell and service worker use no-store; deep links reach the current
shell. Retained hashes avoid broken older tabs during release changes. Asset/disk
retention policy needs supported PWA/offline-client evidence; no timed pruning or
forced reload/storage clearing is introduced. This does not certify offline scanning.

Access logs omit query strings/Authorization/body. Error/journal logs stay private
because diagnostics may contain URLs. No debug access dump. Request-path values
can still appear in logs; do not place credentials in URL paths.

## Local validation and remaining gates

14 renderer refusal/permission/service-contract tests and an actual local TLS
Nginx→Unix Gunicorn→Django harness exercise access, spoofing, maintenance, media and
asset rules. All DB connections are refused. Probe endpoints, self-signed test
certificate and old/new frontend files exist only in the private test wrapper;
there is no diagnostic endpoint in the application. The certificate/hostname are
verified by the client; TLS verification is never disabled. Processes stop afterward.

```sh
PYTHONDONTWRITEBYTECODE=1 /absolute/candidate/python scripts/testing/test_staging_config.py
PYTHONDONTWRITEBYTECODE=1 /absolute/candidate/python scripts/testing/check_staging_proxy.py \
  --nginx-bin /absolute/reviewed/nginx --openssl-bin /absolute/reviewed/openssl \
  --output /absolute/private/new-proxy-check
```

The loopback override is internal to this harness; it is not a deployment CLI.
The source includes the renderer/guards/harness in verified review bundles;
packaged validation runs the14 guards. Actual TLS tests require separately
reviewed native proxy/TLS executables and are a separate explicit check.

Local macOS proxy behavior does **not** establish Linux/systemd behavior, actual
production compatibility, real backup/media restoration or physical Android/iPhone/
installed-PWA/offline acceptance. Before activation: choose/review resources, validate
Linux services and least privilege, run the full extracted package and migration/
recovery tests, rehearse real backup+media restoration in isolation, execute the
phone sheet, finish credential/tracking cleanup and produce a complete reviewed
project commit/release. No installer/production adapter is supplied by this step.

References: [Nginx proxy headers/retries](https://nginx.org/en/docs/http/ngx_http_proxy_module.html),
[Nginx location/headers/files](https://nginx.org/en/docs/http/ngx_http_core_module.html),
[Nginx direct-peer access rules](https://nginx.org/en/docs/http/ngx_http_access_module.html),
[systemd execution/permissions source](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml).


## Step8B7 — owner-selected temporary local Linux VM

On16October the owner chose **a temporary Linux VM on this Mac, without cloud
charges**. Hardware preflight found16GiB RAM,12logical CPUs,ARM64 virtualization
support and approximately104GiB disk free. Initial resource allocation is4vCPU,
4096MiB RAM and a32GiB sparse disk. This is a synthetic test environment, not a
production sizing result or a durable backup. Close other heavy applications if
host memory pressure appears; do not silently allocate more RAM/disk.

Use a portable private vfkit runner with Apple's virtualization framework and an
official Ubuntu24.04 ARM64 cloud disk. No global hypervisor install, host-folder/
clipboard/USB sharing, production key, cloud subscription or existing Mac service
change is needed. The VM directory is private0700 outside the project, with new
private SSH credentials. The guest's root disk and configuration are synthetic.
Record image URL, digest, signing/verification limits and actual guest versions.
Neither downloaded wheels nor an ARM64 VM establish production x86-64 compatibility;
the actual target architecture still needs verification before a release.

Guest SSH ingress is exposed through a private Unix/virtio socket, with the guest
SSH host key pinned using a nonce-checked bootstrap response over a second private
virtual socket. Password/root/agent login is disabled. Guest TCP SSH binds loopback.
No Mac public TCP SSH listener, LAN bridge, host-root mount or production `.pem` is
used. NAT allows outbound package downloads; it is not a general egress firewall.
Do not infer that it prevents access to arbitrary Internet/LAN addresses. Application
configuration must still point exclusively to synthetic local databases/origin.

For later host-side browser access, a private SSH forward can map
`127.0.0.1:24443` to guest `127.0.0.1:443`. This tunnel is not started simply by
rendering a packet. Configure the reviewed hostname and **public_https_port24443**
together: the renderer sets `TT_APP_ORIGIN=https://staging.example.test:24443` and
pins the upstream Host with that port. Nginx still listens on443 inside the VM.
Default443 packets remain unchanged. Non-integer,privileged-other-than443 or out-
of-range public ports are refused; never reflect arbitrary browser Host/Forwarded
headers to construct the origin.

Example additional non-secret input:

```json
"public_https_port": 24443
```

The31local TLS/proxy checks now verify exact nonstandard-port CORS and the pinned
upstream Host in addition to the original access/maintenance/privacy/cache rules.
The harness waits for the previous Nginx worker generation to drain before testing
the new access policy; a single new-worker response is not a reload barrier.
14renderer guards cover port refusal and unchanged internal443 binding. These
checks use database-refused synthetic fixtures and are independent of Linux VM
application acceptance. A loopback URL/tunnel is not reachable from staff phones.
Phone access, valid trusted TLS/DNS and any additional routing remain a separate
reviewed setup; do not expose the Mac or turn off certificate verification.

Before running applications inside the guest: check cloud-init completion, kernel,
Python/systemd versions, architecture, disk/memory, private SSH socket and VM nonce.
Install runtime packages only **inside the fresh guest**, record package/security
sources, create a fresh hash-checked venv and use the verified extracted package.
Do not copy the Mac's venv/node_modules, SQLite, `.env`, browser storage, private
media or production credentials. Original-ID business ownership changes stay out.

Run native Linux dependency/schema/PG/recovery and actual proxy checks, then verify
systemd units and permissions as the separate service users. Actual installation,
maintenance/drain/reboot/resource behavior remains open until executed and recorded.
Stop the guest cleanly when a checkpoint finishes. Keep its private paths for the
next session, but temporary files may be cleared; they are not recovery backups.

Primary references: [vfkit interface](https://github.com/crc-org/vfkit/blob/main/doc/usage.md),
[official Ubuntu ARM cloud image directory](https://cloud-images.ubuntu.com/noble/20260926/),
[NoCloud configuration](https://docs.cloud-init.io/en/latest/reference/datasources/nocloud.html),
[pip foreign-platform downloads](https://pip.pypa.io/en/stable/cli/pip_download/).


## Step8B8 executed service design

The owner-selected VM is the only installation target for this checkpoint. The
earlier layout/next-work text above is historical. Current design uses **seven**
review files, including a fixed root-owned oneshot `tt-staging-close.service`.
Both app/proxy depend on it before starting and invoke it on failure. It deliberately
has no RemainAfterExit, so subsequent starts close ingress again. It never removes
maintenance: an operator must verify identity/schema/health before reopening. Normal
stop/migration procedures still close ingress first and drain all other writers.

Exact-revision environments now live at `S/venvs/<SHA>` and verified source at
`S/releases/<SHA>`. The verified package directory remains unchanged; installed
Python dependencies do not become unmanifested package files. Gunicorn management
control sockets are disabled; systemd owns its process lifecycle. KillMode=mixed
sends the graceful stop to the master first; the existing stop deadline bounds it.
Disposable app bounds are1GiB memory high/1536MiB max,2CPU,128tasks,2048files; proxy
256MiB max,1CPU,64tasks,1024files. These are disposable staging limits, not production
capacity estimates. Disk/log retention and measured production sizing still need review.

`scripts/testing/systemd_service_probe.py` is a **disposable-VM-only test installer**,
not a production activation command. It requires Linux root, the exact private
local-VM sentinel/nonce, fresh fixed paths/accounts and a trusted bundle digest/
revision. It accepts no host/DSN/old credentials; dependencies install offline from
reviewed wheels. It creates a separate private PostgreSQL socket/cluster and
`tt_service_staging`, independent app/migration roles and new test credentials.
Runtime is denied schema/role/database creation. No real data or production media.
Never remove its guards or manufacture its sentinel on EC2 to make it run there.

Actual service acceptance passed44 checks, including a real row-locked HTTP scan
completing during graceful master shutdown, original UUID replay and exact saved
manual challan persistence after restart, guest reboot and forced master failure.
Boot and tested service restarts retained maintenance until explicit operator
review. No real data or production traffic was exercised. Five non-mutating guard
tests run in ordinary package validation; the root installation/reboot exercise
is intentionally separate. Details and limits are in the current
[Step8B8 report](investigations/2026-10-16/STEP_8B8.md).

The test installer grants runtime DML only on the currently migrated tables and
sequences. Any future migration must be followed by a reviewed privilege refresh;
it does not grant future-object defaults or give the runtime DDL privileges.
Normal maintenance still requires closing ingress before stopping/draining every
writer. Process-failure closure is reactive; these checks do not establish zero
requests during every possible crash transition or constitute a live hot-upgrade/
rollback adapter. Resource limits were inspected as effective systemd properties,
not stress-tested to capacity. Disk/log quotas and retention remain open.
