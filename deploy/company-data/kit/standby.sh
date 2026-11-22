#!/bin/bash
# The streaming standby, as ~/work/dbhome's standby.sh. Runs as root; the same kit on both machines, each with its own
# project and folder. The standby dials the primary with TLS (verify-full against the kit's CA) and its own slot.
#   standby.sh allow ADDR[/BITS]   primary's machine: replication from the standby's address only, TLS only
#                                  (postgres/hba-standby.conf), checked, then a reload. On machines: the standby's /32.
#   standby.sh pack                primary's machine: a tar on stdout of what the standby needs: the server's TLS
#                                  files (never the CA key), the gateway's secrets, the run door's, the replication
#                                  password. Pipe it to unpack over a channel only root on both machines reads.
#   standby.sh unpack              standby's machine, a new folder: takes pack's tar on stdin
#   standby.sh seed HOST [PORT]    standby's machine, after unpack, on an empty volume: a base backup from HOST (a name
#                                  in the server cert) over TLS with a new slot, then the standby starts and streams
#   standby.sh status              either machine: replication, lag, slot and archive; names, numbers and times only
#   standby.sh promote             standby's machine, after the old primary is stopped for good: promote, then start
#                                  this machine's gateway. This machine is then the primary.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
host_ok() {
	[[ $1 =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] ||
		{ [ ${#1} -le 253 ] && [[ $1 =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$ ]]; }
}

allow() {
	local a=${1:-} o=$L/postgres/hba-standby.conf
	[[ $a =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}(/([0-9]|[12][0-9]|3[0-2]))?$ ]] || die "allow ADDR[/BITS]: the standby's IPv4 address"
	[[ $a == */* ]] || a=$a/32
	running || die "data-db is not running"
	[ ! -e "$o" ] || cp -p "$o" "$o.old"
	printf '%s\n' "# standby.sh allow: replication from the standby's address only, TLS only." \
		"hostssl  replication  qorpera_data_replicator  $a  scram-sha-256" >"$o.new"
	chmod 0644 "$o.new"
	mv "$o.new" "$o"
	if [ "$(qc "select count(*) from pg_hba_file_rules where error is not null")" != 0 ]; then
		if [ -e "$o.old" ]; then mv "$o.old" "$o"; else rm -f "$o"; fi
		die "allow: the hba has an error with the new line; put back, nothing reloaded"
	fi
	rm -f "$o.old"
	qc "select pg_reload_conf()" >/dev/null
	echo "standby: allowed and reloaded; replication lines: $(qc "select count(*) from pg_hba_file_rules
		where type = 'hostssl' and 'replication' = any(database) and 'qorpera_data_replicator' = any(user_name)")"
}

pack() {
	[ -e "$L/INITIALISED" ] || die "pack: this machine holds no initialised store"
	# The run door's token and cert too: the promoted gateway's door must take the token the nodes hold.
	tar -C "$L" -cf - postgres/tls/server.key postgres/tls/server.crt postgres/tls/ca.crt secrets/gateway secrets/replication \
		$([ ! -d "$L/secrets/run-door" ] || echo secrets/run-door)
}

unpack() {
	[ ! -e "$L/INITIALISED" ] && [ ! -e "$L/STANDBY" ] || die "unpack: $L is a store's folder already"
	[ -z "$(volume)" ] || die "unpack: the volume of $COMPOSE_PROJECT_NAME exists already"
	install -d -m 0700 "$L" "$L/secrets"
	install -d -m 0750 -o 0 -g "$PG_UID" "$L/postgres" "$L/postgres/tls"
	install -d -m 0500 -o "$NOBODY" -g "$NOBODY" "$L/secrets/gateway"
	tar -C "$L" --same-owner -xpf -
	[ -s "$L/postgres/tls/server.key" ] && [ -s "$L/secrets/replication" ] && [ -d "$L/secrets/gateway" ] || die "unpack: the tar lacks a file"
	(umask 077 && new_secret 24 >"$L/secrets/superuser")
	chown "$PG_UID:$PG_UID" "$L/secrets/superuser"
	(umask 077 && printf '*:*:replication:qorpera_data_replicator:%s\n' "$(cat "$L/secrets/replication")" >"$L/postgres/replication.pgpass")
	chown "$PG_UID:$PG_UID" "$L/postgres/replication.pgpass"
	date -u +%Y-%m-%dT%H:%M:%SZ >"$L/STANDBY"
	echo "standby: unpacked $(find "$L/secrets/gateway" -type f | wc -l) gateway secrets, $(find "$L/secrets" -path '*/run-door/*' -type f | wc -l) of the run door and the TLS files"
}

seed() {
	local host=${1:-} port=${2:-5432} c t0
	host_ok "$host" && [[ $port =~ ^[0-9]{1,5}$ ]] || die "seed HOST [PORT]"
	[ -e "$L/STANDBY" ] && [ -s "$L/postgres/replication.pgpass" ] || die "seed: unpack first"
	[ -z "$(volume)" ] || die "seed: the volume of $COMPOSE_PROJECT_NAME exists already"
	c="host=$host port=$port user=qorpera_data_replicator sslmode=verify-full sslrootcert=/etc/company-data-local/tls/ca.crt"
	t0=$(date +%s)
	# As postgres, into the new volume; the slot is made by this backup, so WAL is kept from its first byte.
	dc run --rm --no-deps -T -u postgres -e PGPASSFILE=/etc/company-data-local/replication.pgpass \
		--entrypoint pg_basebackup data-db -d "$c" -D /var/lib/postgresql/data -X stream -C -S "$SLOT" -c fast -w </dev/null
	dc run --rm --no-deps -T -u postgres --entrypoint touch data-db /var/lib/postgresql/data/standby.signal </dev/null
	printf '%s\n' "# standby.sh seed: this store is a standby of $host." \
		"primary_conninfo = '$c passfile=/etc/company-data-local/replication.pgpass application_name=$SLOT'" \
		"primary_slot_name = '$SLOT'" \
		"restore_command = '/etc/company-data/restore-wal.sh %f %p'" >"$L/postgres/standby.conf"
	chmod 0644 "$L/postgres/standby.conf"
	echo "standby: base backup over TLS took $(($(date +%s) - t0))s"
	dc up -d --no-deps data-db </dev/null
	wait_store 120 standby || die "the standby did not come up"
	local receiver_status="NOT streaming"
	for _ in $(seq 1 60); do
		receiver_status=$(qc "select coalesce((select status from pg_stat_wal_receiver), 'none')" 2>/dev/null) || receiver_status=unreachable
		[ "$receiver_status" = streaming ] && break
		sleep 1
	done
	# WHY: Fail non-zero if the standby never starts streaming so provisioning callers do not treat a broken replica as healthy.
	[ "$receiver_status" = streaming ] || die "standby did not reach streaming state (status: $receiver_status)"
	echo "standby: $receiver_status $(($(date +%s) - t0))s after the start"
}

status() {
	running || {
		echo "== data-db is not running here"
		return 0
	}
	if [ "$(qc 'select pg_is_in_recovery()')" = t ]; then
		echo "== standby: receiver status, upstream, received = replayed, time since the last replayed commit"
		qc "select coalesce((select status from pg_stat_wal_receiver), 'none'),
			coalesce((select sender_host from pg_stat_wal_receiver), '-'),
			pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn(),
			coalesce((now() - pg_last_xact_replay_timestamp())::text, '-')"
	else
		echo "== primary: standby, state, TLS, bytes not yet sent, bytes not yet replayed, replay lag"
		qc "select r.application_name, r.state, s.ssl, pg_wal_lsn_diff(pg_current_wal_lsn(), r.sent_lsn),
			pg_wal_lsn_diff(pg_current_wal_lsn(), r.replay_lsn), coalesce(r.replay_lag::text, '-')
			from pg_stat_replication r left join pg_stat_ssl s using (pid)"
		echo "== primary: slot, active, wal_status, bytes held"
		qc "select slot_name, active, wal_status, pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) from pg_replication_slots"
		echo "== primary: archived, failed, last archived file and time"
		qc "select archived_count, failed_count, coalesce(last_archived_wal, '-'), coalesce(last_archived_time::text, '-') from pg_stat_archiver"
	fi
}

promote() {
	local t0
	[ -e "$L/STANDBY" ] || die "promote: this machine holds no standby"
	running || die "promote: data-db is not running"
	t0=$(date +%s)
	[ "$(qc 'select pg_is_in_recovery()')" = f ] || qc "select pg_promote(wait => true, wait_seconds => 60)" >/dev/null
	[ "$(qc 'select pg_is_in_recovery()')" = f ] || die "promote: still in recovery; nothing else changed"
	echo "standby: promoted after $(($(date +%s) - t0))s"
	# Its upstream is gone for good; a restart must not look for it.
	rm -f "$L/postgres/standby.conf"
	qc "select pg_reload_conf()" >/dev/null
	mv "$L/STANDBY" "$L/INITIALISED"
	dc up -d --wait --wait-timeout 120 data-gateway </dev/null
	echo "standby: this machine is the primary; its gateway answers $(($(date +%s) - t0))s after the start"
}

case ${1:-} in
allow) shift && allow "$@" ;;
pack) pack ;;
unpack) unpack ;;
seed) shift && seed "$@" ;;
status) status ;;
promote) promote ;;
*)
	sed -n '2,16p' "$0"
	exit 2
	;;
esac
