"""Read-only preflight for explicitly reviewed email-scoped browser work."""
import uuid
from collections.abc import Mapping
from django.contrib.auth import get_user_model
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from .models import MovementReceipt


def email_scope_allowed(user):
    return bool(user.email and get_user_model().objects.filter(email__iexact=user.email).count() == 1)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def check_saved_work(request):
    data = request.data
    if not isinstance(data, Mapping):
        return Response({'error':'invalid_saved_work_review'},status=400)
    email = data.get('email')
    if (not isinstance(email,str) or email.casefold() != request.user.email.casefold()
            or not email_scope_allowed(request.user) or data.get('confirmed_own_work') is not True):
        return Response({'error':'saved_work_identity_requires_review'},status=409)
    ids = data.get('request_ids')
    if not isinstance(ids,list) or len(ids)>500:
        return Response({'error':'invalid_saved_request_ids'},status=400)
    try:
        if any(not isinstance(i,str) for i in ids): raise ValueError
        ids = [uuid.UUID(i) for i in ids]
    except (ValueError,TypeError,AttributeError):
        return Response({'error':'invalid_saved_request_ids'},status=400)
    # A recycled email cannot borrow another actor's committed UUID. No business
    # command is executed here; unknown UUIDs still need normal role/state checks.
    if MovementReceipt.objects.filter(request_id__in=ids).exclude(actor=request.user).exists():
        return Response({'error':'saved_request_belongs_to_another_login'},status=409)
    response = Response({'user_id':request.user.pk,'email':request.user.email,'review_allowed':True})
    response['Cache-Control']='no-store'
    return response
