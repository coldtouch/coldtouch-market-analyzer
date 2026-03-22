"""
Build comprehensive recipes.json for Albion Online crafting calculator.

Albion crafting follows strict systematic rules:
- Armor pieces: Head = 8, Armor = 16, Shoes = 8 of the primary refined resource
- 1H Weapons: 16 primary + 8 secondary
- 2H Weapons: 32 primary (or 20 primary + 12 secondary for some)
- Off-hands: 8 primary
- Bags: 8 cloth + 8 leather
- Capes: 4 cloth + 4 leather
- Refined materials: N raw + 1 lower tier refined (N varies by tier: T4=2, T5=3, T6=4, T7=5, T8=5)
- Enchanted items use enchanted materials (e.g. T4_METALBAR@1 for T4.1 gear)

This script generates recipes for T4-T8, all sets, all enchantments.
"""

import json

RAW_MULTIPLIER = {4: 2, 5: 3, 6: 4, 7: 5, 8: 5}

# ========== REFINING RECIPES ==========
REFINE_TYPES = {
    'PLANKS': 'WOOD',
    'METALBAR': 'ORE',
    'LEATHER': 'HIDE',
    'CLOTH': 'FIBER',
    'STONEBLOCK': 'ROCK',
}

# ========== GEAR DEFINITIONS ==========
# Format: (item_id_suffix, category, materials_spec)
# materials_spec is a list of (resource_type, quantity)
# resource_type: METALBAR, PLANKS, LEATHER, CLOTH

PLATE_ARMOR = [
    ('HEAD_PLATE_SET1', [('METALBAR', 8)]),
    ('ARMOR_PLATE_SET1', [('METALBAR', 16)]),
    ('SHOES_PLATE_SET1', [('METALBAR', 8)]),
    ('HEAD_PLATE_SET2', [('METALBAR', 8)]),
    ('ARMOR_PLATE_SET2', [('METALBAR', 16)]),
    ('SHOES_PLATE_SET2', [('METALBAR', 8)]),
    ('HEAD_PLATE_SET3', [('METALBAR', 8)]),
    ('ARMOR_PLATE_SET3', [('METALBAR', 16)]),
    ('SHOES_PLATE_SET3', [('METALBAR', 8)]),
    # Undead plate (Graveguard)
    ('HEAD_PLATE_UNDEAD', [('METALBAR', 8)]),
    ('ARMOR_PLATE_UNDEAD', [('METALBAR', 16)]),
    ('SHOES_PLATE_UNDEAD', [('METALBAR', 8)]),
    # Keeper plate
    ('HEAD_PLATE_KEEPER', [('METALBAR', 8)]),
    ('ARMOR_PLATE_KEEPER', [('METALBAR', 16)]),
    ('SHOES_PLATE_KEEPER', [('METALBAR', 8)]),
    # Avalon plate
    ('HEAD_PLATE_AVALON', [('METALBAR', 8)]),
    ('ARMOR_PLATE_AVALON', [('METALBAR', 16)]),
    ('SHOES_PLATE_AVALON', [('METALBAR', 8)]),
    # Morgana plate
    ('HEAD_PLATE_MORGANA', [('METALBAR', 8)]),
    ('ARMOR_PLATE_MORGANA', [('METALBAR', 16)]),
    ('SHOES_PLATE_MORGANA', [('METALBAR', 8)]),
    # Demon plate (Fiend)
    ('HEAD_PLATE_HELL', [('METALBAR', 8)]),
    ('ARMOR_PLATE_HELL', [('METALBAR', 16)]),
    ('SHOES_PLATE_HELL', [('METALBAR', 8)]),
]

LEATHER_ARMOR = [
    ('HEAD_LEATHER_SET1', [('LEATHER', 8)]),
    ('ARMOR_LEATHER_SET1', [('LEATHER', 16)]),
    ('SHOES_LEATHER_SET1', [('LEATHER', 8)]),
    ('HEAD_LEATHER_SET2', [('LEATHER', 8)]),
    ('ARMOR_LEATHER_SET2', [('LEATHER', 16)]),
    ('SHOES_LEATHER_SET2', [('LEATHER', 8)]),
    ('HEAD_LEATHER_SET3', [('LEATHER', 8)]),
    ('ARMOR_LEATHER_SET3', [('LEATHER', 16)]),
    ('SHOES_LEATHER_SET3', [('LEATHER', 8)]),
    ('HEAD_LEATHER_UNDEAD', [('LEATHER', 8)]),
    ('ARMOR_LEATHER_UNDEAD', [('LEATHER', 16)]),
    ('SHOES_LEATHER_UNDEAD', [('LEATHER', 8)]),
    ('HEAD_LEATHER_KEEPER', [('LEATHER', 8)]),
    ('ARMOR_LEATHER_KEEPER', [('LEATHER', 16)]),
    ('SHOES_LEATHER_KEEPER', [('LEATHER', 8)]),
    ('HEAD_LEATHER_AVALON', [('LEATHER', 8)]),
    ('ARMOR_LEATHER_AVALON', [('LEATHER', 16)]),
    ('SHOES_LEATHER_AVALON', [('LEATHER', 8)]),
    ('HEAD_LEATHER_MORGANA', [('LEATHER', 8)]),
    ('ARMOR_LEATHER_MORGANA', [('LEATHER', 16)]),
    ('SHOES_LEATHER_MORGANA', [('LEATHER', 8)]),
    ('HEAD_LEATHER_HELL', [('LEATHER', 8)]),
    ('ARMOR_LEATHER_HELL', [('LEATHER', 16)]),
    ('SHOES_LEATHER_HELL', [('LEATHER', 8)]),
    ('HEAD_LEATHER_FEY', [('LEATHER', 8)]),
    ('ARMOR_LEATHER_FEY', [('LEATHER', 16)]),
    ('SHOES_LEATHER_FEY', [('LEATHER', 8)]),
]

CLOTH_ARMOR = [
    ('HEAD_CLOTH_SET1', [('CLOTH', 8)]),
    ('ARMOR_CLOTH_SET1', [('CLOTH', 16)]),
    ('SHOES_CLOTH_SET1', [('CLOTH', 8)]),
    ('HEAD_CLOTH_SET2', [('CLOTH', 8)]),
    ('ARMOR_CLOTH_SET2', [('CLOTH', 16)]),
    ('SHOES_CLOTH_SET2', [('CLOTH', 8)]),
    ('HEAD_CLOTH_SET3', [('CLOTH', 8)]),
    ('ARMOR_CLOTH_SET3', [('CLOTH', 16)]),
    ('SHOES_CLOTH_SET3', [('CLOTH', 8)]),
    ('HEAD_CLOTH_UNDEAD', [('CLOTH', 8)]),
    ('ARMOR_CLOTH_UNDEAD', [('CLOTH', 16)]),
    ('SHOES_CLOTH_UNDEAD', [('CLOTH', 8)]),
    ('HEAD_CLOTH_KEEPER', [('CLOTH', 8)]),
    ('ARMOR_CLOTH_KEEPER', [('CLOTH', 16)]),
    ('SHOES_CLOTH_KEEPER', [('CLOTH', 8)]),
    ('HEAD_CLOTH_AVALON', [('CLOTH', 8)]),
    ('ARMOR_CLOTH_AVALON', [('CLOTH', 16)]),
    ('SHOES_CLOTH_AVALON', [('CLOTH', 8)]),
    ('HEAD_CLOTH_MORGANA', [('CLOTH', 8)]),
    ('ARMOR_CLOTH_MORGANA', [('CLOTH', 16)]),
    ('SHOES_CLOTH_MORGANA', [('CLOTH', 8)]),
    ('HEAD_CLOTH_HELL', [('CLOTH', 8)]),
    ('ARMOR_CLOTH_HELL', [('CLOTH', 16)]),
    ('SHOES_CLOTH_HELL', [('CLOTH', 8)]),
]

# 1H weapons: 16 primary + 8 secondary
WEAPONS_1H = [
    # Swords (metal + leather)
    ('MAIN_SWORD', [('METALBAR', 16), ('LEATHER', 8)]),
    # Axes
    ('MAIN_AXE', [('METALBAR', 16), ('LEATHER', 8)]),
    # Maces
    ('MAIN_MACE', [('METALBAR', 16), ('LEATHER', 8)]),
    # Hammers
    ('MAIN_HAMMER', [('METALBAR', 16), ('PLANKS', 8)]),
    # Daggers
    ('MAIN_DAGGER', [('METALBAR', 16), ('LEATHER', 8)]),
    # Spears
    ('MAIN_SPEAR', [('METALBAR', 16), ('PLANKS', 8)]),
    # Nature staffs
    ('MAIN_NATURESTAFF', [('PLANKS', 16), ('CLOTH', 8)]),
    # Fire staffs
    ('MAIN_FIRESTAFF', [('PLANKS', 16), ('METALBAR', 8)]),
    # Holy staffs
    ('MAIN_HOLYSTAFF', [('PLANKS', 16), ('CLOTH', 8)]),
    # Arcane staffs
    ('MAIN_ARCANESTAFF', [('PLANKS', 16), ('METALBAR', 8)]),
    # Frost staffs
    ('MAIN_FROSTSTAFF', [('PLANKS', 16), ('CLOTH', 8)]),
    # Cursed staffs
    ('MAIN_CURSEDSTAFF', [('PLANKS', 16), ('CLOTH', 8)]),
    # Crossbows
    ('MAIN_CROSSBOW', [('METALBAR', 16), ('PLANKS', 8)]),
]

# 2H weapons: 32 primary (or mixed)
WEAPONS_2H = [
    # 2H Swords
    ('2H_CLAYMORE', [('METALBAR', 20), ('LEATHER', 12)]),
    ('2H_DUALSWORD', [('METALBAR', 20), ('LEATHER', 12)]),
    ('2H_CLEAVER', [('METALBAR', 20), ('LEATHER', 12)]),
    ('2H_DUALSCIMITAR_UNDEAD', [('METALBAR', 20), ('LEATHER', 12)]),
    ('2H_CLAYMORE_AVALON', [('METALBAR', 20), ('LEATHER', 12)]),
    # 2H Axes
    ('2H_HALBERD', [('METALBAR', 20), ('LEATHER', 12)]),
    ('2H_SCYTHE', [('METALBAR', 20), ('LEATHER', 12)]),
    ('2H_DUALAXE', [('METALBAR', 20), ('LEATHER', 12)]),
    ('2H_HALBERD_MORGANA', [('METALBAR', 20), ('LEATHER', 12)]),
    # 2H Maces
    ('2H_MACE', [('METALBAR', 20), ('LEATHER', 12)]),
    ('2H_FLAIL', [('METALBAR', 20), ('LEATHER', 12)]),
    ('2H_DUALMACE', [('METALBAR', 20), ('LEATHER', 12)]),
    # Quarterstaffs
    ('2H_QUARTERSTAFF', [('PLANKS', 20), ('LEATHER', 12)]),
    ('2H_IRONCLADEDSTAFF', [('PLANKS', 20), ('LEATHER', 12)]),
    ('2H_DOUBLEBLADEDSTAFF', [('PLANKS', 20), ('LEATHER', 12)]),
    ('2H_COMBATSTAFF_MORGANA', [('PLANKS', 20), ('LEATHER', 12)]),
    # Hammers
    ('2H_POLEHAMMER', [('METALBAR', 20), ('PLANKS', 12)]),
    ('2H_HAMMER', [('METALBAR', 20), ('PLANKS', 12)]),
    ('2H_HAMMER_UNDEAD', [('METALBAR', 20), ('PLANKS', 12)]),
    ('2H_DUALHAMMER', [('METALBAR', 20), ('PLANKS', 12)]),
    # Daggers
    ('2H_CLAWPAIR', [('METALBAR', 20), ('LEATHER', 12)]),
    ('2H_DAGGER_KATAR', [('METALBAR', 20), ('LEATHER', 12)]),
    ('2H_DAGGERPAIR', [('METALBAR', 20), ('LEATHER', 12)]),
    # Spears
    ('2H_GLAIVE', [('METALBAR', 20), ('PLANKS', 12)]),
    ('2H_PIKE', [('METALBAR', 20), ('PLANKS', 12)]),
    ('2H_TRIDENT_UNDEAD', [('METALBAR', 20), ('PLANKS', 12)]),
    ('2H_HARPOON_HELL', [('METALBAR', 20), ('PLANKS', 12)]),
    # Bows
    ('2H_BOW', [('PLANKS', 32)]),
    ('2H_LONGBOW', [('PLANKS', 20), ('LEATHER', 12)]),
    ('2H_WARBOW', [('PLANKS', 20), ('LEATHER', 12)]),
    ('2H_BOW_KEEPER', [('PLANKS', 20), ('LEATHER', 12)]),
    ('2H_LONGBOW_UNDEAD', [('PLANKS', 20), ('LEATHER', 12)]),
    ('2H_BOW_AVALON', [('PLANKS', 20), ('LEATHER', 12)]),
    # Crossbows
    ('2H_CROSSBOW', [('METALBAR', 20), ('PLANKS', 12)]),
    ('2H_CROSSBOWLARGE', [('METALBAR', 20), ('PLANKS', 12)]),
    ('2H_REPEATINGCROSSBOW_UNDEAD', [('METALBAR', 20), ('PLANKS', 12)]),
    # Fire staffs
    ('2H_FIRESTAFF', [('PLANKS', 20), ('METALBAR', 12)]),
    ('2H_INFERNOSTAFF', [('PLANKS', 20), ('METALBAR', 12)]),
    ('2H_FIRESTAFF_KEEPER', [('PLANKS', 20), ('METALBAR', 12)]),
    ('2H_FIRE_RINGPAIR_AVALON', [('PLANKS', 20), ('METALBAR', 12)]),
    # Holy staffs
    ('2H_HOLYSTAFF', [('PLANKS', 20), ('CLOTH', 12)]),
    ('2H_DIVINESTAFF', [('PLANKS', 20), ('CLOTH', 12)]),
    ('2H_HOLYSTAFF_UNDEAD', [('PLANKS', 20), ('CLOTH', 12)]),
    ('2H_HOLYSTAFF_HELL', [('PLANKS', 20), ('CLOTH', 12)]),
    ('2H_HOLYSTAFF_MORGANA', [('PLANKS', 20), ('CLOTH', 12)]),
    # Nature staffs
    ('2H_NATURESTAFF', [('PLANKS', 20), ('CLOTH', 12)]),
    ('2H_WILDSTAFF', [('PLANKS', 20), ('CLOTH', 12)]),
    ('2H_NATURESTAFF_KEEPER', [('PLANKS', 20), ('CLOTH', 12)]),
    ('2H_NATURESTAFF_HELL', [('PLANKS', 20), ('CLOTH', 12)]),
    # Frost staffs
    ('2H_FROSTSTAFF', [('PLANKS', 20), ('CLOTH', 12)]),
    ('2H_GLACIALSTAFF', [('PLANKS', 20), ('CLOTH', 12)]),
    ('2H_ICEGAUNTLETS', [('PLANKS', 20), ('CLOTH', 12)]),
    ('2H_FROSTSTAFF_KEEPER', [('PLANKS', 20), ('CLOTH', 12)]),
    # Arcane staffs
    ('2H_ARCANESTAFF', [('PLANKS', 20), ('METALBAR', 12)]),
    ('2H_ENIGMATICSTAFF', [('PLANKS', 20), ('METALBAR', 12)]),
    ('2H_ENIGMATICORB_MORGANA', [('PLANKS', 20), ('METALBAR', 12)]),
    # Cursed staffs
    ('2H_CURSEDSTAFF', [('PLANKS', 20), ('CLOTH', 12)]),
    ('2H_DEMONICSTAFF', [('PLANKS', 20), ('CLOTH', 12)]),
    ('2H_SKULLORB_HELL', [('PLANKS', 20), ('CLOTH', 12)]),
    ('2H_CURSEDSTAFF_UNDEAD', [('PLANKS', 20), ('CLOTH', 12)]),
    # Shapeshifter staffs (20 Wood + 12 Leather)
    ('2H_SHAPESHIFTER_SET1', [('PLANKS', 20), ('LEATHER', 12)]),
    ('2H_SHAPESHIFTER_SET2', [('PLANKS', 20), ('LEATHER', 12)]),
    ('2H_SHAPESHIFTER_SET3', [('PLANKS', 20), ('LEATHER', 12)]),
    ('2H_SHAPESHIFTER_MORGANA', [('PLANKS', 20), ('LEATHER', 12)]),
    ('2H_SHAPESHIFTER_HELL', [('PLANKS', 20), ('LEATHER', 12)]),
    ('2H_SHAPESHIFTER_KEEPER', [('PLANKS', 20), ('LEATHER', 12)]),
    ('2H_SHAPESHIFTER_AVALON', [('PLANKS', 20), ('LEATHER', 12)]),
    ('2H_SHAPESHIFTER_CRYSTAL', [('PLANKS', 20), ('LEATHER', 12)]),
]

OFFHANDS = [
    ('OFF_SHIELD', [('METALBAR', 8)]),
    ('OFF_TOWERSHIELD_UNDEAD', [('METALBAR', 8)]),
    ('OFF_SPIKEDSHIELD_MORGANA', [('METALBAR', 8)]),
    ('OFF_SHIELD_HELL', [('METALBAR', 8)]),
    ('OFF_SHIELD_AVALON', [('METALBAR', 8)]),
    ('OFF_BOOK', [('CLOTH', 8)]),
    ('OFF_TORCH', [('LEATHER', 8)]),
    ('OFF_HORN_KEEPER', [('LEATHER', 8)]),
    ('OFF_JESTERCANE_HELL', [('PLANKS', 8)]),
    ('OFF_LAMP_UNDEAD', [('METALBAR', 8)]),
    ('OFF_CENSER_AVALON', [('METALBAR', 8)]),
    ('OFF_TOTEM_KEEPER', [('PLANKS', 8)]),
    ('OFF_TALISMAN_AVALON', [('CLOTH', 8)]),
]

BAGS_CAPES = [
    ('BAG', [('CLOTH', 8), ('LEATHER', 8)]),
    ('CAPE', [('CLOTH', 4), ('LEATHER', 4)]),
    ('CAPEITEM_FW_BRIDGEWATCH', [('CLOTH', 4), ('LEATHER', 4)]),
    ('CAPEITEM_FW_FORTSTERLING', [('CLOTH', 4), ('LEATHER', 4)]),
    ('CAPEITEM_FW_LYMHURST', [('CLOTH', 4), ('LEATHER', 4)]),
    ('CAPEITEM_FW_MARTLOCK', [('CLOTH', 4), ('LEATHER', 4)]),
    ('CAPEITEM_FW_THETFORD', [('CLOTH', 4), ('LEATHER', 4)]),
    ('CAPEITEM_MORGANA', [('CLOTH', 4), ('LEATHER', 4)]),
    ('CAPEITEM_UNDEAD', [('CLOTH', 4), ('LEATHER', 4)]),
    ('CAPEITEM_KEEPER', [('CLOTH', 4), ('LEATHER', 4)]),
    ('CAPEITEM_HELL', [('CLOTH', 4), ('LEATHER', 4)]),
    ('CAPEITEM_AVALON', [('CLOTH', 4), ('LEATHER', 4)]),
]


def generate_recipes():
    recipes = {}
    
    # 1. Refining recipes (T3-T8)
    for tier in range(3, 9):
        for refined, raw in REFINE_TYPES.items():
            item_id = f'T{tier}_{refined}'
            mats = [{'id': f'T{tier}_{raw}', 'qty': RAW_MULTIPLIER.get(tier, 2)}]
            if tier >= 4:
                mats.append({'id': f'T{tier-1}_{refined}', 'qty': 1})
            recipes[item_id] = {'materials': mats, 'category': 'materials'}
            
            # Enchanted refining (T4-T8)
            if tier >= 4:
                for ench in range(1, 5):
                    ench_id = f'{item_id}@{ench}'
                    ench_mats = [{'id': f'T{tier}_{raw}_LEVEL{ench}@{ench}', 'qty': RAW_MULTIPLIER.get(tier, 2)}]
                    if tier >= 4:
                        ench_mats.append({'id': f'T{tier-1}_{refined}@{ench}', 'qty': 1})
                    recipes[ench_id] = {'materials': ench_mats, 'category': 'materials'}
    
    # 2. Gear recipes (T4-T8)
    all_gear = (
        [(s, m, 'armor') for s, m in PLATE_ARMOR] +
        [(s, m, 'armor') for s, m in LEATHER_ARMOR] +
        [(s, m, 'armor') for s, m in CLOTH_ARMOR] +
        [(s, m, 'weapons') for s, m in WEAPONS_1H] +
        [(s, m, 'weapons') for s, m in WEAPONS_2H] +
        [(s, m, 'offhand') for s, m in OFFHANDS] +
        [(s, m, 'accessories') for s, m in BAGS_CAPES]
    )
    
    for tier in range(4, 9):
        for suffix, mat_spec, category in all_gear:
            item_id = f'T{tier}_{suffix}'
            mats = [{'id': f'T{tier}_{res}', 'qty': qty} for res, qty in mat_spec]
            recipes[item_id] = {'materials': mats, 'category': category}
            
            # Enchanted variants
            for ench in range(1, 5):
                ench_id = f'{item_id}@{ench}'
                ench_mats = [{'id': f'T{tier}_{res}_LEVEL{ench}@{ench}', 'qty': qty} for res, qty in mat_spec]
                recipes[ench_id] = {'materials': ench_mats, 'category': category}
    
    return recipes


if __name__ == '__main__':
    recipes = generate_recipes()
    
    # Merge consumables if dump exists
    import os
    if os.path.exists('consumables_recipes_dump.json'):
        with open('consumables_recipes_dump.json', 'r', encoding='utf-8') as cf:
            consumables = json.load(cf)
            recipes.update(consumables)

    with open('recipes.json', 'w', encoding='utf-8') as f:
        json.dump(recipes, f, indent=2)
    
    # Stats
    cats = {}
    for r in recipes.values():
        c = r['category']
        cats[c] = cats.get(c, 0) + 1
    
    print(f"Generated {len(recipes)} recipes:")
    for cat, count in sorted(cats.items()):
        print(f"  {cat}: {count}")
