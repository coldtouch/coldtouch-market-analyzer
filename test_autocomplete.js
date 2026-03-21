const fs = require('fs');
const ITEM_NAMES = JSON.parse(fs.readFileSync('items.json', 'utf8'));
const itemsList = Object.keys(ITEM_NAMES);

function getFriendlyName(id) {
    if (ITEM_NAMES[id] && ITEM_NAMES[id].trim() !== '') return ITEM_NAMES[id];
    return id.replace(/_/g, ' ').replace(/T(\d+)/, 'Tier $1').toLowerCase().replace(/\b\w/g, l => l.toUpperCase());
}

function getTierEnchLabel(itemId) {
    if (!itemId) return '';
    let label = '';
    const tMatch = itemId.match(/^T(\d+)/);
    if (tMatch) label += `T${tMatch[1]}`;
    const eMatch = itemId.match(/@(\d+)$/);
    if (eMatch) label += `.${eMatch[1]}`;
    return label;
}

const val = "Dawnsong".toLowerCase();
const words = val.split(' ').filter(w => w);
const matches = [];

for (const item of itemsList) {
    const name = getFriendlyName(item);
    const target = (name + ' ' + item.replace(/_/g, ' ') + ' ' + getTierEnchLabel(item)).toLowerCase();
    
    if (words.every(w => target.includes(w))) {
        matches.push({ id: item, name });
    }
}

console.log(`Found ${matches.length} matches for "Dawnsong":`);
console.log(matches.slice(0, 5));
