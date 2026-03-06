import requests
import json

BASE_URL = 'http://127.0.0.1:8000'
LOGIN_URL = f'{BASE_URL}/api/login/'
USER_URL = f'{BASE_URL}/api/system-users/'

# Credentials
EMAIL = 'nihal@amaudiovisuals.com'
PASSWORD = 'Nihal123@'

def test_add_user():
    session = requests.Session()
    
    # 1. Login
    print(f"Logging in as {EMAIL}...")
    try:
        login_resp = session.post(LOGIN_URL, json={'email': EMAIL, 'password': PASSWORD})
        if login_resp.status_code != 200:
            print(f"Login Failed: {login_resp.status_code} - {login_resp.text}")
            return
        token = login_resp.json().get('token')
        print(f"Login Success! Token: {token[:10]}...")
    except Exception as e:
        print(f"Connection Error during Login: {e}")
        return

    # 2. Add User
    headers = {'Authorization': f'Token {token}'}
    new_user = {'email': 'bhavin_test@amaudiovisuals.com', 'password': 'TestPassword123!'}
    
    print(f"Adding user {new_user['email']}...")
    try:
        add_resp = session.post(USER_URL, json=new_user, headers=headers)
        print(f"Response Status: {add_resp.status_code}")
        print(f"Response Body: {add_resp.text}")
    except Exception as e:
        print(f"Connection Error during Add User: {e}")

if __name__ == '__main__':
    test_add_user()
