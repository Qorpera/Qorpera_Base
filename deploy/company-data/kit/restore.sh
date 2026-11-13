#!/bin/bash
# A point-in-time restore of the store into a fresh volume: a base backup from $DATA_BACKUP/base, then the archived WAL
# replayed up to a time, then the copy is promoted and answers. Runs as root, with a project and a machine folder of
# its own (COMPOSE_PROJECT_NAME and DATA_LOCAL new and unused), DATA_BACKUP the archive to read.
#   restore.sh STAMP|latest TIME   TIME as PostgreSQL reads it, with its zone: 2026-11-13 02:17:00+00
# The archive is mounted read-only and archive_mode is off in the copy, so it never writes there. The copy gets a new
# CA and cert of its own (name data-restore). To make the copy a primary later: copy the real machine's postgres/tls
# and secrets into its folder, delete postgres/restore.conf, restart it, and start a new WAL folder (init.sh's rule).
# Settings in the environment win over the kit's .env, so on a machine:
#   COMPOSE_PROJECT_NAME=company-data-restore DATA_LOCAL=/opt/company-data/restore ./restore.sh latest '...'
# Prints names, counts and times only.
set -euo pipefail
# The store alone, whatever this machine's .env says: never replication.yml's published port, never the gateway, never
# its run door (an empty DATA_RUN_LISTEN wins over the .env, so lib.sh adds no run-door.yml).
export COMPOSE_FILE=docker-compose.yml DATA_RUN_LISTEN=
. "$(dirname "$0")/lib.sh"
export DATA_BACKUP_MODE=ro
want=${1:-}
target=${2:-}
[ -n "$want" ] && [ -n "$target" ] || die "restore STAMP|latest TIME"
[[ $target =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}[\ T][0-9:.]+([+-][0-9:]+|Z|\ UTC)$ ]] || die "TIME is a date and time with its zone"
if [ "$want" = latest ]; then
	stamp=$(find "$B/base" -mindepth 1 -maxdepth 1 -type d -name '2*Z' | sort | tail -1)
	stamp=$(basename "${stamp:-none}")
else
	stamp=$want
fi
[[ $stamp =~ ^[0-9]{8}T[0-9]{6}Z$ ]] && [ -s "$B/base/$stamp/base.tar.gz" ] || die "no base backup $want in $B/base"
[ ! -e "$L/INITIALISED" ] && [ ! -e "$L/STANDBY" ] || die "$L is a store's folder already: a restore takes a new one"
[ -z "$(volume)" ] || die "the volume of $COMPOSE_PROJECT_NAME exists already: a restore takes a new project"
t0=$(date +%s)

install -d -m 0700 "$L" "$L/ca" "$L/secrets"
install -d -m 0750 -o 0 -g "$PG_UID" "$L/postgres"
install -d -m 0500 -o "$NOBODY" -g "$NOBODY" "$L/secrets/gateway"
(umask 077 && new_secret 24 >"$L/secrets/superuser")
chown "$PG_UID:$PG_UID" "$L/secrets/superuser"
"$K/tls.sh" ca "$L/ca" >/dev/null
"$K/tls.sh" server "$L/ca" "$L/postgres/tls" data-restore >/dev/null
cat >"$L/postgres/restore.conf" <<EOF
# restore.sh: replay archived WAL up to the target, then promote. This copy never archives.
restore_command = '/etc/company-data/restore-wal.sh %f %p'
recovery_target_time = '$target'
recovery_target_action = 'promote'
archive_mode = off
EOF
chmod 0644 "$L/postgres/restore.conf"

# The base backup into the new volume, as root in a one-off container of the same image; the server's own user owns it.
dc run --rm --no-deps -T -u root --entrypoint bash data-db -c "set -e
cd /var/lib/postgresql/data
tar -xzf /backup/base/$stamp/base.tar.gz
mkdir -p pg_wal
tar -xzf /backup/base/$stamp/pg_wal.tar.gz -C pg_wal
touch recovery.signal
chown -R postgres:postgres .
chmod 0700 ." </dev/null
t_unpack=$(($(date +%s) - t0))
dc up -d --no-deps data-db </dev/null
wait_store 900 || die "the copy did not leave recovery in 900 s"
echo "restore: $stamp to $target: unpacked in ${t_unpack}s, promoted $(($(date +%s) - t0))s after the start, timeline $(qc 'select timeline_id from pg_control_checkpoint()')"
