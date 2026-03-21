const ITEM_NAMES = {
    "T5_2H_ENIGMATICORB_MORGANA": "Expert's Malevolent Locus"
};
const itemsList = Object.keys(ITEM_NAMES);
function getFriendlyName(id) {
    if (ITEM_NAMES[id] && ITEM_NAMES[id].trim() !== '') return ITEM_NAMES[id];
    return id.replace(/_/g, ' ').replace(/T(\d+)/, 'Tier $1').toLowerCase().replace(/\b\w/g, l => l.toUpperCase());
}

let searchVal = "Expert's Malevolent Locus";
const match = itemsList.find(i => getFriendlyName(i).toLowerCase() === searchVal.toLowerCase() || i.toLowerCase() === searchVal.toLowerCase());
console.log("Match:", match);

// Wait, what if the user searches for the item using autocomplete?
