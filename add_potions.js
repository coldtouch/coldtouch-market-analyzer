const fs = require('fs');
const path = require('path');

const recipesPath = path.join(__dirname, 'recipes.json');
const recipes = JSON.parse(fs.readFileSync(recipesPath, 'utf8'));

// Potions output 5 per craft
const EXTRACTS = {
    1: 'T1_ALCHEMY_EXTRACT_LEVEL1', // Basic (used for .1)
    2: 'T1_ALCHEMY_EXTRACT_LEVEL2', // Refined (used for .2)
    3: 'T1_ALCHEMY_EXTRACT_LEVEL3'  // Pure (used for .3)
};

// Resistance potions
const resistance_potions = {
    3: [
        { id: 'T3_COMFREY', qty: 8 }
    ],
    5: [
        { id: 'T5_TEASEL', qty: 24 },
        { id: 'T4_BURDOCK', qty: 12 },
        { id: 'T4_MILK', qty: 6 }
    ],
    7: [
        { id: 'T7_MULLEIN', qty: 72 },
        { id: 'T6_FOXGLOVE', qty: 36 },
        { id: 'T4_BURDOCK', qty: 36 },
        { id: 'T6_MILK', qty: 18 },
        { id: 'T7_ALCOHOL', qty: 18 }
    ]
};

for (const [tierStr, baseMats] of Object.entries(resistance_potions)) {
    const tier = parseInt(tierStr);
    
    // .0 Base Potion
    recipes[`T${tier}_POTION_STONESKIN`] = {
        category: 'consumables',
        output: 5,
        materials: baseMats
    };
    
    // .1, .2, .3 Enchanted Potions
    for (const ench of [1, 2, 3]) {
        const extractQty = tier === 3 ? 5 : (tier === 5 ? 15 : 45); // Approximate scale
        
        const enchMats = baseMats.map(mem => ({ id: mem.id, qty: mem.qty }));
        enchMats.push({ id: EXTRACTS[ench], qty: extractQty });
        
        recipes[`T${tier}_POTION_STONESKIN@${ench}`] = {
            category: 'consumables',
            output: 5,
            materials: enchMats
        };
    }
}

fs.writeFileSync(recipesPath, JSON.stringify(recipes, null, 2));
console.log('Added Resistance Potions to recipes.json');
