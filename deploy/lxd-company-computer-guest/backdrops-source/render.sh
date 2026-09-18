#!/usr/bin/env bash
set -euo pipefail

# Renders the office backdrops in ../backdrops from the per-character SVG
# templates here. Each template draws the traced avatar figure tone-on-tone over
# a ground whose lightness follows the local day (night 6 %, day 95 %, dawn ramp
# 05–08, dusk ramp 18–21; accent about five points off the ground, hue 225,
# low saturation). Output: qorpera-screen-<character>-<HH>.png for every hour
# plus qorpera-screen-<character>.png (the noon frame) as the static fallback.
# Rendering uses a local headless Chromium/Chrome; nothing here runs on the node.
here=$(cd "$(dirname "$0")" && pwd -P)
out="${here}/../backdrops"
chrome=${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}
mkdir -p "${out}"
for character in bloom brain folio halo pebble ribbon wisp; do
	for ((h = 0; h < 24; h++)); do
		printf -v hour '%02d' "${h}"
		"${chrome}" --headless=new --hide-scrollbars --window-size=1920,1200 --default-background-color=00000000 \
			--screenshot="${out}/qorpera-screen-${character}-${hour}.png" "file://${here}/${character}.html?h=${h}" >/dev/null 2>&1
	done
	cp -f "${out}/qorpera-screen-${character}-12.png" "${out}/qorpera-screen-${character}.png"
done
ls "${out}" | wc -l
