# Reviewed source cleanup and credential rotation before release

This is a procedure to prepare for a separate coordinated operation, not commands
to run against production now. Step 8B4 made no real credential change, history
rewrite, business export, Git index cleanup or deployment. The current local code
uses explicit private secure-mode configuration and expiring API tokens, but this
does not retire old credentials from deployed services or Git history.

## Establish the exact candidate

1. Preserve the complete working tree, owner folder move, Git identity and private
   business/media backup inventory. Keep temporary source snapshots private. Review
   each intended source addition/deletion; do not restore old root App files or
   reset to a moving remote branch. No blanket `git add .` or old sync/deploy script.
2. Use the redacted Step 8B4 exposure report to review the 68 indexed private/generated
   paths. Some are owner-moved/deleted paths; determine the intended final tracking
   set individually. Keep needed private files outside Git and build artifacts.
   Removing a path from the index does not erase its previous Git versions.
3. A reviewed source commit must contain the entire frontend/backend/schema/lock/
   test/config/tooling change, not only the newest fix. Check exact diff and base
   revision. Another laptop must start from that agreed revision and preserve its
   own uncommitted work before integrating. Resolve diverged changes deliberately.
4. Build in a clean checkout at the reviewed full SHA. Run hash-checked Python
   installation, peer-checked npm ci, dependency/advisory checks and all relevant
   suites. Record source/build/runtime hashes. No business DB/export/private media,
   key, environment file, cache, bytecode or legacy maintenance script enters the
   eventual source/release artifact. Step 8B5 completes that artifact procedure.

## Plan real credential changes privately

Create a private credential inventory using names/roles only in shared documents;
never paste keys or passwords into a chat, changelog, plan or Git. Historical
pattern matches include synthetic examples, so verify ownership/use before rotating.
Review Django signing key, real shared/default user passwords, active DRF tokens,
database service credentials and any provider/server credentials actually exposed.
A zero-pattern result for AWS/Google key shapes is not proof none were ever exposed.

Before changing anything, establish the affected services, owner/operator, maintenance
window, active warehouse work, tested recovery route and private replacement secret
storage. Check the current server/DB/deployed SHA again; older observations are not
a permanent live-state guarantee. Confirm backup restoration of the matching DB and
private media on an isolated host; a synthetic dump rehearsal does not prove it.

Perform these coordinated actions only after the release/operation is concretely
reviewable and authorized:

- Provision private random replacements in the actual service manager/secret store,
  with least privilege and restrictive file access. Do not change source to contain
  new real values. Verify staging uses different credentials and synthetic records.
- Rotate database/service/provider credentials using each service's supported process;
  coordinate connection pools and service activation, verify new access, then revoke
  old access. Keep independent administrator recovery access. No blind password
  change that leaves running services unable to connect.
- Rotate Django signing credentials and explicitly assess session invalidation.
  A signing-key change does not revoke database-backed DRF tokens. If real API
  credentials are compromised, separately revoke affected tokens and coordinate
  fresh login. Do not recreate users or change original user IDs to accomplish it.
- Reset confirmed shared/default passwords through the reviewed explicit-password
  flow. Inform affected operators through an authorized channel; do not send
  messages from this procedure without the owner's direction.
- Preserve account/origin-scoped drafts and pending UUID commands through re-login.
  Do not clear browser storage, mint replacement scan UUIDs or replay uncertain
  commands blindly. Use the saved-work review/receipt checks where needed; historical
  email reuse still needs human ownership review. Existing in-flight authenticated
  requests may finish, so coordinate active stock work during revocation.
- Verify both valid new access and rejection of retired credentials, anonymous and
  cross-role private-document denial, configured proxy limits and public-only logo
  access on the actual HTTPS host. Check direct storage/Nginx routes too.

Record only credential identifiers, timestamps, operator, outcome and rollback
constraints in a private operations log. Do not retain retired secret values in a
public handover. Recovery must not silently re-enable a known-compromised credential.

## Git history and generated artifacts

Rotation addresses credential validity; source deletion alone does not. If history
cleanup is required, first scope exact paths/objects and repository consumers,
preserve appropriate private recovery copies, arrange collaborator coordination,
and review the rewrite/force-push procedure separately. Do not rewrite history as
part of a dependency update. Remove/replace affected published artifacts and check
other clones/caches according to their scope. Avoid reintroducing old files from
another laptop after cleanup.

Current evidence: [Step 8B4](investigations/2026-10-15/STEP_8B4.md),
[redacted source/history inventory](investigations/2026-10-15/evidence/step-8b4-source-exposure.json).
This review is limited pattern matching, not a complete secret scan or validation
of production credentials. Real rotation/cleanup remains an explicit release gate.
