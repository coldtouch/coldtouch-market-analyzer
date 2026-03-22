import json

with open('recipes.json', 'r', encoding='utf-8') as f:
    recipes = json.load(f)

with open('consumables_recipes_dump.json', 'r', encoding='utf-8') as cf:
    consumables = json.load(cf)

recipes.update(consumables)

with open('recipes.json', 'w', encoding='utf-8') as f:
    json.dump(recipes, f, indent=2)

print(f"Added {len(consumables)} consumable recipes to recipes.json")
