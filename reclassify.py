from core.models import Asset

sound_keywords = ['bose', 'jbl', 'speaker', 'mixer', 'mic', 'shure', 'sennheiser', 'audio', 'stand', 'subwoofer']
it_keywords = ['laptop', 'i3', 'i5', 'i7', 'i9', 'macbook', 'thinkpad', 'switch', 'router', 'dell', 'hp', 'lenovo']
av_keywords = ['led', 'display', 'projector', 'novastar', 'watchout', 'screen', 'tv']

updated_count = 0

assets = Asset.objects.filter(type='Other')

for asset in assets:
    search_string = f"{asset.name} {asset.alias_name} {asset.sku} {asset.description}".lower()
    
    assigned_type = None
    
    if any(kw in search_string for kw in sound_keywords):
        assigned_type = 'Sound System'
    elif any(kw in search_string for kw in it_keywords):
        assigned_type = 'IT & Networking'
    elif any(kw in search_string for kw in av_keywords):
        assigned_type = 'AV Equipment'
        
    if assigned_type:
        print(f"Renormalizing: {asset.name} (SKU: {asset.sku}) -> {assigned_type}")
        asset.type = assigned_type
        asset.save()
        updated_count += 1

print(f"✅ NORMALIZATION COMPLETE! Successfully reclassified {updated_count} historic assets.")
