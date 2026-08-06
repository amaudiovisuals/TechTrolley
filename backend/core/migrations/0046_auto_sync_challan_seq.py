from django.db import migrations

def sync_next_challan_number(apps, schema_editor):
    CompanySettings = apps.get_model('core', 'CompanySettings')
    Conference = apps.get_model('core', 'Conference')
    
    settings_obj = CompanySettings.objects.first()
    if not settings_obj:
        return

    highest = 999
    for conf in Conference.objects.all():
        val = conf.challan_number or (str(1000 + conf.id) if conf.id else '')
        if str(val).isdigit():
            num = int(val)
            if num > highest:
                highest = num
                
    if highest >= settings_obj.next_challan_number:
        settings_obj.next_challan_number = highest + 1
        settings_obj.save(update_fields=['next_challan_number'])

class Migration(migrations.Migration):
    dependencies = [
        ('core', '0045_companysettings_next_challan_number'),
    ]

    operations = [
        migrations.RunPython(sync_next_challan_number, migrations.RunPython.noop),
    ]
