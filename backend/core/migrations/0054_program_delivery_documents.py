from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [('core', '0053_alter_userprofile_role')]
    operations = [
        migrations.CreateModel(
            name='ProgramDelivery',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('request_key', models.UUIDField(unique=True)),
                ('request_hash', models.CharField(max_length=64)),
                ('reference', models.CharField(max_length=100)),
                ('snapshot', models.JSONField(default=dict)),
                ('issued_at', models.DateTimeField(auto_now_add=True)),
                ('issued_by', models.CharField(max_length=150)),
                ('voided_at', models.DateTimeField(blank=True, null=True)),
                ('voided_by', models.CharField(blank=True, default='', max_length=150)),
                ('void_reason', models.CharField(blank=True, default='', max_length=500)),
                ('conference', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='issued_deliveries', to='core.conference')),
            ],
            options={'ordering': ['-id']},
        ),
        migrations.AddConstraint(model_name='programdelivery', constraint=models.UniqueConstraint(fields=('conference', 'reference'), name='unique_program_delivery_reference')),
    ]
