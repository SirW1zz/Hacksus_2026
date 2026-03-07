import urllib.request
import urllib.parse
import json

data = urllib.parse.urlencode({
    'session_id': 'test123',
    'jd_text': 'software engineer'
}).encode()

req = urllib.request.Request('http://localhost:8000/upload-jd', data=data)

try:
    resp = urllib.request.urlopen(req)
    print("SUCCESS:", resp.read().decode())
except urllib.error.HTTPError as e:
    print(f"HTTP Error {e.code}: {e.reason}")
    print("Response body:", e.read().decode())
