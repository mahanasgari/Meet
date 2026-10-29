#!/usr/bin/env bash
# Update a worker music-bot to the latest GHCR image, keeping its env
# (usage: ssh worker "bash -s" < deploy/update-worker.sh).
set -e
IMG=ghcr.io/mahanasgari/meet-music-bot:latest
docker pull -q "$IMG" >/dev/null
MEM=$(docker inspect music-bot -f '{{.HostConfig.Memory}}')
umask 077
# Container env, plus any keys added to the env file by hand (file wins).
docker inspect music-bot -f '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -vE '^(PATH|NODE_VERSION|YARN_VERSION|NODE_ENV)=' | grep . > /root/music-bot.next.env
if [ -f /root/music-bot.current.env ]; then
  while IFS= read -r line; do
    k="${line%%=*}"; [ -n "$k" ] || continue
    sed -i "/^$k=/d" /root/music-bot.next.env; echo "$line" >> /root/music-bot.next.env
  done < /root/music-bot.current.env
fi
# Keys listed in /root/music-bot.unset (one per line) are removed for good.
if [ -f /root/music-bot.unset ]; then
  while IFS= read -r k; do [ -n "$k" ] && sed -i "/^$k=/d" /root/music-bot.next.env; done < /root/music-bot.unset
fi
mv /root/music-bot.next.env /root/music-bot.current.env
sed -i '/^HOME_URL=/d' /root/music-bot.current.env; echo 'HOME_URL=https://music.cloudproducts.ir/extractor' >> /root/music-bot.current.env
docker rm -f music-bot >/dev/null
docker run -d --name music-bot --restart unless-stopped --memory "$MEM" \
  --add-host host.docker.internal:host-gateway -p 127.0.0.1:4100:4100 \
  --env-file /root/music-bot.current.env -v music_shares:/shares "$IMG" >/dev/null
sleep 8
docker exec -u root music-bot sh -c 'mkdir -p /shares/users && chown -R node:node /shares'
# The image just replaced is left untagged; each is ~1 GB and they filled
# Germany's disk once (2026-10-29).
docker image prune -f >/dev/null 2>&1 || true
curl -s -m 5 127.0.0.1:4100/health; echo
