from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('core', '0070_quantity_venue_transfers')]
    operations = [
        migrations.CreateModel(
            name='ChallanArchiveFile',
            fields=[
                ('sha256', models.CharField(max_length=64, primary_key=True, serialize=False)),
                ('content_type', models.CharField(max_length=32)),
                ('content', models.BinaryField()),
            ],
        ),
    ]
