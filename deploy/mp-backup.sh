#!/usr/bin/env bash
# Nightly backup (cron, root on HOME server): music bot data + extra files -> backup server.
set -euo pipefail

MP_BACKUP_VOLUME_DIR="${MP_BACKUP_VOLUME_DIR:-/var/lib/docker/volumes/meet_music_shares/_data}"
MP_BACKUP_EXTRA="${MP_BACKUP_EXTRA:-/root/Projects/Meet/.env}"
MP_BACKUP_TARGET="${MP_BACKUP_TARGET:-root@2.31.7.202}"
MP_BACKUP_KEY="${MP_BACKUP_KEY:-/root/.ssh/mp_backup_ed25519}"
MP_BACKUP_STATUS="${MP_BACKUP_STATUS:-$MP_BACKUP_VOLUME_DIR/monitor/backup.json}"

NAME="mp-home-$(date -u +%Y%m%d-%H%M%S).tar.gz"
TMP=""
BYTES=0
KEPT=null
DETAIL=""
REPORTED=0

# write_status <ok true|false>: atomic JSON status file (readable by uid 1000)
write_status() {
  mkdir -p "$(dirname "$MP_BACKUP_STATUS")"
  local tmp="$MP_BACKUP_STATUS.tmp"
  python3 -I -c '
import json, sys, datetime
ok, nbytes, name, kept, detail = sys.argv[1:6]
print(json.dumps({
    "at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "ok": ok == "true",
    "bytes": int(nbytes),
    "file": name,
    "kept": None if kept == "null" else int(kept),
    "detail": detail,
}))' "$1" "$BYTES" "$NAME" "$KEPT" "$DETAIL" > "$tmp"
  chmod 644 "$tmp"
  mv -f "$tmp" "$MP_BACKUP_STATUS"
  REPORTED=1
}

fail() {
  DETAIL="$*"
  echo "mp-backup: $DETAIL" >&2
  exit 1
}

# On any failure: write ok:false (once) and clean up the temp dir.
on_exit() {
  local rc=$?
  if [ "$rc" -ne 0 ] && [ "$REPORTED" -eq 0 ]; then
    [ -n "$DETAIL" ] || DETAIL="failed (exit $rc)"
    write_status false || true
  fi
  [ -n "$TMP" ] && rm -rf "$TMP"
  exit "$rc"
}
trap on_exit EXIT

TMP="$(mktemp -d)"
ARCH="$TMP/$NAME"
STAGE="$TMP/stage"

[ -d "$MP_BACKUP_VOLUME_DIR" ] || fail "volume dir missing: $MP_BACKUP_VOLUME_DIR"

# Stage extra files (skip missing ones) under extra/
mkdir -p "$STAGE/extra"
for f in $MP_BACKUP_EXTRA; do  # space-separated on purpose
  if [ -f "$f" ]; then cp -p "$f" "$STAGE/extra/"; fi
done

# Volume content goes under shares/ (the '.' prefix is rewritten), extras under extra/.
# The bot keeps writing while this runs: GNU tar exits 1 for "file changed
# as we read it", which is fine for a nightly copy; only 2+ is a real error.
rc=0
tar -czf "$ARCH" --warning=no-file-changed --warning=no-file-removed \
  --exclude='./app/files' --exclude='./art' --exclude='./lyrics' --exclude='*.tmp' \
  --transform='s,^\.,shares,' \
  -C "$MP_BACKUP_VOLUME_DIR" . \
  -C "$STAGE" extra || rc=$?
[ "$rc" -le 1 ] || fail "tar failed (exit $rc)"

BYTES="$(stat -c %s "$ARCH")"

# Verify the archive is readable and not empty
COUNT="$(tar -tzf "$ARCH" | wc -l)"
[ "$COUNT" -gt 0 ] || fail "archive has no entries"

# Send: remote forced command reads the name from SSH_ORIGINAL_COMMAND and data from stdin
RES="$(ssh -i "$MP_BACKUP_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
  -o ConnectTimeout=20 "$MP_BACKUP_TARGET" "$NAME" < "$ARCH" 2> "$TMP/ssh.err")" \
  || fail "ssh: $(tr '\n' ' ' < "$TMP/ssh.err" | head -c 300)"

# Expect "ok <bytes> <kept>" as the last line
LAST="$(printf '%s\n' "$RES" | tail -n 1)"
read -r R_OK R_BYTES R_KEPT <<< "$LAST" || true
[ "$R_OK" = "ok" ] || fail "bad reply: $(printf '%s' "$LAST" | head -c 200)"
[ "$R_BYTES" = "$BYTES" ] || fail "size mismatch: sent $BYTES, remote got $R_BYTES"
case "$R_KEPT" in
  ''|*[!0-9]*) KEPT=null ;;
  *) KEPT="$R_KEPT" ;;
esac

write_status true
echo "mp-backup: ok $NAME $BYTES bytes, kept ${KEPT}"
