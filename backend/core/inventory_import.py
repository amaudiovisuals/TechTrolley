"""Create-only inventory imports. A spreadsheet must never transfer existing stock."""
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from io import BytesIO
from zipfile import BadZipFile, ZipFile

from django.db import transaction
from openpyxl import load_workbook

from .models import Asset, SubrentalCompany
from .inventory_registration import identity_tokens, lock_inventory_identifiers, occupied_identifiers, unit_quantity_required


class InventoryImportError(ValueError):
    pass


def text(value):
    return '' if value is None else str(value).strip()


def workbook_rows(upload):
    if not upload.name.lower().endswith('.xlsx') or not 0 < upload.size <= 5 * 1024 * 1024:
        raise InventoryImportError('Use an .xlsx workbook no larger than 5 MB.')
    payload = upload.read(5 * 1024 * 1024 + 1)
    try:
        with ZipFile(BytesIO(payload)) as archive:
            members = archive.infolist()
            if len(members) > 1000 or sum(item.file_size for item in members) > 32 * 1024 * 1024:
                raise InventoryImportError('Workbook contents exceed the import limit.')
            if any(item.file_size > 8 * 1024 * 1024 for item in members):
                raise InventoryImportError('A workbook sheet exceeds the import limit.')
            if any('vbaproject' in item.filename.lower() or '/externallinks/' in item.filename.lower() for item in members):
                raise InventoryImportError('Use a values-only workbook without macros or external links.')
        book = load_workbook(BytesIO(payload), read_only=True, data_only=False, keep_links=False)
        try:
            sheet = book.worksheets[0]
            if (sheet.max_row or 0) > 5001 or (sheet.max_column or 0) > 64:
                raise InventoryImportError('Import at most 5000 rows and 64 columns at a time.')
            rows = []
            for cells in sheet.iter_rows(max_row=5002, max_col=65):
                if any(cell.data_type == 'f' for cell in cells):
                    raise InventoryImportError('Replace formulas with their values before importing.')
                values = [cell.value for cell in cells]
                if values[64] is not None or len(rows) >= 5001:
                    if any(value is not None for value in values):
                        raise InventoryImportError('Import at most 5000 rows and 64 columns at a time.')
                    break
                rows.append(values[:64])
            if not rows:
                raise InventoryImportError('The workbook is empty.')
            headers = [text(value).lower().replace('_', ' ') for value in rows[0]]
            nonempty = [value for value in headers if value]
            if len(nonempty) != len(set(nonempty)):
                raise InventoryImportError('The workbook contains duplicate column headers.')
            if not {'sku', 'serial number', 'serial'} & set(headers):
                raise InventoryImportError('Use the inventory template with SKU or Serial Number columns.')
            return [(number, dict(zip(headers, values))) for number, values in enumerate(rows[1:], 2)
                    if any(value is not None and text(value) for value in values)]
        finally:
            book.close()
    except (BadZipFile, KeyError, OSError, ValueError) as exc:
        if isinstance(exc, InventoryImportError):
            raise
        raise InventoryImportError('The file is not a readable .xlsx workbook.') from None


def amount(value, label, maximum=Decimal('1e18')):
    try:
        number = Decimal(text(value) or '0')
        if not number.is_finite() or number < 0 or number >= maximum or number != number.quantize(Decimal('.01')):
            raise ValueError()
        return number.quantize(Decimal('.01'))
    except (ValueError, InvalidOperation):
        raise InventoryImportError(f'{label} must be a non-negative number with at most two decimal places.') from None


def parsed_date(value):
    if value is None or text(value) == '':
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(text(value))
    except ValueError:
        raise InventoryImportError('Dates must use YYYY-MM-DD or Excel date cells.') from None


def asset_from_row(row, company):
    def get(*names):
        return next((row[name] for name in names if name in row), None)

    sku, serial = text(get('sku')), text(get('serial number', 'serial'))
    if not sku and not serial:
        raise InventoryImportError('SKU or Serial Number is required.')
    quantity = get('quantity', 'qty')
    try:
        q = Decimal(text(quantity) or '1')
        if not q.is_finite() or q != q.to_integral_value() or not 1 <= q <= 2147483647:
            raise ValueError()
    except (ValueError, InvalidOperation):
        raise InventoryImportError('Quantity must be a positive whole number.') from None
    category = text(get('type', 'category')) or 'Other'
    categories = {key.lower(): key for key, _ in Asset.CATEGORY_CHOICES}
    if category.lower() not in categories:
        raise InventoryImportError(f'Unknown inventory Type: {category}. Use an existing inventory category.')
    if q != 1 and unit_quantity_required(categories[category.lower()], company):
        raise InventoryImportError('Equipment needs one row per item with a distinct SKU and QR. Use batch registration to create multiple items.')
    raw_depreciation = get('depreciation percentage', 'depreciation')
    if isinstance(raw_depreciation, str) and raw_depreciation.strip().endswith('%'):
        raw_depreciation = raw_depreciation.strip()[:-1]
    elif isinstance(raw_depreciation, (int, float)) and 0 < raw_depreciation < 1:
        raw_depreciation = Decimal(str(raw_depreciation)) * 100
    depreciation = amount(raw_depreciation, 'Depreciation Percentage', Decimal('100.01'))
    barcode, qr = text(get('barcode')), text(get('qr code'))
    asset = Asset(
        sku=sku or serial, serial_number=serial, alias_name=text(get('alias name')),
        mac_address=text(get('mac address')), imei_number_1=text(get('imei number 1', 'imei1')),
        imei_number_2=text(get('imei number 2', 'imei2')), description=text(get('description')),
        type=categories[category.lower()], quantity=int(q), barcode=barcode, qr_code=qr,
        barcode_type=text(get('barcode type')), subrental_company=company,
        is_barcode_added=bool(barcode or qr) or text(get('is barcode added', 'barcode added')).lower() in {'yes', 'true', '1', 'y'},
        purchased_date=parsed_date(get('purchased date')), available_from=parsed_date(get('available from')),
        available_till=parsed_date(get('available till')), item_price=amount(get('item price', 'price'), 'Item Price'),
        depreciation_percentage=depreciation,
    )
    if asset.available_from and asset.available_till and asset.available_from > asset.available_till:
        raise InventoryImportError('Available till must be on or after Available from.')
    asset.full_clean(validate_unique=False)
    return asset


@transaction.atomic
def import_assets(upload, company_id):
    lock_inventory_identifiers()
    company = None
    if company_id not in (None, '', 'null'):
        if not str(company_id).isdigit():
            raise InventoryImportError('Choose a valid supplier company.')
        company = SubrentalCompany.objects.select_for_update().filter(pk=company_id).first()
        if not company:
            raise InventoryImportError('The selected supplier company no longer exists.')
    rows = workbook_rows(upload)
    if not rows:
        raise InventoryImportError('The workbook contains no inventory rows.')
    identifiers = occupied_identifiers()
    prepared, errors, seen = [], [], {}
    for number, row in rows:
        try:
            asset = asset_from_row(row, company)
            values = identity_tokens(vars(asset))
            for value in values:
                if value in identifiers:
                    raise InventoryImportError('An identifier already belongs to existing inventory. Existing stock was not changed; use the reviewed ownership workflow to move it.')
                if value in seen:
                    raise InventoryImportError(f'An identifier is repeated in row {seen[value]}.')
            seen.update({value: number for value in values})
            prepared.append(asset)
        except Exception as exc:
            from django.core.exceptions import ValidationError
            if not isinstance(exc, (InventoryImportError, ValidationError)):
                raise
            errors.append(f'Row {number}: {exc}')
    if errors:
        return {'created': 0, 'updated': 0, 'skipped': 0, 'errors': errors,
                'message': 'No inventory changes saved. Correct the file and try again.'}, 400
    for asset in prepared:
        asset.save()
    return {'created': len(prepared), 'updated': 0, 'skipped': 0, 'errors': [],
            'message': f'{len(prepared)} asset(s) created. Existing inventory was not changed.'}, 201
