const https = require('https');

https.get('https://europe.albion-online-data.com/api/v2/stats/prices/T5_2H_ENIGMATICORB_MORGANA.json', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const parsed = JSON.parse(data);
    const valid = parsed.filter(p => p.sell_price_min > 0 || p.buy_price_max > 0);
    const hasBuy = valid.filter(p => p.buy_price_max > 0).map(p => p.city);
    console.log('Europe - Cities with buy orders:', [...new Set(hasBuy)]);
  });
});

https.get('https://east.albion-online-data.com/api/v2/stats/prices/T5_2H_ENIGMATICORB_MORGANA.json', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const parsed = JSON.parse(data);
    const valid = parsed.filter(p => p.sell_price_min > 0 || p.buy_price_max > 0);
    const hasBuy = valid.filter(p => p.buy_price_max > 0).map(p => p.city);
    console.log('East - Cities with buy orders:', [...new Set(hasBuy)]);
  });
});
