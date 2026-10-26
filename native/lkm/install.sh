#!/bin/sh
# liveapi_uts 内核模块安装脚本。
#
# 为什么需要这个：模块用 insmod 加载后只活到下次重启。机器一重启，
# 20 个槽的 uname -r 全部退回宿主值 —— 而且没有任何报错，
# stepUts 只会在日志里写一句"跳过"，很容易被忽略。
#
# 做成 systemd unit 而不是塞 /etc/modules：/etc/modules 在部分
# 发行版（尤其容器化宿主）不生效，systemd 是确定的。
set -e

MOD=liveapi_uts
SRC_DIR=$(cd "$(dirname "$0")" && pwd)
KDIR=/lib/modules/$(uname -r)/build

if [ "$(id -u)" != "0" ]; then
  echo "需要 root" >&2
  exit 1
fi

if [ ! -d "$KDIR" ]; then
  echo "缺少内核头文件: $KDIR" >&2
  echo "  apt-get install -y linux-headers-\$(uname -r)" >&2
  exit 1
fi

echo "[1/4] 编译"
make -C "$SRC_DIR" clean >/dev/null 2>&1 || true
make -C "$SRC_DIR" 2>&1 | grep -E "error|ERROR" && exit 1 || true

if [ ! -f "$SRC_DIR/$MOD.ko" ]; then
  echo "编译失败：没有产出 $MOD.ko" >&2
  exit 1
fi

echo "[2/4] 安装到 /lib/modules/$(uname -r)/extra/"
install -d "/lib/modules/$(uname -r)/extra"
install -m 0644 "$SRC_DIR/$MOD.ko" "/lib/modules/$(uname -r)/extra/$MOD.ko"
depmod -a

echo "[3/4] 写 systemd unit"
cat > /etc/systemd/system/live-api-uts.service <<UNIT
[Unit]
Description=live-api UTS spoofing kernel module
After=local-fs.target
Before=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
# 先卸再装：重装场景下旧模块还占着 /proc/liveapi_uts，
# 直接 modprobe 会返回 "already loaded" 并让 unit 失败。
ExecStartPre=-/sbin/modprobe -r $MOD
ExecStart=/sbin/modprobe $MOD
ExecStop=-/sbin/modprobe -r $MOD

[Install]
WantedBy=multi-user.target
UNIT

echo "[4/4] 启用并启动"
systemctl daemon-reload
systemctl enable live-api-uts.service >/dev/null 2>&1
systemctl restart live-api-uts.service

if lsmod | grep -q "^$MOD"; then
  echo "完成：$MOD 已加载，接口 /proc/$MOD"
  echo "  重启后自动加载：systemctl is-enabled live-api-uts"
else
  echo "失败：模块未加载" >&2
  systemctl status live-api-uts.service --no-pager -l 2>&1 | tail -10 >&2
  exit 1
fi
