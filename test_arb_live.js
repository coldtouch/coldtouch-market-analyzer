const https = require('https');

const CITIES = ['Martlock', 'Thetford', 'Fort Sterling', 'Lymhurst', 'Bridgewatch', 'Caerleon', 'Brecilien', 'Black Market'];
const TAX_RATE = 0.065;

function extractEnchantment(itemId) {
    if (!itemId || !itemId.includes('@')) return '0';
    return itemId.split('@')[1];
}

function processArbitrage(data, quality, tier, enchantment, includeBM, isSingleItem = false) {
    const itemsData = {};
    data.forEach(entry => {
        if (quality !== 'all' && entry.quality.toString() !== quality) return;
        if (tier !== 'all' && !entry.item_id.startsWith('T' + tier)) return;
        if (enchantment !== 'all' && extractEnchantment(entry.item_id) !== enchantment) return;
        if (entry.sell_price_min === 0 && entry.buy_price_max === 0) return;

        const itemKey = `${entry.item_id}_${entry.quality}`;
        if (!itemsData[itemKey]) itemsData[itemKey] = {};

        let city = entry.city;
        if (city && city.includes('Black Market')) city = 'Black Market';
        if (!CITIES.includes(city)) return;
        if (!includeBM && city === 'Black Market') return;

        let current = itemsData[itemKey][city];
        const entryDate = entry.sell_price_min_date > entry.buy_price_max_date ? entry.sell_price_min_date : entry.buy_price_max_date;

        if (!current) {
            itemsData[itemKey][city] = { sellMin: entry.sell_price_min, buyMax: entry.buy_price_max, updateDate: entryDate };
        } else {
            if (entry.sell_price_min > 0 && (current.sellMin === 0 || entry.sell_price_min < current.sellMin)) current.sellMin = entry.sell_price_min;
            if (entry.buy_price_max > 0 && entry.buy_price_max > current.buyMax) current.buyMax = entry.buy_price_max;
            if (entryDate > '0001' && entryDate > current.updateDate) current.updateDate = entryDate;
        }
    });

    const trades = [];
    for (const [itemKey, citiesObj] of Object.entries(itemsData)) {
        const lastUnderscore = itemKey.lastIndexOf('_');
        const itemId = itemKey.substring(0, lastUnderscore);
        const qual = itemKey.substring(lastUnderscore + 1);
        const cities = Object.keys(citiesObj);

        for (let i = 0; i < cities.length; i++) {
            for (let j = 0; j < cities.length; j++) {
                if (i === j) continue;
                const cityBuy = cities[i];
                const citySell = cities[j];
                if (cityBuy === 'Black Market') continue;

                const priceBuy = citiesObj[cityBuy].sellMin;
                const priceSell = citiesObj[citySell].buyMax;

                if (priceBuy && priceBuy > 0 && priceSell && priceSell > 0) {
                    const tax = priceSell * TAX_RATE;
                    const profit = priceSell - priceBuy - tax;
                    if (profit > 0 || isSingleItem) {
                        const dateBuy = citiesObj[cityBuy].updateDate;
                        const dateSell = citiesObj[citySell].updateDate;
                        trades.push({
                            itemId, quality: qual, buyCity: cityBuy, sellCity: citySell,
                            buyPrice: priceBuy, sellPrice: priceSell,
                            tax, profit, roi: (profit / priceBuy) * 100,
                            updateDate: dateBuy < dateSell ? dateBuy : dateSell
                        });
                    }
                }
            }
        }
    }
    return trades.sort((a, b) => b.profit - a.profit).slice(0, 60);
}

https.get('https://west.albion-online-data.com/api/v2/stats/prices/T5_2H_ENIGMATICORB_MORGANA.json', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const parsed = JSON.parse(data);
    const trades = processArbitrage(parsed, 'all', 'all', 'all', true, true);
    console.log(`Produced ${trades.length} trades.`);
    if (trades.length > 0) {
        console.log("Top trade:", trades[0]);
    }
  });
}).on('error', (err) => {
  console.log("Error: " + err.message);
});
