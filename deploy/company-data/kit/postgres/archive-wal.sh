#!/bin/sh
# archive_command (postgresql.conf): archive-wal.sh %p %f. Runs inside the database container as postgres.
# Copies one finished WAL file into /backup/wal as <name>.gz (the NAS folder on a machine; a local folder in the
# drill): gzip to a temporary name, check that it decompresses whole, flush it to disk, rename, flush the folder.
# Exit 0 only once a whole, equal copy is there; any other exit makes PostgreSQL keep the WAL file and try again.
# A copy already there (after a crash) counts only if it decompresses whole (gzip checks its trailer's CRC and size)
# and equals the WAL file. A damaged one is replaced; a whole one that differs is an error.
# No pipeline: each step's own status is checked (dash has no pipefail).
set -eu
src=$1
wal_dir=${QORPERA_WAL_ARCHIVE_DIR:-/backup/wal}
dst=$wal_dir/$2.gz
check=""
tmp=""
cleanup() {
	[ -z "$check" ] || rm -f -- "$check"
	[ -z "$tmp" ] || rm -f -- "$tmp"
}
# WHY: Remove temp files on failure or signal because pg_archivecleanup only prunes .gz WAL files, never .tmp remnants.
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if [ -e "$dst" ]; then
	check=$(mktemp)
	if gzip -dc "$dst" >"$check" 2>/dev/null; then
		if cmp -s "$check" "$src"; then
			exit 0
		fi
		echo "archive-wal: $dst exists and differs" >&2
		exit 1
	fi
	rm -f -- "$check"
	check=""
	echo "archive-wal: $dst is damaged; archiving it again" >&2
fi
tmp="$dst.tmp.$$"
gzip -1 -c "$src" >"$tmp"
gzip -t "$tmp"
sync "$tmp"
mv "$tmp" "$dst"
tmp=""
sync "$wal_dir"
