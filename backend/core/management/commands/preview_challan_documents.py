import json
import os
from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction
from core.challan_preview import preview_legacy_documents


class Command(BaseCommand):
    help = 'Read-only legacy challan preview. Never creates documents or reserves numbers.'

    def add_arguments(self, parser):
        parser.add_argument('--conference', type=int)
        parser.add_argument('--output', help='Optional private JSON path; must not exist already.')

    def handle(self, *args, **options):
        with transaction.atomic():
            if connection.vendor == 'postgresql':
                with connection.cursor() as cursor:
                    cursor.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
            result = preview_legacy_documents(options['conference'])
        if options['output']:
            try:
                descriptor = os.open(options['output'], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(descriptor, 'w') as target:
                    json.dump(result, target, indent=2)
            except OSError as error:
                raise CommandError(f'Could not create a new private preview file: {error}')
        self.stdout.write(json.dumps({'mode': result['mode'], 'documents': len(result['documents']),
                                      'warnings': len(result['warnings']), 'output_created': bool(options['output'])}))
