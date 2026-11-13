#!/bin/sh
# restore_command (standby.sh seed, restore.sh): restore-wal.sh %f %p. Runs inside the database container as postgres.
# Exit 1 when the file is not in the archive: PostgreSQL expects that at the archive's end, and then streams from the
# primary (a standby) or ends recovery (a restore).
set -eu
src=/backup/wal/$1.gz
[ -e "$src" ] || exit 1
gzip -dc "$src" >"$2.tmp"
mv "$2.tmp" "$2"
