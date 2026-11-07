#!/bin/bash
# Nightly on Germany (cron): the song database only (no .env, no secrets) from the
# newest home backup -> integrity check -> zstd -> private Telegram backup channel.
# Install: /usr/local/bin/mp-db-telegram.sh + /usr/local/lib/tg-upload.mjs + /etc/cron.d/mp-db-telegram
set -eo pipefail
CHANNEL=${MP_DB_TG_CHANNEL:--1004441859458}
V=/var/lib/docker/volumes/music_shares/_data; W=$V/dbbak; L=/root/dbbak.log; DONE=/root/.dbbak-last
exec >>"$L" 2>&1
trap 'rm -rf "$W"; docker exec -u 0 music-bot rm -f /app/tg-upload.mjs 2>/dev/null || true' EXIT
F=$(ls -t /root/mp-backups/mp-home-*.tar.gz 2>/dev/null | head -1)
[ -n "$F" ] || { echo "$(date -u +%F\ %T) no backup found"; exit 1; }
[ "$(cat $DONE 2>/dev/null)" = "$F" ] && { echo "$(date -u +%F\ %T) $F already uploaded"; exit 0; }
# Still arriving? The receiver writes it in one go; wait until it stops growing.
s1=$(stat -c %s "$F"); sleep 60; [ "$s1" = "$(stat -c %s "$F")" ] || { echo "$F still growing"; exit 1; }
echo "$(date -u +%F\ %T) from $F"
rm -rf "$W"; mkdir -p "$W"
tar -xzf "$F" -C "$W" shares/catalog/catalog-snapshot.db
chown -R 1000:1000 "$W"
docker exec music-bot node -e 'const {DatabaseSync}=require("node:sqlite"); const d=new DatabaseSync("/shares/dbbak/shares/catalog/catalog-snapshot.db",{readOnly:true}); console.log("quick_check", d.prepare("PRAGMA quick_check").get()["quick_check"])' 2>&1 | grep -v Experimental | tee "$W/check"
grep -q "quick_check ok" "$W/check" || { echo "CHECK FAILED"; exit 1; }
STAMP=$(basename "$F" .tar.gz | sed 's/mp-home-//')
OUT=$W/catalog-$STAMP.db.zst
nice zstd -q -10 -T2 "$W/shares/catalog/catalog-snapshot.db" -o "$OUT"
rm -f "$W/shares/catalog/catalog-snapshot.db"
SUM=$(sha256sum "$OUT" | cut -c1-16)
chown 1000:1000 "$OUT"
docker cp /usr/local/lib/tg-upload.mjs music-bot:/app/tg-upload.mjs
docker exec -w /app music-bot node tg-upload.mjs "$CHANNEL" "/shares/dbbak/$(basename "$OUT")" \
  "MiniPlayer song database backup (catalog only, no secrets), from nightly $STAMP UTC. zstd; sha256 starts $SUM. Restore: zstd -d" 2>&1 | grep -v Experimental
echo "$F" > "$DONE"
echo "$(date -u +%F\ %T) DONE"
# Keep the log small.
tail -n 200 "$L" > "$L.tmp" && mv "$L.tmp" "$L"
