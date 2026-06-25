#!/usr/bin/env bash
# Nightly health check for albion-saas. Posts a summary to Discord and logs a line.
# Looks at the LAST 24h (event-loop wedges, restarts) + current DB/disk — the signals
# that actually predict the recurring DB-bloat outage, which an HTTP-only check misses.
set -uo pipefail

ENV_FILE=/opt/albion-saas/.env
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
WEBHOOK="${HEALTH_WEBHOOK:-${DISCORD_FEEDBACK_WEBHOOK:-}}"
SERVICE=albion-saas
DB=/opt/albion-saas/database.sqlite

HTTP=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 https://albionaitool.xyz/api/leaderboard 2>/dev/null || echo 000)
ACTIVE=$(systemctl is-active "$SERVICE" 2>/dev/null || echo unknown)
NRESTARTS=$(systemctl show "$SERVICE" -p NRestarts --value 2>/dev/null || echo '?')
WEDGES=$(journalctl -u "$SERVICE" --since '24 hours ago' --no-pager 2>/dev/null | grep -c 'Event loop blocked' || true)
FATALS=$(journalctl -u "$SERVICE" --since '24 hours ago' --no-pager 2>/dev/null | grep -c '\[FATAL\]' || true)
STARTS=$(journalctl -u "$SERVICE" --since '24 hours ago' --no-pager 2>/dev/null | grep -c 'Started.*[Aa]lbion' || true)
DBBYTES=$(stat -c%s "$DB" 2>/dev/null || echo 0); DBMB=$(( DBBYTES / 1048576 ))
DISKPCT=$(df --output=pcent / 2>/dev/null | tail -1 | tr -dc '0-9'); DISKPCT=${DISKPCT:-0}
DISKLINE=$(df -h / 2>/dev/null | tail -1 | awk '{print $3"/"$2" ("$5")"}')
HB=$(journalctl -u "$SERVICE" --no-pager -n 1200 2>/dev/null | grep '\[HEALTH\]' | tail -1 | grep -oE '\[HEALTH\].*' || echo '(no heartbeat in recent logs)')

STATUS=OK; EMO="✅"; COLOR=3066993; FLAGS=""
addflag(){ FLAGS="${FLAGS:+$FLAGS; }$1"; }
if [ "$HTTP" != "200" ]; then STATUS=CRITICAL; EMO="🔴"; COLOR=15158332; addflag "HTTP=$HTTP"; fi
if [ "$ACTIVE" != "active" ]; then STATUS=CRITICAL; EMO="🔴"; COLOR=15158332; addflag "service=$ACTIVE"; fi
if [ "$DISKPCT" -ge 90 ] 2>/dev/null; then STATUS=CRITICAL; EMO="🔴"; COLOR=15158332; addflag "disk ${DISKPCT}%"; fi
if [ "$STATUS" = OK ]; then
  if [ "${WEDGES:-0}" -gt 0 ] 2>/dev/null; then STATUS=WARN; EMO="⚠️"; COLOR=16098851; addflag "${WEDGES} event-loop wedge(s)/24h"; fi
  if [ "${DBMB:-0}" -ge 20000 ] 2>/dev/null; then STATUS=WARN; EMO="⚠️"; COLOR=16098851; addflag "DB ${DBMB}MB — prune overdue"; fi
  if [ "$DISKPCT" -ge 80 ] 2>/dev/null; then STATUS=WARN; EMO="⚠️"; COLOR=16098851; addflag "disk ${DISKPCT}%"; fi
fi
[ -z "$FLAGS" ] && FLAGS="none"

DESC=$(printf '**HTTP** %s · **service** %s · **restarts(24h)** %s · **NRestarts(total)** %s\n**24h:** %s event-loop wedge(s), %s FATAL\n**DB** %s MB · **disk** %s\n`%s`\n**Flags:** %s' \
  "$HTTP" "$ACTIVE" "$STARTS" "$NRESTARTS" "$WEDGES" "$FATALS" "$DBMB" "$DISKLINE" "$HB" "$FLAGS")

echo "$(date -u +%FT%TZ) $STATUS HTTP=$HTTP db=${DBMB}MB disk=${DISKPCT}% wedges24h=$WEDGES nrestarts=$NRESTARTS flags=[$FLAGS]"

if [ -n "$WEBHOOK" ]; then
  jq -nc --arg title "$EMO Nightly Health — $STATUS" --arg desc "$DESC" --argjson color "$COLOR" \
     '{username:"Albion Health", embeds:[{title:$title, description:$desc, color:$color}]}' \
   | curl -s -m 20 -H 'Content-Type: application/json' -d @- "$WEBHOOK" >/dev/null \
   && echo "discord: sent" || echo "discord: FAILED"
else
  echo "discord: no webhook configured"
fi
