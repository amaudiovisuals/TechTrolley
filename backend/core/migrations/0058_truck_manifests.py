import uuid
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [('core', '0057_consumable_allocations')]
    operations = [
        migrations.CreateModel(name='TruckManifest', fields=[
            ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
            ('conference', models.OneToOneField(on_delete=django.db.models.deletion.PROTECT, related_name='truck_manifest', to='core.conference')),
            ('master', models.OneToOneField(on_delete=django.db.models.deletion.PROTECT, related_name='manifest', to='core.challandocument')),
        ]),
        migrations.CreateModel(name='TruckManifestEntry', fields=[
            ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
            ('quantity', models.PositiveIntegerField(default=0)),
            ('document_line_id', models.UUIDField(default=uuid.uuid4, unique=True)),
            ('manifest', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='entries', to='core.truckmanifest')),
            ('master_line', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='manifest_entries', to='core.challanline')),
            ('truck', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='manifest_entries', to='core.truckchallan')),
        ]),
        migrations.AddConstraint(model_name='truckmanifestentry', constraint=models.UniqueConstraint(fields=('master_line', 'truck'), name='unique_manifest_source_truck')),
    ]
