#!/usr/bin/env bash
# Installs the agent exit from a checkout of this folder: verifies every file against the pins below, copies the
# tool, rules, logger, plug tool, logs' tool (the tender, the shipper to the NAS and the lookup) and names reconciler
# (each company's resolver, E8b) to /usr/local/libexec/qorpera-agent-exit and the units to /etc/systemd/system, and
# runs the tool's check. With them it installs the rules reader (E8b) from its package, which
# scripts/package-agent-exit-rules.mjs builds from the same checkout: every file as the package's manifest says, its
# unit and CA as pinned here. It installs no system package, creates no group, mounts nothing, starts nothing and
# enables nothing: README.md has the switch-on steps.
#
# The rules reader trusts Supabase's CA, as pinned here. For a self-hosted database a deploy gives our own CA instead,
# with --database-ca <file> and --database-ca-sha256 <the file's sha256>, always both: the file must match its pin,
# and the reader then trusts that CA alone, still with verify-full (a drop-in adds the CA and its pin as two more
# credentials; packages/runtime/src/database-ca.ts checks them again). Without them the reader keeps Supabase's CA, and
# an own CA a previous install placed is removed.
set -euo pipefail

EXPECTED_TOOL_SHA256="8a20cdd74fb07b7d06c49316c2850d8f9488fd602112eec2ab9c34bb47bf514f"
EXPECTED_EXIT_RULES_SHA256="06db392f3791a44a14a9a24105e141ff0b94c99f58dc2156310871572b68d111"
EXPECTED_HOST_RULES_SHA256="f916b1e859cf4e07707d0f5d5369356c4d57df0417b192b366c001bf36130ef4"
EXPECTED_BRIDGE_RULES_SHA256="271f3f7ba20b794c54bf5676740f55452026a39d7af8b3af20574091bd1e3ac8"
EXPECTED_LOGGER_SHA256="2297aca502a965f2fc3f3bc5fb277cd8c836adb72faf0996ce0bf1662b49e841"
EXPECTED_UNIT_SHA256="027b179a9229c10b2e99b8c8418d35945986734ecd85443c3300367519b57139"
EXPECTED_DNS_UNIT_SHA256="17957ff9b3fa3ea761aec4f1750ddea9556de5ebb3fd7ef53713680619d0aadb"
EXPECTED_LOG_UNIT_SHA256="59deee252d70c740b46c59a965c0dc0f2c3a86b5ea60a079e9aafafed0d05fe1"
EXPECTED_PLUG_SHA256="d8e41150cc805d7f9107fbf373e7c08af9057cee5dd0814a1925d354383044d1"
EXPECTED_PLUG_UNIT_SHA256="1036a1d8090fd7a32004d0454f117637ce360d86c178bcabbc83285b234324dc"
EXPECTED_HEALTH_UNIT_SHA256="55b4ea20fcab358f572e4c34d122efb5c1a202b3cff08079e56c7d48e04ca5fc"
EXPECTED_HEALTH_TIMER_SHA256="6abd734ac5e7bcc9f0370bdf1bcdf722fc3123ffdd6fc8bd4f808c9001ab27b3"
EXPECTED_LOGS_SHA256="0ab71eae876001bd8b5ec11a5df40240fb375ccff0e3ca6628d3681fc91a7891"
EXPECTED_LOGS_UNIT_SHA256="038999e576ce720b55b54a75e9620ec55729815b0b1b3355eda0d186783b92db"
EXPECTED_LOGS_TIMER_SHA256="64f27bbab37ae889b6a4be8be94816ba30e635ba090a51be84c5c7c6b0f8cb78"
EXPECTED_SHIP_UNIT_SHA256="a122ffe3c84559b89c37cca3390972d9fc46507218d77d4701000876825959de"
EXPECTED_SHIP_TIMER_SHA256="cc812def189de59af2a57be07f0a1fc2b5469742395681d81d0d446814dddfd8"
EXPECTED_RULES_UNIT_SHA256="5669346ed525d77def7f3366e89e842cd753248b3c1f771029d1c0317f66d8bc"
EXPECTED_NAMES_SHA256="4a8f3b1d0bccf72371f7a7be57f4c527e67346af09f6635d46dbe92aa00cc6d3"
EXPECTED_NAMES_UNIT_SHA256="b3f81e5096745ade6d4f46881a538aedae5d3f58d86a4f1d0c16dc2d7feb2be4"
EXPECTED_RESOLVER_UNIT_SHA256="6776d06b1b0533d1ac127010c5c6855edf000ad839ea98be665af22da94a7884"
EXPECTED_SNI_SHA256="2a4bbbd1358b2a636090019641dea8489fbf4300addff204a13263b4e1ee0841"
EXPECTED_SNI_RULES_SHA256="d0872aec7635ead37c01354a03f23aa2778fbd02aa4d67526c43b655d49a0c6e"
EXPECTED_SNI_UNIT_SHA256="72d18b520f2ef8c43dcce15ace4bf606db0e8659eed642a51ab9cc73c6e6679a"
EXPECTED_RULES_CA_SHA256="700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7"
SOURCE_ROOT=$(cd "$(dirname "$0")" && pwd)
INSTALL_ROOT="/usr/local/libexec/qorpera-agent-exit"
OWN_CA_DROP_IN="/etc/systemd/system/qorpera-agent-exit-rules.service.d/database-own-ca.conf"

usage() {
	echo "Usage: $0 <rules-reader-package-directory> [--database-ca <file> --database-ca-sha256 <sha256>]" >&2
	exit 64
}
[[ $# -ge 1 && -d $1 ]] || usage
PACKAGE=$(cd "$1" && pwd)
shift
OWN_CA=
OWN_CA_SHA256=
while [[ $# -gt 0 ]]; do
	case $1 in
	--database-ca)
		[[ $# -ge 2 && -n $2 && -z $OWN_CA ]] || usage
		OWN_CA=$2
		shift 2
		;;
	--database-ca-sha256)
		[[ $# -ge 2 && -n $2 && -z $OWN_CA_SHA256 ]] || usage
		OWN_CA_SHA256=$2
		shift 2
		;;
	*) usage ;;
	esac
done
# Our own CA: both inputs or neither, the pin a sha256, the file one PEM certificate that matches it. The check runs on
# a private copy, which is what gets installed.
OWN_CA_COPY=
if [[ -n $OWN_CA || -n $OWN_CA_SHA256 ]]; then
	[[ -n $OWN_CA && -n $OWN_CA_SHA256 ]] || {
		echo "--database-ca and --database-ca-sha256 go together; refusing to install" >&2
		exit 64
	}
	[[ $OWN_CA_SHA256 =~ ^[0-9a-f]{64}$ ]] || {
		echo "--database-ca-sha256: not a sha256 (64 lowercase hex digits); refusing to install" >&2
		exit 64
	}
	[[ -f $OWN_CA && ! -L $OWN_CA ]] || {
		echo "$OWN_CA: not a regular file; refusing to install" >&2
		exit 66
	}
	OWN_CA_COPY=$(mktemp)
	trap 'rm -f "$OWN_CA_COPY"' EXIT
	cat -- "$OWN_CA" >"$OWN_CA_COPY"
	actual=$(sha256sum "$OWN_CA_COPY" | cut -d' ' -f1)
	[[ $actual == "$OWN_CA_SHA256" ]] || {
		echo "$OWN_CA: sha256 $actual, expected $OWN_CA_SHA256; refusing to install" >&2
		exit 65
	}
	python3 -c '
import re, sys
with open(sys.argv[1], "rb") as f:
    data = f.read()
pem = rb"-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\r?\n?"
sys.exit(0 if len(data) <= 65536 and re.fullmatch(pem, data) else 1)
' "$OWN_CA_COPY" || {
		echo "$OWN_CA: not one PEM certificate; refusing to install" >&2
		exit 65
	}
fi
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
base_files = ["qorpera-agent-exit-rules.mjs", "qorpera-agent-exit-rules.service", "supabase-prod-ca-2021.crt"]
own_ca_files = ["database-own-ca.crt", "database-own-ca.sha256", "database-own-ca.conf"]
with open(os.path.join(package, "manifest.json"), encoding="utf-8") as f:
    manifest = json.load(f)
assert sorted(manifest) == ["artifacts", "schema"] and manifest["schema"] == "qorpera.agent-exit-rules-package/v1"
names = [artifact["file"] for artifact in manifest["artifacts"]]
assert names in (base_files, base_files + own_ca_files)
assert sorted(os.listdir(package)) == sorted(names + ["manifest.json"])
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
if [[ -f "$PACKAGE/database-own-ca.crt" ]]; then
	PKG_OWN_CA_SHA256=$(python3 -c '
import hashlib, re, sys
pkg = sys.argv[1]
with open(pkg + "/database-own-ca.crt", "rb") as f:
    crt = f.read()
with open(pkg + "/database-own-ca.sha256", encoding="utf-8") as f:
    sha_txt = f.read().strip()
with open(pkg + "/database-own-ca.conf", encoding="utf-8") as f:
    conf_txt = f.read()
expected_conf = (
    "[Service]\n"
    "LoadCredential=qorpera-agent-exit-rules-database-own-ca:/usr/local/libexec/qorpera-agent-exit/database-own-ca.crt\n"
    "LoadCredential=qorpera-agent-exit-rules-database-own-ca-sha256:/usr/local/libexec/qorpera-agent-exit/database-own-ca.sha256\n"
)
pem = rb"-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\r?\n?"
actual = hashlib.sha256(crt).hexdigest()
assert len(crt) <= 65536 and re.fullmatch(pem, crt)
assert re.fullmatch(r"[0-9a-f]{64}", sha_txt) and sha_txt == actual
assert conf_txt == expected_conf
print(actual)
' "$PACKAGE") || {
		echo "$PACKAGE: packaged database-own-ca artifacts are invalid; refusing to install" >&2
		exit 65
	}
	if [[ -n $OWN_CA_COPY ]]; then
		[[ $OWN_CA_SHA256 == "$PKG_OWN_CA_SHA256" ]] || {
			echo "--database-ca-sha256 ($OWN_CA_SHA256) does not match packaged CA ($PKG_OWN_CA_SHA256); refusing to install" >&2
			exit 65
		}
	else
		OWN_CA="$PACKAGE/database-own-ca.crt"
		OWN_CA_SHA256="$PKG_OWN_CA_SHA256"
		OWN_CA_COPY=$(mktemp)
		trap 'rm -f "$OWN_CA_COPY"' EXIT
		cat -- "$OWN_CA" >"$OWN_CA_COPY"
	fi
fi
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
if [[ -n $OWN_CA_COPY ]]; then
	/usr/bin/node -e 'const { X509Certificate } = require("node:crypto");
process.exit(new X509Certificate(require("node:fs").readFileSync(process.argv[1])).ca === true ? 0 : 1)' \
		"$OWN_CA_COPY" 2>/dev/null || {
		echo "$OWN_CA: not a CA certificate; refusing to install" >&2
		exit 65
	}
fi

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
if [[ -n $OWN_CA_COPY ]]; then
	install -m 0644 "$OWN_CA_COPY" "$INSTALL_ROOT/database-own-ca.crt"
	printf '%s\n' "$OWN_CA_SHA256" >"$OWN_CA_COPY"
	install -m 0644 "$OWN_CA_COPY" "$INSTALL_ROOT/database-own-ca.sha256"
	install -d -m 0755 "$(dirname "$OWN_CA_DROP_IN")"
	printf '%s\n' "[Service]" \
		"LoadCredential=qorpera-agent-exit-rules-database-own-ca:$INSTALL_ROOT/database-own-ca.crt" \
		"LoadCredential=qorpera-agent-exit-rules-database-own-ca-sha256:$INSTALL_ROOT/database-own-ca.sha256" \
		>"$OWN_CA_COPY"
	install -m 0644 "$OWN_CA_COPY" "$OWN_CA_DROP_IN"
else
	rm -f "$OWN_CA_DROP_IN" "$INSTALL_ROOT/database-own-ca.crt" "$INSTALL_ROOT/database-own-ca.sha256"
fi
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
