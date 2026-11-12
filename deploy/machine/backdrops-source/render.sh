#!/usr/bin/env bash
set -euo pipefail

# Renders the machine desktop's neutral backdrop into ../backdrops: the Qorpera wordmark (the outlines of
# packages/web/public/assets/brand/qorpera-wordmark.svg), tone-on-tone over a ground whose lightness follows the local
# day, drawn exactly as the agents' figures are (deploy/lxd-company-computer-guest/backdrops-source: night 6 %, day
# 95 %, dawn ramp 05-08, dusk ramp 18-21, hue 225). A desktop whose machine names no agent's figure shows it
# (deploy/machine/desktop-look). Output: neutral-<HH>.png for every hour. Rendering uses a local headless
# Chromium/Chrome; nothing here runs on a node, and nothing here is packaged but the PNGs.
here=$(cd "$(dirname "$0")" && pwd -P)
out="${here}/../backdrops"
chrome=${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}
mkdir -p "${out}"
for ((h = 0; h < 24; h++)); do
	printf -v hour '%02d' "${h}"
	"${chrome}" --headless=new --hide-scrollbars --window-size=1920,1200 --default-background-color=00000000 \
		--screenshot="${out}/neutral-${hour}.png" "file://${here}/neutral.html?h=${h}" >/dev/null 2>&1
done
ls "${out}" | wc -l
