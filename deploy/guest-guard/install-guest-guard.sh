#!/usr/bin/env bash
# Installs the guest guard from a checkout of this folder: verifies every file against the pins below, copies
# them to /usr/local/libexec/qorpera-guest-guard and the unit to /etc/systemd/system, and parses the rules
# against the kernel. It loads nothing and enables nothing: README.md has the observe and enforce steps.
set -euo pipefail

EXPECTED_RULES_SHA256="31f82e834604796d2072ee677c7a626efde7be946d25ca5a21e877b9f903f952"
EXPECTED_TOOL_SHA256="fba9a23b5d4d5d6119892de049f253d34b5121fcdddc52d2229e0257f0eea4a7"
EXPECTED_UNIT_SHA256="6ef1d6ee3e1203eba9c486228e20cabfe967dd83542093e31ccf6768cab1dd0e"
SOURCE_ROOT=$(cd "$(dirname "$0")" && pwd)
INSTALL_ROOT="/usr/local/libexec/qorpera-guest-guard"

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
pin qorpera-guest-guard.nft "$EXPECTED_RULES_SHA256"
pin qorpera-guest-guard.sh "$EXPECTED_TOOL_SHA256"
pin qorpera-guest-guard.service "$EXPECTED_UNIT_SHA256"

install -d -m 0755 "$INSTALL_ROOT" /etc/qorpera-guest-guard
install -m 0644 "$SOURCE_ROOT/qorpera-guest-guard.nft" "$INSTALL_ROOT/qorpera-guest-guard.nft"
install -m 0755 "$SOURCE_ROOT/qorpera-guest-guard.sh" "$INSTALL_ROOT/qorpera-guest-guard.sh"
install -m 0644 "$SOURCE_ROOT/qorpera-guest-guard.service" /etc/systemd/system/qorpera-guest-guard.service
systemctl daemon-reload
"$INSTALL_ROOT/qorpera-guest-guard.sh" check
echo "Installed. Nothing is loaded or enabled; next: README.md step 3 (observe through the mode file)"
