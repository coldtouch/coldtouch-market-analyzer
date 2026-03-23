import paramiko
import time
import sys
import os

ip = '209.97.129.125'
password = 'iT%Me78@GQ/+t6p'
usr = 'root'
domain = '209-97-129-125.nip.io'

def main():
    print(f"Connecting to {ip}...")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    
    try:
        ssh.connect(ip, username=usr, password=password, timeout=10)
    except Exception as e:
        print(f"Failed to connect: {e}")
        sys.exit(1)
        
    print("Connected.")
    
    def run_cmd(cmd):
        print(f" -> Executing: {cmd[:100]}...")
        stdin, stdout, stderr = ssh.exec_command(cmd)
        exit_status = stdout.channel.recv_exit_status()
        out = stdout.read().decode()
        err = stderr.read().decode()
        if exit_status != 0:
            print(f"ERROR: {err}")
        return exit_status, out
        
    # 1. Update and install dependencies
    run_cmd("apt-get update")
    run_cmd("apt-get install -y nodejs npm certbot")
    
    # 2. Get SSL Cert
    print("Getting SSL certificate...")
    run_cmd(f"certbot certonly --standalone -d {domain} --non-interactive --agree-tos -m admin@{domain}")
    
    # 3. Setup Node.js app
    run_cmd("mkdir -p /opt/albion-proxy")
    run_cmd("cd /opt/albion-proxy && npm init -y && npm install nats ws")
    
    js_code = f"""
const {{ connect, StringCodec }} = require('nats');
const WebSocket = require('ws');
const fs = require('fs');
const https = require('https');

const domain = '{domain}';
const server = https.createServer({{
  cert: fs.readFileSync(`/etc/letsencrypt/live/${{domain}}/fullchain.pem`),
  key: fs.readFileSync(`/etc/letsencrypt/live/${{domain}}/privkey.pem`)
}});

const wss = new WebSocket.Server({{ server }});

let clients = new Set();
wss.on('connection', ws => {{
  console.log('Client connected');
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
}});

server.listen(443, () => console.log('WSS running on 443'));

(async () => {{
  try {{
      const nc = await connect({{ servers: "nats://public:thenewalbiondata@nats.albion-online-data.com:4222" }});
      console.log('Connected to NATS');
      const sc = StringCodec();
      const sub = nc.subscribe("marketorders.deduped.*");
      for await (const m of sub) {{
        const strData = sc.decode(m.data);
        for (let c of clients) {{
          if (c.readyState === WebSocket.OPEN) {{
            c.send(strData);
          }}
        }}
      }}
  }} catch (err) {{
      console.error('NATS Error:', err);
  }}
}})();
"""
    # Write js code to file
    import base64
    b64_js = base64.b64encode(js_code.encode()).decode()
    run_cmd(f"echo '{b64_js}' | base64 -d > /opt/albion-proxy/server.js")
    
    # 4. Systemd Service
    service_code = """
[Unit]
Description=Albion NATS Proxy
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/albion-proxy/server.js
WorkingDirectory=/opt/albion-proxy
Restart=always
User=root

[Install]
WantedBy=multi-user.target
"""
    b64_svc = base64.b64encode(service_code.encode()).decode()
    run_cmd(f"echo '{b64_svc}' | base64 -d > /etc/systemd/system/albion-proxy.service")
    
    run_cmd("systemctl daemon-reload")
    run_cmd("systemctl enable albion-proxy")
    run_cmd("systemctl restart albion-proxy")
    
    print("Checking status...")
    _, out = run_cmd("systemctl status albion-proxy | head -n 10")
    print(out)
    
    ssh.close()
    print("Deployment complete.")

if __name__ == '__main__':
    main()
