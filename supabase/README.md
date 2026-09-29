# Hosted database: migrations and SQL tests

- `migrations/` — the schema, applied in name order. A migration runs once; later changes are new files.
- `tests/*.test.sql` — SQL regression tests, run in name order on one database (`tests/bootstrap.sql` stands in
  for the Supabase roles and schemas first). `tests/fixtures/` holds setup shared by tests and scripts.

## Running the tests

SQL and PostgreSQL script tests run on the operator test machine, not on a Mac
([`deploy/test-machine/README.md`](../deploy/test-machine/README.md)):

```sh
node scripts/run-on-node.mjs hosted-db                       # migrations + SQL tests
node scripts/run-on-node.mjs --install hosted-db -- --scripts  # also the PostgreSQL scripts (what `changed` runs)
```

One run starts one PostgreSQL and replays the migrations once, in one `psql` process that opens a fresh
session for every file. It keeps a copy of the database at the points the scripts start from (the scripts
listed in `HOSTED_DB_SCRIPTS` in `scripts/test-hosted-db.mjs`); each script then gets its own database with
`CREATE DATABASE … TEMPLATE` and replays only what it needs on top. `test-runtime-node-capacity` restarts the
server, so it keeps a container of its own. Each script still runs alone (`node scripts/<script>.mjs`) against
a container it starts itself.

## Seeing a function's live definition

About a quarter of the migrations change functions by text (`pg_get_functiondef` plus `replace`, often through
a `pg_temp.*_patch` helper), so the last `create or replace` in a file is often not the body that runs. To see
what runs after every migration:

```sh
npm run schema:dump -- --function qorpera_claim_runner_job_for_orchestrator   # every overload
npm run schema:dump -- --out /tmp/live-schema.sql             # every function, trigger and policy
```

It builds the database from your working tree on the test machine (uncommitted changes included) and writes
the dump locally, sorted and stable, so two dumps diff cleanly: dump master, then your branch, and compare.
The dump is not committed; every SQL change would conflict on it.

When you change a live function, keep the repository's pattern: patch it by text through a helper that fails
when master's text moved, or restate it in full from the dump. A failing patch helper means another PR changed
the function first; rebuild the patch on master's body rather than overwriting it.
