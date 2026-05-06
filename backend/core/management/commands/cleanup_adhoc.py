
import os
import django
from django.core.management.base import BaseCommand
from django.db.models import Count

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from core.models import Asset, Conference

class Command(BaseCommand):
    help = 'Delete all ad‑hoc assets and deduplicate assets in the production DB.'

    def handle(self, *args, **options):
        # 1. Reset "In Use" status for assets not linked to any conference
        assigned_ids = set(Conference.objects.values_list('assets', flat=True))
        in_use_but_not_assigned = Asset.objects.filter(status='In Use').exclude(id__in=assigned_ids)
        count_reset = in_use_but_not_assigned.update(status='Available')
        self.stdout.write(self.style.SUCCESS(f"Reset {count_reset} 'In Use' assets to 'Available'."))

        # 2. Delete ad‑hoc assets (SKU prefix)
        sku_deleted, _ = Asset.objects.filter(sku__startswith='ADHOC-').delete()
        self.stdout.write(self.style.SUCCESS(f"Deleted {sku_deleted} assets with SKU starting with 'ADHOC-'."))

        # 3. Delete assets that exist only via challan linkage
        challan_ids = set(Conference.objects.values_list('challan_assets', flat=True))
        linked_ids = set(Conference.objects.values_list('assets', flat=True)) | set(Conference.objects.values_list('staged_assets', flat=True))
        only_challan_qs = Asset.objects.filter(id__in=challan_ids).exclude(id__in=linked_ids)
        only_deleted, _ = only_challan_qs.delete()
        self.stdout.write(self.style.SUCCESS(f"Deleted {only_deleted} assets that were only in challans.") )

        # 4. Deduplicate by serial_number
        duplicates = Asset.objects.exclude(serial_number__exact='').exclude(serial_number__isnull=True).values('serial_number').annotate(count=Count('id')).filter(count__gt=1)
        total_deleted = 0
        for d in duplicates:
            serial = d['serial_number']
            assets = Asset.objects.filter(serial_number=serial).order_by('id')
            to_keep = assets.first()
            to_delete = assets.exclude(id=to_keep.id)
            count = to_delete.count()
            to_delete.delete()
            total_deleted += count
        self.stdout.write(self.style.SUCCESS(f"Deleted {total_deleted} duplicate assets by serial number."))

        total_now = Asset.objects.count()
        self.stdout.write(self.style.SUCCESS(f"Total assets remaining after cleanup: {total_now}"))
