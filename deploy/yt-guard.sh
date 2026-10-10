#!/bin/sh
# yt-guard: keeps a MiniPlayer music server unblocked by YouTube.
#  - Every run: fetch a test song through the WARP proxy; if YouTube answers
#    "Sign in to confirm you're not a bot", get a fresh Cloudflare WARP
#    address (YouTube blocks per IP) and check again.
#  - Once a day: update yt-dlp inside the container.
# Install: /usr/local/bin/yt-guard.sh + cron "*/10 * * * * /usr/local/bin/yt-guard.sh"
CONTAINER=${YT_GUARD_CONTAINER:-music-bot}
PROXY=${YT_GUARD_PROXY:-socks5h://host.docker.internal:14000}
VIDEO=${YT_GUARD_VIDEO:-https://www.youtube.com/watch?v=jNQXAC9IVRw}
LOG=/var/log/yt-guard.log
STAMP=/var/lib/yt-guard.updated
log() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }

probe() {
  docker exec "$CONTAINER" yt-dlp --js-runtimes node --proxy "$PROXY" \
    --no-warnings --no-playlist -f bestaudio --simulate --print id "$VIDEO" 2>&1
}

# Daily yt-dlp update (YouTube changes often; old versions get flagged).
if [ ! -f "$STAMP" ] || [ -n "$(find "$STAMP" -mmin +1440 2>/dev/null)" ]; then
  out=$(docker exec -u root "$CONTAINER" yt-dlp -U 2>&1 | tail -1)
  log "update: $out"
  mkdir -p "$(dirname "$STAMP")"; touch "$STAMP"
fi

out=$(probe)
case "$out" in
  *"confirm you"*|*"not a bot"*|*"HTTP Error 429"*)
    log "blocked ($(echo "$out" | tail -1 | cut -c1-80)); rotating WARP"
    for i in 1 2 3; do
      warp-cli --accept-tos registration delete >/dev/null 2>&1
      warp-cli --accept-tos registration new >/dev/null 2>&1
      warp-cli --accept-tos mode proxy >/dev/null 2>&1
      warp-cli --accept-tos proxy port 40000 >/dev/null 2>&1
      warp-cli --accept-tos connect >/dev/null 2>&1
      sleep 8
      ip=$(curl -s -m 10 --socks5-hostname 127.0.0.1:40000 https://www.cloudflare.com/cdn-cgi/trace | sed -n 's/^ip=//p')
      out=$(probe)
      case "$out" in
        *"confirm you"*|*"not a bot"*|*"HTTP Error 429"*) log "try $i: $ip still blocked" ;;
        *) log "try $i: unblocked with $ip"; exit 0 ;;
      esac
    done
    log "still blocked after 3 new addresses"
    ;;
  *ERROR*) log "probe error: $(echo "$out" | tail -1 | cut -c1-100)" ;;
esac
