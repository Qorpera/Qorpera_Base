#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
	echo "Run as root." >&2
	exit 1
fi

KIT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="${1:-}"
if [ -z "$BIN_DIR" ] || [ ! -x "$BIN_DIR/qorpera-web-router" ] || [ ! -x "$BIN_DIR/qorpera-app-host" ]; then
	echo "Usage: $0 <dir-containing-qorpera-web-router-and-qorpera-app-host>" >&2
	exit 2
fi

if ! id -u qorpera-web >/dev/null 2>&1; then
	if ! getent group qorpera-web >/dev/null 2>&1; then
		groupadd --system --gid 20049 qorpera-web 2>/dev/null || groupadd --system qorpera-web
	fi
	useradd --system --uid 20049 --gid qorpera-web --no-create-home --shell /usr/sbin/nologin qorpera-web 2>/dev/null \
		|| useradd --system --gid qorpera-web --no-create-home --shell /usr/sbin/nologin qorpera-web
fi
if ! id -u qorpera-apphost >/dev/null 2>&1; then
	useradd --system --no-create-home --shell /usr/sbin/nologin --groups lxd qorpera-apphost
fi
if ! id -u caddy >/dev/null 2>&1; then
	useradd --system --no-create-home --shell /usr/sbin/nologin caddy
fi
usermod -aG qorpera-web caddy

install -d -m 0755 /etc/qorpera-web
install -d -m 0750 -o qorpera-web -g qorpera-web /var/lib/qorpera-web-blobs 2>/dev/null || install -d -m 0755 /var/lib/qorpera-web-blobs
install -d -m 0750 -o caddy -g caddy /var/lib/qorpera-web-certs 2>/dev/null || install -d -m 0755 /var/lib/qorpera-web-certs
install -d -m 0755 /usr/local/libexec/qorpera-web-hosting

install -m 0755 "$BIN_DIR/qorpera-web-router" /usr/local/bin/qorpera-web-router
install -m 0755 "$BIN_DIR/qorpera-app-host" /usr/local/bin/qorpera-app-host
if [ -x "$BIN_DIR/caddy" ]; then
	install -m 0755 "$BIN_DIR/caddy" /usr/bin/caddy
fi
install -m 0755 "$KIT_DIR/builder-railpack.sh" /usr/local/libexec/qorpera-web-hosting/builder-railpack.sh
install -m 0644 "$KIT_DIR/Caddyfile" /etc/qorpera-web/Caddyfile
install -m 0644 "$KIT_DIR/nftables-edge.nft" /etc/qorpera-web/nftables-edge.nft
if [ -f /etc/qorpera-web/company-data-egress.conf ]; then
	DATA_ENDPOINTS=""
	while IFS= read -r raw_line || [ -n "$raw_line" ]; do
		line="${raw_line%%#*}"
		line="$(printf '%s' "$line" | tr -d '[:space:]')"
		[ -z "$line" ] && continue
		if [[ "$line" =~ ^([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}):([0-9]{1,5})$ ]]; then
			ip_part="${BASH_REMATCH[1]}"
			port_part="${BASH_REMATCH[2]}"
			if [ "$port_part" -ge 1 ] && [ "$port_part" -le 65535 ]; then
				DATA_ENDPOINTS="${DATA_ENDPOINTS:+${DATA_ENDPOINTS}, }${ip_part} . ${port_part}"
			else
				echo "Invalid port in /etc/qorpera-web/company-data-egress.conf: $line" >&2
				exit 1
			fi
		else
			echo "Invalid IPv4:port entry in /etc/qorpera-web/company-data-egress.conf: $line" >&2
			exit 1
		fi
	done </etc/qorpera-web/company-data-egress.conf
	if [ -n "$DATA_ENDPOINTS" ]; then
		awk -v elems="$DATA_ENDPOINTS" '
			/type ipv4_addr \. inet_service/ {
				print
				print "\t\telements = { " elems " }"
				next
			}
			{ print }
		' /etc/qorpera-web/nftables-edge.nft >/etc/qorpera-web/nftables-edge.nft.tmp
		mv /etc/qorpera-web/nftables-edge.nft.tmp /etc/qorpera-web/nftables-edge.nft
		chmod 0644 /etc/qorpera-web/nftables-edge.nft
	fi
fi
install -m 0644 "$KIT_DIR/qorpera-web-router.service" /etc/systemd/system/qorpera-web-router.service
install -m 0644 "$KIT_DIR/qorpera-app-host.service" /etc/systemd/system/qorpera-app-host.service
install -m 0644 "$KIT_DIR/qorpera-web-caddy.service" /etc/systemd/system/qorpera-web-caddy.service

if [ ! -f /etc/qorpera-web/edge.env ]; then
	LAN_IP="$(ip -4 -o addr show scope global | awk '$2 != "tailscale0" && $2 !~ /^(docker|lxd|qweb|qorpera|qdb|br-|veth)/ {sub(/\/.*/, "", $4); print $4; exit}' || true)"
	if [ -n "$LAN_IP" ]; then
		printf 'QORPERA_EDGE_BIND=%s 192.168.1.250\n' "$LAN_IP" >/etc/qorpera-web/edge.env
		chmod 0644 /etc/qorpera-web/edge.env
	fi
fi

cat <<'SYSCTL' >/etc/sysctl.d/99-qorpera-web-hosting.conf
net.ipv4.ip_nonlocal_bind = 1
net.netfilter.nf_conntrack_tcp_loose = 0
net.ipv4.tcp_syncookies = 1
net.core.somaxconn = 4096
SYSCTL
if command -v sysctl >/dev/null 2>&1; then
	sysctl --system >/dev/null 2>&1 || true
fi
if [ -w /sys/module/zswap/parameters/enabled ]; then
	echo 1 >/sys/module/zswap/parameters/enabled || true
fi
if [ -w /sys/module/zswap/parameters/compressor ]; then
	echo lz4 >/sys/module/zswap/parameters/compressor 2>/dev/null || echo zstd >/sys/module/zswap/parameters/compressor 2>/dev/null || true
fi

if command -v lxc >/dev/null 2>&1; then
	if ! lxc network show qweb0 >/dev/null 2>&1; then
		lxc network create qweb0 ipv4.address=10.209.0.1/24 ipv4.nat=true ipv6.address=none
	fi
	if ! lxc project show qorpera-web-apps >/dev/null 2>&1; then
		lxc project create qorpera-web-apps \
			-c features.images=true \
			-c features.profiles=true \
			-c features.storage.volumes=true \
			-c restricted=true \
			-c restricted.containers.nesting=block \
			-c restricted.containers.privilege=unprivileged
	fi
	if ! lxc --project qorpera-web-apps profile show qorpera-web-apps-egress >/dev/null 2>&1; then
		lxc --project qorpera-web-apps profile create qorpera-web-apps-egress
	fi
	if ! lxc --project qorpera-web-apps profile device show qorpera-web-apps-egress | grep -q '^eth0:'; then
		lxc --project qorpera-web-apps profile device add qorpera-web-apps-egress eth0 nic network=qweb0 name=eth0
	fi
	if ! lxc --project qorpera-web-apps profile device show qorpera-web-apps-egress | grep -q '^root:'; then
		LXD_POOL="$(lxc storage list -f csv -c n | head -n 1 || true)"
		if [ -n "$LXD_POOL" ]; then
			lxc --project qorpera-web-apps profile device add qorpera-web-apps-egress root disk path=/ pool="$LXD_POOL"
		fi
	fi
fi

if command -v nft >/dev/null 2>&1; then
	nft -c -f /etc/qorpera-web/nftables-edge.nft
fi

systemctl daemon-reload

cat <<'EOF'
Installed qorpera-web-router, qorpera-app-host, Caddyfile, builder-railpack.sh, nftables-edge.nft, and systemd units.
Next steps:
  1. Provision encrypted credentials under /etc/credstore.encrypted/:
     - qorpera-web-control-token
     - qorpera-web-cookie-secret
     - qorpera-web-database-url
  2. Apply firewall rules: nft -f /etc/qorpera-web/nftables-edge.nft
  3. Enable and start services:
     systemctl enable --now qorpera-web-router qorpera-app-host qorpera-web-caddy
EOF
