import requests
import json

BASE_URL = 'http://127.0.0.1:8000'
LOGIN_URL = f'{BASE_URL}/api/login/'
ASSET_URL = f'{BASE_URL}/api/assets/'

EMAIL = 'nihal@amaudiovisuals.com'
PASSWORD = 'Nihal123@'

def test_add_asset():
    session = requests.Session()
    
    # Login
    print(f"Logging in...")
    resp = session.post(LOGIN_URL, json={'email': EMAIL, 'password': PASSWORD})
    if resp.status_code != 200:
        print(f"Login Failed: {resp.text}")
        return
    token = resp.json()['token']
    
    # Add Asset with "Sound System" category
    headers = {'Authorization': f'Token {token}'}
    payload = {
        "name": "Test Speaker",
        "brand": "JBL",
        "model_number": "XYZ-123",
        "serial_number": "SN-TEST-CAT-01",
        "category": "Sound System",  # This was failing before
        "status": "Available",
        "unit_price": 1000,
        "sku": "SKU-TEST-CAT-01",
        "barcode": "123456789",
        "condition": "Good"
    }
    
    print(f"Adding asset with category='Sound System'...")
    resp = requests.post(ASSET_URL, json=payload, headers=headers)
    print(f"Status: {resp.status_code}")
    print(f"Response: {resp.text}")

if __name__ == '__main__':
    test_add_asset()
