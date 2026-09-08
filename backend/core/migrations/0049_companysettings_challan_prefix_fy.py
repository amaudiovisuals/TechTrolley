from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0048_alter_userprofile_role_truckchallan'),
    ]

    operations = [
        migrations.AddField(
            model_name='companysettings',
            name='challan_prefix',
            field=models.CharField(
                blank=True,
                default='AMDL',
                max_length=20,
                help_text="Fixed prefix in challan number (e.g. 'AMDL' -> '26-27/AMDL-00122')",
            ),
        ),
        migrations.AddField(
            model_name='companysettings',
            name='challan_fy',
            field=models.CharField(
                blank=True,
                default='',
                max_length=10,
                help_text="Financial year the current sequence counter belongs to (e.g. '26-27'). Auto-resets on April 1.",
            ),
        ),
    ]
