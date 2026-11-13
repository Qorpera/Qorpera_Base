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

A company's database is `c_` and the 32 hex digits of its folder's id, with a connection limit of 12, a temp file
limit of 256 MB, `work_mem` 16 MB and no parallel workers. Each database folder is one schema in it, with three
logins of its own: `<db>_o<n>` runs its steps, `<db>_w<n>` its changes, `<db>_r<n>` its questions. Each is a member of
nothing, so no statement can switch to another folder's role. Their passwords are derived from the gateway's folder
key (HMAC-SHA256 of the role's name, base64url) and never stored.

The template's event triggers put three triggers on every new table: `qorpera_changed` (a notice per statement),
`qorpera_emptied` and `qorpera_rows_gone` (what a step destroys). A command that switches one off, replaces, renames
or drops it, or that makes an unlogged table, is refused the moment it runs.

## The gateway

`new Gateway({ store: { host, port, logins: { admin, keeper, watch, folderKey } }, platform, limits })`, where
`platform` is `new Platform({ url, publishableKey })` and `folderKey` is 32 random bytes as hex. `serve(gateway)`
answers on loopback; `startWatcher(gateway)` looks every 10 s.

Every call is `POST /v1/company-data/<environment id>/<call>` with the member's own token (`authorization: Bearer
…`) and a JSON body. The gateway reads the files it needs as the member. When it does not hold a file's text yet, it
answers `{ need: [{ path, sha256 }] }`, and the caller sends the same body again with `texts: { <sha256>: <text> }`.

| Call | Body | Answer |
| --- | --- | --- |
| `query` | `{ database, question, params?, etag? }` | `{ columns, rows, more, asOf, etag }`, or `{ same: true, etag }` |
| `watch` | `{ watches: [{ database, question, params?, etag }], wait? }` | `{ changed: [{ index, answer }] }` when an answer differs, else `{ same: true }` after the wait |
| `apply` | `{ database }` | `{ applied, results: [{ name, state, detail?, destroys? }] }`; a state is `applied`, `already`, `failed`, `held`, `changed` or `missing` |
| `describe` | `{ database }` | `{ database, applied: [{ name, at }], tables: [{ name, rows, columns }], companyBytes }` |

A refusal is `{ error }` with its status: 400 (the call or the SQL), 401 (sign in), 404 (no such question or database
that you may read), 405 (not POST), 408 (past the time limit), 409 (no step applied yet), 413 (body too large), 429
(the database's connections are taken), 507 (the company's database is at its size limit).

### Limits (`LIMITS`)

| Limit | Value |
| --- | --- |
| A question | 2 s, 2,000 rows, 256 KiB; past those rows or bytes the answer says `more: true` |
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
