import json

with open('items.json', 'r', encoding='utf-8') as f:
    items = json.load(f)

print(f"Total items in items.json: {len(items)}")

# Read the raw dumped data from network again
import urllib.request
import ssl
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

url = "https://raw.githubusercontent.com/broderickhyman/ao-bin-dumps/master/formatted/items.json"
req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
with urllib.request.urlopen(req, context=ctx) as response:
    data = json.loads(response.read().decode('utf-8'))

for i in data:
    u = i.get('UniqueName', '')
    if 'Dawnsong' in str(i):
        ln = i.get('LocalizedNames')
        print(f"Checking {u}:")
        print(f"  u is truthy? {bool(u)}")
        print(f"  ln is truthy? {bool(ln)}")
        print(f"  isinstance(ln, dict)? {isinstance(ln, dict)}")
        if isinstance(ln, dict):
            print(f"  ln.get('EN-US'): {ln.get('EN-US')}")
        print(f"  In items.json? {u in items}")
