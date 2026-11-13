#!/bin/sh
# archive_command (postgresql.conf): archive-wal.sh %p %f. Runs inside the database container as postgres.
# Copies one finished WAL file into /backup/wal as <name>.gz (the NAS folder on a machine; a local folder in the
# drill): gzip to a temporary name, flush it to disk, rename, flush the folder. Exit 0 only once the file is safely
# there; any other exit makes PostgreSQL keep the WAL file and try again.
# A second call for a file already archived (after a crash) succeeds only if the archived copy is the same WAL.
set -eu
src=$1
dst=/backup/wal/$2.gz
if [ -e "$dst" ]; then
	if gzip -dc "$dst" | cmp -s - "$src"; then exit 0; fi
	echo "archive-wal: $dst exists and differs" >&2
	exit 1
fi
gzip -1 -c "$src" >"$dst.tmp"
sync "$dst.tmp"
mv "$dst.tmp" "$dst"
sync /backup/wal
