# Company data: the store and the gateway

The design is [RUNTIME-COMPANY-DATABASES.md](../first-node/RUNTIME-COMPANY-DATABASES.md). A company database is a
folder `data/<name>/` of the company folder; its rows live in the company data store, a PostgreSQL of its own. The
data gateway is the one service that connects to the store. Nothing here is live yet.

| Path | What |
| --- | --- |
| `store/cluster.sql` | the store's logins and its template database, run once on a new server |
| `store/template.sql` | the schema `qorpera_data` every company's database is copied from |
| `gateway/gateway.mjs` | the gateway: questions, steps, the held watch, the watcher, its HTTP side |
| `gateway/sql-text.mjs` | reads one SQL file: its words, its `:name` parameters, one statement |
| `gateway/*.test.mjs` | the tests (below) |
| `proof/` | the proofs of the design (§11) and the end-to-end proof |

## The store

Set it up as the server's superuser, with psql:

```sh
psql -d postgres -v ON_ERROR_STOP=1 -v admin_password=… -v keeper_password=… -v watch_password=… -f store/cluster.sql
psql -d qorpera_company_template -v ON_ERROR_STOP=1 -f store/template.sql
```

| Login | What it does |
| --- | --- |
| `qorpera_data_admin` | makes a company's database (from the template) and each database folder's schema and logins |
| `qorpera_data_keeper` | the gateway's own records in each company's database, and its LISTEN; never runs a company's SQL |
| `qorpera_data_watch` | reads sizes and running statements, and ends what runs too long |

A company's database is `c_` and the 32 hex digits of its folder's id, with a connection limit of 24, a temp file
limit of 256 MB, `work_mem` 16 MB and no parallel workers. Nothing of it goes into the server's log: errors, statements
and their context carry the company's values, and the caller hears its errors through the gateway. It sets
`log_min_messages = panic`, `log_error_verbosity = terse`, `log_min_error_statement = panic`, `log_statement = none`,
`log_min_duration_statement = -1`, `log_min_duration_sample = -1`, `log_transaction_sample_rate = 0`,
`log_lock_waits = off` and `log_temp_files = -1`; `LOG_SETTINGS` in `gateway.mjs` says why each, and why the other log
sources (connections, autovacuum, auto_explain, a PANIC) carry no company value. A company's login cannot lift any of
these. The store's server must never preload `auto_explain`. Each database folder is one schema in it, with three
logins of its own: `<db>_o<n>` runs its steps, `<db>_w<n>` its changes, `<db>_r<n>` its questions. Each is a member of
nothing, so no statement can switch to another folder's role. Their passwords are derived from the gateway's folder
key (HMAC-SHA256 of the role's name, base64url) and never stored.

The template's event triggers put three triggers on every new table: `qorpera_changed` (a notice per statement),
`qorpera_emptied` and `qorpera_rows_gone` (what a step destroys). A command that switches one off, replaces, renames
or drops it, or that makes an unlogged table, is refused the moment it runs.

## The gateway

`new Gateway({ store: { host, port, logins: { admin, keeper, watch, folderKey } }, platform, limits, runs })`, where
`platform` is `new Platform({ url, publishableKey })`, `folderKey` is 32 random bytes as hex and `runs` is `{ token }`,
the node's private token agents' tools bring (leave it out and the run door answers nothing). `serve(gateway)` answers
members on loopback; `serveRuns(gateway, { host, port, cert, key })` is the run door, its own listener (TLS with the PEM
`cert` and `key`; without them only on loopback); `startWatcher(gateway)` looks every 10 s.

Every call is `POST /v1/company-data/<environment id>/<call>` with the member's own token (`authorization: Bearer
…`) and a JSON body. The gateway reads the files it needs as the member. When it does not hold a file's text yet, it
answers `{ need: [{ path, sha256 }] }`, and the caller sends the same body again with `texts: { <sha256>: <text> }`.

| Call | Body | Answer |
| --- | --- | --- |
| `query` | `{ database, question, params?, etag? }` | `{ columns, rows, more, asOf, etag }`, or `{ same: true, etag }` |
| `watch` | `{ watches: [{ database, question, params?, etag }], wait? }` | `{ changed: [{ index, answer }] }` when an answer differs, else `{ same: true }` after the wait |
| `apply` | `{ database }` | `{ applied, results: [{ name, state, detail?, destroys? }] }`; a state is `applied`, `already`, `failed`, `held`, `changed` or `missing` |
| `describe` | `{ database }` | `{ database, applied: [{ name, at }], tables: [{ name, rows, columns }], companyBytes }` |

### The run door (agents)

An agent's tool (`data_describe`, `data_apply`, `data_query`, `packages/runtime/src/cloud-data-tools.ts`) calls `POST
/v1/run-data/<call>` on the run door with the node's private token (`authorization: Bearer …`) and, in the body, a data
pass the platform made for its run (`qorpera_run_data_pass`, migration `20260930750000`). The gateway redeems the pass
once with the publishable key alone (`qorpera_data_pass_redeem`): it names the company, the member who asked the run and
each file the run may read under `data/<name>/` (its `database.toml` and the files directly in `tables/`, `queries/`
and `actions/`) with its hash. The gateway reads nothing else as the run: a file is the run's when the pass kept it, and
a text is used only when its hash is the kept one. One pass serves one call; a `need` answer is asked again with a new
pass and the texts. A wrong token, no pass and a pass that redeems to nothing (redeemed, unknown, expired, or its run's
job ended) all answer 401 `{ error: "Not allowed" }`.

| Call | Body (with `pass`, and `texts` after a `need`) | Answer |
| --- | --- | --- |
| `describe` | `{ database? }` | `{ databases: [{ database, name, about, steps: { applied, waiting, changed, missing }, tables, questions: [{ name, words, parameters }] }], companyBytes, limitBytes }` |
| `apply` | `{ database }` | as a member's `apply` |
| `query` | `{ database, question, params? }` or `{ database, sql, params? }` | `{ columns, rows, more, asOf }` |

A run's question or own read runs as a question does (the database folder's read login, read only, one statement), with
an agent's limits: 15 s, 200 rows and 24 KiB an answer, `more: true` past them. `:viewer` is the member who asked the run
unless the run names one in `params.viewer`. The watcher gives a read login's backend an agent's limit while the gateway
runs an agent's read on it, known by its pid.

A refusal is `{ error }` with its status: 400 (the call or the SQL), 401 (sign in), 404 (no such question or database
that you may read), 405 (not POST), 408 (past the time limit), 409 (no step applied yet), 413 (body too large), 429
(the database's connections are taken), 507 (the company's database is at its size limit).

### Limits (`LIMITS`)

| Limit | Value |
| --- | --- |
| A question | 2 s, 2,000 rows, 256 KiB; past those rows or bytes the answer says `more: true` |
| An agent's question or own read | 15 s, 200 rows, 24 KiB, with `more: true` |
| A change | 5 s |
| A step | 60 s, 5 s for a lock |
| A file | a question 16 KiB, a step 64 KiB, 500 steps a database |
| A watch | 24 questions, held 20 s, asked again at most every 500 ms |
| A member's folder read | kept 10 s |
| A body | 1 MiB |
| A company's database | 1 GiB: the watcher closes its steps, questions still answer |

The watcher also ends a statement of a folder's login that runs 2 s past its door's limit.

## Tests and proofs

Nothing runs on a Mac. On a test machine:

```sh
node scripts/run-on-node.mjs --no-status -- node --test deploy/company-data/gateway/sql-text.test.mjs deploy/company-data/gateway/gateway.test.mjs
node scripts/run-on-node.mjs --no-status --machine node01 -- bash deploy/company-data/proof/run.sh e2e
```

`gateway.test.mjs` starts its own PostgreSQL 17 (the pinned image of `scripts/test-hosted-db.mjs`) in a container on a
random loopback port, capped at 2 CPUs and 4 GiB, and removes it at the end; the platform is a stand-in. Both test
files run in `changed` (the `deploy-node` step). The end-to-end proof needs a real PostgREST, which only node01 holds.
