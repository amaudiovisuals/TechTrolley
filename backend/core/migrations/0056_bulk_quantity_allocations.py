from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [('core', '0055_durable_challan_documents')]
    operations = [
        migrations.AddField(model_name='asset', name='quantity_tracking', field=models.BooleanField(default=False, editable=False)),
        migrations.CreateModel(name='QuantityAllocation', fields=[
            ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
            ('reserved', models.PositiveIntegerField(default=0)),
            ('dispatched', models.PositiveIntegerField(default=0)),
            ('awaiting_verification', models.PositiveIntegerField(default=0)),
            ('dispatched_total', models.PositiveBigIntegerField(default=0)),
            ('verified_total', models.PositiveBigIntegerField(default=0)),
            ('asset', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='quantity_allocations', to='core.asset')),
            ('conference', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='quantity_allocations', to='core.conference')),
        ]),
        migrations.AddConstraint(model_name='quantityallocation', constraint=models.UniqueConstraint(fields=('asset', 'conference'), name='unique_quantity_event_asset')),
        migrations.CreateModel(name='QuantityMovement', fields=[
            ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
            ('action', models.CharField(max_length=30)),
            ('quantity', models.PositiveIntegerField()),
            ('before', models.JSONField()), ('after', models.JSONField()),
            ('created_at', models.DateTimeField(auto_now_add=True)),
            ('allocation', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='movements', to='core.quantityallocation')),
            ('receipt', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='quantity_movements', to='core.movementreceipt')),
        ]),
    ]
