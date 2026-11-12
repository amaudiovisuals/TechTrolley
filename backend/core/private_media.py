"""Local filesystem media: only the configured logo is public."""
from pathlib import Path
from django.conf import settings
from django.http import FileResponse, Http404
from PIL import Image
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.permissions import AllowAny

MAX_PDF_BYTES = 20 * 1024 * 1024
MAX_LOGO_BYTES = 2 * 1024 * 1024


def open_media(field, folder, max_bytes):
    """Validate the stored relative name and resolved path, including symlinks."""
    if not field or not field.name:
        raise Http404
    name = Path(field.name)
    root = Path(settings.MEDIA_ROOT).resolve()
    if name.is_absolute() or '..' in name.parts or not name.parts or name.parts[0] != folder:
        raise Http404
    try:
        path = (root / name).resolve(strict=True)
        path.relative_to(root / folder)
        if not path.is_file() or path.stat().st_size > max_bytes:
            raise Http404
        return path.open('rb')
    except (OSError, ValueError):
        raise Http404 from None


@api_view(['GET'])
@authentication_classes([])
@permission_classes([AllowAny])
def public_logo(request):
    from .models import CompanySettings
    company = CompanySettings.objects.first()
    stream = open_media(company.logo if company else None, 'company', MAX_LOGO_BYTES)
    try:
        with Image.open(stream) as image:
            fmt = image.format
            if fmt not in {'PNG', 'JPEG', 'GIF', 'WEBP'} or image.width * image.height > 16_000_000:
                raise Http404
            image.verify()
        # Pillow may close the stream during verification; reopen only the same
        # validated configured field, never a request-supplied filesystem name.
    except (OSError, ValueError, Image.DecompressionBombError):
        raise Http404 from None
    finally:
        stream.close()
    response = FileResponse(open_media(company.logo, 'company', MAX_LOGO_BYTES), content_type=Image.MIME[fmt])
    response['X-Content-Type-Options'] = 'nosniff'
    response['Cache-Control'] = 'no-store'
    return response
