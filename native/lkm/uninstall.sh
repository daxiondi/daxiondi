#!/bin/sh
# 卸载 skylink_uts 并移除开机自启。
set -e
MOD=skylink_uts
[ "$(id -u)" = "0" ] || { echo "需要 root" >&2; exit 1; }

systemctl disable --now skylink-uts.service 2>/dev/null || true
rm -f /etc/systemd/system/skylink-uts.service
systemctl daemon-reload
rm -f "/lib/modules/$(uname -r)/extra/$MOD.ko"
depmod -a
/sbin/modprobe -r "$MOD" 2>/dev/null || true
echo "已卸载 $MOD"
