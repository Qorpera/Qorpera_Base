#!/usr/bin/env bash
set -euo pipefail

# Renders the office backdrops in ../backdrops from the per-figure SVG
# templates here. Each template draws the traced avatar figure tone-on-tone over
# a ground whose lightness follows the local day (night 6 %, day 95 %, dawn ramp
# 05–08, dusk ramp 18–21; accent about five points off the ground, hue 225,
# low saturation), and since 14 Nov 2026 the figure's two eyes in white, where
# the product draws them (eyes.mjs writes them into the templates from
# motion-model.js; run it first when the product's eyes move). Output:
# qorpera-screen-<character>-<HH>.png for every hour
# plus qorpera-screen-<character>.png (the noon frame) as the static fallback.
# Rendering uses a local headless Chromium/Chrome; nothing here runs on the node.
# The first seven file names are the ones every installed image carries and are
# historical. The figure each one draws: bloom = heart, brain = planet,
# folio = acorn, halo = crown, pebble = rocket, ribbon = flame, wisp = ghost.
# The six added in November 2026 are named for their figure: star, cloud, bolt,
# mushroom, moon, puzzle. (The table lives in
# packages/runtime/src/cloud-company-computer-wallpapers.ts and is tested.)
#
#   render.sh              every backdrop
#   render.sh star moon    only these (a new figure leaves the others' bytes alone)
here=$(cd "$(dirname "$0")" && pwd -P)
out="${here}/../backdrops"
chrome=${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}
mkdir -p "${out}"
if [ "$#" -gt 0 ]; then characters=("$@"); else characters=(bloom brain folio halo pebble ribbon star cloud bolt mushroom moon puzzle); fi
for character in "${characters[@]}"; do
	[ -f "${here}/${character}.html" ] || { echo "no template for ${character}" >&2; exit 1; }
	for ((h = 0; h < 24; h++)); do
		printf -v hour '%02d' "${h}"
		"${chrome}" --headless=new --hide-scrollbars --window-size=1920,1200 --default-background-color=00000000 \
			--screenshot="${out}/qorpera-screen-${character}-${hour}.png" "file://${here}/${character}.html?h=${h}" >/dev/null 2>&1
	done
done
ls "${out}" | wc -l
