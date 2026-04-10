
from django.db import models
from django.core.validators import MinValueValidator
from decimal import Decimal

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
        ('Other', 'Other'),
    ]

    sku = models.CharField(max_length=100, db_index=True)
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
    current_venue = models.CharField(max_length=200, null=True, blank=True)
    return_date = models.DateField(null=True, blank=True)
    assigned_to = models.ForeignKey('Employee', on_delete=models.SET_NULL, null=True, blank=True, related_name='assets')
    parent_asset = models.ForeignKey('self', on_delete=models.SET_NULL, null=True, blank=True, related_name='sub_assets')
    
    # Deprecated fields (will be removed after migration)
    # name, brand, model_number are now part of description or alias_name in the new structure
    name = models.CharField(max_length=200, blank=True, default='')
    brand = models.CharField(max_length=100, blank=True, default='')
    model_number = models.CharField(max_length=100, blank=True, default='')

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
    assigned_employees = models.ManyToManyField(Employee, blank=True, related_name='assigned_conferences')
    pdf_document = models.FileField(upload_to='conference_pdfs/', null=True, blank=True)
    # approximate_value = models.DecimalField(max_digits=20, decimal_places=2, default=0, null=True, blank=True)

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
            if self.logo:
                existing.logo = self.logo
            existing.powered_by_name = self.powered_by_name
            existing.dashboard_config = self.dashboard_config
            existing.theme_template = self.theme_template
            return existing.save()
        return super(CompanySettings, self).save(*args, **kwargs)

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
    if not pk_set:
        return
    if action == 'post_add':
        Asset.objects.filter(pk__in=pk_set).update(status='In Use')
    elif action in ('post_remove', 'pre_clear'):
        # PERFORMANCE OPTIMIZATION: One bulk query instead of a loop
        others_using = set(Conference.objects.exclude(pk=instance.pk).filter(assets__in=pk_set).values_list('assets__id', flat=True))
        crosscheck_using = set(Conference.objects.filter(crosscheck_assets__in=pk_set).values_list('crosscheck_assets__id', flat=True))
        
        to_revert = [aid for aid in pk_set if aid not in others_using and aid not in crosscheck_using]
        if to_revert:
            Asset.objects.filter(pk__in=to_revert).exclude(status='Damaged').update(status='Available')

@receiver(m2m_changed, sender=Conference.crosscheck_assets.through)
def update_asset_status_on_crosscheck_change(sender, instance, action, pk_set, **kwargs):
    if not pk_set:
        return
    if action == 'post_add':
        Asset.objects.filter(pk__in=pk_set).update(status='Crosscheck')
    elif action in ('post_remove', 'pre_clear'):
        # PERFORMANCE OPTIMIZATION: One bulk query instead of a loop
        actual_using = set(Conference.objects.filter(assets__in=pk_set).values_list('assets__id', flat=True))
        others_cc_using = set(Conference.objects.exclude(pk=instance.pk).filter(crosscheck_assets__in=pk_set).values_list('crosscheck_assets__id', flat=True))
        
        to_revert = [aid for aid in pk_set if aid not in actual_using and aid not in others_cc_using]
        if to_revert:
            Asset.objects.filter(pk__in=to_revert).exclude(status='Damaged').update(status='Available')
