import paramiko
import sys
import base64

ip = '209.97.129.125'
password = 'iT%Me78@GQ/+t6p'
usr = 'root'
webhook = 'https://discord.com/api/webhooks/1485758021261987871/hywzsHMaVX549fgmDM8PUIUNvUD1HtpqGQ9vlG35lrK4Cc25aZUp7cZxRUahjb2dauW5'

def main():
    print(f"Connecting to {ip}...")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    
    try:
        ssh.connect(ip, username=usr, password=password, timeout=10)
    except Exception as e:
        print(f"Failed to connect: {e}")
        sys.exit(1)
        
    print("Connected. Deploying alerter.js...")
    
    js_code = """
const WebSocket = require('ws');
const https = require('https');

const WEBHOOK_URL = 'WEBHOOK_TARGET';
const TAX_RATE = 0.065;
const MIN_PROFIT = 50000; // Trigger alert on 50,000+ silver arbitrage

// In-RAM Database
const db = {}; // db[itemId][quality][cityId] = { sellMin, buyMax }
const alerted = {}; // Cooldown cache

const API_LOCALE_MAP = {
    '0': 'Thetford', '7': 'Thetford', '3004': 'Thetford',
    '3': 'Lymhurst', '1002': 'Lymhurst',
    '4': 'Bridgewatch', '2004': 'Bridgewatch',
    '3003': 'Black Market', '3005': 'Caerleon',
    '3008': 'Fort Sterling', '4000': 'Martlock', '4300': 'Brecilien'
};

function getCity(id) { return API_LOCALE_MAP[id] || 'City-'+id; }

function sendDiscordMsg(msg) {
    const payload = JSON.stringify({ content: msg });
    const [_, host, path] = WEBHOOK_URL.match(/https:\\/\\/([^/]+)(.*)/);
    const req = https.request({ hostname: host, path: path, method: 'POST', headers: { 'Content-Type': 'application/json' } });
    req.write(payload);
    req.end();
}

function fireDiscordAlert(itemId, qual, sellLoc, sellPrice, buyLoc, buyPrice, profit) {
    const embed = {
        embeds: [{
            title: `🚨 Arbitrage Alert! 💰 ${Math.floor(profit).toLocaleString()} Silver`,
            color: 0xffd700,
            fields: [
                { name: "Item", value: `${itemId} (Quality ${qual})`, inline: false },
                { name: "Buy In", value: `**${getCity(sellLoc)}** for ${Math.floor(sellPrice).toLocaleString()}`, inline: true },
                { name: "Sell In", value: `**${getCity(buyLoc)}** for ${Math.floor(buyPrice).toLocaleString()}`, inline: true },
                { name: "Profit", value: `**${Math.floor(profit).toLocaleString()}** (After 6.5% Tax)`, inline: false }
            ],
            timestamp: new Date().toISOString()
        }]
    };
    
    const [_, host, path] = WEBHOOK_URL.match(/https:\\/\\/([^/]+)(.*)/);
    const req = https.request({
        hostname: host,
        path: path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    });
    req.write(JSON.stringify(embed));
    req.end();
}

function connectWS() {
    const ws = new WebSocket('wss://127.0.0.1:443', { rejectUnauthorized: false });
    
    ws.on('open', () => {
        console.log('Alerter connected to local WSS');
        sendDiscordMsg("🟢 **Albion Market Alerter** is Online & listening to Live Sync!");
    });
    
    ws.on('message', (data) => {
        try {
            const payloads = JSON.parse(data);
            for (const p of payloads) {
                if (!p.ItemTypeId || !p.LocationId || !p.UnitPriceSilver) continue;
                
                const id = p.ItemTypeId;
                const q = p.QualityLevel;
                const loc = p.LocationId;
                const price = p.UnitPriceSilver / 10000;
                
                if (!db[id]) db[id] = {};
                if (!db[id][q]) db[id][q] = {};
                if (!db[id][q][loc]) db[id][q][loc] = { sellMin: Infinity, buyMax: 0 };
                
                // Track the live bounds per city
                if (p.AuctionType === 'offer' && price < db[id][q][loc].sellMin) {
                    db[id][q][loc].sellMin = price;
                } else if (p.AuctionType === 'request' && price > db[id][q][loc].buyMax) {
                    db[id][q][loc].buyMax = price;
                }
                
                // Run cross-city Arbitrage check
                let bestSell = { price: Infinity, loc: null };
                let bestBuy = { price: 0, loc: null };
                
                for (const [c, cd] of Object.entries(db[id][q])) {
                    if (cd.sellMin > 0 && cd.sellMin < bestSell.price) bestSell = { price: cd.sellMin, loc: c };
                    if (cd.buyMax > 0 && cd.buyMax > bestBuy.price) bestBuy = { price: cd.buyMax, loc: c };
                }
                
                // If profit exists
                if (bestSell.loc && bestBuy.loc && bestSell.loc !== bestBuy.loc) {
                    const tax = bestBuy.price * TAX_RATE;
                    const profit = bestBuy.price - bestSell.price - tax;
                    
                    if (profit >= MIN_PROFIT) {
                        const key = `${id}_${q}`;
                        const last = alerted[key] || 0;
                        if (Date.now() - last > 1800000) { // 30 minute alert cooldown per tier/quality
                            alerted[key] = Date.now();
                            fireDiscordAlert(id, q, bestSell.loc, bestSell.price, bestBuy.loc, bestBuy.price, profit);
                            console.log(`Alerted ${key}: ${profit} profit`);
                        }
                    }
                }
            }
        } catch(e) {
            // drop
        }
    });
    
    ws.on('close', () => {
        console.log('WS disconnected, reconnecting in 5s');
        setTimeout(connectWS, 5000);
    });
    ws.on('error', () => {});
}

connectWS();
"""
    def run_wait(cmd):
        stdin, stdout, stderr = ssh.exec_command(cmd)
        stdout.channel.recv_exit_status()
        return stdout.read().decode()

    js_code = js_code.replace("WEBHOOK_TARGET", webhook)
    b64_js = base64.b64encode(js_code.encode()).decode()
    run_wait(f"echo '{b64_js}' | base64 -d > /opt/albion-proxy/alerter.js")
    
    svc = """
[Unit]
Description=Albion Discord Alerter
After=network.target albion-proxy.service

[Service]
ExecStart=/usr/bin/node /opt/albion-proxy/alerter.js
WorkingDirectory=/opt/albion-proxy
Restart=always
User=root

[Install]
WantedBy=multi-user.target
"""
    b64_svc = base64.b64encode(svc.encode()).decode()
    run_wait(f"echo '{b64_svc}' | base64 -d > /etc/systemd/system/albion-alerter.service")
    
    run_wait("systemctl daemon-reload")
    run_wait("systemctl enable albion-alerter")
    run_wait("systemctl restart albion-alerter")
    
    out = run_wait("systemctl status albion-alerter | head -n 5")
    print(out)
    
    ssh.close()
    print("Alerter Deployed!")

if __name__ == '__main__':
    main()
