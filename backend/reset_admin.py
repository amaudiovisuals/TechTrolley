import os
import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
django.setup()

from django.contrib.auth import get_user_model

User = get_user_model()

username = "admin"
password = "Nihal123@"
email = "nihal@amaudiovisuals.com"

try:
    user = User.objects.get(username=username)
    user.set_password(password)
    user.email = email
    user.save()
    print(f"User '{username}' updated: Password set to '{password}', Email set to '{email}'.")
except User.DoesNotExist:
    User.objects.create_superuser(username, email, password)
    print(f"User '{username}' created with password '{password}' and email '{email}'.")
