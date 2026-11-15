#!/bin/bash
# C2i proof: the members' Claude sign-in on Claude Code 2.1.325 (the image's one pin) and on 2.1.231 (the old harness
# pin, for comparison), with NO real sign-in: signin.ts drives the official `claude auth login --claudeai` with the
# helper's own code (without the isolation here: the test VM's node is not the /usr/bin/node it needs; image.sh signin
# runs it in the isolation on the image), as `nobody` in the login helper unit's hardening
# (deploy/cloud-secret-broker/qorpera-model-login-helper.service, read by unit-props.py); a made-up code goes in and
# Anthropic refuses it. As root on the test VM through run-on-node --sudo (with install: esbuild and the packager).
# Usage: signin.sh [VERSION...]   (default: 2.1.231 2.1.325)
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
L=/home/tester/lanes/agent-box-C2i
P=/opt/qorpera-c2i-proof
B=/var/lib/c2i-proof
VERSIONS=("$@")
((${#VERSIONS[@]})) || VERSIONS=(2.1.231 2.1.325)
say() { echo "$(date -u +%H:%M:%S) $*"; }

install -d -m 0755 $L $L/cc $P
pin_sha=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["artifact"]["sha256"])' "$REPO/deploy/first-node/native-claude/linux-x64-artifact.json")
for v in "${VERSIONS[@]}"; do
	if [[ ! -x $L/cc/$v/package/claude ]]; then
		rm -rf "$L/cc/$v"; install -d -m 0755 "$L/cc/$v"
		(cd "$L/cc/$v" && npm pack --silent "@anthropic-ai/claude-code-linux-x64@$v" >/dev/null && tar xzf ./*.tgz)
	fi
	install -d -m 0755 "$P/claude-$v"
	install -m 0555 "$L/cc/$v/package/claude" "$P/claude-$v/claude"
	say "Claude Code $v: sha256 $(sha256sum "$P/claude-$v/claude" | cut -c1-16) $(stat -c %s "$P/claude-$v/claude") B$([[ $(sha256sum "$P/claude-$v/claude" | cut -d' ' -f1) == "$pin_sha" ]] && echo ', the pin of deploy/first-node/native-claude/linux-x64-artifact.json')"
done
npx esbuild "$HERE/signin.ts" --bundle --platform=node --format=esm --target=node22 --log-level=warning \
	--alias:@qorpera/contracts=./packages/contracts/src/index.ts \
	"--banner:js=import { createRequire as __c2i_require } from \"node:module\"; const require = __c2i_require(import.meta.url);" \
	--outfile=$P/signin.bundle.mjs || { echo "BUNDLE FAILED"; exit 1; }
chmod 0444 $P/signin.bundle.mjs

mapfile -t props < <(python3 "$HERE/unit-props.py" "$REPO/deploy/cloud-secret-broker/qorpera-model-login-helper.service")
args=()
for prop in "${props[@]}"; do args+=(-p "$prop"); done
echo "=== the login helper unit's hardening, as the runs below have it: ${props[*]}"
for v in "${VERSIONS[@]}"; do
	rm -rf $B
	install -d -o 65534 -g 65534 -m 0700 $B $B/root
	for what in raw helper; do
		say "SIGNIN $v $what"
		if [[ $what == raw ]]; then cmd=(raw "$P/claude-$v/claude" $B/root); else cmd=(helper "$P/claude-$v/claude" none $B/root); fi
		systemd-run --quiet --pipe --wait --collect --uid=65534 --gid=65534 --working-directory=$B "${args[@]}" \
			-p ReadWritePaths=$B "$(command -v node)" $P/signin.bundle.mjs "${cmd[@]}" </dev/null 2>&1
		say "SIGNIN $v $what end rc=$?"
	done
	echo "left in the sign-in root: $(find $B/root -mindepth 1 | wc -l) entries"
done
rm -rf $B
