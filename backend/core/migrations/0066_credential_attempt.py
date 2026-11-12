from django.db import migrations, models

class Migration(migrations.Migration):
    dependencies = [('core','0065_external_supplier_balances')]
    operations = [migrations.CreateModel(name='CredentialAttempt',fields=[
        ('key',models.CharField(max_length=64,primary_key=True,serialize=False)),
        ('attempts',models.PositiveIntegerField(default=0)),
        ('expires_at',models.DateTimeField(db_index=True)),
    ])]
