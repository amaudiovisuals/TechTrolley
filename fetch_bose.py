
import urllib.request
import json
import ssl

token = 'af4a4a12b19dfb49888f04008215605dd8ae26db'
url = 'http://127.0.0.1:8000/api/assets/'
headers = {'Authorization': f'Token {token}'}

req = urllib.request.Request(url, headers=headers)
context = ssl._create_unverified_context()

try:
    with urllib.request.urlopen(req, context=context) as response:
        data = json.loads(response.read().decode())
        found = False
        for asset in data:
            if 'Bose' in asset.get('name', '') or 'Bose' in asset.get('brand', ''):
                print(json.dumps(asset, indent=4))
                found = True
        if not found:
            print("No Bose assets found.")
except Exception as e:
    print(f"Error: {e}")
