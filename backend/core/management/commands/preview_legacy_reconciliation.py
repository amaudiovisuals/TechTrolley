import json
import os
from urllib.parse import urlparse, parse_qs
from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction
from core.legacy_reconciliation import collect_snapshot, preview_reconciliation


class Command(BaseCommand):
    help = 'SELECT-only legacy evidence. No apply flag. Explicit database identity required.'

    def add_arguments(self, parser):
        parser.add_argument('--expected-database', required=True)
        parser.add_argument('--allow-test-sqlite', action='store_true', help='Only in-memory test databases; never a SQLite business file.')
        parser.add_argument('--output', help='New private JSON evidence path. Existing paths are refused.')

    def handle(self, *args, **options):
        expected = options['expected_database']
        if connection.vendor == 'sqlite':
            name = str(connection.settings_dict['NAME'])
            uri = urlparse(name)
            memory = name == ':memory:' or (name.startswith('file:memorydb_') and parse_qs(uri.query).get('mode') == ['memory'])
            if not options['allow_test_sqlite'] or not memory or expected != name:
                raise CommandError('SQLite business files are refused; only explicit in-memory tests allowed.')
        elif connection.vendor != 'postgresql':
            raise CommandError('Expected PostgreSQL production or explicit in-memory tests.')
        with transaction.atomic():
            if connection.vendor == 'postgresql':
                with connection.cursor() as cursor:
                    cursor.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
                    cursor.execute('SELECT current_database()')
                    if cursor.fetchone()[0] != expected:
                        raise CommandError('Database identity differs from --expected-database; no evidence collected.')
            snapshot = collect_snapshot(connection)
            report = preview_reconciliation(snapshot)
            transaction.set_rollback(True)
        if options['output']:
            try:
                fd = os.open(options['output'], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, 'w') as target:
                    json.dump({'database': expected, 'vendor': connection.vendor, 'snapshot': snapshot, 'report': report}, target, indent=2)
            except OSError as error:
                raise CommandError(f'Cannot create new private evidence file: {error}')
        self.stdout.write(json.dumps({key: report[key] for key in ('mode', 'snapshot_sha256', 'counts', 'finding_counts', 'missing_optional_tables')}))
