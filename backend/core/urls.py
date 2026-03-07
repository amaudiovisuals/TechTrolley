from django.urls import path
from . import views
from . import auth_views
from . import user_views
from . import conference_views
from . import profile_view

urlpatterns = [
    # API endpoints or views
    path('login/', auth_views.custom_login, name='api_login'),
    path('my-profile/', profile_view.get_my_profile, name='get_my_profile'),
    path('change-password/', user_views.change_password, name='change_password'),
    path('system-users/', user_views.system_user_list, name='system_user_list'),
    path('system-users/<int:pk>/', user_views.system_user_delete, name='system_user_delete'),
    
    path('conferences/', conference_views.conference_list, name='conference_list'),
    path('conferences/<int:pk>/', conference_views.conference_detail, name='conference_detail'),
    
    path('dashboard/', views.dashboard, name='dashboard'),
    path('assets/', views.asset_list, name='asset_list'),
    path('assets/<int:pk>/', views.asset_detail, name='asset_detail'),
    path('assets/<int:pk>/sub-assets/', views.asset_sub_assets, name='asset_sub_assets'),
    path('assets/<int:pk>/sub-assets/<int:child_pk>/', views.asset_sub_asset_remove, name='asset_sub_asset_remove'),
    path('employees/', views.employee_list, name='employee_list'),
    path('employees/<int:pk>/', views.employee_detail, name='employee_detail'),
    path('company-settings/', views.company_settings, name='company_settings'),
    path('upload-assets/', views.bulk_upload_assets, name='bulk_upload_assets'),
    path('download-template/', views.download_asset_template, name='download_asset_template'),
]

