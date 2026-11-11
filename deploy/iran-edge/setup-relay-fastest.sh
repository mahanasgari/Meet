#!/bin/bash
# Run from the PC once: the Iran relay reaches Germany, the United States and
# Turkey through SSH tunnels and uses whichever answers fastest (mpedge-pick).
# The tunnel users can only open 127.0.0.1:4100 (no shell, no other ports).
# Leaves haproxy and the irtunnel@ VPN services alone.
set -e
cd "$(dirname "$0")"
KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFvwmuKGHBpESdeMp94XPS0G9InaUIURTUA3f+0Wl0As mpedge-iran'
for h in bl-us bl-tr; do
  ssh "$h" "id mpedge >/dev/null 2>&1 || useradd -r -m -d /home/mpedge -s /usr/sbin/nologin mpedge
install -d -m 700 -o mpedge -g mpedge /home/mpedge/.ssh
echo 'restrict,port-forwarding,permitopen=\"127.0.0.1:4100\" $KEY' > /home/mpedge/.ssh/authorized_keys
chown mpedge:mpedge /home/mpedge/.ssh/authorized_keys; chmod 600 /home/mpedge/.ssh/authorized_keys
echo \"\$(hostname): tunnel user ready\""
done
# Iran trusts the servers' real host keys (read here over our own SSH).
for x in bl-us:104.37.191.251 bl-tr:80.253.254.57; do
  h=${x%%:*}; ip=${x#*:}
  k=$(ssh "$h" cat /etc/ssh/ssh_host_ed25519_key.pub | awk '{print $1" "$2}')
  ssh bl-irm "grep -q '^$ip ' /etc/mpedge/known_hosts || echo '$ip $k' >> /etc/mpedge/known_hosts"
done
scp -q mpedge-tunnel-us.service mpedge-tunnel-tr.service mpedge-pick.service bl-irm:/etc/systemd/system/
scp -q mpedge-pick.sh bl-irm:/usr/local/bin/mpedge-pick.sh
scp -q mpedge.conf bl-irm:/etc/nginx/conf.d/mpedge.conf.new
ssh bl-irm 'set -e
chmod +x /usr/local/bin/mpedge-pick.sh
[ -f /etc/nginx/mpedge-upstream.conf ] || printf "server 127.0.0.1:14100 max_fails=2 fail_timeout=15s;\nserver 127.0.0.1:14101 backup max_fails=2 fail_timeout=15s;\nserver 127.0.0.1:14102 backup max_fails=2 fail_timeout=15s;\n" > /etc/nginx/mpedge-upstream.conf
cp /etc/nginx/conf.d/mpedge.conf /root/mpedge.conf.bak-$(date +%F-%H%M)
mv /etc/nginx/conf.d/mpedge.conf.new /etc/nginx/conf.d/mpedge.conf
if ! nginx -t -q; then cp "$(ls -t /root/mpedge.conf.bak-* | head -1)" /etc/nginx/conf.d/mpedge.conf; echo "nginx config failed: restored"; exit 1; fi
systemctl reload nginx
systemctl daemon-reload
systemctl enable --now mpedge-tunnel-us mpedge-tunnel-tr mpedge-pick
sleep 8
for p in 14100 14101 14102; do printf "port %s: " $p; curl -s -m 8 -o /dev/null -w "%{http_code} %{time_total}s\n" http://127.0.0.1:$p/health || echo down; done
echo "Iran relay: using the fastest server"'
