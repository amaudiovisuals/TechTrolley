"""Keep exact original bytes without mutable links to Company Settings."""
import hashlib
from io import BytesIO

from django.http import FileResponse, Http404
from django.shortcuts import get_object_or_404
from PIL import Image
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import AllowAny, IsAuthenticated

from .asset_commands import CommandError
from .models import ChallanArchiveFile, ChallanDocument
from .permissions import WAREHOUSE_ROLES, get_business_role
from .private_media import MAX_LOGO_BYTES, open_media

LOGO_TYPES = {'image/png', 'image/jpeg', 'image/gif', 'image/webp'}


def issuer_logo(settings):
    if not settings or not settings.logo:
        return None
    try:
        with open_media(settings.logo, 'company', MAX_LOGO_BYTES) as stream:
            content = stream.read()
        with Image.open(BytesIO(content)) as image:
            mime = Image.MIME.get(image.format)
            if mime not in LOGO_TYPES or image.width * image.height > 16_000_000:
                raise ValueError
            image.verify()
    except (Http404, OSError, ValueError, Image.DecompressionBombError):
        raise CommandError('issuer_logo_requires_review') from None
    return hashlib.sha256(content).hexdigest(), mime, content


def archive_file(sha256, content_type, content):
    item, _ = ChallanArchiveFile.objects.get_or_create(
        sha256=sha256, defaults={'content_type': content_type, 'content': content},
    )
    if item.content_type != content_type or bytes(item.content) != content:
        raise CommandError('challan_archive_file_conflict')


def file_response(item, filename=None):
    response = FileResponse(
        BytesIO(bytes(item.content)), content_type=item.content_type,
        as_attachment=filename is not None, filename=filename or '',
    )
    response['Cache-Control'] = 'private, no-store' if filename else 'public, max-age=31536000, immutable'
    response['X-Content-Type-Options'] = 'nosniff'
    if filename:
        response['Content-Security-Policy'] = "sandbox; default-src 'none'"
    return response


@api_view(['GET'])
@authentication_classes([])
@permission_classes([AllowAny])
def archived_challan_logo(request, sha256):
    return file_response(get_object_or_404(ChallanArchiveFile, sha256=sha256, content_type__in=LOGO_TYPES))


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def archived_challan_pdf(request, document_id, direction='dispatch'):
    if get_business_role(request.user) not in WAREHOUSE_ROLES | {'accounts'}:
        raise PermissionDenied
    document = get_object_or_404(ChallanDocument, pk=document_id)
    key = 'original_return_pdf_sha256' if direction == 'return' else 'original_pdf_sha256'
    sha256 = document.header.get(key)
    if not sha256:
        raise Http404
    item = get_object_or_404(ChallanArchiveFile, sha256=sha256, content_type='application/pdf')
    return file_response(item, f'Original-{direction}-challan-{document.pk}.pdf')
