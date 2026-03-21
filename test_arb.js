const fs = require('fs');

const CITIES = ['Martlock', 'Thetford', 'Fort Sterling', 'Lymhurst', 'Bridgewatch', 'Caerleon', 'Brecilien', 'Black Market'];
const TAX_RATE = 0.065;

function processArbitrage(data, quality, tier, enchantment, includeBM, isSingleItem = false) {
    const itemsData = {};
    data.forEach(entry => {
        if (quality !== 'all' && entry.quality.toString() !== quality) return;
        if (tier !== 'all' && !entry.item_id.startsWith('T' + tier)) return;
        
        // mock extractEnchantment
        const itemEnch = entry.item_id.includes('@') ? entry.item_id.split('@')[1] : '0';
        if (enchantment !== 'all' && itemEnch !== enchantment) return;
        
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

                if (priceBuy > 0 && priceSell > 0) {
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

const mockData = [
  { item_id: 'T5_2H_ENIGMATICORB_MORGANA', city: 'Martlock', quality: 1, sell_price_min: 10000, buy_price_max: 8000, sell_price_min_date: '2026-01-01T00:00:00', buy_price_max_date: '2026-01-01T00:00:00' },
  { item_id: 'T5_2H_ENIGMATICORB_MORGANA', city: 'Lymhurst', quality: 1, sell_price_min: 12000, buy_price_max: 11000, sell_price_min_date: '2026-01-01T00:00:00', buy_price_max_date: '2026-01-01T00:00:00' }
];

const res = processArbitrage(mockData, 'all', 'all', 'all', true, true);
console.log('Trades:', res.length > 0 ? res : 'No trades found');
