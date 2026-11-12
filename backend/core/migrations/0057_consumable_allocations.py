from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [('core', '0056_bulk_quantity_allocations')]
    operations = [
        migrations.CreateModel(name='ConsumableAllocation', fields=[
            ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
            ('requested', models.PositiveIntegerField(default=0)),
            ('returned', models.PositiveIntegerField(blank=True, null=True)),
            ('consumed', models.PositiveIntegerField(default=0)),
            ('state', models.CharField(choices=[('reserved', 'Reserved'), ('dispatched', 'Dispatched'), ('settled', 'Settled')], default='reserved', max_length=20)),
            ('asset', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='consumable_allocations', to='core.asset')),
            ('conference', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='consumable_allocations', to='core.conference')),
        ]),
        migrations.AddConstraint(model_name='consumableallocation', constraint=models.UniqueConstraint(fields=('asset', 'conference'), name='unique_consumable_event_asset')),
        migrations.CreateModel(name='ConsumableMovement', fields=[
            ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
            ('action', models.CharField(max_length=30)), ('before', models.JSONField()), ('after', models.JSONField()),
            ('stock_before', models.PositiveIntegerField()), ('stock_after', models.PositiveIntegerField()),
            ('created_at', models.DateTimeField(auto_now_add=True)),
            ('allocation', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='movements', to='core.consumableallocation')),
            ('receipt', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='consumable_movements', to='core.movementreceipt')),
        ]),
    ]
