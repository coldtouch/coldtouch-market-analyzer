import json
import urllib.request
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

url = "https://raw.githubusercontent.com/broderickhyman/ao-bin-dumps/master/formatted/items.json"
try:
    print("Downloading updated items list...")
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, context=ctx) as response:
        data = json.loads(response.read().decode('utf-8'))
    
    print(f"Downloaded {len(data)} items.")
    res = {}
    count = 0
    for i in data:
        u = i.get('UniqueName')
        ln = i.get('LocalizedNames')
        if u and ln and isinstance(ln, dict) and ln.get('EN-US'):
            name = ln.get('EN-US')
            name = ' '.join(name.split())
            if '@' in u:
                level = u.split('@')[1]
                if not name.endswith(f'.{level}'):
                    name = f'{name} .{level}'
            res[u] = name
            count += 1
    
    with open('items.json', 'w', encoding='utf-8') as f:
        json.dump(res, f, indent=2)
    print(f"Successfully generated items.json with {count} items!")

except Exception as e:
    print(f"Error: {e}")
