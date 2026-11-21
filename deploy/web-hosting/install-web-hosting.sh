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

if ! id -u qorpera-apphost >/dev/null 2>&1; then
	useradd --system --no-create-home --shell /usr/sbin/nologin --groups lxd qorpera-apphost
fi
if ! id -u caddy >/dev/null 2>&1; then
	useradd --system --no-create-home --shell /usr/sbin/nologin caddy
fi

install -d -m 0755 /etc/qorpera-web
install -d -m 0755 /var/lib/qorpera-web-blobs
install -d -m 0750 -o caddy -g caddy /var/lib/qorpera-web-certs
install -d -m 0755 /usr/local/libexec/qorpera-web-hosting

install -m 0755 "$BIN_DIR/qorpera-web-router" /usr/local/bin/qorpera-web-router
install -m 0755 "$BIN_DIR/qorpera-app-host" /usr/local/bin/qorpera-app-host
install -m 0755 "$KIT_DIR/builder-railpack.sh" /usr/local/libexec/qorpera-web-hosting/builder-railpack.sh
install -m 0644 "$KIT_DIR/Caddyfile" /etc/qorpera-web/Caddyfile
install -m 0644 "$KIT_DIR/nftables-edge.nft" /etc/qorpera-web/nftables-edge.nft
install -m 0644 "$KIT_DIR/qorpera-web-router.service" /etc/systemd/system/qorpera-web-router.service
install -m 0644 "$KIT_DIR/qorpera-app-host.service" /etc/systemd/system/qorpera-app-host.service
install -m 0644 "$KIT_DIR/qorpera-web-caddy.service" /etc/systemd/system/qorpera-web-caddy.service

if command -v lxc >/dev/null 2>&1; then
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
