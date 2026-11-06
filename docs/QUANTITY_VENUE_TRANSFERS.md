# Partial reusable quantities between venues

Migration0070 adds incoming/outgoing transfer counters and recorded movement
context. Existing quantities default to zero transfers; old dispatch addresses
remain unknown instead of being reconstructed from mutable company details.

In a program's Packup, Transfer Assets accepts individual items and reusable
quantity stock. Select a stock QR, enter the number moving and choose an open,
non-audit destination. The source program's saved delivery address is recorded
as the dispatch location. Consumables keep their separate settlement workflow.

For stock100 with20 on site atA, forwarding8 toB leaves80 available in the
godown,12 atA and8 atB. The stock ID, owner, QR, total quantity and source
original challan stay unchanged. A's current return paper uses12. B's original
dispatch uses8 and records A's full address under Dispatched from. Separately
packed godown stock forB stays reserved.

The endpoint requires both event revisions and one durable request UUID. Asset,
event and allocation locks serialize competing operations. A mixed physical and
quantity batch commits atomically; an uncertain response is recovered by the
same saved request, never by creating another transfer. The UI blocks a second
movement until the stored request is recovered. Close the transfer window to
reach the pending-movement retry control after a connection failure.

Each quantity transfer writes paired outgoing/incoming movements with matching
asset, receipt, amount and source/destination snapshots. Completion accepts a
verified return or a proven onward transfer, and rejects missing counterpart
evidence. Legacy ambiguous quantities, legacy truck splits without a coordinated
manifest, inconsistent membership/balances and unavailable stock require review.
Managed original truck documents remain historical snapshots.

New delivery packets use recorded arrival batches. Previously issued quantities
are allocated first so a later venue arrival can issue a new delivery using its
own source address. Supplier ownership is retained, and the customer and supplier
papers use the selected counts. Existing issued copies remain frozen. Saved
delivery numbers are reused for reprints.

Validation covers partial/full transfers, mixed atomicity, competing operators,
exact retry, source paper preservation, managed manifests, stale revisions,
multi-hop transfers, reserved/unchecked balances, completion evidence and
multiple-arrival paperwork. A disposable real App/Django browser flow exercises
the phone quantity control, a lost response and recovery, both source paper
counts, destination origin, paired delivery papers and partial return/crosscheck.

This change prepares the review candidate; it does not perform production stock
conversion, change ownership or switch the issuing company.
