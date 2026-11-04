"""
URL configuration for config project.

The `urlpatterns` list routes URLs to views. For more information please see:
    https://docs.djangoproject.com/en/6.0/topics/http/urls/
Examples:
Function views
    1. Add an import:  from my_app import views
    2. Add a URL to urlpatterns:  path('', views.home, name='home')
Class-based views
    1. Add an import:  from other_app.views import Home
    2. Add a URL to urlpatterns:  path('', Home.as_view(), name='home')
Including another URLconf
    1. Import the include() function: from django.urls import include, path
    2. Add a URL to urlpatterns:  path('blog/', include('blog.urls'))
"""
from django.conf import settings
from django.contrib import admin
from django.urls import path, include
from django.http import JsonResponse

def home(request):
    return JsonResponse({"message": "Backend is running successfully!"})

urlpatterns = [
    path('', home),
    path('api/', include('core.urls')),
]

# Business administrators use the scoped application screens. Keep the generic
# Django admin outside secure web runtimes so it cannot bypass API login budgets.
if getattr(settings, 'RUNTIME_ENVIRONMENT', None) == 'development':
    urlpatterns.append(path('admin/', admin.site.urls))

# Uploaded event documents are private even in development. Do not add a blanket
# media route or a reverse-proxy media alias; branding has one explicit endpoint.
