#!/usr/bin/env bash
# Installs the agent exit from a checkout of this folder: verifies every file against the pins below, copies the
# tool, rules and logger to /usr/local/libexec/qorpera-agent-exit and the units to /etc/systemd/system, and runs the
# tool's check. It installs no package, starts nothing and enables nothing: README.md has the switch-on steps.
set -euo pipefail

EXPECTED_TOOL_SHA256="cc549b097c198d1a873e7f6fc5b388e17845b027cfc0c582986294f329a9c30b"
EXPECTED_EXIT_RULES_SHA256="cc627aaa45294cc0a68b0680fb6ca9cbca2afe1fe0eeedb84feb3c1df8463934"
EXPECTED_HOST_RULES_SHA256="3b091446eb0a9ba2d15c63337f8d5530e7550c04850a057521ce3db3f5a3ca67"
EXPECTED_LOGGER_SHA256="67ea5b9eb38f1d2e8ee067f9770600ac347099e94c90da58f124b85c1aa67376"
EXPECTED_UNIT_SHA256="0c91f5d4a59689d132073eb148bc96290a83ee88b287532480af989b0cd67be1"
EXPECTED_DNS_UNIT_SHA256="e8c58a5da2586633159592358546caf7abd1462ddec069ddb0d72baa458b37c5"
EXPECTED_LOG_UNIT_SHA256="53f75dfda39d62df68f2c48c1ebe17a6f2cd6bf90094e57670b00458a9ce7b63"
SOURCE_ROOT=$(cd "$(dirname "$0")" && pwd)
INSTALL_ROOT="/usr/local/libexec/qorpera-agent-exit"

[[ $# -eq 0 ]] || {
	echo "Usage: $0" >&2
	exit 64
}
[[ $(id -u) -eq 0 ]] || {
	echo "Run as root." >&2
	exit 77
}

pin() {
	local actual
	actual=$(sha256sum "$SOURCE_ROOT/$1" | cut -d' ' -f1)
	[[ $actual == "$2" ]] || {
		echo "$1: sha256 $actual, expected $2; refusing to install" >&2
		exit 65
	}
}
pin qorpera-agent-exit.sh "$EXPECTED_TOOL_SHA256"
pin qorpera-agent-exit.nft "$EXPECTED_EXIT_RULES_SHA256"
pin qorpera-agent-exit-host.nft "$EXPECTED_HOST_RULES_SHA256"
pin qorpera-agent-exit-log.py "$EXPECTED_LOGGER_SHA256"
pin qorpera-agent-exit.service "$EXPECTED_UNIT_SHA256"
pin qorpera-agent-exit-dns.service "$EXPECTED_DNS_UNIT_SHA256"
pin qorpera-agent-exit-log.service "$EXPECTED_LOG_UNIT_SHA256"

install -d -m 0755 "$INSTALL_ROOT"
install -m 0755 "$SOURCE_ROOT/qorpera-agent-exit.sh" "$INSTALL_ROOT/qorpera-agent-exit.sh"
install -m 0644 "$SOURCE_ROOT/qorpera-agent-exit.nft" "$INSTALL_ROOT/qorpera-agent-exit.nft"
install -m 0644 "$SOURCE_ROOT/qorpera-agent-exit-host.nft" "$INSTALL_ROOT/qorpera-agent-exit-host.nft"
install -m 0755 "$SOURCE_ROOT/qorpera-agent-exit-log.py" "$INSTALL_ROOT/qorpera-agent-exit-log.py"
for unit in qorpera-agent-exit.service qorpera-agent-exit-dns.service qorpera-agent-exit-log.service; do
	install -m 0644 "$SOURCE_ROOT/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload
"$INSTALL_ROOT/qorpera-agent-exit.sh" check
echo "Installed. Nothing is started or enabled; next: README.md, 'Switching a node on'."
