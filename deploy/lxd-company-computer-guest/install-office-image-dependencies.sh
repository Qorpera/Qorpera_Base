#!/usr/bin/env bash
# Installs the office image's dependencies (office-image-dependencies.json) into the guest being built, offline.
# Runs as root inside the build VM, before the office package installer (INSTALLATION.md). The builder pushes one
# root-owned directory: the recipe, debs/ (apt's closure for the recipe's packages on this guest), downloads/ (each
# pinned download by its URL's file name) and npm-cache/ (an npm cache holding the recipe's npm tools).
#
#   bash install-office-image-dependencies.sh /root/office-dependencies
set -euo pipefail

fail() { echo "FAIL: $*" >&2; exit 1; }
[[ $# -eq 1 ]] || fail "usage: install-office-image-dependencies.sh <pushed directory>"
dir=$1
recipe="$dir/office-image-dependencies.json"
[[ $(id -u) == 0 ]] || fail "run as root"
[[ $(uname -m) == x86_64 ]] || fail "the recipe pins x86_64 downloads"
[[ -d /run/systemd/system ]] || fail "systemd is not running"
[[ -f "$recipe" && ! -L "$dir" && $(stat -c %u "$dir") == 0 ]] || fail "no root-owned recipe in $dir"
export DEBIAN_FRONTEND=noninteractive LC_ALL=C
# One line per answer. The base has Python for cloud-init, and nothing else that reads JSON yet.
query() {
	python3 - "$recipe" "$1" <<'EOF'
import json, sys
recipe, name = json.load(open(sys.argv[1])), sys.argv[2]
downloads = {d["name"]: d for d in recipe["downloads"]}
file = lambda d: d["url"].rsplit("/", 1)[1]
if name == "sha256sums": lines = [d["sha256"] + "  " + file(d) for d in recipe["downloads"]]
elif name == "packages": lines = [p for group in recipe["packages"].values() for p in group]
elif name == "npm": lines = [p["name"] + "@" + p["version"] for p in recipe["npm"]]
elif name == "toolbox": lines = [" ".join(check) for check in recipe["toolbox"]]
elif name.endswith(".file"): lines = [file(downloads[name.removesuffix(".file")])]
elif name.endswith(".version"): lines = [downloads[name.removesuffix(".version")]["version"]]
else: sys.exit("unknown query " + name)
print("\n".join(lines))
EOF
}
download() { echo "$dir/downloads/$(query "$1.file")"; }

# Every download is the pinned file.
query sha256sums >"$dir/downloads.sha256"
(cd "$dir/downloads" && sha256sum --check --strict --quiet ../downloads.sha256) || fail "a download is not its pinned file"

# The image never updates itself; the office installer masks the same units again.
systemctl mask apt-daily.timer apt-daily-upgrade.timer apt-daily.service apt-daily-upgrade.service unattended-upgrades.service
mapfile -t packages < <(query packages)
# apt orders the pushed closure itself (pre-dependencies included) and has nothing to download.
if compgen -G "$dir/debs/*.deb" >/dev/null; then
	apt-get install --yes --no-install-recommends --no-download -o DPkg::Options::=--force-confold "$dir"/debs/*.deb
fi
for name in "${packages[@]}"; do
	[[ $(dpkg-query -W -f '${db:Status-Status}' "$name" 2>/dev/null) == installed ]] || fail "$name is not installed"
done
# Node.js comes from its own pinned build below, never from apt.
if dpkg-query -W -f '${db:Status-Status}' nodejs 2>/dev/null | grep -qx installed; then fail "apt installed nodejs"; fi

# Node.js under /usr: the office service and every shell run the same /usr/bin/node, a single-link regular file.
node=$(query node.version)
tar --extract --xz --file "$(download node)" --directory /usr --strip-components 1 --no-same-owner --no-overwrite-dir \
	--exclude "node-v$node-linux-x64/CHANGELOG.md" --exclude "node-v$node-linux-x64/LICENSE" \
	--exclude "node-v$node-linux-x64/README.md"
[[ -f /usr/bin/node && ! -L /usr/bin/node && $(stat -c %h /usr/bin/node) == 1 ]] || fail "/usr/bin/node is not one regular file"
[[ $(/usr/bin/node --version) == "v$node" ]] || fail "node is $(/usr/bin/node --version)"
mapfile -t tools < <(query npm)
# The builder filled the cache from the registry; tsc and tsx need no install scripts.
HOME=/root npm_config_update_notifier=false /usr/bin/npm install --global --prefix /usr --offline --cache "$dir/npm-cache" \
	--ignore-scripts --no-fund --no-audit "${tools[@]}"
rm -rf /root/.npm

# The browser: Chrome for Testing, the build the packaged Playwright drives.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
[[ ! -e /usr/lib/qorpera-chromium ]] || fail "/usr/lib/qorpera-chromium already exists"
unzip -q "$(download chromium)" -d "$work"
mv "$work/chrome-linux64" /usr/lib/qorpera-chromium
chown -R root:root /usr/lib/qorpera-chromium
chmod -R go-w /usr/lib/qorpera-chromium
find /usr/lib/qorpera-chromium -type f -perm /6000 -exec chmod ug-s {} +
browser=$(/usr/lib/qorpera-chromium/chrome --version)
[[ $browser == *" $(query chromium.version)"* ]] || fail "the browser is $browser"

# uv and mise: single programs under /usr, which is all a computer's shell sees.
tar --extract --gzip --file "$(download uv)" --directory "$work" --no-same-owner
install -o root -g root -m 0755 "$work/uv-x86_64-unknown-linux-gnu/uv" "$work/uv-x86_64-unknown-linux-gnu/uvx" /usr/local/bin/
install -o root -g root -m 0755 "$(download mise)" /usr/local/bin/mise
# Debian names fd fdfind; the toolbox calls it fd.
ln -sfn /usr/bin/fdfind /usr/local/bin/fd

# Swap stays off: no swap unit can start and fstab names none (deploy/first-node/RUNTIME-COMPANY-FOLDER.md).
swapoff --all
systemctl mask swap.target
sed -i -E '/^[^#[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+swap[[:space:]]/d' /etc/fstab
rm -f /swap.img /swapfile
[[ $(wc -l </proc/swaps) == 1 ]] || fail "swap is still on: $(cat /proc/swaps)"

apt-get clean
# What root sees; the image contract test runs the same list from a computer's shell. A throwaway home keeps
# the tools' first-run files (LibreOffice's profile, mise's state) out of the image.
mapfile -t checks < <(query toolbox)
mkdir -m 0700 "$work/home"
for check in "${checks[@]}"; do
	# shellcheck disable=SC2086 # each check is a command and its one flag
	out=$(PATH=/usr/local/bin:/usr/bin:/bin HOME="$work/home" $check 2>&1) || fail "$check failed: $out"
	echo "$check: ${out%%$'\n'*}"
done
