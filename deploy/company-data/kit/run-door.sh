#!/bin/bash
# The gateway's run door on this machine (README.md, "The run door"). Runs as root, from any folder.
#   run-door.sh status   read only: whether DATA_RUN_LISTEN is set, how many of the door's three secrets are there,
#                        whether the gateway's port 8481 is published, and the gateway's own last word on its door:
#                        "run door: on", or "run door: off (<why>)". Exit 0 when on, 1 when off.
#   run-door.sh make     makes what is missing in secrets/run-door (lib.sh make_run_door): the token only if there is
#                        none (never made again), the cert only if there is none. Then `compose.sh up -d data-gateway`.
# Prints names, counts and yes/no; never a secret.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
case ${1:-} in
make)
	[ -s "$L/ca/ca.key" ] || die "make: no CA in $L/ca (a standby has none: its door comes from standby.sh pack)"
	make_run_door
	;;
status)
	secrets=$(find "$L/secrets/run-door" -type f \( -name token -o -name door.key -o -name door.crt \) 2>/dev/null | wc -l | tr -d ' ')
	published=$(dc port data-gateway 8481 </dev/null 2>/dev/null | grep -c . || true)
	said=$(dc logs --no-log-prefix data-gateway </dev/null 2>/dev/null | grep -E '^data gateway: (run door|no run door)' | tail -1 || true)
	echo "setting DATA_RUN_LISTEN: $([ -n "${DATA_RUN_LISTEN:-}" ] && echo set || echo unset); secrets: $secrets of 3; port 8481 published: $([ "$published" -gt 0 ] && echo yes || echo no)"
	case $said in
	"data gateway: run door listening on "*)
		echo "run door: on"
		exit 0
		;;
	"data gateway: run door: off"*) echo "run door: off${said#data gateway: run door: off}" ;;
	"data gateway: no run door") echo "run door: off (the gateway was started without DATA_RUN_LISTEN)" ;;
	*) echo "run door: off (the gateway has not said: is it running?)" ;;
	esac
	exit 1
	;;
*)
	sed -n '2,8p' "$0"
	exit 2
	;;
esac
