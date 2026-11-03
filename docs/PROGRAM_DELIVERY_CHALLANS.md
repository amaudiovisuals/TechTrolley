# Saved program delivery challans

Open Billing, select a program (or an individual truck), then use **New delivery**
in Saved delivery challans. Review the date, reference, vehicle and selected item
quantities. **Issue delivery challans** saves a customer document and one supplier
document per owner in the same transaction. Each separate delivery gets fresh
numbers. Reopening or printing a saved copy never allocates another number.

Supplier papers contain equipment and quantities only, as requested by the owner.
Rental charges and declared goods values are not inferred from inventory prices.
The saved customer copy also provides quantity-only delivery evidence; the existing
valued/customized legacy challan remains available below. New saved delivery papers
use an independent `YY-YY/OUT-000001` and `YY-YY/SR<owner>-000001` number namespace.
Do not infer a previously issued historical document from these new records.

The saved issuer, recipient, owner, program, equipment, quantity and transport
details are snapshots. Later company edits, stock ownership changes, returns,
asset deletion or local browser drafts cannot rewrite the saved copy. New program
deletion is refused when delivery history exists, before releasing asset statuses.
Corrections use **Void delivery**, preserving the paper and reason, then a new
delivery. Voiding is a document action; it does not return physical equipment.

Accounts can view and print the customer and supplier copies from each program.
Only admin, boss, godown incharge or qualified staff can issue/void. Accounts and
technicians cannot issue, even if their login has Django staff status. The server
enforces these permissions independently of the frontend.

Review selection carefully. Previously documented quantities start unselected;
an operator may explicitly select equipment again for a separate real delivery.
Inventory and ticket references to the same equipment refuse issuance until the
duplicate is reviewed. Ticket equipment has no truck assignment in the legacy
system and is available for explicit selection from the program scope. Paperwork
does not dispatch equipment, create rental tickets or clone stock. A lost-response
retry retains the exact payload/key and recovers the saved record. Source changes
since preview require a reload; quantities and event/truck membership are checked.

Unsaved legacy browser customization is not silently imported into a new saved
delivery. Existing saved manual inventory items are selectable; delivery descriptions
can be edited in the review without editing the source asset. The existing company
identity stays in effect until the separately reviewed branding cutover. Supplier
bulk/consumable scans and unsupported custody remain blocked pending quantity work.
No ownership or company identity change is included in this release.

## Verification and deployment

`scripts/run_hotfix_tests.py` configures its own disposable database without reading
project settings. It covers inventory plus document snapshots, roles, duplicates,
stale sources, partial quantities, voids, deletion and idempotent retries. Optional
`TT_TEST_POSTGRES_NAME=codex_delivery_acceptance_<suffix>` runs the same contracts
and simultaneous request tests on disposable PostgreSQL. It is guarded against
using business database names. Hosted CI has a synthetic PostgreSQL 16 service.

`TT_TEST_PYTHON=<isolated-python> node scripts/browser_program_deliveries.cjs` starts
a loopback-only synthetic Django server and uses real HTTP to exercise review,
response loss, reprints, accounts, voids, escaping and A4 three-copy printing.
The backend never imports project settings. Existing scan/browser tests remain
separate. Physical phones and offline operation are not certified by headless tests.

Migration `0054_program_delivery_documents` adds only the ProgramDelivery table
and constraints. It shares the production 0053 parent with the audit's independent
0054 chain; the future audit merge needs an explicit migration merge and carryover
of this model, endpoints, UI and deployment changes. Do not overwrite either chain.

The bounded activation script verifies unchanged existing models/migrations/settings
and dependencies, takes private source/frontend/database/media checkpoints, then
restores the exact database archive into an isolated temporary PostgreSQL database
before applying the single reviewed additive migration. The migration plan must
contain only this migration. Code/frontend rollback retains any new document table
and data; it never restores the live database or drops issued documents. Subsequent
code-only changes use the previous activation path, which refuses schema changes.
