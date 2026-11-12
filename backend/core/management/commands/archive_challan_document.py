"""Archive one reviewed legacy scope. Preview is the default."""
import hashlib
import json
import os
from datetime import date
from pathlib import Path

from django.conf import settings
from django.contrib.auth.models import User
from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction

from core.asset_commands import CommandError as ArchiveError
from core.challan_archive_files import archive_file, issuer_logo
from core.challan_documents import document_data, replace_lines
from core.challan_preview import preview_legacy_documents
from core.models import ChallanDocument, ChallanRevision, CompanySettings, Conference, TruckChallan
from core.permissions import is_business_administrator
from core.private_media import MAX_PDF_BYTES
from core.reconciliation_commands import digest, read_snapshot
from core.revisions import lock_conference_for_write


class Command(BaseCommand):
    help = 'Preview or archive a single reviewed numbered legacy challan without changing custody.'

    def add_arguments(self, parser):
        parser.add_argument('--conference', type=int, required=True)
        parser.add_argument('--scope', default='master')
        parser.add_argument('--expected-database', required=True)
        parser.add_argument('--expected-instance', required=True)
        parser.add_argument('--original-pdf', type=Path)
        parser.add_argument('--original-return-pdf', type=Path)
        parser.add_argument('--output', type=Path)
        parser.add_argument('--apply', action='store_true')
        parser.add_argument('--actor', type=int)
        parser.add_argument('--review-sha256')
        parser.add_argument('--reason', default='')

    def handle(self, *args, **options):
        try:
            self.run_archive(options)
        except ArchiveError as error:
            raise CommandError(error.code) from None

    def run_archive(self, options):
        if connection.vendor != 'postgresql':
            raise CommandError('Archive review requires an identified PostgreSQL database.')
        apply = options['apply']
        reason = options['reason'].strip()
        if apply and (not getattr(settings, 'CHALLAN_ARCHIVE_WRITES_ENABLED', False)
                      or not options['actor'] or not options['review_sha256'] or not reason
                      or len(reason) > 2000):
            raise CommandError('Apply requires an enabled archive gate, exact reviewed digest, admin actor and reason.')
        pdf = self.read_pdf(options['original_pdf'])
        pdf_hash = hashlib.sha256(pdf).hexdigest() if pdf else None
        return_pdf = self.read_pdf(options['original_return_pdf'])
        return_hash = hashlib.sha256(return_pdf).hexdigest() if return_pdf else None
        with transaction.atomic():
            if not apply:
                read_snapshot()
            with connection.cursor() as cursor:
                cursor.execute('SELECT current_database()')
                database = cursor.fetchone()[0]
            instance = getattr(settings, 'RUNTIME_INSTANCE_ID', '')
            if not instance or (database, instance) != (options['expected_database'], options['expected_instance']):
                raise CommandError('Archive database or instance identity differs.')
            if not Conference.objects.filter(pk=options['conference'], is_audit=False).exists():
                raise CommandError('Numbered non-audit conference required.')
            if apply:
                event = lock_conference_for_write(options['conference'], {})
                list(TruckChallan.objects.select_for_update().filter(conference=event).order_by('pk'))
                list(CompanySettings.objects.select_for_update().order_by('pk'))
                actor = User.objects.filter(pk=options['actor'], is_active=True).first()
                if not is_business_administrator(actor):
                    raise CommandError('Active administrator required.')
            scope = options['scope']
            existing = ChallanDocument.objects.filter(conference_id=options['conference'], scope=scope).first()
            if existing:
                if (apply and existing.provenance == 'reviewed_legacy_archive'
                        and existing.header.get('archive_review_sha256') == options['review_sha256']
                        and existing.history.filter(revision=1, actor=actor, reason=reason).exists()):
                    self.stdout.write(json.dumps({'archived': True, 'document_id': str(existing.pk), 'replayed': True}))
                    return
                raise CommandError('A saved challan already exists. Its history is preserved.')
            preview = preview_legacy_documents(options['conference'], numbered_only=True)
            source = next((row for row in preview['documents'] if row['scope'] == scope), None)
            if source is None:
                raise CommandError('Numbered legacy scope not found.')
            logo = issuer_logo(CompanySettings.objects.order_by('pk').first())
            if logo:
                source['header']['company']['logo'] = f'/api/challan-logos/{logo[0]}/'
            warnings = [warning for warning in preview['warnings']
                        if warning.get('scope') == scope or warning.get('number') == source['number']]
            packet = {'database': database, 'instance': instance, 'document': source,
                      'warnings': warnings, 'original_pdf_sha256': pdf_hash,
                      'original_return_pdf_sha256': return_hash}
            review_hash = digest(packet)
            if apply:
                if review_hash != options['review_sha256']:
                    raise CommandError('Archive source changed. Review a fresh preview.')
                if not source['lines'] and not pdf:
                    raise CommandError('An empty legacy challan requires its verified original PDF.')
                if any(type(line['quantity']) is not int or line['quantity'] < 1 for line in source['lines']):
                    raise CommandError('Legacy line quantities require review.')
                if logo:
                    archive_file(*logo)
                if pdf:
                    archive_file(pdf_hash, 'application/pdf', pdf)
                if return_pdf:
                    archive_file(return_hash, 'application/pdf', return_pdf)
                header = {**source['header'], 'archive_review_sha256': review_hash,
                          'original_pdf_sha256': pdf_hash, 'original_return_pdf_sha256': return_hash,
                          'archive_warnings': warnings}
                document = ChallanDocument.objects.create(
                    conference=event, truck_id=source['truck_id'], scope=scope,
                    number=source['number'], state='issued', revision=1,
                    document_date=date.fromisoformat(source['document_date']) if source['document_date'] else None,
                    total_override=source['total_override'], header=header, provenance='reviewed_legacy_archive',
                )
                replace_lines(document, source['lines'])
                ChallanRevision.objects.create(document=document, revision=1, actor=actor,
                                               reason=reason, snapshot=document_data(document))
        if apply:
            self.stdout.write(json.dumps({'archived': True, 'document_id': str(document.pk), 'replayed': False}))
        else:
            if options['output']:
                with os.fdopen(os.open(options['output'], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as out:
                    json.dump({**packet, 'review_sha256': review_hash}, out, indent=2)
            self.stdout.write(json.dumps({'archived': False, 'review_sha256': review_hash,
                                          'lines': len(source['lines']), 'warnings': warnings,
                                          'original_pdf_attached_to_review': bool(pdf)}))

    @staticmethod
    def read_pdf(path):
        if path is None:
            return None
        if path.is_symlink() or not path.is_file():
            raise CommandError('Original PDF must be a regular private file.')
        with path.open('rb') as stream:
            pdf = stream.read(MAX_PDF_BYTES + 1)
        if not pdf.startswith(b'%PDF-') or len(pdf) > MAX_PDF_BYTES:
            raise CommandError('Use an original PDF up to 20 MB.')
        return pdf
