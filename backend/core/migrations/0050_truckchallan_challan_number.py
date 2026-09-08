from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0049_companysettings_challan_prefix_fy'),
    ]

    operations = [
        migrations.AddField(
            model_name='truckchallan',
            name='challan_number',
            field=models.CharField(
                blank=True,
                default='',
                max_length=50,
                help_text="Auto-assigned unique challan number for this truck (e.g. '26-27/AMDL-00123')",
            ),
        ),
    ]
