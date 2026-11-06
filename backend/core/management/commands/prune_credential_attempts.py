"""Bounded housekeeping; never called automatically by authentication requests."""
from datetime import timedelta
from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone
from core.models import CredentialAttempt

class Command(BaseCommand):
    help = 'Delete at most one batch of credential budgets expired more than 24 hours ago.'
    def add_arguments(self,parser):
        parser.add_argument('--batch-size',type=int,default=1000)
    def handle(self,*args,**options):
        count=options['batch_size']
        if not 1<=count<=10000: raise CommandError('batch-size must be 1 through 10000')
        cutoff=timezone.now()-timedelta(hours=24)
        keys=list(CredentialAttempt.objects.filter(expires_at__lt=cutoff).order_by('expires_at').values_list('pk',flat=True)[:count])
        # Recheck expiry so a worker renewing a budget cannot have it deleted.
        deleted,_=CredentialAttempt.objects.filter(pk__in=keys,expires_at__lt=cutoff).delete()
        self.stdout.write(f'Removed {deleted} expired credential budgets.')
