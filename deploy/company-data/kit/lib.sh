# Shared by the kit's scripts (init.sh, base-backup.sh, restore.sh, standby.sh). Sourced, never run.
# Settings come from the environment, then from a .env file beside docker-compose.yml for what the environment
# does not set (the environment wins, as it does for docker compose itself). docker-compose.yml lists them.
# Every script runs as root: the machine's folder holds passwords and keys. They work from any current folder.

K=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [ -f "$K/.env" ]; then
	while IFS= read -r line || [ -n "$line" ]; do
		[[ $line =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
		name=${BASH_REMATCH[1]}
		value=${BASH_REMATCH[2]}
		[[ $value =~ ^\"(.*)\"$ || $value =~ ^\'(.*)\'$ ]] && value=${BASH_REMATCH[1]}
		[ -n "${!name+set}" ] || export "$name=$value"
	done <"$K/.env"
	unset line name value
fi
# Every compose file is taken from the kit's folder when it is named relative, whichever folder a script is run from
# (a systemd unit runs it from /). Compose's own project folder is the kit's too (dc below).
files=
IFS=: read -ra parts <<<"${COMPOSE_FILE:-docker-compose.yml}"
for part in "${parts[@]}"; do
	[ -n "$part" ] || continue
	[[ $part == /* ]] || part=$K/$part
	files=${files:+$files:}$part
done
export COMPOSE_FILE=$files
unset files parts part
export COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:?set COMPOSE_PROJECT_NAME (the project of this machine, for example company-data)}
: "${DATA_LOCAL:?set DATA_LOCAL (the own folder of this machine)}" "${DATA_BACKUP:?set DATA_BACKUP (the backup folder)}"
# A folder named relative is the kit's, as compose takes it, so the scripts and compose mean the same folder.
for name in DATA_LOCAL DATA_BACKUP DATA_GATEWAY_PACKAGE; do
	[ -z "${!name:-}" ] || [[ ${!name} == /* ]] || export "$name=$K/${!name}"
done
L=$DATA_LOCAL
B=$DATA_BACKUP

# The gateway's secrets, one file each in $L/secrets/gateway (gateway-main.mjs reads them by name, folder-key as
# folderKey). PASSWORDS are the store's three logins: cluster.sql takes each as -v <name>_password. KEYS are 32 random
# bytes as hex: folder-key derives every database folder's own login password. All must be the same on the standby's
# machine, or a promoted standby's gateway cannot log in (standby.sh pack carries them).
GATEWAY_PASSWORDS="admin keeper watch"
GATEWAY_KEYS="folder-key"

# uid and gid of postgres in the pinned PostgreSQL image (docker-compose.yml data-db), and of nobody, the gateway's.
PG_UID=999
NOBODY=65534
SLOT=${DATA_SLOT:-company_data_standby}

die() {
	echo "$(basename "$0"): $*" >&2
	exit 1
}
[ "$(id -u)" = 0 ] || die "run as root"

dc() { docker compose --project-directory "$K" "$@"; }
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
