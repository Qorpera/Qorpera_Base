#!/bin/bash
# Brings this machine's store to the kit's store/template.sql, for a store that was made from an earlier one: runs
# store/update.sql, as the superuser, inside the template database and inside every company's database. On the
# primary's machine only: a standby follows its primary and is refused. Safe to run again. While it is inside the
# template database (well under a second), a company's first database cannot be made from it; the gateway's caller is
# told and asks again. Prints names and counts only.
#   update-store.sh
set -euo pipefail
. "$(dirname "$0")/lib.sh"
STORE=$K/../store
[ -f "$STORE/update.sql" ] || die "no $STORE/update.sql: the kit stands beside ../store, as in the repository"
running data-db || die "the store does not run on this machine"
[ "$(qc 'select pg_is_in_recovery()')" = f ] || die "this store follows a primary: run it on the primary's machine"
companies=$(qc "select datname from pg_database where datname ~ '^c_[0-9a-f]{32}\$' order by 1")
n=0
for database in qorpera_company_template $companies; do
	q -d "$database" -f - <"$STORE/update.sql" >/dev/null || die "store/update.sql did not run in $database"
	n=$((n + 1))
done
echo "update-store: the template and $((n - 1)) companies' databases are as store/template.sql makes them"
