# Shared by the kit's scripts (init.sh, base-backup.sh, restore.sh, standby.sh). Sourced, never run.
# Settings come from the environment, or from a .env file beside docker-compose.yml (docker-compose.yml lists them).
# Every script runs as root: the machine's folder holds passwords and keys.

K=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [ -f "$K/.env" ]; then
	set -a
	# shellcheck disable=SC1091
	. "$K/.env"
	set +a
fi
export COMPOSE_FILE=${COMPOSE_FILE:-$K/docker-compose.yml}
export COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:?set COMPOSE_PROJECT_NAME (the project of this machine, for example company-data)}
L=${DATA_LOCAL:?set DATA_LOCAL (the own folder of this machine)}
B=${DATA_BACKUP:?set DATA_BACKUP (the backup folder)}

# The gateway's secrets, one file each in $L/secrets/gateway (gateway-main.mjs reads them by name). PASSWORDS are
# the store's logins: cluster.sql takes each as -v <name>_password. KEYS are the gateway's own keys, 32 random bytes
# as hex. Both must be the same on the standby's machine (standby.sh pack carries them).
GATEWAY_PASSWORDS="admin owner write read watch"
GATEWAY_KEYS=""

# uid and gid of postgres in the pinned PostgreSQL image (docker-compose.yml data-db), and of nobody, the gateway's.
PG_UID=999
NOBODY=65534
SLOT=${DATA_SLOT:-company_data_standby}

die() {
	echo "$(basename "$0"): $*" >&2
	exit 1
}
[ "$(id -u)" = 0 ] || die "run as root"

dc() { docker compose "$@"; }
# psql as the store's superuser over the container's socket. Give SQL with -c, or a script on stdin with -f -.
q() { dc exec -T -u postgres data-db psql -X -q -At -v ON_ERROR_STOP=1 -d postgres "$@"; }
# One statement; </dev/null so exec -T never reads a caller's stdin.
qc() { q -c "$1" </dev/null; }
running() { [ -n "$(dc ps -q --status running "${1:-data-db}" </dev/null)" ]; }
# This project's data volume, if it exists.
volume() {
	docker volume ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
		--filter label=com.docker.compose.volume=data
}
new_secret() { head -c "${1:-24}" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
# Waits up to $1 seconds for the store to answer and leave recovery (or, with $2 = standby, to answer at all).
wait_store() {
	local i
	for i in $(seq 1 "$1"); do
		if [ "${2:-}" = standby ]; then
			[ "$(qc 'select 1' 2>/dev/null)" = 1 ] && return 0
		else
			[ "$(qc 'select pg_is_in_recovery()' 2>/dev/null)" = f ] && return 0
		fi
		sleep 1
	done
	return 1
}
