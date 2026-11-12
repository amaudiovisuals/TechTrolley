# Release package and recovery procedure

Step 8B5, local design and synthetic rehearsal, 16 October 2026. **No production
installation is authorized by this document or by producing a bundle.** The owner
does not need to run these commands. Actual Linux/service/proxy adapters, restricted
HTTPS staging, real backups/media, device acceptance and final production review
remain separate gates. The existing working tree is dirty and must be preserved.

## What a review bundle contains

A matching backend (`config`, `core`, management commands and all core migrations),
frontend source and freshly generated frontend output, the single hash-checked
Python runtime lock, exact npm lock/vendor provenance, selected validation runners
and these operational guides. Backend regression tests use synthetic records;
including their source does not create test users or expose test HTTP servers.

Only explicitly allowed paths enter the bundle. Keys, environments, business DBs,
dumps, spreadsheets/CSVs, media, bytecode, source maps, virtual environments, npm
modules, legacy archives and old maintenance scripts are excluded. A clean commit
that still tracks prohibited private/generated paths is refused, not silently made
safe by ignore rules. The active `cleanup_adhoc` management command is retired and
fails before database access; its historical inventory-deleting behavior is not a
supported migration or repair operation.

The builder requires a clean checkout at a full exact Git SHA. It compares selected
working files to committed Git blob IDs, exports only those bytes, runs the locked
dependency check and **its own npm ci/typecheck/build in a new private export**, then
checks source/commit identity again. It never accepts the checkout's old `dist`.
No dirty/skip-build CLI exists. Build children receive a minimal environment and
empty user/global npm configuration, without inherited DB/cloud/AI credentials.
`npm ci --ignore-scripts` skips dependency lifecycle scripts; the reviewed npm build
scripts are then invoked explicitly. Generated output is hashed into the same
manifest as backend and migration source. This is not an OS/container image or an
independent source-code/security attestation.

Python 3.12 and Node 24 are required for the candidate build. Backend dependencies
are not copied from a developer's venv; the artifact carries their locked artifact
hashes. The host must install a **new per-release venv** with hash checking and
validate the actual Linux wheels/native libraries before activation. Node modules
are build-only and not part of the runtime artifact.

## Build and incoming verification (developer procedure)

Prepare a private0700 output directory outside a **reviewed clean checkout**. From
that checkout, in the validated Python3.12 environment:

```sh
python scripts/deployment/release_bundle.py build \
  --revision FULL_REVIEWED_GIT_SHA \
  --output /absolute/private/output/review.tar.gz
```

The printed archive SHA256/full revision must come through a trusted review channel.
A checksum obtained from the same untrusted download as the artifact is not an
independent trust anchor. Hash checking is not a publisher signature. Keep the
artifact and operations evidence private; runtime/test source is not a public
website directory. Never expose the extracted `backend/` or `scripts/` tree through
Nginx/static hosting.

Use the trusted verifier to inspect an incoming archive before writing its files:

```sh
python scripts/deployment/release_bundle.py verify \
  --archive /absolute/private/incoming/review.tar.gz \
  --sha256 TRUSTED_ARCHIVE_SHA256 --revision FULL_REVIEWED_GIT_SHA \
  --extract-to /absolute/private/new-release-directory
```

Extraction requires a new destination and creates it0700/files0600. It verifies
compressed/expanded/member/count bounds, canonical paths, duplicate/case collisions,
plain regular files, ownership/modes, manifest equality and every file hash. No
`extractall`, symlinks/hardlinks/devices/PAX/sparse files, traversal or overwrite.
Partial extraction is removed on a handled failure. An interrupted operation may
leave an incomplete private directory; verify/rebuild it rather than activate it.

The manifest binds source digest, frontend input/output digests, runtime-lock hash,
all core migration hashes/dependencies and its single leaf. Do not edit a packaged
file, overlay source on an existing release or rebuild frontend separately after
verification. A changed file is a different candidate and needs its own review.

## Preflight before any real installation

1. Recheck the actual host/service, DB identity, current full revision and complete
   migration ledger; older read-only observations are not enduring guarantees.
   Confirm runtime package versions, all Django-app migration consistency, no
   unknown or pending migration after upgrade, exact source/build/lock hashes and
   intended staging/production environment. Use the real configured origin/paths.
2. Complete the [source/credential cleanup procedure](SECURITY_RELEASE_CHECKLIST.md).
   Review private environment storage, least privilege, service user filesystem
   access, media/static separation, proxy trust and request/time/upload limits.
   The current Git tracking inventory still needs deliberate cleanup. Do not bulk
   add, reset, force-push or blindly pull/restart to satisfy clean-checkout guards.
3. Restore a fresh identified/encrypted backup of the correct DB **and private
   media/PDFs** on a separate restricted host, verify checksums/relations/application
   reads and measure recovery time. Confirm who can recover and which writes would
   be lost. Synthetic before/after test dumps do not establish business recovery.
4. Stage and verify the complete immutable release plus a fresh per-release venv.
   Start/warm the new worker on its private socket with the reviewed secure config;
   prove that the worker, frontend and schema are the intended candidate. Plan the
   actual Gunicorn/systemd/Nginx mapping and permissions on the real Linux host.
   Neither this guide nor `release_sandbox.py` installs that host configuration.
5. Make maintenance visible and block all business writes: API routes, old tabs,
   scanners/outbox retries, admin, background/import workers and direct maintenance
   scripts. Drain existing requests/transactions and verify no other writer/session
   remains. A frontend banner alone does not quiesce writes. Coordinate shared
   login/token rotation and preserve device drafts/original UUIDs through login.
6. With writers stopped, verify the baseline again and take/identify the coordinated
   pre-change backup/checkpoint. Record previous/candidate code identities, schema,
   DB/media identity, operator and recovery decision in a private durable journal.
   No credentials belong in that journal. Keep maintenance until all acceptance
   checks complete; a process crash must not implicitly open the site.

## Activation and failure decisions

| Point | Required response |
|---|---|
| Before migration/pointer changes | Abort only after observing unchanged schema/pointer and drained writers. No DB restore is needed. |
| Migration failure or unknown/intermediate state | Keep maintenance. Inspect the actual migration ledger/transaction outcome; no blind rerun, reverse migration or old-code switch. Review and recover forward. |
| Schema changed from the previous release | Old-code rollback is refused unless a separately proven compatibility contract exists. A previous directory alone is not such proof. |
| Candidate pointer published but health fails/crashes | Keep maintenance and a durable recovery-required state; verify the staged bytes and actual DB again, then explicitly retry/recover forward. |
| Candidate healthy | Recheck schema/DB/revision and private access, then deliberately reopen traffic. Check canonical saves and retained client work. |
| Work accepted after activation | Preserve its original IDs, UUID receipts and history. Never restore the pre-release DB automatically to fix a code failure. |
| A real DB restore is considered necessary | Separate incident decision: inventory all post-backup writes/media, agreed loss/replay/reconciliation, reviewed isolation and recovery authority. No automatic command is provided here. |

The rehearsal publishes a real pointer to a verified package inside a new private
**test** site. Its previous-code directory is explicitly a synthetic stub. It does
not pretend to validate rollback to the current production binary, restart live
workers, prove an Nginx maintenance rule or certify actual process/traffic draining.

## Keep old browser assets available

New code must not delete hashed JavaScript/CSS that open tabs or installed workers
still reference. Keep a shared immutable `/assets/` store across releases, rejecting
same-name/different-byte collisions. Serve each current shell/service worker from
the coordinated release with revalidation; retain older hash-named assets. Verify
this mapping and headers on the actual HTTPS host, including PWA/cache behavior.
Do not serve raw backend/private media through a fallback or worker cache.

The sandbox exercises retention and collision refusal; it does not modify the live
web server. Do not prune old releases/assets on a timer without measuring supported
old tabs/PWAs, offline storage and recovery needs. Retention also needs disk capacity
monitoring and a reviewed eventual cleanup policy. A pointer swap alone cannot
change already running Gunicorn workers or magically update open browsers.

## Reproduce the synthetic rehearsal

After verified extraction into a new private directory, use the exact candidate
Python environment and private PostgreSQL binaries:

```sh
PYTHONDONTWRITEBYTECODE=1 /absolute/candidate/python \
  /absolute/extracted-release/scripts/testing/run_postgres_tests.py \
  --pg-bin /absolute/private/postgresql/bin --mode release
```

The harness creates a new private Unix-socket cluster, accepts no business DSN,
checks cluster identity on connections and stops it in `finally`. It upgrades actual
packaged migrations0053→0066 with synthetic legacy records and restores both dumps
into a separate synthetic DB. Rehearsal-only pointer/state operations refuse an
unrelated path, DB, nonce, TCP listener, other connection, unknown/pending migration,
invalid archive or modified staged bytes. Failure injection includes pre-migration
abort, unsafe rollback refusal, failed post-pointer health, restart/forward recovery
and retention/replay of a real atomic synthetic scan's original UUID/receipt.

`release_sandbox.py` has **no production activation CLI**. Its private-PG path and
identity requirements are deliberate. Actual deployment automation must be designed
and verified against the restricted Linux/staging service layout before any real
operation; do not remove those guards to make it run on EC2.


## Validate the actual incoming package

The current workflow runs the trusted wrapper against the artifact, not just the
original checkout, before retaining it for review:

```sh
python scripts/testing/check_packaged_release.py \
  --archive /absolute/private/incoming/review.tar.gz \
  --sha256 TRUSTED_ARCHIVE_SHA256 --revision FULL_REVIEWED_GIT_SHA \
  --pg-bin /absolute/private/postgresql/bin \
  --output-dir /absolute/private/new-validation-directory
```

This creates an exclusive0700 directory containing the extracted package, private
logs and `report.json`. It runs dependency/pip/guard/config/settings/Gunicorn,
SQLite/schema, private PostgreSQL release rehearsal and all backend PostgreSQL
tests. It checks that package files remain identical afterward. Both PG clusters
are new and stopped by the harness. No live service, production configuration,
DB password/URL or host credential is accepted. CI publishes only the review
archive, build summary and validation report, not the synthetic cluster directories.
Hosted execution is still unverified; local successful evidence is in the newest
Step8B5 report. Advisory inventory from8B4 is time-bound and must be refreshed for
release; this wrapper is not a replacement for registry, OS or supply-chain review.


## Step8B6 concrete staging design

[Restricted staging operations](STAGING_OPERATIONS.md) now supplies the reviewed
layout and staging-only configuration renderer. The complete bundle includes its
source,12 renderer guard tests and the optional actual loopback TLS proxy harness.
The packaged wrapper also runs the renderer guards. Native TLS/proxy executables
are not included/downloaded by that wrapper. Application peer identity can be
explicitly derived from a sanitized private Unix proxy; defaults remain untrusted.

Only the existing production EC2 is available. No separate host/DNS/database was
provisioned or service changed. The standalone proxy packet is for a proposed
separate server; never install it over the existing live Nginx. Linux/systemd,
actual service drain/restart/reboot/resource controls and real backup/media/phone/
offline acceptance remain open. The maintenance flag blocks new API ingress but
does not stop existing writers. This is a configuration review packet and local
harness, not a production activation or rollback adapter.


## Actual local service checkpoint — Step8B8

The packaged validator now runs13 groups, including five non-mutating guards for
the disposable-VM root tooling. A separate guarded local installation exercised44
actual systemd/HTTPS/PostgreSQL checks: permissions, maintenance, graceful in-flight
scan completion, restart, reboot, crash recovery and retained UUID/challan data.
The root installer refuses an existing site and is not a production activation or
upgrade command. Never manufacture its VM sentinel on a business host.

Install a matching per-revision environment **outside** verified package contents:
`S/venvs/<SHA>`, alongside `S/releases/<SHA>`. The seven-file renderer adds a fixed
root close-ingress unit and bounded, unprivileged app/proxy services. Opening
maintenance is always a separate privileged reviewed action. This synthetic Linux
proof does not replace real backup/media recovery, phone acceptance, credential/
tracking cleanup or a complete reviewed project release. See the current
[operations](STAGING_OPERATIONS.md) and [8B8 report](investigations/2026-10-16/STEP_8B8.md).

## Paired database/media checkpoint — Step8B9

The bundle now includes the read-only private backup integrity verifier,22
filesystem/VM refusal tests and two concrete recovery/access plans. The packaged
validator runs14 groups. The separate guarded VM operator restored synthetic
DB+media into a new cluster and passed18 checks, including all table/sequence
fingerprints, PDFs, saved manual challan and original scan UUID replay. It never
accepts a business DSN/backup or overwrites an existing target. Database dumps,
media, manifests, test credentials and VM keys are not code artifacts.

See [business recovery prerequisites](BACKUP_RECOVERY.md) and the conditional
[phone staging plan](PHONE_STAGING_ACCESS.md). Manifest integrity is distinct from
successful restore, encryption, provenance and consistent capture. No live backup
or restore, phone access, physical device acceptance or production activation was
performed by this checkpoint.
