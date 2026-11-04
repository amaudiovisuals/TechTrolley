from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [('core', '0053_alter_userprofile_role'), migrations.swappable_dependency(settings.AUTH_USER_MODEL)]
    operations = [
        migrations.AddField(model_name='conference', name='revision', field=models.PositiveBigIntegerField(default=0, editable=False)),
        migrations.CreateModel(name='MovementReceipt', fields=[
            ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
            ('request_id', models.UUIDField()),
            ('payload_hash', models.CharField(max_length=64)),
            ('result', models.JSONField(default=dict)),
            ('created_at', models.DateTimeField(auto_now_add=True)),
            ('actor', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, to=settings.AUTH_USER_MODEL)),
        ], options={'constraints': [models.UniqueConstraint(fields=('actor', 'request_id'), name='unique_actor_movement_request')]}),
    ]
