from django.urls import path
from . import views
from . import auth_views
from . import user_views
from . import conference_views
from . import profile_view
from . import subrental_views
from . import subrental_ticket_views

urlpatterns = [
    # API endpoints or views
    path('login/', auth_views.custom_login, name='api_login'),
    path('my-profile/', profile_view.get_my_profile, name='get_my_profile'),
    path('change-password/', user_views.change_password, name='change_password'),
    path('system-users/', user_views.system_user_list, name='system_user_list'),
    path('system-users/<int:pk>/', user_views.system_user_delete, name='system_user_delete'),
    path('users/role/', user_views.update_user_role, name='update_user_role'),
    
    path('conferences/', conference_views.conference_list, name='conference_list'),
    path('conferences/<int:pk>/', conference_views.conference_detail, name='conference_detail'),
    
    path('dashboard/', views.dashboard, name='dashboard'),
    path('asset-stats/', views.asset_stats, name='asset_stats'),
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
    path('ad-hoc-cleanup/', views.ad_hoc_cleanup, name='ad_hoc_cleanup'),
    path('nuke-ghosts/', views.nuke_ghosts, name='nuke_ghosts'),
    
    path('subrental-companies/', subrental_views.subrental_company_list, name='subrental_company_list'),
    path('subrental-companies/<int:pk>/', subrental_views.subrental_company_detail, name='subrental_company_detail'),
    
    path('subrental-tickets/', subrental_ticket_views.subrental_ticket_list, name='subrental_ticket_list'),
    path('subrental-tickets/<int:pk>/', subrental_ticket_views.subrental_ticket_detail, name='subrental_ticket_detail'),
    path('subrental-tickets/<int:ticket_pk>/add-item/', subrental_ticket_views.add_ticket_item, name='add_ticket_item'),
    path('subrental-ticket-items/<int:pk>/', subrental_ticket_views.ticket_item_detail, name='ticket_item_detail'),
]

