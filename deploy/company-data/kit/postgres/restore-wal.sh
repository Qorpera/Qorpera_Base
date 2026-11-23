#!/bin/sh
# restore_command (standby.sh seed, restore.sh): restore-wal.sh %f %p. Runs inside the database container as postgres.
# Exit 1 when the file is not in the archive: PostgreSQL expects that at the archive's end, and then streams from the
# primary (a standby) or ends recovery (a restore).
set -eu
wal_dir=${QORPERA_WAL_ARCHIVE_DIR:-/backup/wal}
src=$wal_dir/$1.gz
[ -e "$src" ] || exit 1
tmp="$2.tmp.$$"
cleanup() {
	[ -z "$tmp" ] || rm -f -- "$tmp"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
gzip -dc "$src" >"$tmp"
mv "$tmp" "$2"
tmp=""
