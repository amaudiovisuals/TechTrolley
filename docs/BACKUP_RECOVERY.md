# Database and private-media recovery — Step8B9

**Current scope: synthetic local rehearsal and a concrete business-recovery plan.**
No production export, real media copy, maintenance or business restore has occurred
in this checkpoint. The owner does not need to execute these developer procedures.
The current local VM explicitly forbids business data; never bypass its sentinel.

## Why a database dump alone is insufficient

The current models store conference PDFs in `Conference.pdf_document` and company
logos in `CompanySettings.logo`. Their database values are file names; their bytes
live under the configured MEDIA_ROOT. All registered FileField/ImageField values
must be enumerated from the actual schema, rather than assuming those two fields
will always be the complete list. Include unreferenced files too; report them for
review and preserve them. A missing PDF must not be silently declared recovered.

PostgreSQL pg_dump provides a consistent snapshot of one database, not an atomic
snapshot of external media or cluster-global roles. For a paired checkpoint,
close ingress and stop/drain every application, worker, scheduled job, direct
writer and uploader, or design an independently verified coordinated snapshot.
A maintenance page alone does not drain writers.
[PostgreSQL pg_dump](https://www.postgresql.org/docs/16/app-pgdump.html)

## New read-only integrity contract

`scripts/deployment/backup_media.py` verifies an already-copied private directory:

```text
backup/                 owner-only directory
  database.dump         PostgreSQL custom-format dump
  media/                complete media tree, including unreferenced files
  manifest.json         capture identity, dump/media hashes, DB file references
```

The manifest records a unique snapshot UUID, explicit source instance/database,
full source-code revision, schema leaf, UTC capture interval, synthetic/business
classification and an operator assertion that writers were quiesced. It binds dump
and media lengths/SHA256 plus model/PK/field/path references. The verifier requires
an independently trusted manifest SHA256; changing both files and the adjacent
manifest is not sufficient to pass against the original trusted digest.

It rejects missing/changed/extra media, wrong dump bytes, missing referenced files,
noncanonical paths, symlinks, hardlinks, FIFOs and public/foreign-owned entries.
The root must be canonical and private; capture/verification runs on a stable
private copy with no concurrent writers. It reads files without modifying them.
Limits:100000files/references,1TiB media total,1TiB per file,32MiB manifest. Review
actual business sizes first; do not silently raise limits to bypass a refusal.

The `PGDMP` header check identifies the expected format only. Integrity does not
establish dump completeness, trusted provenance, truthful capture assertions,
encryption, retention, availability or successful restore. A trusted digest must
come from a separate reviewed ledger/channel. The directory format is a private
decrypted verification layout, **not encrypted storage or an upload artifact**.

Developer-only read verification after those prerequisites:

```sh
PYTHONDONTWRITEBYTECODE=1 /absolute/reviewed/python \
  scripts/deployment/backup_media.py \
  --backup-directory /absolute/private/recovery-copy \
  --trusted-manifest-sha256 INDEPENDENTLY_RECORDED_MANIFEST_SHA256
```

No DB/host/credentials input, SQL, restore, network, service or source-write action
is provided by this verifier. Its `describe()` helper returns observations only;
the capture operator must separately establish source identity and consistency.

## Actual synthetic Linux rehearsal

`scripts/testing/backup_media_vm_probe.py` is a separate root test operator. It
requires the existing private Linux VM identity with business data forbidden,
the verified8B8 synthetic source and a **new** fixed recovery directory. There is
no user-supplied source/target DSN, arbitrary backup input, existing-target overlay,
`--clean`, automatic rewind or real-data mode. Never manufacture its sentinel.

The rehearsal stops app/proxy behind maintenance, checks source cluster/socket/
database identity and other connections, observes every public table/sequence,
enumerates all registered file fields, captures a custom dump and all media, and
verifies the manifest. It restores into a **new private PostgreSQL cluster**, with
TCP disabled and a separate database/runtime role. Restore uses explicit target,
no owner/ACL replay, exit-on-error and a single transaction.
[PostgreSQL pg_restore](https://www.postgresql.org/docs/16/app-pgrestore.html)

It compares53public tables' row counts/content hashes,44sequences and both media
files. Django checks complete migrations, target identity, restricted runtime
privileges, anonymous PDF denial/authenticated PDF bytes/no-store, exact manual
challan and original scan UUID replay with one receipt. The original database,
verified source package and backup bytes stay unchanged. Both clusters stop in
cleanup and maintenance remains closed. **18checks passed**;22local filesystem/
refusal tests also pass. Restored API smoke uses Django's test client, not a new
HTTP proxy or a proof of OS-user media access in the restored layout.8B8 separately
tested actual service permissions/HTTPS. No proxy/phone/business RTO is certified.

## Concrete business-backup rehearsal packet to review next

| Stage | Required concrete evidence before the next action |
| --- | --- |
| Identify source, read only | Verify the current running service's actual DB name/host/data directory/version, MEDIA_ROOT and storage backend, code bytes/revision, complete migration ledger, table/file sizes and free space. `techtrolley_prod` was previously observed; that is historical until rechecked. Do not choose SQLite or another DB from a filename. |
| Inventory existing recovery | Locate current backup job, last success, complete DB+media coverage, encryption/access/retention/off-host copy, extension/locale/encoding/role dependencies and a restore result. Do not read/post key/password contents or delete older backups. |
| Review recovery targets | Agree recovery-point and recovery-time objectives, outage window, operator, acceptable write loss, private durable storage location/encryption/key custody and retention. Measure sizes and timings; the tiny synthetic duration is not a business estimate. |
| Build separate isolation | Create a separately reviewed recovery environment that permits this business copy. Preload compatible verified software, then remove outbound networking; private VM SSH only, no host mounts, browser/profile sharing or staff URL. The current synthetic VM must remain business-free. |
| Capture paired checkpoint | Review production maintenance/drain and resumption commands before use. Include every writer/uploader. Bind DB+media/refs, UTC interval, actual code/schema and a trusted manifest digest; record dump warnings and completeness. Account separately for roles/config/extensions/secret recovery; a single-DB dump is not the whole service. |
| Transfer securely | Use the reviewed encrypted path and durable private destination; verify trusted checksums before and after transfer. Do not upload dumps/media/manifests to GitHub or attach them to this chat. No real `.env`, PEM, signing key or production credential belongs in a code bundle. |
| Restore without source impact | Verify correct isolated target before SQL; restore only into a new cluster/database with explicit flags, never production or an existing business DB. PostgreSQL dump SQL can execute source-defined code: establish trusted source and inspect/review it before restoring. Isolation must exist before SQL execution, not just before starting the web app. |
| Prove recovery privately | Before sanitizing, compare complete schema/ledger, counts/content/relationships, sequences, source identity and every media reference/hash. Record pre-existing missing files separately; unexplained missing files block acceptance. Preserve exact IDs/receipts/manual challans and unresolved work. Measure elapsed recovery and recovery point. |
| Sanitized testing only | In the isolated clone only, invalidate copied sessions/tokens/API keys, replace signing/admin credentials and disable staff logins and every outbound integration/job before any web access. Record intentional differences from the initial restored fingerprint. Prefer separate synthetic phone staging; restored PII/media should remain private. |
| Close and report | Keep source unchanged; record pass/fail/limits without business contents, stop target services, retain encrypted evidence per agreed retention and erase temporary decrypted copies under the reviewed disposal procedure. Real recovery passes only after this exercise, not after manifest verification. |

Production quiescence, real export/transfer, secret rotation and exposing a new
network listener are separate concrete actions to review when this packet is
filled. This plan does not grant those actions or certify an existing backup.
No automatic incident DB rewind is supplied; post-checkpoint staff work must be
preserved and reconciled under a separate recovery decision.

[Phone access plan](PHONE_STAGING_ACCESS.md),
[current report](investigations/2026-10-16/STEP_8B9.md),
[handover](ANTIGRAVITY_HANDOVER.md).
