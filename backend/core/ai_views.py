import json
import os
import re
import requests
from django.conf import settings
from django.db.models import Q
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .models import Asset, Conference, UserProfile

def check_ai_permission(user):
    if not user or not user.is_authenticated:
        return False
    if user.is_superuser or user.is_staff:
        return True
    profile = UserProfile.objects.filter(user=user).first()
    if profile and profile.role in ['admin', 'boss']:
        return True
    return False

def build_inventory_context(query):
    total_assets = Asset.objects.count()
    available_assets = Asset.objects.filter(status='Available').count()
    in_use_assets = Asset.objects.filter(status='In Use').count()
    damaged_assets = Asset.objects.filter(status='Damaged').count()
    on_service_assets = Asset.objects.filter(status='On Service').count()

    active_conferences = []
    conferences = Conference.objects.all().order_by('-start_date')[:15]
    for c in conferences:
        active_conferences.append({
            "name": c.name,
            "dates": f"{c.start_date} to {c.end_date}",
            "venue": c.transport_address or c.billing_address or "Not specified",
            "allocated_assets_count": c.assets.count(),
            "status": "Ongoing" if getattr(c, 'is_ongoing', False) else "Active"
        })

    # Find specific equipment matching query keywords
    matched_assets = []
    terms = [w.strip() for w in re.split(r'[^a-zA-Z0-9_-]+', query) if len(w.strip()) >= 3]
    if terms:
        q_filter = Q()
        for t in terms[:5]:
            q_filter |= Q(alias_name__icontains=t) | Q(sku__icontains=t) | Q(type__icontains=t)
        
        sample_assets = Asset.objects.filter(q_filter).select_related()[:40]
        for a in sample_assets:
            matched_assets.append({
                "sku": a.sku,
                "name": a.alias_name,
                "category": a.type,
                "status": a.status,
                "quantity": a.quantity or 1
            })

    # Privacy guarantee: strictly sanitize all context (zero credentials, zero passwords, zero bank accounts)
    return {
        "metrics": {
            "total_assets": total_assets,
            "available_ready": available_assets,
            "currently_in_use": in_use_assets,
            "maintenance_damaged": damaged_assets,
            "on_service": on_service_assets,
        },
        "recent_conferences": active_conferences[:8],
        "matching_equipment_samples": matched_assets[:30]
    }

def fallback_local_ai(query, context):
    q_lower = query.lower()
    metrics = context.get('metrics', {})
    conferences = context.get('recent_conferences', [])
    assets = context.get('matching_equipment_samples', [])

    if any(w in q_lower for w in ['total', 'how many', 'count', 'overview', 'stats']):
        return (
            f"**TechTrolley System Overview:**\n\n"
            f"• **Total Assets:** {metrics.get('total_assets', 0)}\n"
            f"• **Ready / Available:** {metrics.get('available_ready', 0)}\n"
            f"• **Currently In Use:** {metrics.get('currently_in_use', 0)}\n"
            f"• **Damaged / Maintenance:** {metrics.get('maintenance_damaged', 0)}\n"
            f"• **On Service:** {metrics.get('on_service', 0)}\n\n"
            f"All inventory records are currently synchronized."
        )

    if any(w in q_lower for w in ['conference', 'event', 'ongoing', 'upcoming', 'venue']):
        if not conferences:
            return "There are currently no active or recorded conferences in the pipeline."
        resp = "**Current Conference Pipeline:**\n\n"
        for c in conferences[:5]:
            resp += f"• **{c['name']}**\n  Dates: {c['dates']} | Venue: {c['venue']} | Gear: {c['allocated_assets_count']} items\n\n"
        return resp.strip()

    if assets:
        resp = f"**Found {len(assets)} Matching Assets in Inventory:**\n\n"
        for a in assets[:10]:
            status_badge = "🟢 Available" if a['status'] == 'Available' else f"🟠 {a['status']}"
            resp += f"• **{a['name']}** ({a['sku']}) — {status_badge} [Qty: {a['quantity']}]\n"
        if len(assets) > 10:
            resp += f"\n*...and {len(assets) - 10} more items matching your query.*"
        return resp

    return (
        f"I searched the live system for **'{query}'**. "
        f"There are currently **{metrics.get('total_assets', 0)} total assets** ({metrics.get('available_ready', 0)} available, {metrics.get('currently_in_use', 0)} in use). "
        f"Try asking about a specific gear name (e.g., 'Sony camera', 'Yamaha mixer'), conference venues, or overall inventory counts."
    )

@api_view(['POST'])
@permission_classes([IsAuthenticated])
def ai_assistant_chat(request):
    if not check_ai_permission(request.user):
        return Response(
            {"error": "Access restricted. Only Administrators and Boss accounts have access to the Executive AI Assistant."},
            status=403
        )

    user_query = request.data.get('message', '').strip()
    if not user_query:
        return Response({"error": "Empty query provided."}, status=400)

    # Compile sanitized, privacy-safe context
    context = build_inventory_context(user_query)

    gemini_key = os.environ.get('GEMINI_API_KEY') or getattr(settings, 'GEMINI_API_KEY', None)

    if not gemini_key:
        # Graceful rule-based instant engine
        local_reply = fallback_local_ai(user_query, context)
        return Response({
            "reply": local_reply,
            "engine": "local_rule_engine",
            "note": "For generative multi-turn AI reasoning, set GEMINI_API_KEY in backend/.env"
        })

    # Call Google Gemini Flash API securely
    system_prompt = (
        "You are AM Orbit AI, the intelligent executive assistant for AM Audiovisuals Pvt. Ltd. (TechTrolley).\n"
        "Your role is to assist the Executive Boss and Administrators with live inventory, conference allocations, and logistics.\n"
        "Rules:\n"
        "1. Strictly base your answers on the provided system context.\n"
        "2. Keep responses professional, clear, concise, and structured with bold highlights and bullet points.\n"
        "3. Never guess quantities or statuses not found in the context.\n"
        "4. Data privacy is strictly enforced: never disclose or speculate on credentials or financial records."
    )

    gemini_endpoint = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={gemini_key}"
    payload = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {
                        "text": f"{system_prompt}\n\nLive System Context:\n{json.dumps(context, indent=2)}\n\nUser Question:\n{user_query}"
                    }
                ]
            }
        ],
        "generationConfig": {
            "temperature": 0.2,
            "maxOutputTokens": 800,
            "topP": 0.95
        }
    }

    try:
        res = requests.post(gemini_endpoint, json=payload, timeout=12)
        if res.status_code == 200:
            data = res.json()
            candidates = data.get("candidates", [])
            if candidates:
                parts = candidates[0].get("content", {}).get("parts", [])
                if parts:
                    ai_reply = parts[0].get("text", "")
                    return Response({
                        "reply": ai_reply,
                        "engine": "gemini-1.5-flash",
                        "status": "success"
                    })
        
        # Fallback to local engine if Google API returned non-200
        local_reply = fallback_local_ai(user_query, context)
        return Response({
            "reply": local_reply,
            "engine": "fallback_local",
            "status": "api_fallback"
        })
    except Exception as e:
        local_reply = fallback_local_ai(user_query, context)
        return Response({
            "reply": local_reply,
            "engine": "fallback_local",
            "status": "error_fallback"
        })
