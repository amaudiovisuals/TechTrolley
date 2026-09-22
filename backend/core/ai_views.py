import json
import os
import re
from datetime import date
import requests
from django.conf import settings
from django.db.models import Q
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .models import Asset, Conference, UserProfile

STOPWORDS = {
    "how", "many", "much", "we", "have", "in", "total", "and", "where", "are", "they", 
    "the", "is", "at", "what", "do", "does", "our", "any", "all", "of", "for", "to", 
    "a", "an", "show", "me", "tell", "list", "give", "gear", "items", "assets", "system", 
    "please", "can", "you", "with", "on", "about", "currently", "right", "now", "location",
    "locations", "venue", "venues", "status", "statuses", "count", "check", "details",
    "got", "there", "which", "available", "ready", "use", "used", "using", "in-use"
}

def check_ai_permission(user):
    if not user or not user.is_authenticated:
        return False
    if user.is_superuser or user.is_staff:
        return True
    profile = UserProfile.objects.filter(user=user).first()
    if profile and profile.role in ['admin', 'boss']:
        return True
    return False

def clean_tokens(query):
    words = [w.strip() for w in re.split(r'[^a-zA-Z0-9_-]+', query.lower()) if len(w.strip()) >= 2]
    tokens = [w for w in words if w not in STOPWORDS]
    stemmed = []
    for t in tokens:
        stemmed.append(t)
        # Stem plurals (e.g. dynatechs -> dynatech, mics -> mic, speakers -> speaker)
        if t.endswith('s') and len(t) > 3 and not t.endswith('ss'):
            stemmed.append(t[:-1])
    return list(dict.fromkeys(stemmed))

def build_inventory_context(query):
    q_lower = query.lower().strip()
    tokens = clean_tokens(query)
    today = date.today()

    total_assets = Asset.objects.count()
    available_assets = Asset.objects.filter(status='Available').count()
    in_use_assets = Asset.objects.filter(status='In Use').count()
    crosscheck_assets = Asset.objects.filter(status='Crosscheck').count()
    damaged_assets = Asset.objects.filter(status__in=['Damaged', 'On Service', 'Under Maintenance']).count()

    context = {
        "query": query,
        "tokens": tokens,
        "overall_stats": {
            "total_assets": total_assets,
            "available_ready": available_assets,
            "currently_in_use": in_use_assets,
            "crosscheck_in_transit": crosscheck_assets,
            "maintenance_damaged": damaged_assets,
        }
    }

    # 1. Maintenance / Damaged gear query
    if any(w in q_lower for w in ['damage', 'damaged', 'broken', 'repair', 'service', 'maintenance', 'faulty']):
        maint_qs = Asset.objects.filter(status__in=['Damaged', 'On Service', 'Under Maintenance'])
        maint_list = []
        for a in maint_qs[:25]:
            maint_list.append({
                "sku": a.sku,
                "name": a.alias_name or a.name or a.sku,
                "status": a.status,
                "condition": a.condition or "Unspecified",
                "current_venue": a.current_venue or "Godown"
            })
        context["maintenance_mode"] = True
        context["maintenance_items"] = maint_list
        context["maintenance_total"] = maint_qs.count()

    # 2. Specific equipment search
    if tokens:
        q_asset = Q()
        for t in tokens:
            q_asset |= (
                Q(sku__icontains=t) |
                Q(alias_name__icontains=t) |
                Q(brand__icontains=t) |
                Q(model_number__icontains=t) |
                Q(description__icontains=t) |
                Q(type__icontains=t)
            )

        matched_assets = Asset.objects.filter(q_asset).distinct()
        if matched_assets.exists():
            matched_count = sum(a.quantity or 1 for a in matched_assets)
            avail_cnt = sum(a.quantity or 1 for a in matched_assets.filter(status='Available'))
            in_use_cnt = sum(a.quantity or 1 for a in matched_assets.filter(status='In Use'))
            crosscheck_cnt = sum(a.quantity or 1 for a in matched_assets.filter(status='Crosscheck'))
            maint_cnt = sum(a.quantity or 1 for a in matched_assets.filter(status__in=['Damaged', 'On Service', 'Under Maintenance']))

            # Reconcile exact current conference per active asset
            active_assets = matched_assets.filter(status__in=['In Use', 'Crosscheck'])
            deployments_map = {}
            for a in active_assets:
                # Find the most recent conference associated with this unit
                confs = Conference.objects.filter(crosscheck_assets=a).order_by('-end_date', '-id')
                if not confs.exists():
                    confs = Conference.objects.filter(assets=a).order_by('-end_date', '-id')
                if not confs.exists():
                    confs = Conference.objects.filter(staged_assets=a).order_by('-end_date', '-id')
                
                recent_conf = confs.first()
                if recent_conf:
                    c_name = recent_conf.name
                    if c_name not in deployments_map:
                        is_ongoing = bool((recent_conf.end_date and recent_conf.end_date >= today) or getattr(recent_conf, 'is_ongoing', False))
                        status_tag = "Ongoing / Live Event" if is_ongoing else "Ended / Pending Incheck"
                        deployments_map[c_name] = {
                            "conference_name": c_name,
                            "count": 0,
                            "dates": f"{recent_conf.start_date or 'TBD'} to {recent_conf.end_date or 'TBD'}",
                            "venue": recent_conf.transport_address or recent_conf.billing_address or "Venue not specified",
                            "status": status_tag
                        }
                    deployments_map[c_name]["count"] += (a.quantity or 1)

            deployments = sorted(deployments_map.values(), key=lambda x: x["count"], reverse=True)

            # Model breakdown extracting base model name
            model_counts = {}
            for a in matched_assets:
                base_model = re.sub(r'-\d+$', '', a.sku).replace('_', ' ').title()
                label = f"{base_model} ({a.alias_name})" if a.alias_name and a.alias_name.lower() not in base_model.lower() else base_model
                model_counts[label] = model_counts.get(label, 0) + (a.quantity or 1)

            # Check if user query also specified a conference
            conf_tokens = [t for t in tokens if Conference.objects.filter(name__icontains=t).exists()]
            if conf_tokens:
                filtered_deployments = [d for d in deployments if any(ct in d["conference_name"].lower() for ct in conf_tokens)]
                if filtered_deployments:
                    deployments = filtered_deployments

            display_tokens = [t.capitalize() for t in tokens if not t.endswith('s') or len(t) <= 3]
            if not display_tokens:
                display_tokens = [t.capitalize() for t in tokens]

            context["matched_equipment"] = {
                "search_terms": display_tokens,
                "total_units": matched_count,
                "available_units": avail_cnt,
                "in_use_units": in_use_cnt,
                "crosscheck_units": crosscheck_cnt,
                "active_total": in_use_cnt + crosscheck_cnt,
                "maintenance_units": maint_cnt,
                "deployments": deployments[:8],
                "models": [{"name": k, "count": v} for k, v in sorted(model_counts.items(), key=lambda x: x[1], reverse=True)[:8]]
            }

        # 3. Specific conference search
        q_conf = Q()
        for t in tokens:
            q_conf |= (
                Q(name__icontains=t) |
                Q(transport_address__icontains=t) |
                Q(billing_address__icontains=t)
            )
        matched_confs = Conference.objects.filter(q_conf).distinct().order_by('-start_date')
        if matched_confs.exists():
            conf_list = []
            for c in matched_confs[:6]:
                gear_cnt = c.assets.count() + c.crosscheck_assets.count()
                is_ongoing = bool((c.end_date and c.end_date >= today) or getattr(c, 'is_ongoing', False))
                conf_list.append({
                    "name": c.name,
                    "dates": f"{c.start_date or 'TBD'} to {c.end_date or 'TBD'}",
                    "venue": c.transport_address or c.billing_address or "Venue not specified",
                    "status": "Ongoing / Live" if is_ongoing else "Concluded / Upcoming",
                    "allocated_gear_count": gear_cnt,
                    "contact": f"{c.contact_person} ({c.contact_phone})" if c.contact_person else None
                })
            context["matched_conferences"] = conf_list

    # 4. Ongoing / Upcoming Conferences Overview
    if any(w in q_lower for w in ['ongoing', 'upcoming', 'event', 'events', 'conference', 'conferences', 'schedule']):
        active_confs_qs = [c for c in Conference.objects.all().order_by('-start_date') if (c.end_date and c.end_date >= today) or getattr(c, 'is_ongoing', False)]
        if not active_confs_qs:
            active_confs_qs = list(Conference.objects.all().order_by('-end_date')[:5])
        
        active_list = []
        for c in active_confs_qs[:8]:
            active_list.append({
                "name": c.name,
                "dates": f"{c.start_date or 'TBD'} to {c.end_date or 'TBD'}",
                "venue": c.transport_address or c.billing_address or "Venue not specified",
                "allocated_gear_count": c.assets.count() + c.crosscheck_assets.count()
            })
        context["pipeline_conferences"] = active_list

    return context

def fallback_local_ai(query, context):
    q_lower = query.lower().strip()
    stats = context.get('overall_stats', {})

    # 1. Equipment query match
    eq = context.get('matched_equipment')
    if eq:
        terms_label = " ".join(eq.get('search_terms', []))
        total_units = eq.get('total_units', 0)
        avail = eq.get('available_units', 0)
        in_use = eq.get('in_use_units', 0)
        crosscheck = eq.get('crosscheck_units', 0)
        active_total = eq.get('active_total', 0)
        maint = eq.get('maintenance_units', 0)
        deployments = eq.get('deployments', [])
        models = eq.get('models', [])

        lines = [f"📊 **{terms_label} Equipment Intelligence**\n"]
        lines.append(f"• **Total Units:** {total_units} in system")
        lines.append(f"• 🟢 **Available in Godown:** {avail} units (Ready for deployment)")
        if active_total > 0:
            lines.append(f"• 🟡 **At Events / In Transit:** {active_total} units ({in_use} in use, {crosscheck} in crosscheck)")
        else:
            lines.append(f"• 🟡 **At Events / In Transit:** 0 units")
        if maint > 0:
            lines.append(f"• 🔴 **Damaged / Service:** {maint} units")

        # Deployments / Venues breakdown
        if deployments:
            lines.append(f"\n📍 **Where are the {active_total} units located?**")
            for d in deployments:
                lines.append(
                    f"• **{d['conference_name']}** — {d['count']} units (*{d['status']}*)\n"
                    f"  📍 *Venue:* {d['venue']}\n"
                    f"  📅 *Dates:* {d['dates']}"
                )
        elif active_total > 0:
            lines.append("\n📍 *Current venue records are updating from recent event dispatches.*")

        # Models breakdown
        if models:
            lines.append("\n📦 **Model Inventory Breakdown:**")
            for m in models:
                lines.append(f"• **{m['name']}** — {m['count']} units")

        return "\n".join(lines)

    # 2. Conference query match
    confs = context.get('matched_conferences')
    if confs:
        lines = [f"📅 **Conference & Event Intelligence ({len(confs)} found)**\n"]
        for c in confs:
            lines.append(
                f"• **{c['name']}** (*{c['status']}*)\n"
                f"  📍 *Venue:* {c['venue']}\n"
                f"  📅 *Dates:* {c['dates']}\n"
                f"  📦 *Allocated Gear:* {c['allocated_gear_count']} items"
            )
            if c.get('contact'):
                lines.append(f"  👤 *Contact:* {c['contact']}")
            lines.append("")
        return "\n".join(lines).strip()

    # 3. Maintenance / Damaged Gear query
    if context.get('maintenance_mode'):
        items = context.get('maintenance_items', [])
        total = context.get('maintenance_total', 0)
        if total == 0:
            return "✅ **Fleet Health:** No assets are currently marked as Damaged, On Service, or Under Maintenance. All gear is operational."
        lines = [f"⚠️ **Equipment Needing Service or Repair ({total} units)**\n"]
        for a in items:
            cond = f" — *{a['condition']}*" if a['condition'] != "Unspecified" else ""
            lines.append(f"• **{a['name']}** (`{a['sku']}`) [{a['status']}]{cond}")
        if total > len(items):
            lines.append(f"\n*...and {total - len(items)} more items.*")
        return "\n".join(lines)

    # 4. Pipeline Conferences query
    pipeline = context.get('pipeline_conferences')
    if pipeline and any(w in q_lower for w in ['ongoing', 'upcoming', 'event', 'events', 'conference', 'conferences', 'schedule']):
        lines = ["📅 **Current Conference Pipeline:**\n"]
        for c in pipeline:
            lines.append(
                f"• **{c['name']}**\n"
                f"  📍 *Venue:* {c['venue']}\n"
                f"  📅 *Dates:* {c['dates']} | 📦 Gear: {c['allocated_gear_count']} items\n"
            )
        return "\n".join(lines).strip()

    # 5. Default: Complete System Operational Summary
    tot = stats.get('total_assets', 0)
    avail = stats.get('available_ready', 0)
    in_use = stats.get('currently_in_use', 0)
    crosscheck = stats.get('crosscheck_in_transit', 0)
    maint = stats.get('maintenance_damaged', 0)
    avail_pct = round(avail * 100 / tot) if tot else 0

    return (
        f"📊 **TechTrolley System Overview**\n\n"
        f"• **Total Assets:** {tot} units in fleet\n"
        f"• 🟢 **Ready / Available:** {avail} units ({avail_pct}% godown readiness)\n"
        f"• 🟡 **At Events / In Transit:** {in_use + crosscheck} units ({in_use} in use, {crosscheck} in crosscheck)\n"
        f"• 🔴 **Damaged / Service:** {maint} units\n\n"
        f"💡 **Ask me specifically about:**\n"
        f"• Any equipment: *\"How many Dynatech do we have and where are they?\"*\n"
        f"• Any brand: *\"How many Bose speakers or Sony cameras are available?\"*\n"
        f"• Any event: *\"Where is KENTCON?\"* or *\"What gear is at Grand Hyatt?\"*\n"
        f"• Maintenance: *\"Which gear is damaged or on service?\"*"
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

    # Compile rich, sanitized, privacy-safe context
    context = build_inventory_context(user_query)

    gemini_key = os.environ.get('GEMINI_API_KEY') or getattr(settings, 'GEMINI_API_KEY', None)

    if not gemini_key:
        # Instant local rule engine with high precision
        local_reply = fallback_local_ai(user_query, context)
        return Response({
            "reply": local_reply,
            "engine": "local_rule_engine",
            "status": "success"
        })

    # Call Google Gemini Flash API if key is available
    system_prompt = (
        "You are AM Orbit AI, the senior executive operations intelligence assistant for AM Audiovisuals Pvt. Ltd. (TechTrolley).\n"
        "Rules:\n"
        "1. Strictly base your answer on the provided Live System Context.\n"
        "2. When the user asks about specific equipment (e.g. Dynatech, Bose, Sony), clearly state:\n"
        "   - The total number of units in the system\n"
        "   - How many are available / ready in the godown\n"
        "   - How many are currently in use or at events (crosscheck)\n"
        "   - The exact conference names, venues, dates, and unit counts where active units are located\n"
        "   - Model variations in the fleet\n"
        "3. Use crisp markdown bullet points, bold key figures, and concise executive formatting.\n"
        "4. Never invent numbers not in the context.\n"
        "5. Data privacy is strictly enforced: never disclose passwords, keys, or private financials."
    )

    gemini_endpoint = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={gemini_key}"
    payload = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {
                        "text": f"{system_prompt}\n\nLive System Context:\n{json.dumps(context, indent=2, default=str)}\n\nUser Question:\n{user_query}"
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

        local_reply = fallback_local_ai(user_query, context)
        return Response({
            "reply": local_reply,
            "engine": "fallback_local",
            "status": "api_fallback"
        })
    except Exception:
        local_reply = fallback_local_ai(user_query, context)
        return Response({
            "reply": local_reply,
            "engine": "fallback_local",
            "status": "error_fallback"
        })
