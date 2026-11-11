#!/bin/bash
# Iran relay: every 20 s, time each server's music bot through its tunnel
# and put the fastest first in nginx's upstream (the others as backups, so
# nginx moves on by itself when the first fails). Reloads nginx only when
# the order changes, and switches only for a clearly faster server (25 %).
# Ports: 14100 Germany, 14101 United States, 14102 Turkey.
CONF=/etc/nginx/mpedge-upstream.conf
STATE=/run/mpedge-pick.state
PORTS="14100 14101 14102"
while true; do
  best=""; bestms=999999; cur="$(cat "$STATE" 2>/dev/null)"; curms=999999
  declare -A ms=()
  for p in $PORTS; do
    t=$(curl -s -o /dev/null -m 5 -w '%{http_code} %{time_total}' "http://127.0.0.1:$p/health")
    code=${t%% *}; sec=${t#* }
    if [ "$code" = "200" ]; then
      ms[$p]=$(awk -v s="$sec" 'BEGIN{printf "%d", s*1000}')
      [ "${ms[$p]}" -lt "$bestms" ] && { best=$p; bestms=${ms[$p]}; }
      [ "$p" = "$cur" ] && curms=${ms[$p]}
    fi
  done
  # Keep the current one unless it's down or another is 25 % faster.
  if [ -n "$cur" ] && [ "$curms" -lt 999999 ] && [ $((bestms * 125 / 100)) -ge "$curms" ]; then best=$cur; fi
  [ -z "$best" ] && best=${cur:-14100}
  {
    echo "# written by mpedge-pick $(date -u +%FT%TZ): ${!ms[*]} -> ${ms[*]} ms"
    echo "server 127.0.0.1:$best max_fails=2 fail_timeout=15s;"
    for p in $PORTS; do [ "$p" != "$best" ] && echo "server 127.0.0.1:$p backup max_fails=2 fail_timeout=15s;"; done
  } > "$CONF.new"
  if ! cmp -s <(grep -v '^#' "$CONF.new") <(grep -v '^#' "$CONF" 2>/dev/null); then
    mv "$CONF.new" "$CONF"
    nginx -t -q && systemctl reload nginx && echo "relay now via port $best (${ms[$best]:-?} ms)"
  else
    mv "$CONF.new" "$CONF" # keep the timings fresh
  fi
  echo "$best" > "$STATE"
  sleep 20
done
