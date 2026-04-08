from django.db import migrations, models

def migrate_categories(apps, schema_editor):
    Asset = apps.get_model('core', 'Asset')
    mapping = {
        'Sound System': ['Speakers & Audio', 'Audio Mixers', 'Microphones'],
        'IT & Networking': ['Laptops', 'Smartphones', 'Computers & Servers', 'Peripherals', 'UPS & Power', 'Printers'],
        'Display System': ['Monitors', 'TVs', 'Projectors'],
        'AV Equipment': ['Video Switchers', 'Capture Cards', 'Cameras'],
        'Cable and consumables': ['Splitters & Converters', 'Consumables'],
        'Lighting & Effects': ['Lighting & LED']
    }
    reverse_map = {}
    for new_cat, old_cats in mapping.items():
        for old_cat in old_cats:
            reverse_map[old_cat.lower()] = new_cat

    for asset in Asset.objects.all():
        try:
            old_type = asset.type.strip().lower()
            if old_type in reverse_map:
                asset.type = reverse_map[old_type]
                asset.save()
        except Exception:
            pass

class Migration(migrations.Migration):

    dependencies = [
        ('core', '0028_alter_asset_status'),
    ]

    operations = [
        migrations.AlterField(
            model_name='asset',
            name='type',
            field=models.CharField(
                choices=[
                    ('IT & Networking', 'IT & Networking'),
                    ('AV Equipment', 'AV Equipment'),
                    ('Sound System', 'Sound System'),
                    ('Display System', 'Display System'),
                    ('Cable and consumables', 'Cable and consumables'),
                    ('Lighting & Effects', 'Lighting & Effects'),
                    ('Other', 'Other')
                ],
                default='Other',
                max_length=100
            ),
        ),
        migrations.RunPython(migrate_categories, reverse_code=migrations.RunPython.noop),
    ]
