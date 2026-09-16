# Meet

A minimal video meeting app for private hangouts with friends.

- Create a room and share the link — no accounts, no setup.
- Join with a display name, camera + microphone, and screen sharing.
- See everyone in the room and who is sharing their screen.
- Responsive UI for desktop and mobile.

## Stack

- **Next.js 16 (App Router)** + **TypeScript** + **Tailwind CSS v4** — web app
- **LiveKit** — self-hosted SFU for realtime audio/video
- **Redis** — LiveKit state
- **Caddy** — reverse proxy + automatic Let's Encrypt HTTPS
- **Docker Compose** — small-VPS deployment

Rooms are URL slugs (`/room/abc123xyz`). LiveKit creates them on demand when
the first person joins; they disappear once everyone leaves.

## Architecture

```
Browser ──HTTPS──► Caddy ──► Next.js (UI + /api/token)
   │                  │
   │                  └── WSS ► LiveKit signaling
   └──── UDP/TCP WebRTC media ──► LiveKit (host ports)
```

- `/api/token` signs a short-lived LiveKit join token using server-only
  `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` (never sent to the browser).
- The client connects to LiveKit at `LIVEKIT_URL`; media does not pass through
  Next.js.
- No database, no accounts, no chat.

## Local development

```bash
# 1. LiveKit + Redis
docker compose -f docker-compose.dev.yml up -d

# 2. App env (local defaults are fine on localhost only)
cp .env.example .env.local
# Ensure:
#   LIVEKIT_URL=ws://localhost:7880
#   LIVEKIT_API_KEY=devkey
#   LIVEKIT_API_SECRET=local_dev_only_secret_do_not_use_in_prod

# 3. Run the app
npm install
npm run dev
```

Open http://localhost:3000.

## Production deployment (small VPS)

Designed for one inexpensive VPS (1–2 vCPU, 1–2 GB RAM is enough for a few
friends). Caddy obtains and renews Let's Encrypt certificates automatically.

### 1. DNS

Create A/AAAA records (both → your VPS public IP):

| Name | Example |
| --- | --- |
| App | `meet.example.com` |
| LiveKit signaling | `livekit.meet.example.com` |

### 2. Firewall

Allow inbound:

| Port | Purpose |
| --- | --- |
| 80/tcp | HTTP + ACME |
| 443/tcp (+ udp for HTTP/3 optional) | HTTPS |
| 7881/tcp | LiveKit RTC TCP fallback |
| 50000–50100/udp | WebRTC media |

### 3. Environment

```bash
cp .env.example .env
./scripts/gen-livekit-credentials.sh   # paste into .env
```

Edit `.env` (required):

| Variable | Required | Description |
| --- | --- | --- |
| `DOMAIN` | yes | App hostname (`meet.example.com`) |
| `ACME_EMAIL` | yes | Email for Let's Encrypt |
| `LIVEKIT_URL` | yes | Browser LiveKit URL, e.g. `wss://livekit.meet.example.com` |
| `LIVEKIT_API_KEY` | yes | Shared with LiveKit (strong random) |
| `LIVEKIT_API_SECRET` | yes | Shared with LiveKit (strong random) |
| `LIVEKIT_USE_EXTERNAL_IP` | no | Default `true` on VPS |
| `LIVEKIT_NODE_IP` | no | Set to public IPv4 if ICE fails |
| `LIVEKIT_RTC_TCP_PORT` | no | Default `7881` |
| `LIVEKIT_RTC_PORT_START` / `END` | no | Default `50000`–`50100` |
| `LIVEKIT_LOG_LEVEL` | no | Default `info` |

Do **not** commit `.env`. Do **not** use local/dev credentials off localhost —
the app refuses those defaults when `LIVEKIT_URL` is non-local in production.
LiveKit requires `LIVEKIT_API_SECRET` to be at least **32 characters**.

### 4. Start

```bash
docker compose up -d --build
docker compose ps
curl -fsS https://$DOMAIN/api/health
```

Caddy serves the app at `https://$DOMAIN` and LiveKit signaling at
`wss://livekit.$DOMAIN`. All services use `restart: unless-stopped`.

### Existing Nginx / reverse proxy

If the VPS already terminates TLS:

```bash
docker compose -f docker-compose.yml -f docker-compose.noproxy.yml up -d --build
```

Then proxy to `127.0.0.1:3000` (app) and `127.0.0.1:7880` (LiveKit). See
`deploy/nginx.example.conf`. Still publish UDP `50000–50100` and TCP `7881`
on the host.

### Local production smoke test

```bash
cp .env.example .env
# For local only:
#   DOMAIN=localhost
#   ACME_EMAIL=dev@localhost
#   LIVEKIT_URL=ws://localhost:7880
#   LIVEKIT_API_KEY=devkey
#   LIVEKIT_API_SECRET=local_dev_only_secret_do_not_use_in_prod
#   LIVEKIT_USE_EXTERNAL_IP=false

docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
curl -fsS http://localhost:3000/api/health
```

Open http://localhost:3000. Caddy is disabled in this overlay.

### Updates

```bash
git pull
docker compose up -d --build
```

## Security notes

- LiveKit API credentials stay on the server; only join JWTs reach the browser.
- Rooms are joinable by anyone who knows the link (no accounts).
- `/api/token` is rate-limited and rejects cross-origin browser POSTs.

## Project layout

```
app/                   Next.js App Router (UI + /api/token + /api/health)
components/            React UI
lib/                   LiveKit helpers, validation, errors
deploy/
  Caddyfile            Production reverse proxy + HTTPS
  livekit-entrypoint.sh  Builds LiveKit config from env (no secrets in git)
  livekit.yaml.example Reference config shape
  nginx.example.conf   Optional Nginx instead of Caddy
docker-compose.yml           Production stack
docker-compose.local.yml     Local prod-style (no TLS)
docker-compose.noproxy.yml   Behind an existing reverse proxy
docker-compose.dev.yml       LiveKit + Redis for `npm run dev`
```

## Scripts

```bash
npm run dev        # development server
npm run build      # production build (standalone)
npm run start      # run standalone server (loads `.env.local`)
npm run lint       # ESLint
npm run typecheck  # Next typegen + tsc
npm test           # Vitest unit tests
npm run test:e2e   # Playwright smoke test (APP_URL)
```
