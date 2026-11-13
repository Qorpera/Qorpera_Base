#!/bin/bash
# One base backup of this machine's store into $DATA_BACKUP/base/<UTC>, as ~/work/dbhome's base-backup.sh. Runs as
# root on the primary's machine: nightly from a timer (README.md), and once in the drill.
#   KEEP=7             backups kept; archived WAL older than the oldest kept is removed, so a point-in-time restore
#                      reaches back about KEEP days
#   CHECKPOINT=spread  the default, gentle on a busy store; drills use fast
# Prints one line per backup, also appended to base/base-backup.log: stamp, seconds, bytes, first WAL file.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
KEEP=${KEEP:-7}
CHECKPOINT=${CHECKPOINT:-spread}
[[ $KEEP =~ ^[1-9][0-9]*$ ]] || die "KEEP is a number of backups"
running || die "data-db is not running"
[ "$(qc 'select pg_is_in_recovery()')" = f ] || die "this store is a standby: base backups are taken on the primary"
D=$B/base
[[ $D == /* ]] && [ -d "$D" ] || die "no backup folder $D"
# A backup's own name, and the only names retention removes. Nothing here passes a path through word splitting: every
# name is read null-delimited, checked against these, and removed by its full quoted path directly inside $D.
STAMP='^[0-9]{8}T[0-9]{6}Z$'
PARTIAL='^[0-9]{8}T[0-9]{6}Z\.partial$'
backups() { # the complete backups' names, oldest first, one per element of the array named $1
	local -n into=$1
	into=()
	local name
	while IFS= read -r -d '' name; do
		if [[ $name =~ $STAMP ]]; then into+=("$name"); fi
	done < <(find "$D" -mindepth 1 -maxdepth 1 -type d -printf '%f\0' | sort -z)
}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
while [ -e "$D/$stamp" ] || [ -e "$D/$stamp.partial" ]; do
	sleep 1
	stamp=$(date -u +%Y%m%dT%H%M%SZ)
done
t0=$(date +%s)
# Tar format, gzip, with the WAL it needs streamed beside it (pg_wal.tar.gz), so each backup restores on its own.
dc exec -T -u postgres data-db pg_basebackup -U postgres -D "/backup/base/$stamp.partial" -Ft -z -X stream \
	-c "$CHECKPOINT" -l "company-data $stamp" -w </dev/null
secs=$(($(date +%s) - t0))
# backup_label names the first WAL file this backup needs. Reading it unpacks the whole tar once, which checks it.
start=$(tar -xzOf "$D/$stamp.partial/base.tar.gz" backup_label | sed -n 's/^START WAL LOCATION: .* (file \([0-9A-F]\{24\}\))$/\1/p')
[ -n "$start" ] || die "no START WAL LOCATION in backup_label"
gzip -t "$D/$stamp.partial/pg_wal.tar.gz"
echo "$start" >"$D/$stamp.partial/START_WAL"
mv "$D/$stamp.partial" "$D/$stamp"
sync "$D"
bytes=$(du -sb "$D/$stamp" | cut -f1)
echo "$stamp ${secs}s ${bytes}B start=$start" | tee -a "$D/base-backup.log"
# The newest KEEP complete backups; an unfinished one only for a day.
backups all
for ((i = 0; i < ${#all[@]} - KEEP; i++)); do
	rm -rf -- "$D/${all[i]}"
done
while IFS= read -r -d '' name; do
	if [[ $name =~ $PARTIAL ]]; then rm -rf -- "$D/$name"; fi
done < <(find "$D" -mindepth 1 -maxdepth 1 -type d -name '*.partial' -mmin +1440 -printf '%f\0')
backups kept
oldest=${kept[0]}
first=$(cat "$D/$oldest/START_WAL")
[[ $first =~ ^[0-9A-F]{24}$ ]] || die "$D/$oldest/START_WAL does not name a WAL file"
# pg_archivecleanup removes only WAL files (by their names) older than that one, inside /backup/wal.
dc exec -T -u postgres data-db pg_archivecleanup -x .gz /backup/wal "$first" </dev/null
echo "base-backup: ${#kept[@]} kept, oldest $oldest, $(find "$B/wal" -type f | wc -l) WAL files archived"
