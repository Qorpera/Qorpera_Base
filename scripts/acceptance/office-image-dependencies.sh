#!/bin/bash
set -euo pipefail
test "$(id -u)" = 0
test "$(uname -m)" = x86_64
test -d /run/systemd/system
export DEBIAN_FRONTEND=noninteractive
export LC_ALL=C
# Use the authenticated archive endpoints and the guest's proven IPv4 route.
sed -i -E 's#http://(archive|security)\.ubuntu\.com/ubuntu#https://\1.ubuntu.com/ubuntu#g' /etc/apt/sources.list.d/ubuntu.sources
# Prevent automatic jobs racing the explicit disposable image construction.
systemctl mask apt-daily.timer apt-daily-upgrade.timer apt-daily.service apt-daily-upgrade.service unattended-upgrades.service
for attempt in $(seq 1 120); do
  if ! systemctl is-active --quiet apt-daily.service && ! systemctl is-active --quiet apt-daily-upgrade.service; then break; fi
  sleep 2
done
apt-get -o Acquire::ForceIPv4=true -o Acquire::Retries=0 -o Acquire::https::Timeout=15 -o APT::Update::Error-Mode=any -o DPkg::Lock::Timeout=180 update
apt-get -o Acquire::ForceIPv4=true -o Acquire::Retries=0 -o Acquire::https::Timeout=15 -o DPkg::Lock::Timeout=180 install --yes --no-install-recommends \
  ca-certificates curl unzip xz-utils mokutil bubblewrap tini tigervnc-standalone-server \
  xfce4-session xfwm4 xfconf xfce4-panel xfdesktop4 xfce4-terminal thunar \
  dbus-x11 x11-utils x11-xserver-utils xdotool scrot apparmor-utils tzdata \
  fonts-liberation fonts-dejavu-core libgbm1 libnss3 libatk1.0-0t64 \
  libatk-bridge2.0-0t64 libcups2t64 libxcomposite1 libxdamage1 libxrandr2 \
  libasound2t64 libxkbcommon0 libpango-1.0-0 libcairo2
mkdir -m 0700 /root/office-dependency-downloads
cd /root/office-dependency-downloads
node_file=node-v22.19.0-linux-x64.tar.xz
curl --ipv4 --fail --location --proto '=https' --tlsv1.2 --retry 3 --max-time 180 --output "$node_file" "https://nodejs.org/dist/v22.19.0/$node_file"
curl --ipv4 --fail --location --proto '=https' --tlsv1.2 --retry 3 --max-time 60 --output SHASUMS256.txt https://nodejs.org/dist/v22.19.0/SHASUMS256.txt
awk '$2 == "node-v22.19.0-linux-x64.tar.xz" {print}' SHASUMS256.txt > node.sha256
test "$(wc -l < node.sha256)" = 1
test "$(awk '{print $1}' node.sha256)" = c0649af18e6a24f6fe5535a3e86b341dd49a8e71117c8b68bde973ef834f16f2
sha256sum --check node.sha256
tar -xf "$node_file"
install -m 0755 node-v22.19.0-linux-x64/bin/node /usr/bin/node
test "$(/usr/bin/node --version)" = v22.19.0
# Exact browser version is supplied from the checkout's pinned Playwright inventory.
case "${1:-}" in ''|*[!0-9.]*) exit 2;; esac
test "$1" = 151.0.7922.34
curl --ipv4 --fail --location --proto '=https' --tlsv1.2 --retry 3 --max-time 300 --output chrome.zip "https://storage.googleapis.com/chrome-for-testing-public/$1/linux64/chrome-linux64.zip"
test "$(sha256sum chrome.zip | awk '{print $1}')" = ae8736ac28bc69278551500f219fc749575648263c43ec5990749eff43b9fcf8
unzip -q chrome.zip
test ! -e /usr/lib/qorpera-chromium
mv chrome-linux64 /usr/lib/qorpera-chromium
chmod -R go-w /usr/lib/qorpera-chromium
find /usr/lib/qorpera-chromium -type f -exec chmod a-s '{}' +
sha256sum "$node_file" chrome.zip > archives.sha256
/usr/lib/qorpera-chromium/chrome --version
dpkg-query -W > dpkg-manifest.txt
apt-get clean
