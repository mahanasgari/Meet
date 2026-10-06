#!/usr/bin/env bash
# One-command MiniPlayer music server (music-bot + Cloudflare WARP egress).
#
#   curl -fsSL https://raw.githubusercontent.com/mahanasgari/Meet/main/deploy/install-music-server.sh \
#     | sudo bash -s -- --token YOUR_MUSIC_API_TOKEN --domain music.example.com
#
# What it does (safe to run again; it updates in place):
#   1. Installs Docker if missing.
#   2. Installs Cloudflare WARP in proxy mode, so YouTube sees a Cloudflare
#      address instead of this datacenter IP (avoids "confirm you're not a bot").
#   3. Runs the music-bot container on 127.0.0.1:4100 (image from GHCR, or
#      built from this repo if the pull fails).
#   4. Publishes it at https://DOMAIN/extractor/ :
#        - existing nginx: adds a /extractor/ location to the site whose
#          server_name is DOMAIN (backs the file up first);
#        - no web server on 80/443: runs Caddy with automatic HTTPS.
# Options: --token (required), --domain, --memory 600m, --no-warp, --no-web
set -euo pipefail

TOKEN="" DOMAIN="" MEM="" WARP=1 WEB=1
IMAGE="ghcr.io/mahanasgari/meet-music-bot:latest"
REPO="https://github.com/mahanasgari/Meet.git"
ENVF=/etc/miniplayer-music.env
while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --memory) MEM="$2"; shift 2 ;;
    --no-warp) WARP=0; shift ;;
    --no-web) WEB=0; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
[ -n "$TOKEN" ] || { echo "--token is required (same MUSIC_API_TOKEN as your other servers)" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
say() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }

say "Docker"
if ! command -v docker >/dev/null; then
  apt-get update -q >/dev/null && apt-get install -y -q docker.io >/dev/null
  systemctl enable --now docker >/dev/null
fi
docker --version

PROXY=""
if [ "$WARP" = 1 ]; then
  say "Cloudflare WARP (proxy mode)"
  if ! command -v warp-cli >/dev/null; then
    apt-get install -y -q curl gpg >/dev/null
    curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg | gpg --yes --dearmor -o /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ noble main" > /etc/apt/sources.list.d/cloudflare-client.list
    apt-get update -q >/dev/null && apt-get install -y -q cloudflare-warp >/dev/null || true
  fi
  if ! command -v warp-cli >/dev/null; then
    echo "WARNING: could not install Cloudflare WARP here; continuing without it."
    WARP=0
  fi
fi
if [ "$WARP" = 1 ]; then
  command -v socat >/dev/null || apt-get install -y -q socat >/dev/null
  systemctl enable --now warp-svc >/dev/null; sleep 3
  warp-cli --accept-tos registration new >/dev/null 2>&1 || true
  warp-cli --accept-tos mode proxy >/dev/null
  warp-cli --accept-tos proxy port 40000 >/dev/null
  warp-cli --accept-tos connect >/dev/null; sleep 5
  # Expose the local-only WARP proxy to Docker's bridge (not the internet).
  cat > /etc/systemd/system/warp-bridge.service <<'U'
[Unit]
Description=Expose WARP SOCKS/HTTP proxy to Docker (music-bot)
After=docker.service warp-svc.service
[Service]
ExecStart=/usr/bin/socat TCP-LISTEN:14000,bind=172.17.0.1,fork,reuseaddr TCP:127.0.0.1:40000
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
U
  systemctl daemon-reload; systemctl enable --now warp-bridge >/dev/null; systemctl restart warp-bridge
  if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
    ufw allow from 172.17.0.0/16 to 172.17.0.1 port 14000 proto tcp comment "music-bot to WARP" >/dev/null
  fi
  if curl -s -m 15 --socks5-hostname 127.0.0.1:40000 https://www.cloudflare.com/cdn-cgi/trace | grep -q '^warp=on'; then
    echo "WARP connected"
    PROXY=http://host.docker.internal:14000
  else
    echo "WARNING: WARP did not connect (blocked here?). Continuing without it;"
    echo "         YouTube may ask this server to sign in. Re-run later, or use --no-warp."
  fi
fi

say "Settings ($ENVF)"
umask 077
{
  echo "PORT=4100"
  echo "SHARES_DIR=/shares"
  echo "MUSIC_API_TOKEN=$TOKEN"
  # LiveKit is only used by Meet rooms; a worker needs placeholders.
  echo "LIVEKIT_URL=ws://127.0.0.1:7880"
  echo "LIVEKIT_API_KEY=unused"
  echo "LIVEKIT_API_SECRET=unused"
  if [ -n "$PROXY" ]; then
    echo "YTDLP_PROXY=socks5h://host.docker.internal:14000"
    echo "NODE_USE_ENV_PROXY=1"
    echo "HTTPS_PROXY=$PROXY"
    echo "HTTP_PROXY=$PROXY"
    echo "NO_PROXY=localhost,127.0.0.1"
  fi
} > "$ENVF"
umask 022

say "music-bot image"
if ! docker pull -q "$IMAGE"; then
  echo "pull failed; building from source (takes a few minutes)"
  rm -rf /opt/miniplayer-music-src
  git clone --depth 1 "$REPO" /opt/miniplayer-music-src
  docker build -t "$IMAGE" /opt/miniplayer-music-src/music-bot
fi

if [ -z "$MEM" ]; then
  # Leave room for whatever else runs here: about 40% of RAM, 300–900 MB.
  total=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
  MEM=$(( total * 40 / 100 )); [ $MEM -lt 300 ] && MEM=300; [ $MEM -gt 900 ] && MEM=900; MEM="${MEM}m"
fi
say "Starting music-bot (memory cap $MEM)"
docker rm -f music-bot >/dev/null 2>&1 || true
docker run -d --name music-bot --restart unless-stopped --memory "$MEM" \
  --add-host host.docker.internal:host-gateway \
  -p 127.0.0.1:4100:4100 --env-file "$ENVF" -v music_shares:/shares "$IMAGE" >/dev/null
sleep 8
docker exec -u root music-bot sh -c 'mkdir -p /shares/users && chown -R node:node /shares'
curl -fsS -m 10 127.0.0.1:4100/health; echo

if [ "$WEB" = 1 ] && [ -n "$DOMAIN" ]; then
  say "Publishing https://$DOMAIN/extractor/"
  if ss -ltnp | grep -qE ':(443|80) .*nginx'; then
    site=$(grep -rlE "server_name[^;]*\b${DOMAIN//./\\.}\b" /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null | head -1 || true)
    [ -n "$site" ] && site=$(readlink -f "$site")
    if [ -z "$site" ]; then
      echo "nginx runs here but no site has server_name $DOMAIN."
      echo "Add this inside that site's HTTPS server block, then: nginx -t && systemctl reload nginx"
    elif grep -q "location /extractor/" "$site"; then
      echo "already configured in $site"
    else
      cp "$site" "$site.bak-music-$(date +%Y%m%d%H%M%S)"
      python3 - "$site" <<'PY'
import re, sys
p = sys.argv[1]; s = open(p).read()
block = """    # MiniPlayer music API (local music-bot). Not logged.
    location /extractor/ {
        access_log off;
        proxy_pass http://127.0.0.1:4100/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_buffering off;
        proxy_read_timeout 300s;
        client_max_body_size 2m;
    }

"""
# Put it before the first location of the TLS server block (the one with ssl).
m = re.search(r"server\s*\{(?:(?!server\s*\{).)*?listen[^;]*ssl[^;]*;", s, re.S)
start = m.start() if m else 0
i = s.find("    location", start)
if i < 0:
    sys.exit("could not find a location block to insert before")
open(p, "w").write(s[:i] + block + s[i:])
PY
      nginx -t && systemctl reload nginx && echo "added to $site"
    fi
  elif ! ss -ltn | grep -qE ':(80|443) '; then
    mkdir -p /etc/miniplayer-caddy
    cat > /etc/miniplayer-caddy/Caddyfile <<C
$DOMAIN {
  handle_path /extractor/* {
    reverse_proxy host.docker.internal:4100 {
      flush_interval -1
    }
  }
  respond 404
}
C
    docker rm -f music-caddy >/dev/null 2>&1 || true
    docker run -d --name music-caddy --restart unless-stopped --add-host host.docker.internal:host-gateway \
      -p 80:80 -p 443:443 -v /etc/miniplayer-caddy/Caddyfile:/etc/caddy/Caddyfile:ro \
      -v music_caddy_data:/data caddy:2 >/dev/null
    echo "Caddy started; it gets a certificate for $DOMAIN automatically (DNS must point here)."
  else
    echo "Something other than nginx uses port 80/443. Point it at http://127.0.0.1:4100/ for /extractor/."
  fi
fi

say "Done"
echo "Health:  ${DOMAIN:+https://$DOMAIN/extractor/health  (or) }http://127.0.0.1:4100/health"
echo "Update:  run the same command again."
