#!/usr/bin/env bash
# Installs the agent exit from a checkout of this folder: verifies every file against the pins below, copies the
# tool, rules, logger, plug tool and logs' tool (the tender, the shipper to the NAS and the lookup) to
# /usr/local/libexec/qorpera-agent-exit and the units to /etc/systemd/system, and runs the tool's check. It installs no
# package, creates no group, mounts nothing, starts nothing and enables nothing: README.md has the switch-on steps.
set -euo pipefail

EXPECTED_TOOL_SHA256="82e441f44db7170e74fcf4fe4e6899aeb5997a61a9a12b711f1beef61878e3e1"
EXPECTED_EXIT_RULES_SHA256="9d5f885ab9f7654471c6f54aea23470965a774f94478771b81c8ea114bb4149b"
EXPECTED_HOST_RULES_SHA256="f916b1e859cf4e07707d0f5d5369356c4d57df0417b192b366c001bf36130ef4"
EXPECTED_BRIDGE_RULES_SHA256="271f3f7ba20b794c54bf5676740f55452026a39d7af8b3af20574091bd1e3ac8"
EXPECTED_LOGGER_SHA256="74d36591409b8ff6af90b49ce5fad3a42a55229b70904dc16403125046024d89"
EXPECTED_UNIT_SHA256="636aac78c4cb5a50f45b24ca1d1b008762839b8e12830459c4a609afc837dbb3"
EXPECTED_DNS_UNIT_SHA256="e8c58a5da2586633159592358546caf7abd1462ddec069ddb0d72baa458b37c5"
EXPECTED_LOG_UNIT_SHA256="53f75dfda39d62df68f2c48c1ebe17a6f2cd6bf90094e57670b00458a9ce7b63"
EXPECTED_PLUG_SHA256="583112cda5f53e53da2782ee1cc4d0442df586800c38b0dba3c1bd827d80449e"
EXPECTED_PLUG_UNIT_SHA256="4abfe51bb6ec5723815dbd3384f16abe849ed404d6be0b1858b202f51accbf89"
EXPECTED_HEALTH_UNIT_SHA256="a048a3a71baa7afbc477df027e7109926ddcb33fea5f391ea3164aa1659a4f09"
EXPECTED_HEALTH_TIMER_SHA256="6abd734ac5e7bcc9f0370bdf1bcdf722fc3123ffdd6fc8bd4f808c9001ab27b3"
EXPECTED_LOGS_SHA256="8daf0f612ab1ac2899ae60efcc6f268c99c9f513f0876a6550cd63d3159e1b57"
EXPECTED_LOGS_UNIT_SHA256="038999e576ce720b55b54a75e9620ec55729815b0b1b3355eda0d186783b92db"
EXPECTED_LOGS_TIMER_SHA256="64f27bbab37ae889b6a4be8be94816ba30e635ba090a51be84c5c7c6b0f8cb78"
EXPECTED_SHIP_UNIT_SHA256="a122ffe3c84559b89c37cca3390972d9fc46507218d77d4701000876825959de"
EXPECTED_SHIP_TIMER_SHA256="cc812def189de59af2a57be07f0a1fc2b5469742395681d81d0d446814dddfd8"
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
pin qorpera-agent-exit-ship.service "$EXPECTED_SHIP_UNIT_SHA256"
pin qorpera-agent-exit-ship.timer "$EXPECTED_SHIP_TIMER_SHA256"

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
	qorpera-agent-exit-logs.service qorpera-agent-exit-logs.timer qorpera-agent-exit-ship.service \
	qorpera-agent-exit-ship.timer; do
	install -m 0644 "$SOURCE_ROOT/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload
"$INSTALL_ROOT/qorpera-agent-exit.sh" check
echo "Installed. Nothing is started or enabled; next: README.md, 'Switching a node on'."
