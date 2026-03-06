import json
import urllib.request
import urllib.parse
import sys

BASE_URL = "http://127.0.0.1:8000/api/conferences/"
AUTH_TOKEN = "9eb2a4cc6e66cc7588e7d33ed1cdedfd79c5afa9"

def get_headers():
    return {
        'Content-Type': 'application/json',
        'Authorization': f'Token {AUTH_TOKEN}'
    }

def create_conference():
    data = {
        "name": "Test Conference API",
        "association_name": "Test Association",
        "billing_address": "123 Test St",
        "transport_address": "456 Logistics Ave",
        "gst_number": "GST123456789",
        "start_date": "2023-10-01",
        "end_date": "2023-10-05",
        "conference_type": "Medical Conference",
        "contact_person": "John Doe",
        "contact_phone": "555-1234",
        "contact_email": "john@example.com",
        "assets": [] 
    }
    
    req = urllib.request.Request(
        BASE_URL, 
        data=json.dumps(data).encode('utf-8'),
        headers=get_headers()
    )
    
    try:
        with urllib.request.urlopen(req) as response:
            if response.status == 201:
                result = json.loads(response.read().decode())
                print(f"[SUCCESS] Created Conference ID: {result['id']}")
                return result['id']
            else:
                print(f"[ERROR] Failed to create. Status: {response.status}")
                print(response.read().decode())
                return None
    except Exception as e:
        print(f"[ERROR] Exception during create: {e}")
        return None

def get_conference(conf_id):
    url = f"{BASE_URL}{conf_id}/"
    req = urllib.request.Request(url, headers=get_headers())
    try:
        with urllib.request.urlopen(req) as response:
            if response.status == 200:
                result = json.loads(response.read().decode())
                print(f"[SUCCESS] Retrieved Conference: {result['name']}")
                # Verify new fields
                if result.get('transport_address') == "456 Logistics Ave":
                     print("[SUCCESS] Verified transport_address")
                else:
                     print(f"[FAILURE] transport_address mismatch: {result.get('transport_address')}")
                     
                if result.get('gst_number') == "GST123456789":
                     print("[SUCCESS] Verified gst_number")
                else:
                     print(f"[FAILURE] gst_number mismatch: {result.get('gst_number')}")
                return result
            else:
                 print(f"[ERROR] Failed to get. Status: {response.status}")
    except Exception as e:
        print(f"[ERROR] Exception during get: {e}")

def update_conference(conf_id):
    url = f"{BASE_URL}{conf_id}/"
    data = {
        "name": "Updated Conference Name",
        "transport_address": "Updated Logistics Ave"
    }
    
    req = urllib.request.Request(
        url, 
        data=json.dumps(data).encode('utf-8'),
        headers=get_headers(),
        method='PATCH'
    )
    
    try:
        with urllib.request.urlopen(req) as response:
            if response.status == 200:
                 print(f"[SUCCESS] Updated Conference ID: {conf_id}")
            else:
                 print(f"[ERROR] Failed to update. Status: {response.status}")
    except Exception as e:
        print(f"[ERROR] Exception during update: {e}")

def delete_conference(conf_id):
    url = f"{BASE_URL}{conf_id}/"
    req = urllib.request.Request(url, headers=get_headers(), method='DELETE')
    
    try:
        with urllib.request.urlopen(req) as response:
            if response.status == 204:
                 print(f"[SUCCESS] Deleted Conference ID: {conf_id}")
            else:
                 print(f"[ERROR] Failed to delete. Status: {response.status}")
    except Exception as e:
        print(f"[ERROR] Exception during delete: {e}")

if __name__ == "__main__":
    with open("verification.log", "w") as f:
        sys.stdout = f
        sys.stderr = f
        print("Starting Verification...")
        new_id = create_conference()
        if new_id:
            get_conference(new_id)
            update_conference(new_id)
            delete_conference(new_id)
        print("Verification Finished.")
