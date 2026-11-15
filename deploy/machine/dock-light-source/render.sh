#!/usr/bin/env bash
set -euo pipefail

# Renders the dock's marked icons for a light ground into ../dock-light (14 Nov 2026): a machine's dock stands on its
# wallpaper, which is light by day (deploy/machine/desktop-look), and there the mark under an open program is dark.
# The same drawings as the office dock's (deploy/lxd-company-computer-guest/design/dock-icons.js, tone "light"); an
# idle icon has no mark and is the same picture on every ground, so only the six marked states are here. Rendering
# uses a local headless Chromium/Chrome; nothing here runs on a node, and nothing here is packaged but the PNGs.
here=$(cd "$(dirname "$0")" && pwd -P)
design="${here}/../../lxd-company-computer-guest/design"
out="${here}/../dock-light"
chrome=${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}
mkdir -p "${out}"
for icon in browser:running browser:launching browser:launching-2 browser:failed files:running terminal:running; do
	"${chrome}" --headless=new --hide-scrollbars --window-size=112,112 --default-background-color=00000000 \
		--screenshot="${out}/${icon/:/-}.png" "file://${design}/icon.html?name=${icon%:*}&state=${icon#*:}&tone=light" >/dev/null 2>&1
done
ls -l "${out}"
