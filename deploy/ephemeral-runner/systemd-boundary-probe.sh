#!/bin/sh
set -eu

: "${QORPERA_SYSTEMD_PROBE_PODMAN:?}"
: "${QORPERA_SYSTEMD_PROBE_IMAGE:?}"
: "${QORPERA_SYSTEMD_PROBE_HOME:?}"
: "${QORPERA_SYSTEMD_PROBE_RUNTIME:?}"

"$QORPERA_SYSTEMD_PROBE_PODMAN" run \
	--rm \
	--pull=never \
	--network=none \
	--entrypoint=/usr/local/bin/node \
	"$QORPERA_SYSTEMD_PROBE_IMAGE" \
	--eval ''
printf '%s\n' home > "$QORPERA_SYSTEMD_PROBE_HOME"
printf '%s\n' runtime > "$QORPERA_SYSTEMD_PROBE_RUNTIME"
