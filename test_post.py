import requests

login_res = requests.post('http://localhost:8000/api/login/', json={'username': 'admin', 'password': 'password123'})
token = login_res.json().get('token')

headers = {'Authorization': f'Token {token}'}

payload = {
    "name": "Test Conference",
    "association_name": "Test",
    "billing_address": "Test",
    "transport_address": "Test",
    "gst_number": "",
    "vehicle_number": "",
    "driver_phone": "",
    "contact_person": "",
    "contact_phone": "",
    "contact_email": "",
    "start_date": "2024-05-15",
    "end_date": "2024-05-18",
    "conference_type": "Medical Conference",
    "assets": [],
    "crosscheck_assets": [],
    "assigned_employees": []
}

res = requests.post('http://localhost:8000/api/conferences/', json=payload, headers=headers)
print(res.status_code)
print(res.text)
