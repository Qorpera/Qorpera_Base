#!/usr/bin/env bash
# Installs the agent exit from a checkout of this folder: verifies every file against the pins below, copies the
# tool, rules, logger, plug tool and logs' tender to /usr/local/libexec/qorpera-agent-exit and the units to
# /etc/systemd/system, and runs the tool's check. It installs no package, creates no group, starts nothing and
# enables nothing: README.md has the switch-on steps.
set -euo pipefail

EXPECTED_TOOL_SHA256="192d3ac697f26b11f55ae303ed6c4218cd5611dfa8c5192ae5b93e5737dc0baa"
EXPECTED_EXIT_RULES_SHA256="070186dc88624c7f36105c5478f315b5f79deb1d162b7ef4a7f22309ecaf2469"
EXPECTED_HOST_RULES_SHA256="f916b1e859cf4e07707d0f5d5369356c4d57df0417b192b366c001bf36130ef4"
EXPECTED_BRIDGE_RULES_SHA256="271f3f7ba20b794c54bf5676740f55452026a39d7af8b3af20574091bd1e3ac8"
EXPECTED_LOGGER_SHA256="dd5611c8e7e869b930c495834a38d416c4c6b6d1fb59aa19abebfb8df445aea8"
EXPECTED_UNIT_SHA256="636aac78c4cb5a50f45b24ca1d1b008762839b8e12830459c4a609afc837dbb3"
EXPECTED_DNS_UNIT_SHA256="e8c58a5da2586633159592358546caf7abd1462ddec069ddb0d72baa458b37c5"
EXPECTED_LOG_UNIT_SHA256="53f75dfda39d62df68f2c48c1ebe17a6f2cd6bf90094e57670b00458a9ce7b63"
EXPECTED_PLUG_SHA256="3b98e1dc23cff19268000613b3c3e58bc2e189c25e30090ca0d52638842dd9c0"
EXPECTED_PLUG_UNIT_SHA256="4abfe51bb6ec5723815dbd3384f16abe849ed404d6be0b1858b202f51accbf89"
EXPECTED_HEALTH_UNIT_SHA256="a048a3a71baa7afbc477df027e7109926ddcb33fea5f391ea3164aa1659a4f09"
EXPECTED_HEALTH_TIMER_SHA256="6abd734ac5e7bcc9f0370bdf1bcdf722fc3123ffdd6fc8bd4f808c9001ab27b3"
EXPECTED_LOGS_SHA256="823075e015c61ab8ed33fa0cbf97aa5001b7cb8f9a727bcf20636a25e259b7f3"
EXPECTED_LOGS_UNIT_SHA256="038999e576ce720b55b54a75e9620ec55729815b0b1b3355eda0d186783b92db"
EXPECTED_LOGS_TIMER_SHA256="64f27bbab37ae889b6a4be8be94816ba30e635ba090a51be84c5c7c6b0f8cb78"
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
pin qorpera-agent-exit-bridge.nft "$EXPECTED_BRIDGE_RULES_SHA256"
pin qorpera-agent-exit-log.py "$EXPECTED_LOGGER_SHA256"
pin qorpera-agent-exit.service "$EXPECTED_UNIT_SHA256"
pin qorpera-agent-exit-dns.service "$EXPECTED_DNS_UNIT_SHA256"
pin qorpera-agent-exit-log.service "$EXPECTED_LOG_UNIT_SHA256"
pin qorpera-agent-plug.py "$EXPECTED_PLUG_SHA256"
pin qorpera-agent-plug.service "$EXPECTED_PLUG_UNIT_SHA256"
pin qorpera-agent-exit-health.service "$EXPECTED_HEALTH_UNIT_SHA256"
pin qorpera-agent-exit-health.timer "$EXPECTED_HEALTH_TIMER_SHA256"
pin qorpera-agent-exit-logs.py "$EXPECTED_LOGS_SHA256"
pin qorpera-agent-exit-logs.service "$EXPECTED_LOGS_UNIT_SHA256"
pin qorpera-agent-exit-logs.timer "$EXPECTED_LOGS_TIMER_SHA256"

install -d -m 0755 "$INSTALL_ROOT"
install -m 0755 "$SOURCE_ROOT/qorpera-agent-exit.sh" "$INSTALL_ROOT/qorpera-agent-exit.sh"
install -m 0644 "$SOURCE_ROOT/qorpera-agent-exit.nft" "$INSTALL_ROOT/qorpera-agent-exit.nft"
install -m 0644 "$SOURCE_ROOT/qorpera-agent-exit-host.nft" "$INSTALL_ROOT/qorpera-agent-exit-host.nft"
install -m 0644 "$SOURCE_ROOT/qorpera-agent-exit-bridge.nft" "$INSTALL_ROOT/qorpera-agent-exit-bridge.nft"
install -m 0755 "$SOURCE_ROOT/qorpera-agent-exit-log.py" "$INSTALL_ROOT/qorpera-agent-exit-log.py"
install -m 0755 "$SOURCE_ROOT/qorpera-agent-plug.py" "$INSTALL_ROOT/qorpera-agent-plug.py"
install -m 0755 "$SOURCE_ROOT/qorpera-agent-exit-logs.py" "$INSTALL_ROOT/qorpera-agent-exit-logs.py"
for unit in qorpera-agent-exit.service qorpera-agent-exit-dns.service qorpera-agent-exit-log.service \
	qorpera-agent-plug.service qorpera-agent-exit-health.service qorpera-agent-exit-health.timer \
	qorpera-agent-exit-logs.service qorpera-agent-exit-logs.timer; do
	install -m 0644 "$SOURCE_ROOT/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload
"$INSTALL_ROOT/qorpera-agent-exit.sh" check
echo "Installed. Nothing is started or enabled; next: README.md, 'Switching a node on'."
