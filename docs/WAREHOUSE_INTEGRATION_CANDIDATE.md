# Supplier quantity integration candidate

This branch combines the audited shared-warehouse quantity, consumable, custody,
truck manifest and durable-document implementation with the production inventory
import/template/export fixes and ProgramDelivery supplier papers. It is a reviewed
release candidate, not the code-only production hotfix path. No stock ownership,
company classification or branding change is performed by assembling this branch.

The audit working tree and previously deployed production checkout are preserved
separately. Migration0067 merges the production delivery-table branch with the
audit's0066 branch. Existing ProgramDelivery IDs, snapshots and numbers stay intact.
New delivery papers read reviewed durable customer lines and recorded quantities;
they never substitute a stock master's current quantity for a program count.
External rentals require recorded receipt balances. Manual customer lines survive.
New packet issuance follows the audited asset-before-event lock ordering.

Warehouse bulk scans use one original asset and a global allocation ledger across
programs. Reserve, dispatch, return and verification retain that identity. Supplier
consumables use the recorded request/dispatch/settlement ledger and deduct only
actual consumption. Shared-godown company classification requires the reviewed
classification operation; migrations do not infer it from a supplier's name.
Unsupported or uncertain legacy balances require reconciliation.

Integration tests also cover the admin dispatch button and immediate scanning of
the same code after switching between return and verification. Duplicate reads
within the same event/action still use the scan guard and durable command receipts. Camera
scanning stops when a quantity/picker decision opens; held QR reads cannot reset
the selected count or replace its source during the decision/save.

Run the full disposable SQLite suite with scripts/testing/run_backend_tests.py.
The PostgreSQL harness creates its own private cluster with no TCP listener and
verifies its identity on every connection. Its production_0054 baseline preserves
a preupgrade supplier delivery snapshot through schema upgrade and backup restores.
The workflow on this branch validates and produces a frontend review artifact.
It does not activate this broader schema/configuration/dependency release on live.

Physical device and full release acceptance remain as recorded in the audit's
CURRENT_STATUS and release runbooks. The phone-test environment is separate from
the loopback synthetic browser fixtures. A headless browser is not physical phone
or installed-app storage certification. Source cleanup does not retire historical
credentials; the actual runtime/environment and credential transition need their
own recorded operation before a broader production activation.

The owner's Pvt Ltd keep list remains partial, and company details are held in
the private planning folder. The later reviewed move must preserve original IDs,
QRs, kits and history; exporting/deleting/reimporting is not a stock-transfer method.
