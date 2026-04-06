import traceback
from rest_framework.decorators import api_view, parser_classes
from rest_framework.parsers import MultiPartParser, FormParser
from rest_framework.response import Response
from .models import Conference
from .serializers import ConferenceSerializer
from django.shortcuts import get_object_or_404

@api_view(['GET', 'POST'])
@parser_classes([MultiPartParser, FormParser])
def conference_list(request):
    if request.method == 'GET':
        conferences = Conference.objects.all().order_by('-start_date')
        serializer = ConferenceSerializer(conferences, many=True)
        return Response(serializer.data)
    elif request.method == 'POST':
        try:
            serializer = ConferenceSerializer(data=request.data)
            if serializer.is_valid():
                serializer.save()
                return Response(serializer.data, status=201)
            return Response(serializer.errors, status=400)
        except Exception as e:
            return Response({"error": str(e), "traceback": traceback.format_exc()}, status=500)

@api_view(['GET', 'PUT', 'DELETE', 'PATCH', 'POST'])
@parser_classes([MultiPartParser, FormParser])
def conference_detail(request, pk):
    conference = get_object_or_404(Conference, pk=pk)

    if request.method == 'GET':
        serializer = ConferenceSerializer(conference)
        return Response(serializer.data)

    elif request.method == 'PUT':
        try:
            serializer = ConferenceSerializer(conference, data=request.data)
            if serializer.is_valid():
                serializer.save()
                return Response(serializer.data)
            return Response(serializer.errors, status=400)
        except Exception as e:
            return Response({"error": str(e), "traceback": traceback.format_exc()}, status=500)
    
    elif request.method in ['PATCH', 'POST']:
        try:
            serializer = ConferenceSerializer(conference, data=request.data, partial=True)
            if serializer.is_valid():
                serializer.save()
                return Response(serializer.data)
            return Response(serializer.errors, status=400)
        except Exception as e:
            return Response({"error": str(e), "traceback": traceback.format_exc()}, status=500)

    elif request.method == 'DELETE':
        conference.assets.update(status='Available')
        conference.crosscheck_assets.update(status='Available')
        conference.delete()
        return Response(status=204)

