"""Preview a single normal P2 case, or apply an exact reviewed private packet."""
import json
import os
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction
from core.asset_commands import CommandError as ConversionError
from core.led_cases import prepare, convert
from core.models import Asset
from core.reconciliation_commands import read_snapshot


class Command(BaseCommand):
    help = 'Preserve the original box/history and replace its stock count with six individually tracked normal P2 panels. Preview only by default.'

    def add_arguments(self, parser):
        parser.add_argument('--source-id', required=True, type=int)
        parser.add_argument('--expected-database', required=True)
        parser.add_argument('--expected-instance', required=True)
        parser.add_argument('--apply', action='store_true')
        parser.add_argument('--packet', help='Private JSON: source_id and exact command payload')
        parser.add_argument('--actor', type=int)
        parser.add_argument('--output', required=True, help='New private evidence file; existing files refused')

    def handle(self, *args, **options):
        from django.conf import settings
        if connection.in_atomic_block:
            raise CommandError('Use a standalone review transaction.')
        if str(connection.settings_dict['NAME']) != options['expected_database'] or getattr(settings, 'LED_CASE_CONVERSION_INSTANCE_ID', '') != options['expected_instance']:
            raise CommandError('Database/instance identity differs; no operation performed.')
        if options['apply'] and (not options['packet'] or not options['actor']):
            raise CommandError('Apply requires an exact private packet and active administrator actor.')
        payload = None
        if options['packet']:
            with open(options['packet']) as file:
                packet = json.load(file)
            if not isinstance(packet, dict) or packet.get('source_id') != options['source_id'] or set(packet) != {'source_id', 'command'}:
                raise CommandError('Packet source differs from the selected original box.')
            payload = packet['command']
        descriptor = os.open(options['output'], os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        try:
            with transaction.atomic():
                if options['apply']:
                    user = get_user_model().objects.filter(pk=options['actor'], is_active=True).first()
                    if user is None:
                        raise CommandError('An active administrator actor is required.')
                    result = convert(user, options['source_id'], payload)
                else:
                    read_snapshot()
                    asset = Asset.objects.select_related('subrental_company').get(pk=options['source_id'])
                    review, before = prepare(asset)
                    result = {'review': review, 'original_snapshot': before}
                    transaction.set_rollback(True)
        except Exception as error:
            os.close(descriptor); os.unlink(options['output'])
            if isinstance(error, ConversionError):
                raise CommandError(error.code) from None
            raise
        # An evidence write failure after commit must never masquerade as rollback.
        try:
            with os.fdopen(descriptor, 'w') as file:
                json.dump({'applied': options['apply'], **result}, file, indent=2)
        except OSError as error:
            raise CommandError(f'Data applied={options["apply"]}; evidence output failed. Recover using the exact same actor/request UUID: {error}') from None
        self.stdout.write(json.dumps({'applied': options['apply'], 'source_id': options['source_id'],
            'request_id': result.get('request_id'), 'panels': len(result.get('panels', [])),
            'review_hash': result.get('review', {}).get('review_hash'), 'blockers': result.get('review', {}).get('blockers')}))
