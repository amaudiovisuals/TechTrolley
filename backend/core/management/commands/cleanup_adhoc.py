"""Retired unsafe bulk cleanup. Kept only to fail clearly for old runbooks."""
from django.core.management.base import BaseCommand, CommandError


class Command(BaseCommand):
    help = 'Retired: use the reviewed reconciliation/ownership workflows.'

    def handle(self, *args, **options):
        raise CommandError(
            'cleanup_adhoc is retired because it deletes inventory and rewrites custody without review. '
            'Use the reviewed reconciliation workflows with an approved packet; no records were changed.'
        )
