#!/usr/bin/env bash
# Installs the agent exit from a checkout of this folder: verifies every file against the pins below, copies the
# tool, rules and logger to /usr/local/libexec/qorpera-agent-exit and the units to /etc/systemd/system, and runs the
# tool's check. It installs no package, starts nothing and enables nothing: README.md has the switch-on steps.
set -euo pipefail

EXPECTED_TOOL_SHA256="dff111f116a7a5f593c1500d89a7340cbb51e1022b5e05fd7745e3b705bdb134"
EXPECTED_EXIT_RULES_SHA256="75ca0a8671d72508cbfb716a170302fa2a0d81f1777d4c8fecbfe0bc5abc9210"
EXPECTED_HOST_RULES_SHA256="3b091446eb0a9ba2d15c63337f8d5530e7550c04850a057521ce3db3f5a3ca67"
EXPECTED_LOGGER_SHA256="6b40baf4a29591b4581f1ed50979b65333261d793b90ea11d7594bd19c35f93d"
EXPECTED_UNIT_SHA256="2305ffc1b14b57498959cc4a25334c8cc4f7aa8cb8d0f28b75ba246891654a77"
EXPECTED_DNS_UNIT_SHA256="8a64e1dfbe0e8be8bacb03ec501cc413a4d180251d83183bc48fbf41a29335a1"
EXPECTED_LOG_UNIT_SHA256="d45014a0d8858f657fe5f6c3182064d9b50de68c3735aa8d2bee6dface88dec5"
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
