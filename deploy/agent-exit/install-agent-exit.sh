#!/usr/bin/env bash
# Installs the agent exit from a checkout of this folder: verifies every file against the pins below, copies the
# tool, rules and logger to /usr/local/libexec/qorpera-agent-exit and the units to /etc/systemd/system, and runs the
# tool's check. It installs no package, starts nothing and enables nothing: README.md has the switch-on steps.
set -euo pipefail

EXPECTED_TOOL_SHA256="f01ffd9b24da71e125f3cca4518811aaf3da1255af2ed4f90e1422c875ff9244"
EXPECTED_EXIT_RULES_SHA256="0bbbbb66ea7126d2115188b08205d31c363eaf747e82fa5a00e72b3a2d3630ad"
EXPECTED_HOST_RULES_SHA256="d5299dc73eb357105cc4c2552dbf81fa1bdb301aec95c4d2e85ed32f0e681c0d"
EXPECTED_LOGGER_SHA256="6646a34a982476025739888896c5ee6e062cc688ea9792c88c5aa1951e1e3795"
EXPECTED_UNIT_SHA256="6ee0c965577597c05c35234caf372403013fade44e3c4752da9fae66928b177f"
EXPECTED_DNS_UNIT_SHA256="77ac82a7a97e31ae0c4df40cd59a866a93c34bb0e410e124f32f504e86b715b5"
EXPECTED_LOG_UNIT_SHA256="2cade5b780c0176b9ebcf70f4198e238adedf4a537111e387c2acfa3d394eef6"
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
