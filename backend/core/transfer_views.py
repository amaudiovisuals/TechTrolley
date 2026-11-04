"""Compatibility route delegating physical transfers to the movement service."""
from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response
from .permissions import WarehouseWriteAuthenticatedRead
from .asset_commands import execute_command, CommandError


@api_view(['POST'])
@permission_classes([WarehouseWriteAuthenticatedRead])
def asset_transfer(request, pk):
    try:
        result = execute_command(request.user, pk, {
            'request_id': request.data.get('request_id'), 'action': 'transfer',
            'asset_ids': request.data.get('asset_ids'),
            'target_conference_id': request.data.get('target_conference_id'),
            'source': request.data.get('from_address', 'transfer'),
        })
        return Response({'success': True, 'source_conference': result['conference'],
                         'target_conference': result['target_conference'],
                         'transferred_count': len(result['asset_ids']), 'request_id': result['request_id'],
                         'replayed': result['replayed']})
    except CommandError as error:
        return Response({'error': error.code, 'conflicts': error.details}, status=error.status)
