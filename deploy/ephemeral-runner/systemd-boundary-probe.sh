#!/bin/sh
set -eu

: "${QORPERA_SYSTEMD_PROBE_HOME:?}"
: "${QORPERA_SYSTEMD_PROBE_RUNTIME:?}"

printf '%s\n' home > "$QORPERA_SYSTEMD_PROBE_HOME"
printf '%s\n' runtime > "$QORPERA_SYSTEMD_PROBE_RUNTIME"
