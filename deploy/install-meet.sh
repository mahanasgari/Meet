#!/usr/bin/env bash
# One-command Meet install (video meetings, optional music bot).
#
#   curl -fsSL https://raw.githubusercontent.com/mahanasgari/Meet/main/deploy/install-meet.sh \
#     | sudo bash -s -- --domain meet.example.com --no-music
#
# DNS first: point DOMAIN and livekit.DOMAIN (A records) to this server.
# Options:
#   --domain D        required
#   --email E         for Let's Encrypt (default admin@DOMAIN)
#   --no-music        skip the music bot (no YouTube / MiniPlayer music)
#   --music-token T   MUSIC_API_TOKEN for MiniPlayer (default: random)
#   --dir PATH        install folder (default /opt/meet)
# Safe to run again: pulls the latest code, keeps your .env, restarts.
set -euo pipefail

DOMAIN="" EMAIL="" MUSIC=1 MTOKEN="" DIR=/opt/meet
REPO="https://github.com/mahanasgari/Meet.git"
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --no-music) MUSIC=0; shift ;;
    --music-token) MTOKEN="$2"; shift 2 ;;
    --dir) DIR="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
[ -n "$DOMAIN" ] || { echo "--domain is required" >&2; exit 1; }
EMAIL=${EMAIL:-admin@$DOMAIN}
export DEBIAN_FRONTEND=noninteractive
say() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }

say "Docker + Compose"
command -v docker >/dev/null || { apt-get update -q >/dev/null; apt-get install -y -q docker.io >/dev/null; }
systemctl enable --now docker >/dev/null
if ! docker compose version >/dev/null 2>&1; then
  apt-get install -y -q docker-compose-v2 >/dev/null 2>&1 \
    || apt-get install -y -q docker-compose-plugin >/dev/null 2>&1 \
    || { echo "could not install docker compose" >&2; exit 1; }
fi
command -v git >/dev/null || apt-get install -y -q git >/dev/null
docker compose version

say "Code ($DIR)"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull -q --ff-only; else git clone -q --depth 1 "$REPO" "$DIR"; fi
cd "$DIR"

say "Settings ($DIR/.env)"
if [ ! -f .env ]; then
  rnd() { openssl rand -hex "$1"; }
  umask 077
  cat > .env <<E
DOMAIN=$DOMAIN
ACME_EMAIL=$EMAIL
LIVEKIT_URL=wss://livekit.$DOMAIN
LIVEKIT_API_KEY=API$(rnd 6)
LIVEKIT_API_SECRET=$(rnd 24)
LIVEKIT_USE_EXTERNAL_IP=true
LIVEKIT_RTC_TCP_PORT=7881
LIVEKIT_RTC_PORT_START=50000
LIVEKIT_RTC_PORT_END=50100
LIVEKIT_LOG_LEVEL=info
MUSIC_BOT_URL=http://music-bot:4100
MUSIC_API_TOKEN=${MTOKEN:-$(rnd 24)}
E
  umask 022
  echo "created (keep it private)"
else
  echo "keeping existing .env"
fi
mkdir -p secrets

FILES=(-f docker-compose.yml)
[ "$MUSIC" = 0 ] && FILES+=(-f docker-compose.nomusic.yml)
if ss -ltn | grep -qE ':(80|443) '; then
  # Something (e.g. nginx) already owns 80/443: publish app/LiveKit on
  # localhost only and let that web server proxy them.
  FILES+=(-f docker-compose.noproxy.yml)
  PROXIED=1
else
  PROXIED=0
fi

say "Firewall"
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 443/udp >/dev/null
  ufw allow 7881/tcp >/dev/null; ufw allow 50000:50100/udp >/dev/null
  echo "opened 80, 443, 7881/tcp, 50000-50100/udp"
else
  echo "ufw not active; make sure 80, 443, 7881/tcp and 50000-50100/udp are open"
fi

say "Starting Meet (this builds the app; a few minutes on small servers)"
docker compose "${FILES[@]}" up -d --build
if [ "$MUSIC" = 1 ]; then
  sleep 5
  docker compose "${FILES[@]}" exec -T -u root music-bot sh -c 'mkdir -p /shares && chown -R node:node /shares' 2>/dev/null || true
fi
docker compose "${FILES[@]}" ps --format '{{.Name}}  {{.Status}}'

say "Done"
if [ "$PROXIED" = 1 ]; then
  echo "Ports 80/443 were taken, so Meet listens on 127.0.0.1:3000 (app) and :7880 (LiveKit)."
  echo "Proxy https://$DOMAIN -> 127.0.0.1:3000 and wss://livekit.$DOMAIN -> 127.0.0.1:7880"
  echo "(see $DIR/deploy/nginx.example.conf)."
else
  echo "Open https://$DOMAIN  (certificates are issued automatically on first visit)."
fi
echo "Compose files used: ${FILES[*]}  — reuse them for restarts:"
echo "  cd $DIR && docker compose ${FILES[*]} up -d"
