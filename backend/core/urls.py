from . import program_deliveries, address_book, led_cases
from .asset_commands import asset_commands
from .offline_packages import offline_package
from .quantity_commands import quantity_commands
from .quantity_transfers import quantity_transfers
from .consumable_commands import consumable_commands
from .truck_manifests import manifest_commands
from django.urls import path
from . import views
from .saved_work_views import check_saved_work
from .private_media import public_logo
from . import auth_views
from . import user_views
from . import conference_views
from . import profile_view
from . import inventory_ownership
from . import ownership_commands
from . import supplier_commands
from .supplier_balances import supplier_history
from . import subrental_views
from . import subrental_ticket_views
from . import transfer_views
from . import truck_views
from . import ai_views
from .challan_documents import challan_document, challan_history
from .challan_archive_files import archived_challan_logo, archived_challan_pdf
from . import staff_commands, event_lifecycle, reconciliation_commands

urlpatterns = [
    path('assets/batch-preview/', views.equipment_batch_preview, name='equipment_batch_preview'),
    path('assets/<int:pk>/led-case-conversion/', led_cases.conversion_review, name='led_case_conversion'),
    path('saved-customers/', address_book.customers, name='saved_customers'),
    path('saved-customers/<int:pk>/', address_book.customer_detail, name='saved_customer'),
    path('saved-venues/', address_book.venues, name='saved_venues'),
    path('saved-venues/<int:pk>/', address_book.venue_detail, name='saved_venue'),
    path('conferences/<int:pk>/deliveries/', program_deliveries.program_deliveries, name='program_deliveries'),
    path('conferences/<int:pk>/deliveries/preview/', program_deliveries.delivery_preview, name='delivery_preview'),
    path('conferences/<int:pk>/deliveries/<int:delivery_pk>/void/', program_deliveries.void_delivery, name='void_delivery'),

    path('conferences/<int:pk>/offline-package/', offline_package, name='offline_package'),
    path('subrental-ticket-items/<int:item_id>/supplier-history/', supplier_history, name='supplier_history'),
    path('ownership/preview/', ownership_commands.ownership_preview, name='ownership_preview'),
    path('ownership/commands/', ownership_commands.ownership_commands, name='ownership_commands'),
    path('ownership/history/<uuid:history_id>/', ownership_commands.ownership_history, name='ownership_history'),
    path('reconciliation/current-state/', reconciliation_commands.reconciliation_current_state, name='reconciliation_current_state'),
    path('reconciliation/preview/', reconciliation_commands.reconciliation_preview, name='reconciliation_preview'),
    path('reconciliation/commands/', reconciliation_commands.reconciliation_commands, name='reconciliation_commands'),
    path('conferences/<int:pk>/reconciliation-review/', reconciliation_commands.event_reconciliation_review, name='event_reconciliation_review'),
    path('conferences/<int:pk>/lifecycle-review/', event_lifecycle.lifecycle_review, name='lifecycle_review'),
    path('conferences/<int:pk>/lifecycle-commands/', event_lifecycle.lifecycle_commands, name='lifecycle_commands'),
    path('staff-commands/', staff_commands.staff_commands, name='staff_commands'),
    path('employee-link-commands/', staff_commands.employee_link_commands, name='employee_link_commands'),
    path('employee-link-context/', staff_commands.employee_link_context, name='employee_link_context'),
    path('staff-issue-candidates/', views.staff_issue_candidates, name='staff_issue_candidates'),
    path('employee-allocations/<int:pk>/history/', staff_commands.staff_history, name='staff_history'),
    path('conferences/<int:pk>/custody-review/', conference_views.conference_custody_review, name='conference_custody_review'),
    path('conferences/<int:pk>/manifest-commands/', manifest_commands, name='manifest_commands'),
    path('conferences/<int:pk>/consumable-commands/', consumable_commands, name='consumable_commands'),
    path('conferences/<int:pk>/quantity-commands/', quantity_commands, name='quantity_commands'),
    path('conferences/<int:pk>/quantity-transfers/', quantity_transfers, name='quantity_transfers'),
    path('conferences/<int:pk>/challan-documents/<str:scope>/', challan_document, name='challan_document'),
    path('challan-documents/<uuid:document_id>/history/', challan_history, name='challan_history'),
    path('challan-documents/<uuid:document_id>/original-pdf/', archived_challan_pdf, name='archived_challan_pdf'),
    path('challan-documents/<uuid:document_id>/original-return-pdf/', archived_challan_pdf, {'direction': 'return'}, name='archived_return_challan_pdf'),
    path('challan-logos/<str:sha256>/', archived_challan_logo, name='archived_challan_logo'),
    path('conferences/<int:pk>/asset-commands/', asset_commands, name='asset_commands'),
    # API endpoints or views
    path('ai-assistant/', ai_views.ai_assistant_chat, name='ai_assistant'),
    path('saved-work/recovery-check/', check_saved_work, name='saved_work_recovery_check'),
    path('public-logo/', public_logo, name='public_logo'),
    path('login/', auth_views.custom_login, name='api_login'),
    path('logout/', auth_views.server_logout, name='api_logout'),
    path('my-profile/', profile_view.get_my_profile, name='get_my_profile'),
    path('change-password/', user_views.change_password, name='change_password'),
    path('system-users/', user_views.system_user_list, name='system_user_list'),
    path('system-users/<int:pk>/', user_views.system_user_delete, name='system_user_delete'),
    path('users/role/', user_views.update_user_role, name='update_user_role'),
    path('users/reset-password/', user_views.admin_reset_password, name='admin_reset_password'),
    
    path('conferences/', conference_views.conference_list, name='conference_list'),
    path('conferences/<int:pk>/', conference_views.conference_detail, name='conference_detail'),
    path('conferences/<int:pk>/transfer-assets/', transfer_views.asset_transfer, name='asset_transfer'),
    path('conferences/<int:pk>/trucks/', truck_views.conference_trucks, name='conference_trucks'),
    path('conferences/<int:pk>/trucks/add-to-truck/', truck_views.add_asset_to_truck, name='add_asset_to_truck'),
    path('conferences/<int:pk>/trucks/add-to-truck1/', truck_views.add_asset_to_truck1, name='add_asset_to_truck1'),
    path('conferences/<int:pk>/release-audit-locks/', truck_views.release_audit_conference_locks, name='release_audit_locks'),
    path('truck-challans/<int:truck_pk>/', truck_views.truck_challan_detail, name='truck_challan_detail'),
    path('truck-challans/<int:truck_pk>/transfer/', truck_views.truck_transfer_assets, name='truck_transfer_assets'),
    
    path('dashboard/', views.dashboard, name='dashboard'),
    path('asset-stats/', views.asset_stats, name='asset_stats'),
    path('employee-allocations/', views.employee_allocations, name='employee_allocations'),
    path('aliases/', views.unique_aliases, name='unique_aliases'),
    path('assets/', views.asset_list, name='asset_list'),
    path('assets/<int:pk>/', views.asset_detail, name='asset_detail'),
    path('assets/<int:pk>/sub-assets/', views.asset_sub_assets, name='asset_sub_assets'),
    path('assets/<int:pk>/sub-assets/<int:child_pk>/', views.asset_sub_asset_remove, name='asset_sub_asset_remove'),
    path('assets/<int:pk>/assign-quantity/', views.asset_assign_quantity, name='asset_assign_quantity'),
    path('employees/', views.employee_list, name='employee_list'),
    path('employees/<int:pk>/', views.employee_detail, name='employee_detail'),
    path('company-settings/', views.company_settings, name='company_settings'),
    path('upload-assets/', views.bulk_upload_assets, name='bulk_upload_assets'),
    path('download-template/', views.download_asset_template, name='download_asset_template'),
    path('conferences/<int:conference_id>/download-pdf/', views.download_conference_pdf, name='download_conference_pdf'),
    path('export-inventory/', views.export_inventory, name='export_inventory'),
    path('system-recovery/', views.system_recovery, name='system_recovery'),
    
    path('inventory-ownership/', inventory_ownership.ownership_summary, name='inventory_ownership'),
    path('supplier-commands/', supplier_commands.supplier_commands, name='supplier_commands'),
    path('subrental-companies/', subrental_views.subrental_company_list, name='subrental_company_list'),
    path('subrental-companies/<int:pk>/', subrental_views.subrental_company_detail, name='subrental_company_detail'),
    
    path('subrental-tickets/', subrental_ticket_views.subrental_ticket_list, name='subrental_ticket_list'),
    path('subrental-tickets/<int:pk>/', subrental_ticket_views.subrental_ticket_detail, name='subrental_ticket_detail'),
    path('subrental-tickets/<int:ticket_pk>/add-item/', subrental_ticket_views.add_ticket_item, name='add_ticket_item'),
    path('subrental-ticket-items/<int:pk>/', subrental_ticket_views.ticket_item_detail, name='ticket_item_detail'),
]
