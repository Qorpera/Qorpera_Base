#!/usr/bin/env bash
# Installs the agent exit from a checkout of this folder: verifies every file against the pins below, copies the
# tool, rules and logger to /usr/local/libexec/qorpera-agent-exit and the units to /etc/systemd/system, and runs the
# tool's check. It installs no package, starts nothing and enables nothing: README.md has the switch-on steps.
set -euo pipefail

EXPECTED_TOOL_SHA256="b36a0a35cfb8136cb6f3c9795055b5e21ae94054db66a53b82bb98be2752b966"
EXPECTED_EXIT_RULES_SHA256="f14bb984a4cdb5d59e2dcf24b17dd5b92e4c7f7a82b7ae3ff666702f7affedee"
EXPECTED_HOST_RULES_SHA256="3b091446eb0a9ba2d15c63337f8d5530e7550c04850a057521ce3db3f5a3ca67"
EXPECTED_LOGGER_SHA256="8f213cba17e0dda90a7b0cdd16d7a129808c772f2875604499a1e27a303fed18"
EXPECTED_UNIT_SHA256="6d704e6b64d53ee89a3cb5c91598cfe09ffee0fc5e439699154acdfe5fbd5f98"
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
