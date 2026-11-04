
import django
from django.db import models
from django.core.validators import MinValueValidator
from decimal import Decimal

class CredentialAttempt(models.Model):
    """HMAC identifiers only; no emails, IPs, passwords or tokens."""
    key = models.CharField(max_length=64, primary_key=True)
    attempts = models.PositiveIntegerField(default=0)
    expires_at = models.DateTimeField(db_index=True)


class SubrentalCompany(models.Model):
    ownership_revision = models.PositiveBigIntegerField(default=0, editable=False)
    inventory_mode = models.CharField(max_length=24, default='unreviewed', editable=False,
        choices=[('unreviewed', 'Inventory classification pending'), ('shared_warehouse', 'Stock managed in our godown'), ('external_supplier', 'External supplier catalogue')])
    name = models.CharField(max_length=200)
    address = models.TextField(null=True, blank=True)
    gst_number = models.CharField(max_length=20, null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.name

class Asset(models.Model):
    ownership_revision = models.PositiveBigIntegerField(default=0, editable=False)
    custody_revision = models.PositiveBigIntegerField(default=0, editable=False)
    STATUS_CHOICES = [
        ('Available', 'Available'),
        ('In Use', 'In Use'),
        ('Damaged', 'Damaged'),
        ('Crosscheck', 'Crosscheck'),
        ('On Service', 'On Service'),
        ('Expired', 'Expired'),
        ('Missing', 'Missing'),
    ]

    FLAG_CHOICES = [
        ('', 'None'),
        ('Expired', 'Expired'),
        ('Required Service', 'Required Service'),
        ('On Service', 'On Service'),
        ('Missing', 'Missing'),
    ]
    
    CATEGORY_CHOICES = [
        ('Speakers & Audio', 'Speakers & Audio'),
        ('Audio Mixers', 'Audio Mixers'),
        ('Microphones', 'Microphones'),
        ('Laptops', 'Laptops'),
        ('Smartphones', 'Smartphones'),
        ('Computers & Servers', 'Computers & Servers'),
        ('IT & Networking', 'IT & Networking'),
        ('Peripherals', 'Peripherals'),
        ('Monitors', 'Monitors'),
        ('TVs', 'TVs'),
        ('Projectors', 'Projectors'),
        ('Lighting & LED', 'Lighting & LED'),
        ('Video Switchers', 'Video Switchers'),
        ('Capture Cards', 'Capture Cards'),
        ('Splitters & Converters', 'Splitters & Converters'),
        ('Cameras', 'Cameras'),
        ('UPS & Power', 'UPS & Power'),
        ('Printers', 'Printers'),
        ('Consumables', 'Consumables'),
        ('Cable', 'Cable'),
        ('Other', 'Other'),
    ]

    sku = models.CharField(max_length=100, db_index=True, null=True, blank=True)
    alias_name = models.CharField(max_length=200, null=True, blank=True)
    mac_address = models.CharField(max_length=100, null=True, blank=True)
    imei_number_1 = models.CharField(max_length=100, null=True, blank=True)
    imei_number_2 = models.CharField(max_length=100, null=True, blank=True)
    serial_number = models.CharField(max_length=100, null=True, blank=True, db_index=True)
    description = models.TextField(null=True, blank=True)
    is_barcode_added = models.BooleanField(default=False)
    type = models.CharField(max_length=100, choices=CATEGORY_CHOICES, default='Other')
    quantity = models.PositiveIntegerField(default=1)
    # Kept once bulk tracking starts, even if stock is later reduced to one unit.
    quantity_tracking = models.BooleanField(default=False, editable=False)
    staff_revision = models.PositiveBigIntegerField(default=0, editable=False)
    purchased_date = models.DateField(null=True, blank=True)
    item_price = models.DecimalField(max_digits=20, decimal_places=2, null=True, blank=True, default=Decimal('0.00'))
    depreciation_percentage = models.DecimalField(max_digits=20, decimal_places=2, null=True, blank=True, default=Decimal('0.00'))
    available_from = models.DateField(null=True, blank=True)
    available_till = models.DateField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, null=True, blank=True)
    
    # Keep some internal fields for system logic
    barcode_type = models.CharField(max_length=50, blank=True, default='')
    barcode = models.CharField(max_length=100, blank=True, default='') 
    qr_code = models.CharField(max_length=255, blank=True, default='')
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='Available', db_index=True)
    condition = models.CharField(max_length=50, default='Good')
    flag = models.CharField(max_length=20, choices=FLAG_CHOICES, default='', blank=True, db_index=True)
    last_maintained = models.DateField(null=True, blank=True)
    is_temporary = models.BooleanField(default=False)
    current_venue = models.CharField(max_length=200, null=True, blank=True)
    return_date = models.DateField(null=True, blank=True)
    assigned_to = models.ForeignKey('Employee', on_delete=models.SET_NULL, null=True, blank=True, related_name='assets')
    parent_asset = models.ForeignKey('self', on_delete=models.SET_NULL, null=True, blank=True, related_name='sub_assets')
    subrental_company = models.ForeignKey(SubrentalCompany, on_delete=models.PROTECT, null=True, blank=True, related_name='assets')
    
    # Deprecated fields (will be removed after migration)
    # name, brand, model_number are now part of description or alias_name in the new structure
    name = models.CharField(max_length=200, blank=True, default='')
    brand = models.CharField(max_length=100, blank=True, default='')
    model_number = models.CharField(max_length=100, blank=True, default='')

    @property
    def current_value(self):
        from datetime import date
        
        if not self.item_price or not self.purchased_date:
            return int(self.item_price or 0)
            
        # 1. Determine the Base Rate
        it_categories = ['Computers & Servers', 'Laptops', 'IT & Networking']
        name_lower = f"{self.alias_name or ''} {self.description or ''} {self.type or ''}".lower()
        if self.type in it_categories or 'laptop' in name_lower or 'computer' in name_lower or 'it gear' in name_lower:
            base_rate = 0.40
        else:
            base_rate = 0.15
            
        # 2. Financial Year Handling
        def get_fy_end_year(dt):
            return dt.year if dt.month < 4 else dt.year + 1
            
        purchase_fy_end = get_fy_end_year(self.purchased_date)
        current_date = date.today()
        current_fy_end = get_fy_end_year(current_date)
        
        # 3. The 180-Day Rule
        march_31 = date(purchase_fy_end, 3, 31)
        days_in_first_fy = (march_31 - self.purchased_date).days + 1
        
        year_1_rate = base_rate / 2.0 if days_in_first_fy < 180 else base_rate
        
        # 4. Compounding
        value = float(self.item_price)
        for fy in range(purchase_fy_end, current_fy_end):
            rate = year_1_rate if fy == purchase_fy_end else base_rate
            value = value - (value * rate)
            
        # 5. Return the final compounded integer value
        return int(value)

    def save(self, *args, **kwargs):
        existing = not self._state.adding
        if existing:
            # Generic metadata/import saves cannot release an unproved healthy lock.
            # Reviewed corrections and actual movement verification update explicitly.
            stored = Asset.objects.only('status', 'flag', 'condition').get(pk=self.pk)
            if self.status == 'Available' and stored.status in {'In Use', 'Crosscheck'} and not stored.flag and not self.flag and stored.condition != 'Damaged' and self.condition != 'Damaged':
                self.status = stored.status
            from django.db.models import F
            self.custody_revision = F('custody_revision') + 1
            if kwargs.get('update_fields') is not None:
                kwargs['update_fields'] = set(kwargs['update_fields']) | {'custody_revision'}
        if self.quantity != 1 and self.type != 'Consumables':
            self.quantity_tracking = True
            if kwargs.get('update_fields') is not None:
                kwargs['update_fields'] = set(kwargs['update_fields']) | {'quantity_tracking'}
        # Ensure QR Code is permanently embedded on creation/save if blank
        if not self.qr_code and self.sku:
            self.qr_code = self.sku
            
        from .custody import derived_status
        self.status = derived_status(self, preserve_unproved_custody=True)
        if kwargs.get('update_fields') is not None:
            kwargs['update_fields'] = set(kwargs['update_fields']) | {'status'}

        super().save(*args, **kwargs)
        if existing:
            self.refresh_from_db(fields=['custody_revision'])

    def __str__(self):
        return f"{self.sku} - {self.alias_name or self.serial_number}"

class Employee(models.Model):
    user = models.OneToOneField('auth.User', null=True, blank=True, on_delete=models.PROTECT, related_name='employee_identity')
    identity_revision = models.PositiveBigIntegerField(default=0, editable=False)
    name = models.CharField(max_length=100)
    employee_id = models.CharField(max_length=50, unique=True)
    department = models.CharField(max_length=100)
    email = models.EmailField()
    phone = models.CharField(max_length=20)
    role = models.CharField(max_length=50, default='technician', blank=True)
    joined_at = models.DateField(auto_now_add=True, null=True, blank=True)

    def __str__(self):
        return self.name

class SubrentalTicket(models.Model):
    company = models.ForeignKey(SubrentalCompany, on_delete=models.CASCADE, related_name='tickets')
    conference = models.ForeignKey('Conference', on_delete=models.CASCADE, related_name='subrental_tickets')
    created_at = models.DateTimeField(auto_now_add=True)
    available_from = models.DateField(null=True, blank=True)
    available_till = models.DateField(null=True, blank=True)

    def __str__(self):
        return f"Ticket {self.id} - {self.company.name} for {self.conference.name}"

class SubrentalTicketItem(models.Model):
    ticket = models.ForeignKey(SubrentalTicket, on_delete=models.CASCADE, related_name='items')
    asset = models.ForeignKey(Asset, on_delete=models.CASCADE, related_name='ticket_items')
    rental_price = models.DecimalField(max_digits=20, decimal_places=2, default=Decimal('0.00'))
    quantity = models.PositiveIntegerField(default=1)

    def __str__(self):
        return f"{self.asset.alias_name or self.asset.sku} ({self.quantity}) in Ticket {self.ticket.id}"


class SupplierBalance(models.Model):
    """External order obligation, separate from shared warehouse stock/custody."""
    item = models.OneToOneField(SubrentalTicketItem, on_delete=models.PROTECT, related_name='supplier_balance')
    opening_receipt = models.ForeignKey('MovementReceipt', on_delete=models.PROTECT, related_name='supplier_openings')
    order_receipt = models.ForeignKey('MovementReceipt', null=True, on_delete=models.PROTECT, related_name='supplier_orders')
    provenance = models.CharField(max_length=40, choices=[('new_order', 'New recorded order'), ('reviewed_legacy_opening', 'Reviewed legacy opening')])
    ordered = models.PositiveIntegerField()
    received = models.PositiveIntegerField(default=0)
    returned = models.PositiveIntegerField(default=0)
    cancelled = models.PositiveIntegerField(default=0)
    revision = models.PositiveBigIntegerField(default=0)

    class Meta:
        constraints = [models.CheckConstraint(**{'condition' if django.VERSION >= (5, 1) else 'check': models.Q(ordered__gt=0, received__lte=models.F('ordered')-models.F('cancelled'), returned__lte=models.F('received'))}, name='valid_supplier_balance')]


class SupplierMovement(models.Model):
    balance = models.ForeignKey(SupplierBalance, on_delete=models.PROTECT, related_name='movements')
    receipt = models.OneToOneField('MovementReceipt', on_delete=models.PROTECT, related_name='supplier_movement')
    action = models.CharField(max_length=40)
    quantity = models.PositiveIntegerField(default=0)
    reason = models.CharField(max_length=1000)
    evidence_reference = models.CharField(max_length=1000)
    source_snapshot = models.JSONField(default=dict)
    before = models.JSONField(null=True)
    after = models.JSONField()
    recorded_at = models.DateTimeField(auto_now_add=True)


class SupplierChange(models.Model):
    """Protected documentary edits; these are not receipt or return movements."""
    receipt = models.OneToOneField('MovementReceipt', on_delete=models.PROTECT, related_name='supplier_change')
    company = models.ForeignKey(SubrentalCompany, on_delete=models.PROTECT, related_name='changes')
    ticket = models.ForeignKey(SubrentalTicket, on_delete=models.PROTECT, related_name='changes')
    item = models.ForeignKey(SubrentalTicketItem, null=True, on_delete=models.PROTECT, related_name='changes')
    asset = models.ForeignKey(Asset, null=True, on_delete=models.PROTECT, related_name='supplier_changes')
    action = models.CharField(max_length=30)
    reason = models.CharField(max_length=1000)
    before = models.JSONField(default=dict)
    after = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)

class Conference(models.Model):
    revision = models.PositiveBigIntegerField(default=0, editable=False)
    lifecycle_state = models.CharField(max_length=12, default='open', choices=[('open', 'Open'), ('completed', 'Verified complete'), ('archived', 'Archived')], editable=False, db_index=True)
    completed_at = models.DateTimeField(null=True, blank=True, editable=False)
    completed_by = models.ForeignKey('auth.User', null=True, blank=True, on_delete=models.PROTECT, related_name='completed_events', editable=False)
    archived_at = models.DateTimeField(null=True, blank=True, editable=False)
    archived_by = models.ForeignKey('auth.User', null=True, blank=True, on_delete=models.PROTECT, related_name='archived_events', editable=False)
    TYPE_CHOICES = [
        ('Medical Conference', 'Medical Conference'),
        ('Personal Rental', 'Personal Rental'),
    ]
    
    name = models.CharField(max_length=200, default='')
    association_name = models.CharField(max_length=200, default='', blank=True)
    billing_address = models.TextField(default='', blank=True)
    transport_address = models.TextField(default='', blank=True)
    gst_number = models.CharField(max_length=20, default='', blank=True)
    vehicle_number = models.CharField(max_length=50, default='', blank=True)
    driver_phone = models.CharField(max_length=20, default='', blank=True)
    challan_date = models.DateField(null=True, blank=True)
    contact_person = models.CharField(max_length=100, default='', blank=True)
    contact_phone = models.CharField(max_length=15, default='', blank=True)
    contact_email = models.EmailField(default='', blank=True)
    conference_type = models.CharField(max_length=50, choices=TYPE_CHOICES, default='Medical Conference')
    start_date = models.DateField(null=True, blank=True)
    end_date = models.DateField(null=True, blank=True)
    assets = models.ManyToManyField(Asset, blank=True, related_name='assigned_conferences')
    requirements = models.ManyToManyField(Asset, blank=True, related_name='requirement_conferences')
    crosscheck_assets = models.ManyToManyField(Asset, blank=True, related_name='crosscheck_conferences')
    challan_assets = models.ManyToManyField(Asset, blank=True, related_name='challan_conferences')
    assigned_employees = models.ManyToManyField(Employee, blank=True, related_name='assigned_conferences')
    pdf_document = models.FileField(upload_to='conference_pdfs/', null=True, blank=True)
    challan_number = models.CharField(max_length=50, default='', blank=True)
    staged_assets = models.ManyToManyField(Asset, blank=True, related_name='staged_conferences')
    approximate_value = models.DecimalField(max_digits=20, decimal_places=2, default=0, null=True, blank=True)
    flag_log = models.JSONField(default=list, blank=True, help_text="Log of assets flagged during this conference: [{'asset_id': 1, 'flag': 'Missing', 'stage': 'Packup', 'timestamp': '...'}]")
    consumable_data = models.JSONField(default=dict, blank=True, help_text="Tracks consumable quantities per conference: {'asset_id': {'requested': 5, 'returned': 3, 'consumed': 2, 'status': 'settled'}}")
    transfer_log = models.JSONField(default=list, blank=True, help_text="Audit log of all asset transfers: [{'timestamp': '...', 'direction': 'outgoing'|'incoming', 'transferred_asset_ids': [], 'asset_names': [], 'to/from_conference_id': X, 'to/from_conference_name': '...', 'from_address': '...', 'transferred_by': '...'}]")
    # J-109: Audit Mode — when True, assets in this conference do not lock other live events
    is_audit = models.BooleanField(default=False, help_text="If True, this conference is a non-blocking audit list. Its assets will not lock availability for other conferences.")
    is_invoiced = models.BooleanField(default=False, help_text="Track if challan has been marked invoiced by accounts")

    def recalculate_related_asset_statuses(self):
        from .custody import synchronize_statuses
        ids = set(self.assets.values_list('pk', flat=True)) | set(self.crosscheck_assets.values_list('pk', flat=True))
        synchronize_statuses(ids)

    def save(self, *args, **kwargs):
        is_new = self.pk is None
        old_is_audit = False
        if not is_new:
            try:
                old_is_audit = Conference.objects.values_list('is_audit', flat=True).get(pk=self.pk)
            except Conference.DoesNotExist:
                pass
                
        if not is_new:
            from django.db.models import F
            self.revision = F('revision') + 1
            if kwargs.get('update_fields') is not None:
                kwargs['update_fields'] = set(kwargs['update_fields']) | {'revision'}
        super().save(*args, **kwargs)
        if not is_new:
            self.refresh_from_db(fields=['revision'])
        
        # If is_audit was toggled, propagate status recalculation to its assets
        if not is_new and old_is_audit != self.is_audit:
            self.recalculate_related_asset_statuses()

    def __str__(self):
        return self.name


class QuantityAllocation(models.Model):
    """Reusable bulk stock; allocations never split or decrement the asset row."""
    asset = models.ForeignKey(Asset, on_delete=models.PROTECT, related_name='quantity_allocations')
    conference = models.ForeignKey(Conference, on_delete=models.PROTECT, related_name='quantity_allocations')
    reserved = models.PositiveIntegerField(default=0)
    dispatched = models.PositiveIntegerField(default=0)
    awaiting_verification = models.PositiveIntegerField(default=0)
    dispatched_total = models.PositiveBigIntegerField(default=0)
    verified_total = models.PositiveBigIntegerField(default=0)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['asset', 'conference'], name='unique_quantity_event_asset')]


class ConsumableAllocation(models.Model):
    asset = models.ForeignKey(Asset, on_delete=models.PROTECT, related_name='consumable_allocations')
    conference = models.ForeignKey(Conference, on_delete=models.PROTECT, related_name='consumable_allocations')
    requested = models.PositiveIntegerField(default=0)
    returned = models.PositiveIntegerField(null=True, blank=True)
    consumed = models.PositiveIntegerField(default=0)
    state = models.CharField(max_length=20, default='reserved', choices=[('reserved', 'Reserved'), ('dispatched', 'Dispatched'), ('settled', 'Settled')])

    class Meta:
        constraints = [models.UniqueConstraint(fields=['asset', 'conference'], name='unique_consumable_event_asset')]


class ConsumableMovement(models.Model):
    allocation = models.ForeignKey(ConsumableAllocation, on_delete=models.PROTECT, related_name='movements')
    receipt = models.ForeignKey('MovementReceipt', on_delete=models.PROTECT, related_name='consumable_movements')
    action = models.CharField(max_length=30)
    before = models.JSONField()
    after = models.JSONField()
    stock_before = models.PositiveIntegerField()
    stock_after = models.PositiveIntegerField()
    created_at = models.DateTimeField(auto_now_add=True)


class QuantityMovement(models.Model):
    allocation = models.ForeignKey(QuantityAllocation, on_delete=models.PROTECT, related_name='movements')
    receipt = models.ForeignKey('MovementReceipt', on_delete=models.PROTECT, related_name='quantity_movements')
    action = models.CharField(max_length=30)
    quantity = models.PositiveIntegerField()
    before = models.JSONField()
    after = models.JSONField()
    created_at = models.DateTimeField(auto_now_add=True)

class TruckChallan(models.Model):
    conference = models.ForeignKey(
        Conference, on_delete=models.CASCADE, related_name='truck_challans'
    )
    truck_number = models.PositiveIntegerField(default=1)
    label = models.CharField(max_length=50, default='', blank=True)
    vehicle_number = models.CharField(max_length=50, default='', blank=True)
    driver_phone = models.CharField(max_length=20, default='', blank=True)
    # J-113: Each truck challan gets its own unique challan number from the sequence
    challan_number = models.CharField(max_length=50, default='', blank=True,
        help_text="Auto-assigned unique challan number for this truck (e.g. '26-27/AMDL-00123')")
    assets = models.ManyToManyField(
        Asset, blank=True, related_name='truck_challans'
    )
    asset_quantities = models.JSONField(
        default=dict, blank=True,
        help_text="Per-asset allocated quantity in this truck: {'<asset_id>': <quantity>}"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['truck_number']
        unique_together = [('conference', 'truck_number')]

    def __str__(self):
        return f"Truck {self.truck_number} - {self.conference.name}"

class DeliveryChallan(models.Model):
    challan_number = models.CharField(max_length=50, unique=True)
    conference = models.ForeignKey(Conference, on_delete=models.CASCADE)
    created_at = models.DateTimeField(auto_now_add=True)
    issued_by = models.CharField(max_length=100)

    def __str__(self):
        return self.challan_number


class ChallanNumberLock(models.Model):
    """Singleton mutex shared by number allocation and document reservations."""
    id = models.PositiveSmallIntegerField(primary_key=True, default=1)


class ChallanNumberReservation(models.Model):
    number = models.CharField(max_length=50, unique=True)
    conference = models.ForeignKey(Conference, on_delete=models.SET_NULL, null=True)
    created_at = models.DateTimeField(auto_now_add=True)


class ChallanDocument(models.Model):
    import uuid
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    conference = models.ForeignKey(Conference, on_delete=models.PROTECT, related_name='challan_documents')
    truck = models.OneToOneField(TruckChallan, null=True, blank=True, on_delete=models.PROTECT, related_name='document')
    scope = models.CharField(max_length=50)
    number = models.CharField(max_length=50)
    revision = models.PositiveBigIntegerField(default=0)
    state = models.CharField(max_length=10, choices=[('draft', 'Draft'), ('issued', 'Issued')], default='draft')
    document_date = models.DateField(null=True, blank=True)
    total_override = models.DecimalField(max_digits=20, decimal_places=2, null=True, blank=True)
    header = models.JSONField(default=dict)
    provenance = models.CharField(max_length=50, default='saved_document')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['conference', 'scope'], name='unique_challan_scope')]


class ChallanLine(models.Model):
    import uuid
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    document = models.ForeignKey(ChallanDocument, on_delete=models.CASCADE, related_name='lines')
    asset = models.ForeignKey(Asset, on_delete=models.PROTECT, null=True, blank=True)
    ticket_item = models.ForeignKey(SubrentalTicketItem, on_delete=models.PROTECT, null=True, blank=True)
    supplier = models.ForeignKey(SubrentalCompany, on_delete=models.PROTECT, null=True, blank=True)
    source_kind = models.CharField(max_length=10, choices=[('owned', 'Owned'), ('supplier', 'Supplier'), ('manual', 'Manual')])
    snapshot = models.JSONField(default=dict)
    quantity = models.PositiveIntegerField()
    unit_value = models.DecimalField(max_digits=20, decimal_places=2)
    position = models.PositiveIntegerField()

    class Meta:
        ordering = ['position', 'id']
        constraints = [models.UniqueConstraint(fields=['document', 'position'], name='unique_challan_position')]


class ChallanRevision(models.Model):
    document = models.ForeignKey(ChallanDocument, on_delete=models.PROTECT, related_name='history')
    revision = models.PositiveBigIntegerField()
    actor = models.ForeignKey('auth.User', on_delete=models.PROTECT)
    reason = models.TextField(blank=True)
    snapshot = models.JSONField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['document', 'revision'], name='unique_challan_revision')]


class TruckManifest(models.Model):
    conference = models.OneToOneField(Conference, on_delete=models.PROTECT, related_name='truck_manifest')
    master = models.OneToOneField(ChallanDocument, on_delete=models.PROTECT, related_name='manifest')


class TruckManifestEntry(models.Model):
    import uuid
    manifest = models.ForeignKey(TruckManifest, on_delete=models.PROTECT, related_name='entries')
    master_line = models.ForeignKey(ChallanLine, on_delete=models.PROTECT, related_name='manifest_entries')
    truck = models.ForeignKey(TruckChallan, on_delete=models.PROTECT, related_name='manifest_entries')
    quantity = models.PositiveIntegerField(default=0)
    document_line_id = models.UUIDField(default=uuid.uuid4, unique=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['master_line', 'truck'], name='unique_manifest_source_truck')]

class CompanySettings(models.Model):
    name = models.CharField(max_length=200, default="AM AUDIOVISUALS PVT LTD")
    address = models.TextField(default="Warehouse Complex 7, Industrial Area Phase II, New Delhi - 110020.")
    phone = models.CharField(max_length=50, default="+91 9999 888 777")
    email = models.EmailField(default="support@amaudiovisuals.in")
    gst_number = models.CharField(max_length=50, default="07AAMAU9988Z2Z1")
    website = models.CharField(max_length=100, default="www.amaudiovisuals.in", blank=True)
    logo = models.ImageField(upload_to='company/', null=True, blank=True)
    powered_by_name = models.CharField(max_length=200, default="am audiovisuals")
    dashboard_config = models.JSONField(default=dict, blank=True, help_text="Config for dashboard cards visibility")
    theme_template = models.CharField(max_length=20, default='blue', choices=[('blue', 'Blue'), ('green', 'Green')])
    print_label_width = models.IntegerField(default=50, help_text="Label width in mm")
    print_label_height = models.IntegerField(default=25, help_text="Label height in mm")
    next_challan_number = models.IntegerField(default=1, help_text="Next sequential challan number within the current financial year")
    # J-112: Structured challan number (e.g. "26-27/AMDL-00122")
    challan_prefix = models.CharField(max_length=20, default='AMDL', blank=True,
        help_text="Fixed prefix in challan number (e.g. 'AMDL' → '26-27/AMDL-00122')")
    challan_fy = models.CharField(max_length=10, default='', blank=True,
        help_text="Financial year the current sequence counter belongs to (e.g. '26-27'). Auto-resets on April 1.")

    def __str__(self):
        return self.name

    def save(self, *args, **kwargs):
        if not self.pk and CompanySettings.objects.exists():
            # If you try to save a new instance and one exists, update the existing one
            existing = CompanySettings.objects.first()
            existing.name = self.name
            existing.address = self.address
            existing.phone = self.phone
            existing.email = self.email
            existing.gst_number = self.gst_number
            existing.website = self.website
            existing.logo = self.logo  # BUG J-9: Unconditional mirror — allows clearing logo when empty
            existing.powered_by_name = self.powered_by_name
            existing.dashboard_config = self.dashboard_config
            existing.theme_template = self.theme_template
            existing.print_label_width = self.print_label_width
            existing.print_label_height = self.print_label_height
            existing.next_challan_number = self.next_challan_number
            existing.challan_prefix = self.challan_prefix
            existing.challan_fy = self.challan_fy
            existing.save()
            return
        super(CompanySettings, self).save(*args, **kwargs)


def get_current_financial_year() -> str:
    """
    Returns the Indian financial year as "YY-YY" (e.g. "26-27").
    FY runs April 1 – March 31.
    """
    from datetime import date
    today = date.today()
    if today.month >= 4:  # April onwards = start of new FY
        return f"{str(today.year)[2:]}-{str(today.year + 1)[2:]}"
    else:
        return f"{str(today.year - 1)[2:]}-{str(today.year)[2:]}"


def generate_challan_number(settings_obj) -> str:
    from .challan_documents import allocate_number
    return allocate_number(settings_obj)

from django.contrib.auth.models import User
from django.db.models.signals import post_save
from django.dispatch import receiver

class UserProfile(models.Model):
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name='profile')
    ROLE_CHOICES = [
        ('admin', 'Admin'),
        ('boss', 'Boss / Executive'),
        ('godown_incharge', 'Godown Incharge'),
        ('technician', 'Technician'),
        ('accounts', 'Accounts'),
    ]
    role = models.CharField(max_length=20, choices=ROLE_CHOICES, default='technician')

    def __str__(self):
        return f"{self.user.username} - {self.role}"

@receiver(post_save, sender=User)
def create_or_save_user_profile(sender, instance, created, **kwargs):
    if kwargs.get('raw'):
        return
    if created:
        role = 'admin' if getattr(instance, 'is_superuser', False) or getattr(instance, 'is_staff', False) else 'technician'
        UserProfile.objects.create(user=instance, role=role)
    else:
        if not hasattr(instance, 'profile'):
            role = 'admin' if getattr(instance, 'is_superuser', False) or getattr(instance, 'is_staff', False) else 'technician'
            UserProfile.objects.create(user=instance, role=role)
        else:
            instance.profile.save()
from django.db.models.signals import m2m_changed

def membership_custody_change(instance, action, reverse, pk_set, field):
    # Clear must derive AFTER deletion, when the current relationships are visible.
    key = '_custody_clear_' + field
    if reverse:
        relation = 'assigned_conferences' if field == 'assets' else 'crosscheck_conferences'
        if action == 'pre_clear':
            ids = {instance.pk} if getattr(instance, relation).filter(is_audit=False).exists() else set()
        else:
            ids = {instance.pk} if pk_set and Conference.objects.filter(pk__in=pk_set, is_audit=False).exists() else set()
    else:
        ids = set(getattr(instance, field).values_list('pk', flat=True)) if action == 'pre_clear' else set(pk_set or [])
        if instance.is_audit:
            ids = set()  # An observation change never repairs physical custody.
    if action == 'pre_clear':
        setattr(instance, key, ids)
    elif action == 'post_clear':
        from .custody import synchronize_statuses
        synchronize_statuses(getattr(instance, key, set()))
        if hasattr(instance, key):
            delattr(instance, key)
    elif action in ('post_add', 'post_remove') and ids:
        from .custody import synchronize_statuses
        synchronize_statuses(ids)


@receiver(m2m_changed, sender=Conference.assets.through)
def update_asset_status_on_assets_change(sender, instance, action, pk_set, reverse=False, **kwargs):
    membership_custody_change(instance, action, reverse, pk_set, 'assets')


@receiver(m2m_changed, sender=Conference.crosscheck_assets.through)
def update_asset_status_on_crosscheck_change(sender, instance, action, pk_set, reverse=False, **kwargs):
    membership_custody_change(instance, action, reverse, pk_set, 'crosscheck_assets')


@receiver(models.signals.pre_delete, sender=Conference)
def remember_deleted_conference_custody(sender, instance, **kwargs):
    instance._deleted_custody_ids = (set(instance.assets.values_list('pk', flat=True)) |
                                     set(instance.crosscheck_assets.values_list('pk', flat=True))) if not instance.is_audit else set()


@receiver(models.signals.post_delete, sender=Conference)
def derive_deleted_conference_custody(sender, instance, **kwargs):
    from .custody import synchronize_statuses
    synchronize_statuses(getattr(instance, '_deleted_custody_ids', set()))


class MovementReceipt(models.Model):
    """One committed command and canonical receipt per actor/request UUID."""
    actor = models.ForeignKey(User, on_delete=models.PROTECT)
    request_id = models.UUIDField()
    payload_hash = models.CharField(max_length=64)
    result = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['actor', 'request_id'], name='unique_actor_movement_request')]


class PhysicalMovement(models.Model):
    """Future physical commands only. Never infer an old return from paperwork."""
    asset = models.ForeignKey(Asset, on_delete=models.PROTECT, related_name='physical_movements')
    conference = models.ForeignKey(Conference, on_delete=models.PROTECT, related_name='physical_movements')
    target_conference = models.ForeignKey(Conference, null=True, blank=True, on_delete=models.PROTECT, related_name='incoming_physical_movements')
    receipt = models.ForeignKey(MovementReceipt, on_delete=models.PROTECT, related_name='physical_movements')
    action = models.CharField(max_length=32, choices=[(v, v) for v in ('dispatch', 'return', 'verify_return', 'transfer_out', 'transfer_in', 'legacy_return_review', 'legacy_return_review_revoked')])
    snapshot = models.JSONField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['receipt', 'conference', 'asset'], name='unique_physical_receipt_event_asset')]


class EventLifecycleHistory(models.Model):
    conference = models.ForeignKey(Conference, on_delete=models.PROTECT, related_name='lifecycle_history')
    actor = models.ForeignKey(User, on_delete=models.PROTECT, related_name='event_lifecycle_actions')
    receipt = models.OneToOneField(MovementReceipt, on_delete=models.PROTECT, related_name='event_lifecycle_history')
    action = models.CharField(max_length=12, choices=[(v, v) for v in ('complete', 'archive', 'reopen')])
    before_state = models.CharField(max_length=12)
    after_state = models.CharField(max_length=12)
    reason = models.TextField()
    evidence_sha256 = models.CharField(max_length=64)
    snapshot = models.JSONField()
    created_at = models.DateTimeField(auto_now_add=True)


class ReconciliationHistory(models.Model):
    import uuid
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    actor = models.ForeignKey(User, on_delete=models.PROTECT, related_name='reviewed_reconciliations')
    receipt = models.OneToOneField(MovementReceipt, on_delete=models.PROTECT, related_name='reconciliation_history')
    action = models.CharField(max_length=30)
    reason = models.TextField()
    evidence_reference = models.TextField()
    database_identity = models.JSONField()
    before_snapshot = models.JSONField()
    after_snapshot = models.JSONField(default=dict)
    before_sha256 = models.CharField(max_length=64)
    after_sha256 = models.CharField(max_length=64, blank=True)
    effects = models.JSONField(default=dict)
    reverses = models.OneToOneField('self', null=True, blank=True, on_delete=models.PROTECT, related_name='reversed_by')
    created_at = models.DateTimeField(auto_now_add=True)


class ReconciliationTarget(models.Model):
    history = models.ForeignKey(ReconciliationHistory, on_delete=models.PROTECT, related_name='targets')
    asset = models.ForeignKey(Asset, null=True, blank=True, on_delete=models.PROTECT, related_name='reconciliation_targets')
    conference = models.ForeignKey(Conference, null=True, blank=True, on_delete=models.PROTECT, related_name='reconciliation_targets')

    class Meta:
        constraints = [models.CheckConstraint(**{'condition' if django.VERSION >= (5, 1) else 'check': models.Q(asset__isnull=False, conference__isnull=True) | models.Q(asset__isnull=True, conference__isnull=False)}, name='one_reconciliation_target_kind')]


class OwnershipHistory(models.Model):
    import uuid
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    actor = models.ForeignKey(User, on_delete=models.PROTECT, related_name='ownership_reviews')
    receipt = models.OneToOneField(MovementReceipt, on_delete=models.PROTECT, related_name='ownership_history')
    action = models.CharField(max_length=30)
    reason = models.TextField()
    evidence_reference = models.TextField()
    database_identity = models.JSONField()
    before_snapshot = models.JSONField()
    after_snapshot = models.JSONField(default=dict)
    before_sha256 = models.CharField(max_length=64)
    after_sha256 = models.CharField(max_length=64, blank=True)
    effects = models.JSONField(default=dict)
    reverses = models.OneToOneField('self', null=True, blank=True, on_delete=models.PROTECT, related_name='reversed_by')
    created_at = models.DateTimeField(auto_now_add=True)


class OwnershipTarget(models.Model):
    history = models.ForeignKey(OwnershipHistory, on_delete=models.PROTECT, related_name='targets')
    asset = models.ForeignKey(Asset, null=True, blank=True, on_delete=models.PROTECT, related_name='ownership_targets')
    company = models.ForeignKey(SubrentalCompany, null=True, blank=True, on_delete=models.PROTECT, related_name='ownership_targets')

    class Meta:
        constraints = [models.CheckConstraint(**{'condition' if django.VERSION >= (5, 1) else 'check': models.Q(asset__isnull=False, company__isnull=True) | models.Q(asset__isnull=True, company__isnull=False)}, name='one_ownership_target_kind')]


class PreservedAuditObservation(models.Model):
    conference = models.ForeignKey(Conference, on_delete=models.PROTECT, related_name='preserved_audit_observations')
    asset = models.ForeignKey(Asset, on_delete=models.PROTECT, related_name='preserved_audit_observations')
    history = models.ForeignKey(ReconciliationHistory, on_delete=models.PROTECT, related_name='preserved_observations')
    phase = models.CharField(max_length=30)
    snapshot = models.JSONField()
    original_observed_at = models.DateTimeField(null=True, blank=True)
    preserved_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['history', 'asset', 'phase'], name='unique_preserved_audit_phase')]


class StaffAllocation(models.Model):
    import uuid
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    asset = models.ForeignKey(Asset, on_delete=models.PROTECT, related_name='staff_allocations')
    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name='staff_allocations')
    issued_at = models.DateTimeField(null=True, blank=True)
    issued_by = models.ForeignKey(User, null=True, blank=True, on_delete=models.PROTECT, related_name='staff_issues')
    issue_receipt = models.ForeignKey(MovementReceipt, null=True, blank=True, on_delete=models.PROTECT, related_name='staff_issues')
    issue_reason = models.TextField(blank=True)
    issue_snapshot = models.JSONField(default=dict)
    provenance = models.CharField(max_length=50, default='recorded_issue')
    returned_at = models.DateTimeField(null=True, blank=True)
    returned_by = models.ForeignKey(User, null=True, blank=True, on_delete=models.PROTECT, related_name='staff_returns')
    return_receipt = models.ForeignKey(MovementReceipt, null=True, blank=True, on_delete=models.PROTECT, related_name='staff_returns')
    return_reason = models.TextField(blank=True)
    return_snapshot = models.JSONField(default=dict)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['asset'], condition=models.Q(returned_at__isnull=True), name='one_open_staff_allocation')]


class EmployeeIdentityHistory(models.Model):
    employee = models.ForeignKey(Employee, on_delete=models.PROTECT, related_name='identity_history')
    user = models.ForeignKey(User, on_delete=models.PROTECT, related_name='employee_link_history')
    actor = models.ForeignKey(User, on_delete=models.PROTECT, related_name='performed_employee_links')
    receipt = models.OneToOneField(MovementReceipt, on_delete=models.PROTECT, related_name='employee_link_history')
    reason = models.TextField()
    snapshot = models.JSONField()
    created_at = models.DateTimeField(auto_now_add=True)


# Every document-affecting relation changes the same monotonic revision.
def bump_conference_relation_revision(sender, instance, action, reverse, pk_set, **kwargs):
    from django.db.models import F
    if action not in {'post_add', 'post_remove', 'pre_clear'} or (action != 'pre_clear' and not pk_set):
        return
    field = next(f for f in Conference._meta.many_to_many if f.remote_field.through == sender)
    if field.remote_field.model == Asset:
        ids = set(getattr(instance, field.name).values_list('pk', flat=True)) if isinstance(instance, Conference) and action == 'pre_clear' else set(pk_set or []) if isinstance(instance, Conference) else {instance.pk}
        Asset.objects.filter(pk__in=ids).update(custody_revision=F('custody_revision') + 1)
    if isinstance(instance, Conference):
        Conference.objects.filter(pk=instance.pk).update(revision=F('revision') + 1)
        instance.refresh_from_db(fields=['revision'])
    elif pk_set:
        Conference.objects.filter(pk__in=pk_set).update(revision=F('revision') + 1)
    elif action == 'pre_clear':
        field = next(f for f in Conference._meta.many_to_many if f.remote_field.through == sender)
        ids = getattr(instance, field.remote_field.related_name).values_list('pk', flat=True)
        Conference.objects.filter(pk__in=list(ids)).update(revision=F('revision') + 1)


for _field_name in ('assets', 'crosscheck_assets', 'staged_assets', 'challan_assets', 'requirements', 'assigned_employees'):
    m2m_changed.connect(bump_conference_relation_revision, sender=Conference._meta.get_field(_field_name).remote_field.through,
                        dispatch_uid=f'conference_revision_{_field_name}')


@receiver(m2m_changed, sender=TruckChallan.assets.through)
def bump_truck_membership_revision(sender, instance, action, reverse, pk_set, **kwargs):
    from django.db.models import F
    if action not in {'post_add', 'post_remove', 'pre_clear'} or (action != 'pre_clear' and not pk_set):
        return
    asset_ids = set(instance.assets.values_list('pk', flat=True)) if isinstance(instance, TruckChallan) and action == 'pre_clear' else set(pk_set or []) if isinstance(instance, TruckChallan) else {instance.pk}
    Asset.objects.filter(pk__in=asset_ids).update(custody_revision=F('custody_revision') + 1)
    if isinstance(instance, TruckChallan):
        ids = [instance.conference_id]
    elif pk_set:
        ids = TruckChallan.objects.filter(pk__in=pk_set).values_list('conference_id', flat=True)
    else:
        ids = instance.truck_challans.values_list('conference_id', flat=True)
    Conference.objects.filter(pk__in=list(ids)).update(revision=F('revision') + 1)


@receiver(post_save, sender=TruckChallan)
@receiver(models.signals.post_delete, sender=TruckChallan)
def bump_truck_document_revision(sender, instance, **kwargs):
    from django.db.models import F
    Conference.objects.filter(pk=instance.conference_id).update(revision=F('revision') + 1)


class ProgramDelivery(models.Model):
    """An issued delivery's immutable customer and supplier paper snapshots.

    These are documents, not a second warehouse movement or a rental invoice.
    No live asset/company foreign keys are used inside the snapshots.
    """
    conference = models.ForeignKey(Conference, on_delete=models.PROTECT, related_name='issued_deliveries')
    request_key = models.UUIDField(unique=True)
    request_hash = models.CharField(max_length=64)
    reference = models.CharField(max_length=100)
    snapshot = models.JSONField(default=dict)
    issued_at = models.DateTimeField(auto_now_add=True)
    issued_by = models.CharField(max_length=150)
    voided_at = models.DateTimeField(null=True, blank=True)
    voided_by = models.CharField(max_length=150, blank=True, default='')
    void_reason = models.CharField(max_length=500, blank=True, default='')

    class Meta:
        ordering = ['-id']
        constraints = [models.UniqueConstraint(fields=['conference', 'reference'], name='unique_program_delivery_reference')]
