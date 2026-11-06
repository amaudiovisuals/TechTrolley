"""Inventory owner is separate from shared physical stock and external rentals."""
from django.db import transaction
from django.db.models import Count, Q
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from .models import Asset, SubrentalCompany, CompanySettings
from .asset_commands import CommandError


def warehouse_managed(asset):
    return asset.stock_kind != 'led_case' and not asset.is_temporary and (asset.subrental_company_id is None or asset.subrental_company.inventory_mode == 'shared_warehouse')


def require_warehouse_quantity_source(asset):
    if asset.staff_allocations.filter(returned_at__isnull=True).exists():
        raise CommandError('unavailable_or_staff_allocated', details=[{'asset_id':asset.pk}])
    if not warehouse_managed(asset):
        raise CommandError('supplier_inventory_classification_required', details=[{
            'asset_id':asset.pk, 'supplier_id':asset.subrental_company_id,
            'inventory_mode':asset.subrental_company.inventory_mode if asset.subrental_company_id else 'main_company'}])
    # Old tickets do not prove how many units are still owed to another supplier.
    # Do not treat their catalogue/order quantities as a second warehouse balance.
    if asset.subrental_company_id and asset.ticket_items.exists():
        raise CommandError('supplier_ticket_quantity_requires_review', details=[{'asset_id':asset.pk}])


def inventory_summary():
    aggregates = Asset.objects.filter(is_temporary=False).exclude(stock_kind='led_case').values('subrental_company_id').annotate(
        records=Count('pk'), available_status_records=Count('pk',filter=Q(status='Available')),
        in_use_status_records=Count('pk',filter=Q(status='In Use')),
        crosscheck_status_records=Count('pk',filter=Q(status='Crosscheck')),
        restricted_records=Count('pk',filter=Q(flag__in=['Missing','On Service','Expired','Required Service'])|Q(condition='Damaged')|Q(status__in=['Missing','Damaged','On Service','Expired'])),
        bulk_records=Count('pk',filter=(Q(quantity_tracking=True)|~Q(quantity=1))&~Q(type='Consumables')),
        consumable_records=Count('pk',filter=Q(type='Consumables')))
    fields=('records','available_status_records','in_use_status_records','crosscheck_status_records','restricted_records','bulk_records','consumable_records')
    counts={row['subrental_company_id']:{key:row[key] for key in fields} for row in aggregates}
    settings=CompanySettings.objects.first();blank={key:0 for key in fields}
    rows=[{'owner_id':None,'owner_name':settings.name if settings else 'Main company','inventory_mode':'main_company',**counts.get(None,blank)}]
    rows.extend({'owner_id':company.pk,'owner_name':company.name,'inventory_mode':company.inventory_mode,**counts.get(company.pk,blank)} for company in SubrentalCompany.objects.order_by('pk'))
    main=rows[0]['records'];shared=sum(r['records'] for r in rows if r['inventory_mode']=='shared_warehouse')
    return {'mode':'inventory_ownership_summary','rows':rows,
            'totals':{'main_owned':main,'shared_supplier_owned':shared,'shared_warehouse':main+shared,
                'external_supplier_catalog':sum(r['records'] for r in rows if r['inventory_mode']=='external_supplier'),
                'unreviewed_supplier_catalog':sum(r['records'] for r in rows if r['inventory_mode']=='unreviewed'),
                'all_permanent':sum(r['records'] for r in rows)},
            'limitations':['Counts are permanent inventory records, not stock quantities or proof of availability.',
                           'Stored status counts can include records needing custody review.',
                           'Existing supplier classifications are not inferred; reviewed configuration remains separate.']}


@api_view(['GET'])
@permission_classes([IsAuthenticated])
@transaction.atomic
def ownership_summary(request):
    from .reconciliation_commands import read_snapshot
    read_snapshot()
    return Response(inventory_summary())
