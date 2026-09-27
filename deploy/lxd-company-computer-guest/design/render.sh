#!/usr/bin/env bash
set -euo pipefail

# Renders the dock icons (112x112 PNG, transparent) from dock-icons.js into
# ./icons and the look checks ./mock.png, ./mock-browser.png and ./mock-states.png from mock.html, with a local headless
# Chrome. Nothing here ships to a guest: qorpera-screen-session carries the
# icons as base64 (guest code reaches existing computers; new files do not).
# Every run also rewrites the block between the DOCK-ICONS markers of
# ../qorpera-screen-session (a PNG is not rendered byte-for-byte the same twice;
# a test compares ./icons with what the wrapper writes).
here=$(cd "$(dirname "$0")" && pwd -P)
chrome=${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}
icons=(browser:idle browser:launching browser:launching-2 browser:running browser:failed files:idle files:running terminal:idle terminal:running)
embed() {
	local icon session="${here}/../qorpera-screen-session" block
	block=$(mktemp)
	for icon in "${icons[@]}"; do
		printf 'cosmetic write_dock_icon %s <<'"'"'ICON'"'"'\n' "${icon/:/-}"
		base64 -i "${here}/icons/${icon/:/-}.png" | fold -w 120
		printf 'ICON\n'
	done > "${block}"
	# Replace everything between the DOCK-ICONS markers of the wrapper.
	awk -v block="${block}" '
		/^# DOCK-ICONS-END/ { while ((getline line < block) > 0) print line; skipping = 0 }
		!skipping { print }
		/^# DOCK-ICONS-BEGIN/ { skipping = 1 }
	' "${session}" > "${session}.tmp"
	cat "${session}.tmp" > "${session}"
	rm -f "${session}.tmp" "${block}"
}
mkdir -p "${here}/icons"
for icon in "${icons[@]}"; do
	"${chrome}" --headless=new --hide-scrollbars --window-size=112,112 --default-background-color=00000000 \
		--screenshot="${here}/icons/${icon/:/-}.png" "file://${here}/icon.html?name=${icon%:*}&state=${icon#*:}" >/dev/null 2>&1
done
"${chrome}" --headless=new --hide-scrollbars --window-size=1920,1200 \
	--screenshot="${here}/mock.png" "file://${here}/mock.html" >/dev/null 2>&1
"${chrome}" --headless=new --hide-scrollbars --window-size=1920,1200 \
	--screenshot="${here}/mock-browser.png" "file://${here}/mock.html?browser=1" >/dev/null 2>&1
"${chrome}" --headless=new --hide-scrollbars --window-size=1920,1200 \
	--screenshot="${here}/mock-states.png" "file://${here}/mock.html?states=1" >/dev/null 2>&1
embed
ls -l "${here}/icons" "${here}"/mock*.png
