#!/bin/bash
# The first start of the company data store on this machine, on an empty volume. Runs once, as root.
#   init.sh NAME...   NAME: every name the server cert holds, the primary's and the standby's (tls.sh server)
# It makes the machine's folder ($DATA_LOCAL, root only):
#   ca/                the kit's own CA (tls.sh); its key never leaves this folder
#   secrets/gateway/   the gateway's secrets, one file each (lib.sh GATEWAY_PASSWORDS and GATEWAY_KEYS), nobody's 0400
#   secrets/replication, secrets/superuser   the replication login's password; the superuser's (initdb only)
#   postgres/tls/      the server's key and cert, mounted into the database
#   secrets/run-door/  the run door's token and its TLS key and cert (lib.sh make_run_door), the gateway's user's 0400;
#                      the door itself listens only when DATA_RUN_LISTEN is set (run-door.yml)
# then the backup folder's wal/ and base/, starts the database, runs store/cluster.sql and store/template.sql, makes
# the replication login, and starts the gateway. Refuses a second run, a used volume and a used WAL folder.
# Prints names, counts and times only, never a secret.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
STORE=$K/../store
[ $# -gt 0 ] || die "init NAME...: the names the server cert holds"
[ ! -e "$L/INITIALISED" ] || die "this machine was initialised already ($L/INITIALISED): init runs once"
[ ! -e "$L/STANDBY" ] || die "this machine holds a standby (standby.sh): init is for a new primary"
[ -z "$(volume)" ] || die "the volume of $COMPOSE_PROJECT_NAME exists already: init runs once, on an empty volume"
[ -d "$B" ] || die "no backup folder $B"
[ -z "$(ls -A "$B/wal" 2>/dev/null)" ] || die "$B/wal is not empty: a new store needs a WAL folder of its own"
t0=$(date +%s)

install -d -m 0700 "$L" "$L/ca" "$L/secrets"
install -d -m 0750 -o 0 -g "$PG_UID" "$L/postgres"
install -d -m 0500 -o "$NOBODY" -g "$NOBODY" "$L/secrets/gateway"
put() { # put FILE OWNER VALUE: a secret file, written before anyone else can read it
	(umask 077 && printf '%s\n' "$3" >"$1")
	chown "$2:$2" "$1"
	chmod 0400 "$1"
}
for name in $GATEWAY_PASSWORDS; do put "$L/secrets/gateway/$name" "$NOBODY" "$(new_secret 24)"; done
for name in $GATEWAY_KEYS; do put "$L/secrets/gateway/$name" "$NOBODY" "$(new_secret 32)"; done
put "$L/secrets/replication" 0 "$(new_secret 24)"
put "$L/secrets/superuser" "$PG_UID" "$(new_secret 24)"
"$K/tls.sh" ca "$L/ca"
"$K/tls.sh" server "$L/ca" "$L/postgres/tls" "$@"
make_run_door

install -d -m 0700 -o "$PG_UID" -g "$PG_UID" "$B/wal" "$B/base"

dc up -d --wait --wait-timeout 300 data-db </dev/null
wait_store 120 || die "the store did not come up"

# The passwords cross on psql's stdin as variables, never on a command line, and the session logs no statement, not
# even one that fails.
{
	echo "set log_min_error_statement = panic; set log_min_duration_statement = -1;"
	for name in $GATEWAY_PASSWORDS; do printf '\\set %s_password %s\n' "$name" "$(cat "$L/secrets/gateway/$name")"; done
	cat "$STORE/cluster.sql"
} | q -f - >/dev/null
q -d qorpera_company_template -f - <"$STORE/template.sql" >/dev/null
{
	echo "set log_min_error_statement = panic; set log_min_duration_statement = -1;"
	printf '\\set replication_password %s\n' "$(cat "$L/secrets/replication")"
	echo "create role qorpera_data_replicator login replication password :'replication_password';"
} | q -f - >/dev/null
date -u +%Y-%m-%dT%H:%M:%SZ >"$L/INITIALISED"

dc up -d --wait --wait-timeout 120 data-gateway </dev/null
echo "init: store and gateway up in $(($(date +%s) - t0))s; logins: $(qc "select count(*) from pg_roles where rolname like 'qorpera_data_%' and rolcanlogin"), template: $(qc "select count(*) from pg_database where datname = 'qorpera_company_template' and datistemplate"), run door: $([ -n "${DATA_RUN_LISTEN:-}" ] && echo on || echo off)"
