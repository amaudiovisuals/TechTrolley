> Earlier production release notes. The shared-warehouse integration branch
> supersedes the pending quantity boundary and uses the audited durable customer
> document as the source for new deliveries. See WAREHOUSE_INTEGRATION_CANDIDATE.md.

# First production patch: supplier inventory and single-unit QR scans

This branch starts from production/GitHub revision 783d02b6 and is independent of
the uncommitted audit checkout. No ownership transfer, company rename, schema
migration or production dependency change is included.

Supplier inventory loads the complete company-scoped list, reports failures and
offers Retry. Template downloads contain headers and an example rather than stock.
Imports create new records only; existing/cross-owner/duplicate identifiers or
invalid rows reject the whole workbook with row errors. Accounts cannot import.

The full lookup includes idle permanent supplier stock. A single-unit scan uses
the original ID and normal role-specific requirements/staging flow, preserving its
owner label. Ambiguous identifiers refuse; automatic substitutions stay within
one owner. Customer challans separate scanned stock by owner, preserve those
sections when grouped by model, and refuse overlapping scanned/ticket sources.
Manually added rows remain a separate document section.

## Quantity boundary

The legacy partial-assignment writer clones an asset without its supplier owner.
Supplier bulk/consumable scans and that assignment path are therefore refused in
this patch. Shared quantity/consumable allocations and complete kit/return
acceptance must be enabled before moving those inventories. Main-owned quantity
flows are unchanged. No duplicate master or supplier ticket is created by a scan.

## Validation

- 15 backend contracts passed with disposable SQLite fixtures. The same source
  overlay also passed all 15 under the production interpreter, Python 3.12.3 /
  Django 6.0.2, in a separate process configured only for an in-memory database.
  No files were installed and no business database was connected in that test.
- Frontend helper checks and TypeScript pass. The preexisting Booking interface
  omitted aliases already returned by the save mapper; optional compatibility
  fields now describe that actual response without changing runtime behavior.
- Actual App/browser checks cover more than 50 supplier records, template route,
  row errors, failed-read retry, staging one original supplier ID and duplicate
  reads, three challan copies, model grouping and overlap refusal. HTTP fixtures
  are synthetic, external requests and service workers are blocked. These tests
  do not certify physical QR decoding, PWA behavior or styled printed output.
- Production build passes with the existing large-bundle warning.

Run `python -B scripts/run_hotfix_tests.py`,
`node scripts/test_inventory_helpers.cjs`, `npx tsc --noEmit`, and `npm run build`.
The Python runner explicitly supplies synthetic settings and an in-memory DB;
do not run manage.py tests against the ordinary project settings.
The browser runner accepts `TT_PLAYWRIGHT_MODULE` for an existing Playwright
installation; its default Chrome path is for this Mac.

## Code-only activation

PR validation uses a disposable database and a clean locked frontend install.
Deployment activates the exact validated commit/frontend artifact on main and
refuses schema/settings/dependency changes. It captures private source, existing
frontend, database archive and media checkpoints first; archive listing checks
readability, not restoration acceptance. A failure after activation attempts to
restore source/frontend and restart the old backend, preserving business data.
Old frontend chunks remain available to existing tabs. No fixture import, database
restore, migration apply or environment/dependency update is performed.

The backup restoration rehearsal required for the later ownership cutover remains
separate. Current legacy challans still rely on mutable sources/local drafts;
issued-document identity and manual-edit persistence must be addressed through
the durable-document work before changing company branding or moving stock.

## Next work

Separate supplier-to-Pvt-Ltd documents are not included here. The owner confirmed
one new supplier challan for each separate delivery, with repeat prints retaining
the same number. Add durable issuer/recipient/item snapshots, delivery references,
numbering and accounts access, then complete shared quantity support and review
the exact Pvt Ltd keep list before a controlled ownership/name cutover.

This patch adds no migration names, avoiding a collision with the audit's existing
uncommitted 0054–0066 chain. The later audit merge must carry these fixes forward
and reconcile the deployment workflow rather than overwrite either branch.
