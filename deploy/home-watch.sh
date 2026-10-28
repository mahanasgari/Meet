#!/usr/bin/env bash
# Runs on Germany from cron every 2 minutes: tells the admin on Telegram when
# the MiniPlayer home server stops answering (its own alert bot runs on home,
# so it can't report its own outage), and again when it's back.
#   */2 * * * * /usr/local/bin/home-watch.sh
# /root/home-watch.env (mode 600): BOT_TOKEN=<@miniplayer_robot token>, CHAT_ID=<admin chat>
set -u
. /root/home-watch.env
URL=${HOME_HEALTH_URL:-https://music.cloudproducts.ir/extractor/health}
STATE=/var/lib/home-watch; mkdir -p "$STATE"
fails=$(cat "$STATE/fails" 2>/dev/null || echo 0)
since=$(cat "$STATE/since" 2>/dev/null || echo "")

send() {
  curl -s -m 20 -o /dev/null "https://api.telegram.org/bot$BOT_TOKEN/sendMessage" \
    --data-urlencode "chat_id=$CHAT_ID" --data-urlencode "text=$1"
}

if curl -sf -m 20 "$URL" | grep -q '"ok":true'; then
  if [ -f "$STATE/alerted" ]; then
    mins=$(( ($(date +%s) - since) / 60 ))
    send "🟢 MiniPlayer home is back (down about $mins min)."
    rm -f "$STATE/alerted"
  fi
  echo 0 > "$STATE/fails"; rm -f "$STATE/since"
  exit 0
fi

fails=$((fails + 1)); echo "$fails" > "$STATE/fails"
[ -z "$since" ] && date +%s > "$STATE/since"
# Two misses in a row (about 4 minutes) before alerting; once per outage.
if [ "$fails" -ge 2 ] && [ ! -f "$STATE/alerted" ]; then
  send "🔴 MiniPlayer home (music.cloudproducts.ir) isn't answering. Friends can't sign in, and songs may not play. Checked from Germany."
  touch "$STATE/alerted"
fi
