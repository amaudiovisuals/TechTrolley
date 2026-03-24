from core.models import Asset

# Comprehensive reclassification rules - ordered from most specific to least
# Format: (keywords_to_match_in_sku, target_category)
RULES = [
    # Sound System - Speakers, Amps, Mics, Mixers, Audio
    (['BOSE', 'JBL', 'YAMAHA_DBR', 'YAMAHA_MG', 'QUEST_QSA', 'SOUNDBLASTER', 'ZEBRONICS_PORTABLE_BT_SPEAKER', 'SOUNDCRAFT', 'ALLEN', 'MIDAS', 'DYNATECH', 'SHURE', 'HOLLYLAND_LARK', 'JTS_GM', 'SPEAKON', 'XLR', 'AUDIO_ARRAY', 'DBC_AUDIO', 'HANUTECH_XLR', 'BEHRINGER', 'MICROWARE_SDI_SPLITTER', 'GR_DIGITAL_MIXER'], 'Sound System'),
    # AV Equipment - Projectors, Monitors, TVs, Cameras, Switchers, LED
    (['EPSON_PROJECTOR', 'SONY_4K', 'SONY_HANDYCAM', 'SONY_XDCAM', 'PANASONIC_DIGITAL_AV', 'PANASONIC_TH', 'RECONNECT_LED_TV', 'RECONNECT_FHD_LED_TV', 'SAMSUNG_SA100', 'SAMSUNG_LS24', 'LG_22MA33', 'LG_16M38', 'LG_ULTRAGEAR', 'LG__QHD', 'GOOGLE_TV', 'MAAK_LED', 'HOLLYLAND_PYRO', 'HOLLYLAND_WIRELESS'], 'AV Equipment'),
    # LED Wall - LED screens and processors
    (['HAWAII_P2', 'NOVASTAR', 'NOVA_STAR'], 'LED Wall'),
    # IT & Networking - Laptops, Monitors, Mice, Keyboards, Printers, Hubs, Servers
    (['ASUS_LAPTOP', 'HP_LAPTOP', 'HP_14', 'HP_240', 'HP_VICTUS', 'DELL_LAPTOP', 'ACER_LAPTOP', 'LENOVO_LAPTOP', 'MSI_LAPTOP', 'MACBOOK', 'MAC_A', 'LAPTOP_AVITA', 'LAP_TOP', 'LAPTOP',
      'DLINK', 'CISCO_110', 'HP_J9794', 'TENDA_AC', 'TP-LINK_AC', 'TP-LINK_GIGABIT',
      'DELL_D1918', 'PHILIPS_V', 'LCD_MONITOR', 'LG_ULTRAGEAR_IPS', 'LG_ULTRAGEAR_QHD',
      'HP_LASERJET', 'HP_PRINTER', 'PRINTERSCANNER', 'BROTHER', 'PRINTER_CATRIDGE', 'EPSON_BLACK',
      'TP_LINK_UH700', 'TP_LINK_USB_HUB', 'IBELL_MOUSE', 'PUNTA_MOUSE', 'LAPCARE_MOUSE', 'GENIUS_MOUSE', 'LOGITECH_WIRED', 'LENOVO_MOUSE',
      'LAPCARE_WIRED', 'LOGI_K380', 'ZEBRONICS_K04', 'ZEBRONICS_ZEB', 'ENTER_KEYBOARD', 'LAPCARE_WIRED_KEY',
      'SERVER', 'WD_MY_CLOUD', 'IQOO', 'SAMSUNG_GALAXY', 'IBELL', 'PUNTA', 'LAPCARE',
      'TUKZER_MOUSE'], 'IT & Networking'),
    # Power
    (['EATON', 'POWER_CABLE', 'POWER_DB', 'UPS'], 'Power'),
    # Consumables - Cables, Adapters, Splitters, Connectors, Hubs, Fiber
    (['HDMI_CABLE', 'HDMI_SHORT', 'HDMI_LONG', 'HDMI_FIBRE', 'HDMI_SPLITTER', 'HDMI/KVM',
      'SDI_CABLE', 'SDI_LONG', 'SDI_OVER_FIBER', 'SDI',
      'LAN_CABLE', 'LED_WALL_LAN',
      'DMX_CABLE',
      'ETZIN_HDMI', 'XTREMPRO_HDMI',
      'ATEM_MINI', 'AVMATRIX', 'FEELWORLD', 'FJ-GEAR', 'MONOPRICE', 'IMPRESSIONS_1X', 'NT_HDMI', 'OREI_HDMI', 'NT_MULTI', 'MULTI_TO_SDI', 'SENON_MULTI', 'HDMI_SPLITTER_1', 'HDMI/KVM',
      'DVI', 'SDI', 'MULTI_TO', 'FIBER',
      'PRINTER_CATRIDGE', 'IBELL_MOUSE', 'LAPCARE_MOUSE', 'PUNTA_MOUSE'],
     'Consumables'),
]

# Specific overrides for items that might hit wrong rules
IT_SWITCHER_OVERRIDES = ['ATEM_MINI', 'AVMATRIX', 'FEELWORLD', 'PANASONIC_DIGITAL_AV_MIXER']

updated_count = 0
already_correct = 0
skipped = 0

assets = Asset.objects.all()

for asset in assets:
    sku = (asset.sku or '').upper()
    name = (asset.name or '').upper()
    alias = (asset.alias_name or '').upper()
    search = f"{sku} {name} {alias}"
    
    assigned_type = None
    
    for keywords, category in RULES:
        if any(kw.upper() in search for kw in keywords):
            assigned_type = category
            break
    
    if assigned_type:
        if asset.type == assigned_type:
            already_correct += 1
        else:
            print(f"  [{asset.type}] -> [{assigned_type}]  |  {asset.sku}")
            asset.type = assigned_type
            asset.save()
            updated_count += 1
    else:
        skipped += 1

print(f"\n✅ DONE! reclassified={updated_count}, unchanged={already_correct}, unmatched={skipped}")
