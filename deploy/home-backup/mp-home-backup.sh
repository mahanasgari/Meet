#!/bin/bash
# Nightly on Germany (home since 2026-11): the real home data -> private
# Telegram backup channel, plus the last 2 copies kept here.
#
#   catalog-<stamp>.db.zst   the song catalog (consistent copy, checked)
#   data-<stamp>.tar.zst     accounts, users, invites, shared docs, explore,
#                            song links, monitor alerts, usage/metrics
#
# Left out: the song cache (songs are in Telegram already), chords and HD
# thumbnails (rebuilt), app/ and web/ (republished by scripts/release.sh)
# and youtube_cookies.txt (a login secret).
#
# Restore: zstd -d catalog-*.db.zst -o catalog.db ; zstd -dc data-*.tar.zst | tar -x
# Writes monitor/backup.json: the panel and the bot alert on a failure or
# when the last backup is over 26 h old.
set -Eeo pipefail
CHANNEL=${MP_BACKUP_TG_CHANNEL:--1004441859458}
C=music-bot
V=/var/lib/docker/volumes/music_shares/_data
W=$V/dbbak                       # = /shares/dbbak inside the container
KEEP_DIR=/root/mp-home-backups
KEEP=2
STATUS=$V/monitor/backup.json
LOG=/var/log/mp-home-backup.log
STAMP=$(date -u +%Y%m%d-%H%M%S)
exec >>"$LOG" 2>&1
BYTES=0
FILES=""
say() { echo "$(date -u '+%F %T') $*"; }

status() { # <true|false> <detail>
  local kept
  kept=$(ls "$KEEP_DIR" 2>/dev/null | grep -c '^catalog-' || true)
  python3 -I -c 'import json,sys,datetime
ok,b,f,k,d=sys.argv[1:6]
print(json.dumps({"at":datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
  "ok":ok=="true","bytes":int(b),"file":f,"kept":int(k),"detail":d}))' \
    "$1" "$BYTES" "$FILES" "$kept" "$2" > "$STATUS.tmp"
  chown 1000:1000 "$STATUS.tmp"; chmod 644 "$STATUS.tmp"; mv -f "$STATUS.tmp" "$STATUS"
}
fail() { say "FAILED: $*"; status false "$*"; exit 1; }
cleanup() {
  rm -rf "$W"
  docker exec -u 0 "$C" rm -f /app/tg-upload.mjs /app/mp-snap.mjs 2>/dev/null || true
}
trap cleanup EXIT
trap 'fail "step failed (line $LINENO): $BASH_COMMAND"' ERR

say "start $STAMP"
docker inspect -f '{{.State.Running}}' "$C" | grep -q true || fail "music-bot is not running"
# Room for the catalog copy plus the compressed files.
need=$(( $(stat -c %s "$V/catalog/catalog.db") * 13 / 10 + 1024 * 1024 * 1024 ))
free=$(( $(stat -f -c '%a*%S' "$V" ) ))
[ "$free" -gt "$need" ] || fail "not enough disk: $((free >> 20)) MB free, need $((need >> 20)) MB"

rm -rf "$W"; mkdir -p "$W"; chown 1000:1000 "$W"

# 1. Consistent catalog copy (SQLite online backup: the bot keeps running),
#    then a check, in the container's own Node.
cat > "$W/mp-snap.mjs" <<'JS'
import { DatabaseSync, backup } from "node:sqlite";
const src = new DatabaseSync("/shares/catalog/catalog.db", { readOnly: true });
await backup(src, "/shares/dbbak/catalog.db", { rate: 256 });
src.close();
const d = new DatabaseSync("/shares/dbbak/catalog.db");
d.exec("PRAGMA journal_mode=DELETE");
const check = d.prepare("PRAGMA quick_check").get().quick_check;
const songs = d.prepare("SELECT COUNT(*) n FROM songs").get().n;
const stored = d.prepare("SELECT COUNT(*) n FROM songs WHERE status='stored'").get().n;
d.close();
console.log(`quick_check ${check} songs ${songs} stored ${stored}`);
JS
docker cp "$W/mp-snap.mjs" "$C:/app/mp-snap.mjs"
rm -f "$W/mp-snap.mjs"
check=$(docker exec "$C" nice node /app/mp-snap.mjs 2>&1 | grep -v Experimental | tail -1)
say "$check"
echo "$check" | grep -q "quick_check ok" || fail "catalog copy check: $check"

# 2. The small data files that exist.
items=()
for f in accounts users invites.json shares.json shared explore song-links.json usage.json metrics.json reports.jsonl monitor; do
  [ -e "$V/$f" ] && items+=("$f")
done
tar -C "$V" -cf "$W/data.tar" --exclude='monitor/*.tmp' "${items[@]}"

# 3. Compress.
CAT=$W/catalog-$STAMP.db.zst
DATA=$W/data-$STAMP.tar.zst
nice ionice -c3 zstd -q -10 -T2 "$W/catalog.db" -o "$CAT"
rm -f "$W/catalog.db"
nice zstd -q -10 "$W/data.tar" -o "$DATA"
rm -f "$W/data.tar"
chown 1000:1000 "$CAT" "$DATA"
BYTES=$(( $(stat -c %s "$CAT") + $(stat -c %s "$DATA") ))
FILES="$(basename "$CAT") + $(basename "$DATA")"
say "compressed: $FILES ($((BYTES >> 20)) MB)"

# 4. Upload both to the private backup channel (as the store bot, MTProto: up to 2 GB a file).
docker cp /usr/local/lib/tg-upload.mjs "$C:/app/tg-upload.mjs"
info="${check#quick_check ok }"
for f in "$CAT" "$DATA"; do
  sum=$(sha256sum "$f" | cut -c1-16)
  out=$(docker exec -w /app "$C" node tg-upload.mjs "$CHANNEL" "/shares/dbbak/$(basename "$f")" \
    "MiniPlayer home backup $STAMP UTC (Germany): $(basename "$f"), $info. zstd; sha256 starts $sum." 2>&1 | grep -v Experimental | tail -1)
  say "$out"
  echo "$out" | grep -q '^SENT' || fail "Telegram upload of $(basename "$f"): $out"
done

# 5. Keep the last $KEEP nights here too.
mkdir -p "$KEEP_DIR"; chmod 700 "$KEEP_DIR"
mv "$CAT" "$DATA" "$KEEP_DIR/"
ls -1 "$KEEP_DIR"/catalog-*.db.zst | sort | head -n -"$KEEP" | while read -r old; do
  s=${old##*/catalog-}; s=${s%.db.zst}
  rm -f "$old" "$KEEP_DIR/data-$s.tar.zst"
done

status true ""
say "DONE"
tail -n 300 "$LOG" > "$LOG.tmp" && cat "$LOG.tmp" > "$LOG" && rm -f "$LOG.tmp"
