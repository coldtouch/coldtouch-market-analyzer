const ITEM_NAMES = {
    "T5_2H_ENIGMATICORB_MORGANA": "Expert's Malevolent Locus"
};
const itemsList = Object.keys(ITEM_NAMES);
function getFriendlyName(id) {
    if (ITEM_NAMES[id] && ITEM_NAMES[id].trim() !== '') return ITEM_NAMES[id];
    return id;
}

let searchVal = "Expert's Malevolent Locus";
let arbSearchExactId = null;

if (arbSearchExactId) {
    searchVal = arbSearchExactId;
} else if (searchVal) {
    const match = itemsList.find(i => getFriendlyName(i).toLowerCase() === searchVal.toLowerCase() || i.toLowerCase() === searchVal.toLowerCase());
    if (match) searchVal = match;
    else searchVal = searchVal.toUpperCase();
}

console.log("Final searchVal:", searchVal);
