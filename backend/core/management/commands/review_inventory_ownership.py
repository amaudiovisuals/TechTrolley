"""Pure preview by default; explicit apply uses an exact private decision packet."""
import json,os
from django.core.management.base import BaseCommand,CommandError
from django.contrib.auth.models import User
from django.db import transaction,connection
from core.ownership_commands import prepare_preview,execute_ownership,identity as ownership_identity,read_snapshot,normalize_command,memory_database
from core.asset_commands import CommandError as OwnershipError


class Command(BaseCommand):
    help='Reviewed ownership preview by default. Preserve IDs, custody and paperwork; never clone or import stock.'
    def add_arguments(self,parser):
        parser.add_argument('--expected-database',required=True)
        parser.add_argument('--expected-instance',required=True)
        parser.add_argument('--target',help='Private JSON target for a pure preview')
        parser.add_argument('--packet',help='Private exact reviewed command JSON')
        parser.add_argument('--apply',action='store_true')
        parser.add_argument('--actor',type=int,help='Active administrator operator PK for explicit apply')
        parser.add_argument('--output',help='New private evidence path; existing files are refused')
    def handle(self,*args,**options):
        if options['apply'] and connection.in_atomic_block:raise CommandError('Apply requires a standalone transaction; nested callers are refused.')
        if options['apply'] and (not options['packet'] or not options['actor']):raise CommandError('Apply requires an exact reviewed packet and active administrator operator.')
        path=options['packet'] or options['target']
        if not path:raise CommandError('Provide a private target or decision packet.')
        try:
            with open(path) as f:payload=json.load(f)
        except (OSError,ValueError) as error:raise CommandError(str(error))
        fd=None;committed=False
        try:
            with transaction.atomic():
                if not options['apply']:read_snapshot()
                identity=ownership_identity()
                if identity['name']!=options['expected_database'] or identity['instance_id']!=options['expected_instance']:
                    raise CommandError('Database identity differs; no operation performed.')
                if identity['vendor']=='sqlite' and not memory_database(identity['name']):
                    raise CommandError('SQLite business files are refused.')
                if options['output']:fd=self.reserve_output(options['output'])
                if options['apply']:
                    packet=normalize_command(payload);user=User.objects.filter(pk=options['actor'],is_active=True).first()
                    if user is None:raise CommandError('Unknown active operator.')
                    result=execute_ownership(user,packet)
                else:
                    result=prepare_preview(payload['target'] if options['packet'] else payload)[0]
                    transaction.set_rollback(True)
            committed=bool(options['apply'])
        except Exception as error:
            if fd is not None:
                os.close(fd);os.unlink(options['output'])
            if isinstance(error,OwnershipError):raise CommandError(error.code)
            raise
        # Write after successful commit: an output failure must never be reported as
        # a rolled-back data operation. Recover using the same packet/actor UUID.
        if fd is not None:
            try:
                with os.fdopen(fd,'w') as f:json.dump({**result,'committed':committed},f,indent=2)
            except (OSError,TypeError) as error:
                try:os.close(fd)
                except OSError:pass
                raise CommandError(f'Data committed={committed}; private output failed. Recover the exact request {result.get("request_id")}: {error}')
        self.stdout.write(json.dumps({'mode':result.get('mode',result.get('operation')),'committed':committed,
            'request_id':result.get('request_id'),'history':result.get('history'),'snapshot_sha256':result.get('snapshot_sha256'),
            'write_gate':result.get('write_gate'),'plan':result.get('plan')}))
    def reserve_output(self,path):
        try:return os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        except OSError as error:raise CommandError(f'Cannot create new private evidence file: {error}')
