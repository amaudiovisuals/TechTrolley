import type { Booking } from '../types';
export function mapConference(c: any): Booking {
  return { ...c,
            id: c.id.toString(),
            revision: c.revision ?? 0,
            approximate_value: c.approximate_value == null ? null : Number(c.approximate_value),
            consumable_data: c.consumable_data || {},
            flag_log: c.flag_log || [],
            name: c.name, // Keep for legacy
            conferenceName: c.name,
            association: c.association_name, // Keep for legacy
            associationName: c.association_name,
            billingAddress: c.billing_address,
            transportAddress: c.transport_address,
            venue: c.transport_address, // Map transport to venue
            gstNumber: c.gst_number,
            vehicleNumber: c.vehicle_number,
            driverPhone: c.driver_phone,
            challanDate: c.challan_date || '',
            challan_date: c.challan_date || '',
            startDate: c.start_date,
            start_date: c.start_date,
            endDate: c.end_date,
            end_date: c.end_date,
            type: c.conference_type as any,
            conferenceType: c.conference_type as any,
            contactPerson: c.contact_person,
            contactPhone: c.contact_phone,
            contactEmail: c.contact_email,
            challanNumber: c.challan_number || '',
            assets: (c.assets || []).map((id: any) => id.toString()),
            requirements: (c.requirements || []).map((id: any) => id.toString()),
            staged_assets: (c.staged_assets || []).map((id: any) => id.toString()),
            crosscheckAssets: (c.crosscheck_assets || []).map((id: any) => id.toString()),
            challanAssets: (c.challan_assets || []).map((id: any) => id.toString()),
            challan_assets_details: c.challan_assets_details || [],
            assigned_employees: (c.assigned_employees || []).map((id: any) => parseInt(id, 10)),
            pdf_document: c.pdf_document,
            isAudit: c.is_audit || false,  // J-109: propagate audit flag into backendConferences
            is_invoiced: Boolean(c.is_invoiced),
            isInvoiced: Boolean(c.is_invoiced),
            dispatchOrigins: c.dispatch_origins || [],
            transfer_log: c.transfer_log || [],  // Asset transfer audit trail
            truckChallans: (c.truck_challans_data || []).map((t: any) => ({
              id: String(t.id),
              conference: String(t.conference),
              truck_number: t.truck_number,
              label: t.label || `Truck ${t.truck_number}`,
              vehicle_number: t.vehicle_number || '',
              driver_phone: t.driver_phone || '',
              challan_number: t.challan_number || '',
              assets: (t.assets || []).map(String),
              asset_quantities: t.asset_quantities || {},
              assets_details: t.assets_details || [],
              created_at: t.created_at || '',
            })),
          };
}
export function stockQuantity(value: unknown): number {
  if (value === null || value === undefined) return 1;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}
