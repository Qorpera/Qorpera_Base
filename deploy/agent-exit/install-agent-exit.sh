#!/usr/bin/env bash
# Installs the agent exit from a checkout of this folder: verifies every file against the pins below, copies the
# tool, rules, logger, plug tool, logs' tool (the tender, the shipper to the NAS and the lookup) and names reconciler
# (each company's resolver, E8b) to /usr/local/libexec/qorpera-agent-exit and the units to /etc/systemd/system, and
# runs the tool's check. With them it installs the rules reader (E8b) from its package, which
# scripts/package-agent-exit-rules.mjs builds from the same checkout: every file as the package's manifest says, its
# unit and CA as pinned here. It installs no system package, creates no group, mounts nothing, starts nothing and
# enables nothing: README.md has the switch-on steps.
set -euo pipefail

EXPECTED_TOOL_SHA256="b09af43610de3359b694b9b0a1c8fd0dfe0081c7f3b41ec62b99a940b3219f6e"
EXPECTED_EXIT_RULES_SHA256="01efcc99eea51c252030ab2d927b328692ed004191abe0854c86f4f238b900d0"
EXPECTED_HOST_RULES_SHA256="f916b1e859cf4e07707d0f5d5369356c4d57df0417b192b366c001bf36130ef4"
EXPECTED_BRIDGE_RULES_SHA256="271f3f7ba20b794c54bf5676740f55452026a39d7af8b3af20574091bd1e3ac8"
EXPECTED_LOGGER_SHA256="a3db1a9f57e0c51c0c6987e6079a27422877acc9818ca9e3d276e0b1b6067d8e"
EXPECTED_UNIT_SHA256="027b179a9229c10b2e99b8c8418d35945986734ecd85443c3300367519b57139"
EXPECTED_DNS_UNIT_SHA256="fdbee4fdd95fb66eefc4c062aa814202374377225320441f3b13191abeeb6d8a"
EXPECTED_LOG_UNIT_SHA256="53f75dfda39d62df68f2c48c1ebe17a6f2cd6bf90094e57670b00458a9ce7b63"
EXPECTED_PLUG_SHA256="96910230548561b9835a3cee67f23209233e7a6896206df202c3c7deb98dfdb1"
EXPECTED_PLUG_UNIT_SHA256="4abfe51bb6ec5723815dbd3384f16abe849ed404d6be0b1858b202f51accbf89"
EXPECTED_HEALTH_UNIT_SHA256="a048a3a71baa7afbc477df027e7109926ddcb33fea5f391ea3164aa1659a4f09"
EXPECTED_HEALTH_TIMER_SHA256="6abd734ac5e7bcc9f0370bdf1bcdf722fc3123ffdd6fc8bd4f808c9001ab27b3"
EXPECTED_LOGS_SHA256="e35c9825190e1b5be722ad0f7993e2528257cd470a15eedf7e8bdc9550b2af78"
EXPECTED_LOGS_UNIT_SHA256="038999e576ce720b55b54a75e9620ec55729815b0b1b3355eda0d186783b92db"
EXPECTED_LOGS_TIMER_SHA256="64f27bbab37ae889b6a4be8be94816ba30e635ba090a51be84c5c7c6b0f8cb78"
EXPECTED_SHIP_UNIT_SHA256="a122ffe3c84559b89c37cca3390972d9fc46507218d77d4701000876825959de"
EXPECTED_SHIP_TIMER_SHA256="cc812def189de59af2a57be07f0a1fc2b5469742395681d81d0d446814dddfd8"
EXPECTED_RULES_UNIT_SHA256="5669346ed525d77def7f3366e89e842cd753248b3c1f771029d1c0317f66d8bc"
EXPECTED_NAMES_SHA256="00a28dadb6327c52c6deeb5bbce0ab0054a93431a33a16366d549c0b5421b452"
EXPECTED_NAMES_UNIT_SHA256="4b1146e98a366712012bbba5210ffcca4606f5231a2de627062b5902d795d252"
EXPECTED_RESOLVER_UNIT_SHA256="124b74f25fa4b9f26bc7b13b15148c8e104b8236d68a82cf7e0582c15bc0309c"
EXPECTED_SNI_SHA256="36eb236a255fe14514c219cfa442818dc71efa6a203e2ec08aebc7424e9a9208"
EXPECTED_SNI_RULES_SHA256="4db5bc7c80966d5ef0f18a84aee943d4c7f2c4001fae70ddc427aef993e8d5b9"
EXPECTED_SNI_UNIT_SHA256="33051e68c4a55cb206c96104e26c5870ee02ab6698b20949151bc4512195abcd"
EXPECTED_RULES_CA_SHA256="700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7"
SOURCE_ROOT=$(cd "$(dirname "$0")" && pwd)
INSTALL_ROOT="/usr/local/libexec/qorpera-agent-exit"

[[ $# -eq 1 && -d $1 ]] || {
	echo "Usage: $0 <rules-reader-package-directory>" >&2
	exit 64
}
PACKAGE=$(cd "$1" && pwd)
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
pin qorpera-agent-exit-rules.service "$EXPECTED_RULES_UNIT_SHA256"
pin qorpera-agent-exit-names.py "$EXPECTED_NAMES_SHA256"
pin qorpera-agent-exit-names.service "$EXPECTED_NAMES_UNIT_SHA256"
pin qorpera-agent-exit-resolver@.service "$EXPECTED_RESOLVER_UNIT_SHA256"
pin qorpera-agent-exit-sni.py "$EXPECTED_SNI_SHA256"
pin qorpera-agent-exit-sni.nft "$EXPECTED_SNI_RULES_SHA256"
pin qorpera-agent-exit-sni.service "$EXPECTED_SNI_UNIT_SHA256"

# The rules reader's package: its three files and manifest, nothing else, each file as the manifest says; its unit
# this folder's and its CA Supabase's, as pinned. The program is built from the checkout, so node checks it, not a pin.
python3 -c '
import hashlib, json, os, sys
package = sys.argv[1]
files = ["qorpera-agent-exit-rules.mjs", "qorpera-agent-exit-rules.service", "supabase-prod-ca-2021.crt"]
with open(os.path.join(package, "manifest.json"), encoding="utf-8") as f:
    manifest = json.load(f)
assert sorted(manifest) == ["artifacts", "schema"] and manifest["schema"] == "qorpera.agent-exit-rules-package/v1"
assert [artifact["file"] for artifact in manifest["artifacts"]] == files
assert sorted(os.listdir(package)) == sorted(files + ["manifest.json"])
for artifact in manifest["artifacts"]:
    path = os.path.join(package, artifact["file"])
    assert not os.path.islink(path) and os.path.isfile(path)
    with open(path, "rb") as f:
        data = f.read()
    assert len(data) == artifact["bytes"] and hashlib.sha256(data).hexdigest() == artifact["sha256"]
' "$PACKAGE" || {
	echo "$PACKAGE: not a rules reader package as scripts/package-agent-exit-rules.mjs makes it; refusing to install" >&2
	exit 65
}
package_pin() {
	local actual
	actual=$(sha256sum "$PACKAGE/$1" | cut -d' ' -f1)
	[[ $actual == "$2" ]] || {
		echo "$PACKAGE/$1: sha256 $actual, expected $2; refusing to install" >&2
		exit 65
	}
}
package_pin qorpera-agent-exit-rules.service "$EXPECTED_RULES_UNIT_SHA256"
package_pin supabase-prod-ca-2021.crt "$EXPECTED_RULES_CA_SHA256"
# The unit runs /usr/bin/node; the package is built for Node 22.19 or later.
/usr/bin/node -e 'const [major, minor] = process.versions.node.split(".").map(Number);
process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)' 2>/dev/null || {
	echo "missing /usr/bin/node 22.19 or later, which runs the rules reader" >&2
	exit 69
}
/usr/bin/node --check "$PACKAGE/qorpera-agent-exit-rules.mjs" || {
	echo "$PACKAGE/qorpera-agent-exit-rules.mjs does not parse; refusing to install" >&2
	exit 65
}

install -d -m 0755 "$INSTALL_ROOT"
install -m 0755 "$SOURCE_ROOT/qorpera-agent-exit.sh" "$INSTALL_ROOT/qorpera-agent-exit.sh"
install -m 0644 "$SOURCE_ROOT/qorpera-agent-exit.nft" "$INSTALL_ROOT/qorpera-agent-exit.nft"
install -m 0644 "$SOURCE_ROOT/qorpera-agent-exit-host.nft" "$INSTALL_ROOT/qorpera-agent-exit-host.nft"
install -m 0644 "$SOURCE_ROOT/qorpera-agent-exit-bridge.nft" "$INSTALL_ROOT/qorpera-agent-exit-bridge.nft"
install -m 0755 "$SOURCE_ROOT/qorpera-agent-exit-log.py" "$INSTALL_ROOT/qorpera-agent-exit-log.py"
install -m 0755 "$SOURCE_ROOT/qorpera-agent-plug.py" "$INSTALL_ROOT/qorpera-agent-plug.py"
install -m 0755 "$SOURCE_ROOT/qorpera-agent-exit-logs.py" "$INSTALL_ROOT/qorpera-agent-exit-logs.py"
install -m 0755 "$SOURCE_ROOT/qorpera-agent-exit-names.py" "$INSTALL_ROOT/qorpera-agent-exit-names.py"
install -m 0755 "$SOURCE_ROOT/qorpera-agent-exit-sni.py" "$INSTALL_ROOT/qorpera-agent-exit-sni.py"
install -m 0644 "$SOURCE_ROOT/qorpera-agent-exit-sni.nft" "$INSTALL_ROOT/qorpera-agent-exit-sni.nft"
install -m 0644 "$PACKAGE/qorpera-agent-exit-rules.mjs" "$INSTALL_ROOT/qorpera-agent-exit-rules.mjs"
install -m 0644 "$PACKAGE/supabase-prod-ca-2021.crt" "$INSTALL_ROOT/supabase-prod-ca-2021.crt"
install -m 0644 "$PACKAGE/qorpera-agent-exit-rules.service" /etc/systemd/system/qorpera-agent-exit-rules.service
for unit in qorpera-agent-exit.service qorpera-agent-exit-dns.service qorpera-agent-exit-log.service \
	qorpera-agent-plug.service qorpera-agent-exit-health.service qorpera-agent-exit-health.timer \
	qorpera-agent-exit-logs.service qorpera-agent-exit-logs.timer qorpera-agent-exit-ship.service \
	qorpera-agent-exit-ship.timer qorpera-agent-exit-names.service qorpera-agent-exit-resolver@.service \
	qorpera-agent-exit-sni.service; do
	install -m 0644 "$SOURCE_ROOT/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload
"$INSTALL_ROOT/qorpera-agent-exit.sh" check
echo "Installed. Nothing is started or enabled; next: README.md, 'Switching a node on'."
