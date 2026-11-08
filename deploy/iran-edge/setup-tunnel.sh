#!/bin/bash
# Run from the PC: lets the Iran edge reach Germany's music bot through SSH.
# 1) Germany: tunnel-only user "mpedge"; its key can only open 127.0.0.1:4100
#    (no shell, no other ports).
# 2) Iran: the tunnel service (starts on boot, reconnects by itself).
set -e
KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFvwmuKGHBpESdeMp94XPS0G9InaUIURTUA3f+0Wl0As mpedge-iran'
ssh bl-de "id mpedge >/dev/null 2>&1 || useradd -r -m -d /home/mpedge -s /usr/sbin/nologin mpedge
install -d -m 700 -o mpedge -g mpedge /home/mpedge/.ssh
echo 'restrict,port-forwarding,permitopen=\"127.0.0.1:4100\" $KEY' > /home/mpedge/.ssh/authorized_keys
chown mpedge:mpedge /home/mpedge/.ssh/authorized_keys; chmod 600 /home/mpedge/.ssh/authorized_keys
echo Germany: mpedge ready"
scp -q "$(dirname "$0")/mpedge-tunnel.service" bl-irm:/etc/systemd/system/mpedge-tunnel.service
ssh bl-irm 'systemctl daemon-reload && systemctl enable --now mpedge-tunnel && sleep 5 && systemctl is-active mpedge-tunnel && curl -s -m 10 http://127.0.0.1:14100/health && echo && echo Iran: tunnel up'
