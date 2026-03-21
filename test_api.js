const https = require('https');

https.get('https://west.albion-online-data.com/api/v2/stats/prices/T5_2H_ENIGMATICORB_MORGANA.json', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const parsed = JSON.parse(data);
    console.log(`Found ${parsed.length} prices`);
    const valid = parsed.filter(p => p.sell_price_min > 0 || p.buy_price_max > 0);
    console.log(`Valid prices (>0): ${valid.length}`);
    if (valid.length > 0) {
        const cities = [...new Set(valid.map(p => p.city))];
        console.log('Cities with data:', cities);
        const hasSell = valid.filter(p => p.sell_price_min > 0).map(p => p.city);
        const hasBuy = valid.filter(p => p.buy_price_max > 0).map(p => p.city);
        console.log('Cities with sell orders:', [...new Set(hasSell)]);
        console.log('Cities with buy orders:', [...new Set(hasBuy)]);
    }
  });
}).on('error', (err) => {
  console.log("Error: " + err.message);
});
