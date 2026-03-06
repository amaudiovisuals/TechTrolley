# Bulk CSV Upload + QR Scan-to-Assign

## Background

**Good news:** A `bulk_upload_assets` endpoint already exists in `views.py`. It reads CSV/Excel and maps columns to the `Asset` model. It just needs to be exposed in the frontend UI properly.

**QR codes:** Your existing QR codes encode a unique identifier per asset (likely the Serial Number or SKU/Barcode). We'll use the `barcode` field as the QR scan target — no need to re-encode or replace any physical stickers.

---

## Feature 1 — Bulk CSV Upload

### CSV Format (matches existing backend)

```
Name,Brand,Model Number,Category,Serial Number,SKU,Barcode,Status,Condition,Unit Price
Projector,Sony,VPL-EX315,AV Equipment,SN-001,SKU-001,QR-001,Available,Good,45000
Speaker,JBL,SRX815,Sound System,SN-002,SKU-002,QR-002,Available,Good,28000
```

> [!IMPORTANT]
> The `Barcode` column is what your existing QR codes encode. As long as the CSV Barcode value matches the QR sticker on the asset, scanning will instantly find the right record.

- [x] Research and pinpoint the bug <!-- id: 0 -->
    - [x] Identify the "Edit Conference" component and scanning logic <!-- id: 1 -->
- [x] Create implementation plan <!-- id: 2 -->
- [x] Fix the bug in scanning logic <!-- id: 3 -->
- [x] Verify the fix <!-- id: 4 -->

### Changes

#### [MODIFY] [views.py](file:///c:/Users/amoff/Desktop/tech-trolley-asset-tracker/backend/core/views.py)
- Fix the endpoint: add `get_or_update` logic so re-uploading the same file skips duplicates instead of erroring on unique `serial_number`
- Return per-row error details so the frontend can show a preview

#### [MODIFY] [urls.py](file:///c:/Users/amoff/Desktop/tech-trolley-asset-tracker/backend/core/urls.py)
- Wire up `/api/assets/bulk-upload/` if not already registered (check needed)

#### [NEW] Frontend Upload UI (inside existing Inventory page in `App.tsx`)
- **"Upload CSV" button** in the Inventory toolbar
- Drag-and-drop or file picker (`.csv` or `.xlsx`)
- **"Download Template"** button — generates a blank CSV with the correct headers
- After upload: shows a result panel:
  - ✅ `X assets created`
  - ⚠️ `Y skipped (already exist)`
  - ❌ Row-level errors list

---

## Feature 2 — QR Scan-to-Assign (Conference Asset Panel)

When creating/editing a conference and assigning assets, instead of scrolling through the full list, the user can **scan a QR code** on the physical asset to instantly find and add it.

### How it works
1. User opens conference edit → Asset Assignment panel
2. Clicks **"Scan to Add"** button
3. Camera opens (using device camera via `jsQR` library — no install needed, CDN or npm)
4. User points camera at the QR sticker on the asset
5. QR value (e.g. `QR-001`) is matched against `barcode` field in the fetched assets
6. If found: asset is highlighted and added to the conference instantly
7. If not found: shows "Asset not found — check serial number"

> [!NOTE]
> Works on laptops with webcams and on phones/tablets. The QR value just needs to match the `barcode` column in your database (same as the CSV `Barcode` column).

### Changes

#### [MODIFY] `App.tsx`
- Add `jsQR` import (lightweight, ~30KB, no extra dependencies)
- Add `ScannerModal` component inline: opens camera stream, decodes frame-by-frame, closes on match
- On scan match: looks up asset by `barcode`, adds it to `conferenceFormData.selectedAssets`

---

## Verification Plan

### Automated
- None (existing test suite not found in project)

### Manual — CSV Upload
1. Download the template CSV from the new button
2. Fill in 3–5 rows of real asset data
3. Click **Upload CSV**, select the file
4. Confirm: assets appear in Inventory list
5. Upload the same file again — confirm duplicates are skipped, not errored

### Manual — QR Scan
1. Open any conference in edit mode → Asset Assignment section
2. Click **Scan to Add**
3. Point camera at any asset QR sticker (or hold a phone with a QR code on screen)
4. Confirm the asset is found and added to the conference

---

## Questions for You

> [!IMPORTANT]
> Before I build, please clarify two things:
>
> 1. **What does your existing QR code encode?** Options:
>    - Serial Number (e.g. `SN-001`)
>    - SKU (e.g. `SKU-001`)
>    - A custom barcode/ID?
>    - A URL that contains one of the above?
>
> 2. **Do you have a sample CSV** from your old system you can share? Even 2–3 rows would let me map the columns exactly so you don't have to re-enter data.
