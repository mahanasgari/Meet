#!/usr/bin/env bash
# Forced command on the backup server (root): store one mp-home archive read from stdin.
# authorized_keys: command="/usr/local/bin/mp-backup-receive.sh",restrict ssh-ed25519 ...
set -euo pipefail

MP_BACKUP_DIR="${MP_BACKUP_DIR:-/root/mp-backups}"
MP_BACKUP_KEEP="${MP_BACKUP_KEEP:-14}"
MAX_BYTES=$((2 * 1024 * 1024 * 1024))

NAME="${SSH_ORIGINAL_COMMAND:-}"
NAME_RE='^mp-home-[0-9]{8}-[0-9]{6}\.tar\.gz$'

die() {
  echo "error $*" >&2
  exit 1
}

# Only accept a strict file name; the command is never evaluated
[[ "$NAME" =~ $NAME_RE ]] || die "bad name"

mkdir -p "$MP_BACKUP_DIR"
chmod 700 "$MP_BACKUP_DIR"
FINAL="$MP_BACKUP_DIR/$NAME"
TMP="$MP_BACKUP_DIR/.incoming-$$"
trap 'rm -f "$TMP"' EXIT

# Read at most MAX_BYTES+1 so an oversized upload is detected, not silently truncated
head -c "$((MAX_BYTES + 1))" > "$TMP" || die "write failed"
BYTES="$(stat -c %s "$TMP")"
[ "$BYTES" -gt 0 ] || die "empty upload"
[ "$BYTES" -le "$MAX_BYTES" ] || die "too large"
tar -tzf "$TMP" > /dev/null 2>&1 || die "not a valid gzip tar"

chmod 600 "$TMP"
mv -f "$TMP" "$FINAL"

# Prune: keep only the newest MP_BACKUP_KEEP archives (names sort chronologically)
n=0
while IFS= read -r f; do
  n=$((n + 1))
  if [ "$n" -gt "$MP_BACKUP_KEEP" ]; then rm -f -- "$MP_BACKUP_DIR/$f"; fi
done < <(find "$MP_BACKUP_DIR" -maxdepth 1 -type f -name 'mp-home-*.tar.gz' -printf '%f\n' \
  | grep -E '^mp-home-[0-9]{8}-[0-9]{6}\.tar\.gz$' | sort -r)

if [ "$n" -gt "$MP_BACKUP_KEEP" ]; then KEPT="$MP_BACKUP_KEEP"; else KEPT="$n"; fi
echo "ok $BYTES $KEPT"
