import json

data = json.load(open('downloaded_items.json', encoding='utf-8'))
res = {}
count = 0
for i in data:
    u = i.get('UniqueName')
    ln = i.get('LocalizedNames')
    if u and ln and isinstance(ln, dict) and ln.get('EN-US'):
        name = ln.get('EN-US')
        if '@' in u:
            level = u.split('@')[1]
            if not name.endswith(f'.{level}'):
                name = f'{name} .{level}'
        res[u] = name
        count += 1

with open('items.json', 'w', encoding='utf-8') as f:
    json.dump(res, f, indent=2)

print(f'Successfully wrote {count} items to items.json')
