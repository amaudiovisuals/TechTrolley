from django.contrib import admin
from .models import Asset, Employee

@admin.register(Asset)
class AssetAdmin(admin.ModelAdmin):
    list_display = ('sku', 'alias_name', 'serial_number', 'type', 'status', 'formatted_price', 'assigned_to_name')
    list_filter = ('type', 'status', 'condition', 'is_barcode_added')
    search_fields = ('sku', 'alias_name', 'serial_number', 'mac_address', 'imei_number_1', 'imei_number_2', 'description')
    readonly_fields = ('assigned_to_name', 'formatted_price')

    def assigned_to_name(self, obj):
        return obj.assigned_to.name if obj.assigned_to else '-'
    assigned_to_name.short_description = 'Assigned To'

    def formatted_price(self, obj):
        try:
            return f'₹{float(obj.item_price):,.2f}'
        except (TypeError, ValueError):
            return '₹0.00'
    formatted_price.short_description = 'Item Price'


@admin.register(Employee)
class EmployeeAdmin(admin.ModelAdmin):
    list_display = ('name', 'employee_id', 'department', 'email', 'phone')
    search_fields = ('name', 'employee_id', 'email')
    list_filter = ('department',)
