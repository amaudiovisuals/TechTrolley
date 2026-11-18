/** Display operational errors without changing machine codes or retry decisions. */
const messages: Record<string, string> = {
  audit_is_not_manifest_dispatch: 'Audit programs cannot issue dispatch truck challans. Choose a normal program.',
  document_date_required: 'Choose a challan date before issuing this truck copy.',
  duplicate_sources: 'The same item was selected more than once. Review the selected rows.',
  empty_manifest_cannot_issue: 'This truck has no items. Allocate its equipment before issuing the challan.',
  empty_master_cannot_start: 'The master challan has no items. Save its equipment list before adding trucks.',
  existing_trucks_require_review: 'This program already has older truck records. Ask Admin to review them before starting a new split.',
  manifest_already_issued: 'This truck challan is already issued. Open its saved copy; corrections require a reason.',
  manifest_documents_changed: 'The truck challans changed. Refresh the master and truck copies before trying again.',
  manifest_history_requires_review: 'This truck split has saved history that needs Admin review before it can be changed.',
  manifest_number_is_permanent: 'A saved truck challan number cannot be replaced. Keep its existing number.',
  manifest_ticket_source_changed: 'The supplier ticket no longer matches this challan. Review its current items and quantities.',
  manifest_totals_require_review: 'The truck quantities do not match the saved master. Ask Admin to review the split.',
  number_already_used: 'This challan number is already used. Choose an unused number.',
  same_manifest_destination: 'Choose different source and destination trucks.',
  save_master_challan_first: 'Save the master challan before splitting it between trucks.',
  shared_stock_ticket_requires_review: 'Shared-godown equipment also appears on a supplier ticket. Ask Admin to review this overlap.',
  source_not_in_master: 'A selected item is no longer on the master challan. Refresh the split before trying again.',
  start_truck_manifest_first: 'Add Truck 2 before allocating equipment between trucks.',
  supplier_balance_requires_review: 'The supplier’s recorded receipt quantities need review before this equipment can be split between trucks.',
  individual_challan_quantity_exceeds_one: 'Each individual equipment QR represents one item. Set this row to quantity 1; include the other items using their own QRs.',
  asset_conflict: 'This equipment cannot be moved yet. Review its current location.',
  manifest_source_exceeds_recorded_capacity: 'A saved challan quantity is higher than the recorded equipment count. Ask Admin to review the draft before splitting it between trucks.',
  legacy_quantity_requires_reconciliation: 'An older item has no confirmed quantity for this program. Ask Admin to review its equipment records before continuing.',
  legacy_consumables_require_reconciliation: 'The consumable quantities for this program need an Admin review before continuing.',
  manifest_physical_source_requires_review: 'An item on the saved challan has no matching program record. Ask Admin to review the draft before splitting it.',
  issued_manifest_requires_correction_reason: 'Enter a reason before changing an issued truck challan.',
  issued_truck_split_cannot_cancel: 'This split includes issued truck or delivery paperwork. Open the master to leave the truck view.',
  deallocate_before_reducing_master_line: 'Move the affected quantities from their trucks to Unassigned before reducing or removing this master line.',
  master_total_override_requires_review: 'The saved total differs from the item totals. Review the master challan total before splitting it.',
  insufficient_manifest_quantity: 'The selected quantity is higher than the quantity available in that truck.',
  quantity_exceeds_source: 'The selected quantity is higher than the recorded count for this item.',
  insufficient_available_quantity: 'There is not enough available equipment for this quantity. Refresh and review the current availability.',
  insufficient_reserved_quantity: 'The selected quantity is higher than the quantity packed for this program.',
  insufficient_dispatched_quantity: 'The selected quantity is higher than the quantity still on site for this program.',
  insufficient_awaiting_verification_quantity: 'The selected quantity is higher than the quantity awaiting Crosscheck.',
  external_rental_uses_supplier_balance: 'This is an external rental. Record its receipt or return in the supplier ticket.',
  supplier_inventory_classification_required: 'This supplier inventory needs shared-godown classification before new quantity movements.',
  supplier_ticket_quantity_requires_review: 'This stock also has supplier order history. Ask Admin to review those quantities before reserving it.',
  event_changed: 'This program changed. Refresh and review its latest details before trying again.',
  document_changed: 'The saved details changed. Refresh and review the latest version before trying again.',
  event_is_sealed: 'This program is completed or archived. Ask Admin to review it before making changes.',
  challan_locked: 'This challan is locked. Ask Admin to review it before making changes.',
  not_authorized: 'Your login does not have permission for this action.',
  request_id_reused: 'This saved attempt does not match its recorded request. Ask Admin to review it before retrying.',
  unknown_assets: 'An equipment record could not be found. Refresh the inventory before scanning again.',
  unknown_conference: 'This program could not be found. Refresh the program list.',
  truck_not_in_event: 'This truck does not belong to this program. Refresh and choose a truck from this program.',
  same_source_and_target: 'Choose a different destination program.',
  quantity_stock_requires_quantity_workflow: 'Choose the quantity for this item before confirming its movement.',
  use_physical_or_consumable_workflow: 'Scan this item individually, or use the consumable controls for consumables.',
  select_led_case_panels_not_historical_box: 'Select the panels inside this LED box before confirming their movement.',
  historical_LED_box_cannot_enter_new_truck_manifest: 'This challan refers to an old LED box record. Ask Admin to review its panel records before splitting it.',
  duplicate_stock_identity_requires_review: 'More than one inventory record uses this item’s identifiers. Ask Admin to review them before continuing.',
  overlapping_inventory_and_supplier_ticket: 'The same equipment appears as both scanned stock and a supplier ticket. Review the duplicate before continuing.',
  skip_packup_review_changed: 'Packup changed. Refresh and review the current equipment list.',
  skip_packup_review_blocked: 'Resolve the listed items before skipping Packup.',
  skip_packup_admin_required: 'Only the Admin login can skip Packup.',
  skip_packup_empty: 'There are no items in Packup.',
  skip_packup_reason_required: 'Enter a reason for skipping Packup.',
  skip_packup_audit_program: 'Skip Packup is unavailable for audit programs.',
  audit_requires_observation_action: 'This is an audit program. Use its audit scan controls.',
  audit_is_not_a_transfer_destination: 'Equipment cannot be transferred to an audit program. Choose a normal program.',
};
const reasons: Record<string, string> = {
  component_set_required: 'Scan this item together with all parts of its equipment set.',
  unavailable_or_staff_allocated: 'This item is flagged, damaged, under service or allocated to a staff member. Review its inventory record.',
  not_staged: 'Scan this item into Requirements before dispatching it.',
  not_dispatched_here: 'This item is not recorded as on site at this program. Review its current program before returning or transferring it.',
  not_awaiting_crosscheck: 'This item is not awaiting Crosscheck at this program. Refresh the list before verifying it.',
};
function label(row: any): string {
  return typeof row?.sku === 'string' && row.sku ? row.sku : typeof row?.alias_name === 'string' && row.alias_name ? row.alias_name : 'This item';
}
function conflictMessage(row: any): string {
  if (row.reason === 'held_by_other_event' || row.reason === 'crosscheck_pending') {
    const locations = Array.isArray(row.locations) ? row.locations.filter((where: any) => typeof where?.conference_name === 'string' && ['crosscheck', 'packup'].includes(where.stage)) : [];
    if (locations.length) return `${label(row)}: ${locations.map((where: any) => where.stage === 'crosscheck'
      ? `awaiting Crosscheck in “${where.conference_name}”. Verify its return there before adding it to another program.`
      : `still in Packup at “${where.conference_name}”. Return it or transfer it from that program.`).join(' ')}`;
    return `${label(row)} is still held by a program. Review its Packup and Crosscheck records before moving it.`;
  }
  return reasons[row.reason] ? `${label(row)}: ${reasons[row.reason]}` : '';
}
/** Preserve readable validation text, but never expose raw codes, JSON or IDs as explanations. */
function readable(value: unknown): string | undefined {
  return typeof value === 'string' && /[a-zA-Z]/.test(value) && !/[\[\]{}\n]|\b[a-zA-Z0-9]+_[a-zA-Z0-9_]+\b/.test(value) ? value : undefined;
}
export function apiErrorMessage(body: any, fallback = 'This action could not be completed. Refresh and review the current records before trying again.'): string {
  if (body?.error === 'asset_conflict' && Array.isArray(body.conflicts)) {
    const details = [...new Set<string>(body.conflicts.map(conflictMessage).filter(Boolean))];
    if (details.length) return details.join('\n');
  }
  if (body?.error === 'manifest_source_exceeds_recorded_capacity') {
    const row = body.conflicts?.[0];
    if (Number.isSafeInteger(row?.saved_quantity) && Number.isSafeInteger(row?.recorded_capacity)) {
      return `${label(row)}: the saved challan lists ${row.saved_quantity}, but the program records allow ${row.recorded_capacity}. Ask Admin to review the draft quantities before splitting it between trucks.`;
    }
  }
  if (typeof body?.detail === 'string' && messages[body.detail]) return messages[body.detail];
  if (typeof body?.error === 'string' && messages[body.error]) return messages[body.error];
  if (typeof body?.error === 'string' && /^(invalid_|expected_.*_required$)/.test(body.error)) return 'Some details are missing or invalid. Check the selected items, quantities and required fields before trying again.';
  if (Array.isArray(body)) return body.map(value => messages[value] || readable(value)).filter(Boolean).join(' ') || fallback;
  if (body && typeof body === 'object' && !Array.isArray(body) && !body.error && !body.detail && !body.message) {
    const fields = Object.entries(body).flatMap(([field, value]) => {
      const text = (Array.isArray(value) ? value : [value]).map(readable).filter(Boolean).join(' ');
      return text ? [`${field.replaceAll('_', ' ')}: ${text}`] : [];
    });
    if (fields.length) return fields.join('\n');
  }
  return readable(body?.message) || readable(body?.detail) || readable(body?.error) || readable(body) || fallback;
}
