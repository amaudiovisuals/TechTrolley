# Normal P2 LED case conversion

This operation changes the stock unit from one registered box to six individual
normal P2 panels. It does not change the owner or main issuing company. Flexible
P2 boxes and other LED types are excluded. Apply only reviewed available boxes;
active, staged, unchecked, staff-held, kit, quantity-history or supplier-ticket
records require closure/review first. Audit observations and historical box
papers are retained without becoming custody for the new panels.

The original asset ID, SKU/QR/serial, quantity1 and metadata stay intact, with
`stock_kind=led_case`. This record becomes the container/history reference and
is excluded from current inventory counts, availability, exports and offline
staging. Six new `stock_kind=led_panel` assets each represent one physical panel.
Their generated SKUs identify source case and positions1–6, and their origin
relation is immutable. The source box price is split in cents across six panel
costs. Current depreciation value is allocated across the six positions so its
sum remains exactly the original box value; generic edits cannot alter this
count/valuation grouping. New physical QR/serial labels can be added normally.

The old box QR remains in the online scan index. Scanning it opens a review of
its six registered panels, their actual owners and action eligibility. The user
selects the physical panels being moved; one atomic movement records only those
panel IDs. Partial returns and crosscheck use actual program memberships.
Box scans in venue-transfer selection intersect registered panels with current
on-site assets. The case itself cannot be moved as an additional unit.

Before using box scans without individual labels, physically mark the six panels
with their temporary positions1–6 and keep them with their registered case. The
case registration is not proof of its current physical contents: confirm that the
selected numbered panels are actually present. Repacking into arbitrary cases
before individual identification is not inferred or automatically reconciled.

## Reviewed operation

`LED_CASE_CONVERSION_WRITES_ENABLED` defaults to false. An identified instance
(`LED_CASE_CONVERSION_INSTANCE_ID`) and PostgreSQL (or disposable in-memory test
SQLite) are required for apply. Persistent business SQLite is refused. Review
remains available while writes are disabled.

Use the running service's verified environment and the reviewed release runtime,
never a fallback settings/database connection. `review_led_case` requires the
exact database name, instance identity and original source ID. Preview is
read-only and writes a new private0600 evidence file, including the original
snapshot and review hash. Administrator asset details also provide a read-only
conversion review.

For apply, a private packet contains `source_id` plus `command` with an exact
UUID `request_id`, the reviewed `review_hash`, a meaningful `reason`, and
`confirmed_panel_count:6`. The management command requires `--apply`, that packet,
an active administrator `--actor`, and a new evidence output. The separate write
gate must be explicitly enabled for the identified database. Source rows are
locked before any conversion; stale reviews fail. The conversion and all six
panels commit atomically. Recover a lost response using the exact same actor,
source and request packet; do not generate another request. Evidence output
failure after commit is explicitly reported as applied, not as a rollback.

Ownership changes use the existing separately reviewed ownership workflow after
conversion. For the currently proposed six sources, five full cases supply30
Pvt Ltd panels; positions1–2 of the sixth supply2, while positions3–6 remainAM.
The initial panel count is36, partitioned32/4. The original wider ownership hold
and pending keep-list remain independent; this schema migration applies no
business conversion, owner change or company/GST/address rename.

After activation, keep the conversion gate off except during a coordinated
reviewed operation. Preserve conversion history and original box paperwork.
