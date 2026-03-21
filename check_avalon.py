import json
import urllib.request
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

url = "https://raw.githubusercontent.com/broderickhyman/ao-bin-dumps/master/formatted/items.json"
try:
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, context=ctx) as response:
        data = json.loads(response.read().decode('utf-8'))
    
    print("Searching for FIRESTAFF in UniqueName or EN-US...")
    found = False
    for i in data:
        u = i.get('UniqueName', '')
        if 'FIRESTAFF_AVALON' in u:
            print("Found Avalon Firestaff:")
            print(json.dumps(i, indent=2))
            found = True
        
        ln = i.get('LocalizedNames')
        if ln and isinstance(ln, dict):
            en = ln.get('EN-US', '')
            if 'Dawnsong' in en:
                print("Found Dawnsong by name:")
                print(json.dumps(i, indent=2))
                found = True
    
    if not found:
        print("Could not find any Avalonian fire staffs or 'Dawnsong' in the file.")

except Exception as e:
    print(f"Error: {e}")
