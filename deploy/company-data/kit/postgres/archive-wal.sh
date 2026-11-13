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
dst=/backup/wal/$2.gz
if [ -e "$dst" ]; then
	check=$(mktemp)
	if gzip -dc "$dst" >"$check" 2>/dev/null; then
		if cmp -s "$check" "$src"; then
			rm -f "$check"
			exit 0
		fi
		rm -f "$check"
		echo "archive-wal: $dst exists and differs" >&2
		exit 1
	fi
	rm -f "$check"
	echo "archive-wal: $dst is damaged; archiving it again" >&2
fi
gzip -1 -c "$src" >"$dst.tmp"
gzip -t "$dst.tmp"
sync "$dst.tmp"
mv "$dst.tmp" "$dst"
sync /backup/wal
