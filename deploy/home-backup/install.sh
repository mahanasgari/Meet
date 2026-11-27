#!/bin/bash
# Run from your PC: installs the nightly home backup on Germany, retires the
# old ones (old main's mp-backup.sh, Germany's mp-db-telegram), and starts the
# first backup now. Log: ssh bl-de tail -f /var/log/mp-home-backup.log
set -euo pipefail
cd "$(dirname "$0")"
bash -n mp-home-backup.sh
scp -q mp-home-backup.sh bl-de:/usr/local/bin/mp-home-backup.sh
ssh bl-de 'set -e
  chmod 755 /usr/local/bin/mp-home-backup.sh
  test -f /usr/local/lib/tg-upload.mjs
  # 23:30 UTC = 03:00 Tehran, the quietest hour.
  echo "30 23 * * * root /usr/local/bin/mp-home-backup.sh" > /etc/cron.d/mp-home-backup
  chmod 644 /etc/cron.d/mp-home-backup
  rm -f /etc/cron.d/mp-db-telegram
  setsid -f /usr/local/bin/mp-home-backup.sh </dev/null >/dev/null 2>&1
  echo "Germany: nightly backup installed, first one running"'
# The old main is a mirror now: its nightly backup only copied stale data.
ssh bl-main 'crontab -l | sed "s|^0 22 \* \* \* /usr/local/bin/mp-backup.sh|# retired 2026-11-27 (home is Germany): &|" | crontab -
  crontab -l | grep -n "mp-backup" || true'
