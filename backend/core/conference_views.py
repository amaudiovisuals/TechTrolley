from rest_framework.decorators import api_view
from rest_framework.response import Response
from .models import Conference
from .serializers import ConferenceSerializer

@api_view(['GET', 'POST'])
def conference_list(request):
    if request.method == 'GET':
        conferences = Conference.objects.all().order_by('-start_date')
        serializer = ConferenceSerializer(conferences, many=True)
        return Response(serializer.data)
    elif request.method == 'POST':
        serializer = ConferenceSerializer(data=request.data)
        if serializer.is_valid():
            serializer.save()
            return Response(serializer.data, status=201)
        return Response(serializer.errors, status=400)

from django.shortcuts import get_object_or_404

@api_view(['GET', 'PUT', 'DELETE', 'PATCH'])
def conference_detail(request, pk):
    conference = get_object_or_404(Conference, pk=pk)

    if request.method == 'GET':
        serializer = ConferenceSerializer(conference)
        return Response(serializer.data)

    elif request.method == 'PUT':
        serializer = ConferenceSerializer(conference, data=request.data)
        if serializer.is_valid():
            serializer.save()
            return Response(serializer.data)
        return Response(serializer.errors, status=400)
    
    # Support PATCH for partial updates
    elif request.method == 'PATCH':
        serializer = ConferenceSerializer(conference, data=request.data, partial=True)
        if serializer.is_valid():
            serializer.save()
            return Response(serializer.data)
        return Response(serializer.errors, status=400)

    elif request.method == 'DELETE':
        # Release all assets assigned to this conference back to Available
        conference.assets.update(status='Available')
        # Also release any assets pending Godown Crosscheck back to Available
        conference.crosscheck_assets.update(status='Available')
        conference.delete()
        return Response(status=204)

