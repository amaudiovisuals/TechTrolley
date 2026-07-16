
from django.db import models
from django.core.validators import MinValueValidator
from decimal import Decimal

class SubrentalCompany(models.Model):
    name = models.CharField(max_length=200)
    address = models.TextField(null=True, blank=True)
    gst_number = models.CharField(max_length=20, null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.name

class Asset(models.Model):
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
    subrental_company = models.ForeignKey(SubrentalCompany, on_delete=models.CASCADE, null=True, blank=True, related_name='assets')
    
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
        # Ensure QR Code is permanently embedded on creation/save if blank
        if not self.qr_code and self.sku:
            self.qr_code = self.sku
            
        # Automate Status Update based on Flag Selection
        if self.flag == 'Expired':
            self.status = 'Expired'
        elif self.flag == 'Required Service':
            self.status = 'Damaged'
        elif self.flag == 'On Service':
            self.status = 'On Service'
        elif self.flag == 'Missing':
            self.status = 'Missing'
        elif not self.flag:
            # When flag is cleared, reset special statuses to 'Available' 
            # but preserve 'In Use' or 'Crosscheck' if they were manually set
            if self.status in ['Expired', 'On Service', 'Missing', 'Damaged']:
                self.status = 'Available'
        
        super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.sku} - {self.alias_name or self.serial_number}"

class Employee(models.Model):
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

class Conference(models.Model):
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
    # J-109: Audit Mode — when True, assets in this conference do not lock other live events
    is_audit = models.BooleanField(default=False, help_text="If True, this conference is a non-blocking audit list. Its assets will not lock availability for other conferences.")

    def recalculate_related_asset_statuses(self):
        pk_set = set(self.assets.values_list('pk', flat=True))
        if not pk_set:
            return
            
        if self.is_audit:
            # Audit mode is now True: release assets if not used in other non-audit conferences
            others_using = set(
                Conference.objects
                .exclude(pk=self.pk)
                .exclude(is_audit=True)
                .filter(assets__in=pk_set)
                .values_list('assets__id', flat=True)
            )
            crosscheck_using = set(Conference.objects.filter(crosscheck_assets__in=pk_set).values_list('crosscheck_assets__id', flat=True))
            
            to_revert = [aid for aid in pk_set if aid not in others_using and aid not in crosscheck_using]
            if to_revert:
                Asset.objects.filter(pk__in=to_revert, status='In Use').update(status='Available')
        else:
            # Audit mode is now False: lock all assets in this conference
            Asset.objects.filter(pk__in=pk_set).update(status='In Use')

    def save(self, *args, **kwargs):
        is_new = self.pk is None
        old_is_audit = False
        if not is_new:
            try:
                old_is_audit = Conference.objects.values_list('is_audit', flat=True).get(pk=self.pk)
            except Conference.DoesNotExist:
                pass
                
        super().save(*args, **kwargs)
        
        # If is_audit was toggled, propagate status recalculation to its assets
        if not is_new and old_is_audit != self.is_audit:
            self.recalculate_related_asset_statuses()

    def __str__(self):
        return self.name

class DeliveryChallan(models.Model):
    challan_number = models.CharField(max_length=50, unique=True)
    conference = models.ForeignKey(Conference, on_delete=models.CASCADE)
    created_at = models.DateTimeField(auto_now_add=True)
    issued_by = models.CharField(max_length=100)

    def __str__(self):
        return self.challan_number

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
            existing.save()
            return
        super(CompanySettings, self).save(*args, **kwargs)

from django.contrib.auth.models import User
from django.db.models.signals import post_save
from django.dispatch import receiver

class UserProfile(models.Model):
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name='profile')
    ROLE_CHOICES = [
        ('admin', 'Admin'),
        ('godown_incharge', 'Godown Incharge'),
        ('technician', 'Technician'),
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

@receiver(m2m_changed, sender=Conference.assets.through)
def update_asset_status_on_assets_change(sender, instance, action, pk_set, **kwargs):
    # BUG J-2: When .clear() is called, Django fires 'pre_clear' with pk_set=None.
    # We must snapshot the current relationship BEFORE Django wipes it.
    if action == 'pre_clear':
        pk_set = set(instance.assets.values_list('pk', flat=True))

    if not pk_set:
        return

    if action == 'post_add':
        # J-110: Audit conferences are non-blocking — do NOT stamp assets as 'In Use'
        # when the holding conference is an audit list. This prevents the phantom lock
        # where asset.status === 'In Use' short-circuits LOCK 3 in the frontend even
        # though the .isAudit bypass would have cleared it.
        if not instance.is_audit:
            # Intentional bypass of Asset.save() flag logic for bulk performance
            Asset.objects.filter(pk__in=pk_set).update(status='In Use')
    elif action in ('post_remove', 'pre_clear'):
        # PERFORMANCE OPTIMIZATION: One bulk query instead of a loop
        # J-110: Exclude audit conferences from the 'others_using' check so that
        # removing an asset from a real conference isn't blocked by an audit holder.
        others_using = set(
            Conference.objects
            .exclude(pk=instance.pk)
            .exclude(is_audit=True)  # J-110: audit conferences don't count as real holders
            .filter(assets__in=pk_set)
            .values_list('assets__id', flat=True)
        )
        crosscheck_using = set(Conference.objects.filter(crosscheck_assets__in=pk_set).values_list('crosscheck_assets__id', flat=True))
        
        to_revert = [aid for aid in pk_set if aid not in others_using and aid not in crosscheck_using]
        if to_revert:
            # Intentional bypass of Asset.save() flag logic for bulk performance
            Asset.objects.filter(pk__in=to_revert).exclude(status='Damaged').update(status='Available')

@receiver(m2m_changed, sender=Conference.crosscheck_assets.through)
def update_asset_status_on_crosscheck_change(sender, instance, action, pk_set, **kwargs):
    # BUG J-2: When .clear() is called, Django fires 'pre_clear' with pk_set=None.
    # We must snapshot the current relationship BEFORE Django wipes it.
    if action == 'pre_clear':
        pk_set = set(instance.crosscheck_assets.values_list('pk', flat=True))

    if not pk_set:
        return

    if action == 'post_add':
        # Intentional bypass of Asset.save() flag logic for bulk performance
        Asset.objects.filter(pk__in=pk_set).update(status='Crosscheck')
    elif action in ('post_remove', 'pre_clear'):
        # PERFORMANCE OPTIMIZATION: One bulk query instead of a loop
        actual_using = set(Conference.objects.filter(assets__in=pk_set).values_list('assets__id', flat=True))
        others_cc_using = set(Conference.objects.exclude(pk=instance.pk).filter(crosscheck_assets__in=pk_set).values_list('crosscheck_assets__id', flat=True))
        
        to_revert = [aid for aid in pk_set if aid not in actual_using and aid not in others_cc_using]
        if to_revert:
            # Intentional bypass of Asset.save() flag logic for bulk performance
            Asset.objects.filter(pk__in=to_revert).exclude(status='Damaged').update(status='Available')

