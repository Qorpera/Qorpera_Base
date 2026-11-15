# Company data: the store and the gateway

The design is [RUNTIME-COMPANY-DATABASES.md](../first-node/RUNTIME-COMPANY-DATABASES.md). A company database is a
folder `data/<name>/` of the company folder; its rows live in the company data store, a PostgreSQL of its own. The
data gateway is the one service that connects to the store. Nothing here is live yet.

| Path | What |
| --- | --- |
| `store/cluster.sql` | the store's logins and its template database, run once on a new server |
| `store/template.sql` | the schema `qorpera_data` every company's database is copied from |
| `store/update.sql` | what brings a store made from an earlier `template.sql` to today's: run in the template database and in every company's (`kit/update-store.sh`), safe to run again |
| `gateway/gateway.mjs` | the gateway: questions, changes, steps, the held watch, the watcher, its HTTP side |
| `gateway/sql-text.mjs` | reads one SQL file: its words, its `:name` parameters, one statement; a change's words with its values in place |
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

The template's event triggers put six triggers on every new table, each as the model table `qorpera_data.model`
carries it (`qorpera_data.give_triggers`): `qorpera_changed` (a notice per statement), `qorpera_emptied` and
`qorpera_rows_gone` (what a step destroys; deleted rows are recorded only in a step's session, the folder's owner
login, since a change's deletes are committed and their record would stay for good), and `qorpera_record_add`,
`qorpera_record_change` and `qorpera_record_remove` (the record below). A command that switches one off, replaces,
renames or drops it, or that makes an unlogged table, is refused the moment it runs.

**The record of every row's change** (design §5a, "Who changed what"). The three record triggers fire once a
statement, on its transition tables, and write `qorpera_data.row_changes(txid, seq, schema, relation, op, key, before,
after, rows, bytes)`: a line a row, `op` `add`, `change` or `remove`; `key` the primary key's columns (null for a table
made without one); `after` the added row, `before` the removed one, and for a change only the columns that differ on
each side (a table without a key keeps both rows whole; a change that changes nothing leaves no line). A statement
that touches more than 1,000 rows of a relation leaves one line with the count in `rows` and no row. `bytes` is what a
line holds (its names, key and rows as text). They run as `qorpera_data_recorder` (made by `store/cluster.sql`, or by
`update.sql` on a store made before it), a role that logs in nowhere and may only read and write the record's lines
and its counters, whoever writes, with or without an actor's line in `qorpera_data.change_log(txid, at, by_kind, by_id, via)`. Both tables are granted to no one but the
keeper (`select` on the lines; `select`, `insert`, `delete` on the actors), not to `public` and not to any folder
login: no step, question or change reads or writes them. Since the record turns rows into JSON, which would call a
cast to json a company defined, the template refuses every new cast to `json` or `jsonb` (`qorpera_no_json_cast`), and
`update.sql` stops on a store that holds one. The record keeps 100 MiB (`qorpera_data.record_limit`) by
the sum of its lines' `bytes`: each writing backend adds its lines' bytes to its own row of `qorpera_data.record_bytes`
(no two sessions wait on one row); when a backend has written another 1/1024 of the limit, its statement sums the
rows, and past the limit it removes the oldest lines until the sum fits, but never the newest line, so the record
never empties itself. A company's size is its database's size less
the record's tables with their indexes and TOAST, wherever it is read: `describe`, and the watcher, which reads the
record's tables on the keeper's connection only for a company whose whole database is past 80 % of its limit. So a
record can never close a company's writes.

## The gateway

`new Gateway({ store: { host, port, logins: { admin, keeper, watch, folderKey } }, platform, limits, runs })`, where
`platform` is `new Platform({ url, publishableKey })`, `folderKey` is 32 random bytes as hex and `runs` is `{ token }`,
the run door's own token, which each provider host holds as its systemd credential `qorpera-company-data` and no other
service takes (leave it out and the run door answers nothing). `serve(gateway)` answers
members on loopback; `serveRuns(gateway, { host, port, cert, key })` is the run door, its own listener (TLS with the PEM
`cert` and `key`; without them only on loopback); `startWatcher(gateway)` looks every 10 s.

Every call is `POST /v1/company-data/<environment id>/<call>` with the member's own token (`authorization: Bearer
…`) and a JSON body. The gateway reads the files it needs as the member. When it does not hold a file's text yet, it
answers `{ need: [{ path, sha256 }] }`, and the caller sends the same body again with `texts: { <sha256>: <text> }`.

| Call | Body | Answer |
| --- | --- | --- |
| `query` | `{ database, question, params?, etag? }` | `{ columns, rows, more, asOf, etag }`, or `{ same: true, etag }` |
| `watch` | `{ watches: [{ database, question, params?, etag }` or `{ database, table, order?, desc?, limit?, etag }], wait? }` | `{ changed: [{ index, answer }] }` when an answer differs, else `{ same: true }` after the wait. A table is its first page, as `rows` gives it, on the same rule |
| `apply` | `{ database }` | `{ applied, more?, results: [{ name, state, detail?, destroys?, allow?, destroyed? }] }`; a state is `applied`, `already`, `failed`, `held`, `changed`, `missing` or `waiting`. A `held` step would destroy data: `destroys` says what, and `allow` is what a member's yes is for (below). A call starts no step once 45 s have passed since it began: it answers `more: true`, the steps it did not start `waiting`, and the next call goes on. A call so lasts at most about 105 s (45 s and one step's 60 s) |
| `describe` | `{ database? }` | `{ databases: [{ database, name, about, write, list, applied?, tables?, questions: [{ name, words, parameters }], changes }], companyBytes, limitBytes }`, every database the member may read (from their own listing of `data/`) or the one named. A table is `{ name, kind, key, rows?, rowsAbout?, columns: [{ name, type, settable }] }`: `kind` `table` or `view`, `key` the primary key's columns, `settable` whether a member's edit may set the column (a table's column, not generated, not an identity kept by the store). `write` is whether the member may write `data/<database>/`; `list` whether they get whole tables (below). A member without the list gets no `applied` and no `tables`. `companyBytes` is the company's own data, without the record |
| `rows` | `{ database, table, order?, desc?, limit?, after? }` | `{ columns, key, rows: [{ values, seen }], more, next?, etag, asOf }`: one page of a relation in the database's own schema, as its read login, within a question's time and bytes; 100 rows unless `limit` says (1 to 200). Ordered by `order` (nulls last, `desc` for the other way) and then by the key, or by the key alone; `next` is where the following page starts, passed back as `after` with the same order. `seen` is the sha256 of the row's text as it was read (`row::text`, UTC, ISO dates). A row larger than a page's bytes gives a page with no rows, `tooLarge: true` and the `next` past it. A relation with no key gives its first page alone, with `more` and no `next`. 403 for a member who does not get the list |
| `change` | `{ database, change, params?, sha256? }` | `{ changed?, columns?, rows?, more?, asOf }`: `changed` is how many rows the statement wrote (a select says none); `columns`, `rows` and `more` are there when the statement gives rows back |
| `change` | `{ database, change, params?, preview: true }` | `{ words, values, sha256 }`, and nothing runs |

### A change

A named change is `data/<database>/actions/<change>.sql`: one statement, run as the database folder's write login in
a transaction of its own, 5 s at most. A member who may read the file may run it. What the statement did is judged
after it ran and before it is committed, and whatever is refused is rolled back whole:

- It must be an insert, an update, a delete, a merge or a select (which may call a function a step made). A `set`, a
  `copy`, a `do` and every other command is refused.
- It may delete rows: that is the change's own defined act. It may not drop or empty a table or drop a column, which
  the write login can only do through a function a step made as its owner: that is a step's work, which waits for a
  member. The statement's deferred work runs before this check. A change's transaction is not sealed as a step's is:
  a seal is a row kept for good, and a change may delete rows anyway, so work a step's function defers a second time
  to the commit is not seen (it reaches only the folder's own tables, whose rows a change may delete as it is).
- It may not leave a table without Qorpera's triggers.
- While the company's database is at its size limit, only a change that writes nothing runs: a delete, so the company
  can make room. It is judged by what the transaction wrote as PostgreSQL counted it (rows added or changed in any
  table: a `with` part's, a function's and a large object's too), not by the statement's word, since a delete can
  carry an insert.
- Nothing of a change stays on its connection for the next one (a setting, a session's advisory lock): unlike a
  question, a change is committed, so the connection is given back only after `discard all`.
- What the statement sends back is counted as it arrives. Past 1 MiB (`changeBytes`) the gateway closes the
  connection under it, so the change is rolled back and nothing was changed. A write cannot be wrapped in a statement
  of the gateway's own as a question is, so this is what keeps one company's `returning *` out of the gateway's
  memory. Rows that fit are given back cut at an answer's rows and bytes, with `more: true`; the change ran whole.

`preview: true` is what a member is shown before they say yes: `words` are the file's leading `--` lines as text and
`{ name, value }` in turn, so the bar can tell a value, which the page chose, from the words the file's writer wrote
(the member looking reads as `you`); `values` is every value the statement takes, also one the words do not name;
`sha256` is the file's hash. Sent back with the change, `sha256` makes the gateway run only that text: a file changed
since answers 409. A caller that leaves before the change began gets none; once begun, the change runs to its end.
A change is not run twice for one call, and a call is not remembered: a caller whose call ended without an answer does
not know whether the change ran, and reads before it asks again (`data_change` says so).

A table's `rows` are counted when it is described, as the database folder's read login, each count a question of its
own (read only, a question's time at most): tables first, the smallest first, then views. `rows` is never a guess.
All the counts of one call are over within 1.5 s (`countMs`), the wait for one of the read login's three connections
included: a count that finds none free in that time is given up. A table that was not counted carries PostgreSQL's
own estimate as `rowsAbout`, a name of its own so that nothing that passes `rows` on passes a guess for a count, and
neither when PostgreSQL has none (it has none before a table is first analysed, and autovacuum leaves a table of a
few rows alone; a view never has one). A describe is never refused over a count.

### The run door (agents)

An agent's tool (`data_describe`, `data_apply`, `data_query`, `data_change`, `packages/runtime/src/cloud-data-tools.ts`) calls `POST
/v1/run-data/<call>` on the run door with the run door's token (`authorization: Bearer …`) and, in the body, a data
pass the platform made for its run (`qorpera_run_data_pass`, migration `20260930750000`). The gateway redeems the pass
once with the publishable key alone (`qorpera_data_pass_redeem`): it names the company, the member who asked the run and
each file the run may read under `data/<name>/` (its `database.toml` and the files directly in `tables/`, `queries/`
and `actions/`) with its hash. The gateway reads nothing else as the run: a file is the run's when the pass kept it, and
a text is used only when its hash is the kept one. One pass serves one call; a `need` answer is asked again with a new
pass and the texts. A wrong token, no pass and a pass that redeems to nothing (redeemed, unknown, expired, or its run's
job ended) all answer 401 `{ error: "Not allowed" }`.

Where it listens: on the store's machine the kit starts it when `DATA_RUN_LISTEN` is set (`kit/README.md`, "The run
door"), over TLS with a cert from the kit's CA for `10.41.0.1`. A provider host (a slot of its node's execution host)
dials `https://10.41.0.1:8481` on its own node, which the guest guard lets through, and the node forwards it to the run
door (node 2's through node 1); TLS ends at the gateway. The host holds the token as its credential
`qorpera-company-data` and pins the kit's CA by its sha256 (`deploy/shared-execution/shared-execution.env.example`).

| Call | Body (with `pass`, and `texts` after a `need`) | Answer |
| --- | --- | --- |
| `describe` | `{ database? }` | `{ databases: [{ database, name, about, steps: { applied, waiting, changed, missing }, tables, questions: [{ name, words, parameters }], changes: [{ name, words, parameters }] }], companyBytes, limitBytes }` |
| `apply` | `{ database }` | as a member's `apply`; a held step is applied when the pass carries its `allow` (below), and then says `destroyed` |
| `apply` | `{ database, check: <allow> }` | `{ step, destroys }`, and nothing is applied: the held step named, which must be the next to apply, is run and rolled back, and both its text and what it would destroy must still be as `allow` says (else 409). It is what the member's card shows |
| `query` | `{ database, question, params? }` or `{ database, sql, params? }` | `{ columns, rows, more, asOf }` |
| `change` | `{ database, change, params? }` | as a member's `change`, the rows it gives back cut at an agent's 200 rows and 24 KiB |

**A member's yes for a held step.** `allow` is `<step>.<sha256 of its text>.<sha256 of what it destroys>`, counted
rows included. A step that destroys data is applied only for a run's pass that carries that very `allow`, which the
platform puts there for a member's Allow on the card of the agent's `data_apply` call that this run used
(`qorpera_run_data_pass_approved`, migration `20260930764000`; a plain pass names none). The gateway takes no word of the run's own for it (an
`allow` in a call's body is not read), a member's own `apply` holds the step as before, and a pass whose `allow` is for
another step, another text or other rows holds it again with the `allow` it has now. The same yes used again finds the
step applied.

A run's question or own read runs as a question does (the database folder's read login, read only, one statement), with
an agent's limits: 15 s, 200 rows and 24 KiB an answer, `more: true` past them. `:viewer` is the member who asked the run
unless the run names one in `params.viewer`. The watcher gives a read login's backend an agent's limit while the gateway
runs an agent's read on it, known by its pid.

**Who gets the list.** `rows`, a table's `watch` and the tables in `describe` are a member's when `database.toml`'s
`[list] members` is `"readers"` and the member may read `data/<database>/database.toml`, or when it is `"writers"`
(any other value, and a `[list]` it cannot read, counts as it) and the platform's `qorpera_member_folder_may_write` says the member may write
`data/<database>/` (kept 10 s). Without the line it is readers, unless a question file of the database
(`queries/*.sql`, as the member lists them) names `:viewer`, or cannot be read, or the listing does not fit the platform's one page of 1,000 entries: then writers. A platform without
`qorpera_member_folder_may_write` (it answers 404) lets nobody write, so a list for writers is shown to nobody.

A refusal is `{ error }` with its status: 400 (the call or the SQL), 401 (sign in), 403 (a table of a database whose
list is not the member's), 404 (no such question, change, table or
database that you may read), 405 (not POST), 408 (past the time limit, or no connection of the login's own came free in
it), 409 (no step applied yet, or a change's file is not the one that was shown), 413 (body too large), 429 (the
database's connections are taken), 507 (the company's database is at its size limit).

### Limits (`LIMITS`)

| Limit | Value |
| --- | --- |
| A question | 2 s, 2,000 rows, 256 KiB; past those rows or bytes the answer says `more: true` |
| An agent's question or own read | 15 s, 200 rows, 24 KiB, with `more: true` |
| A change | 5 s; what its statement sends back at most 1 MiB, else it is rolled back; the rows it gives back as a question's (a member) or an agent's |
| A step | 60 s, 5 s for a lock; an apply call starts no step after 45 s (`applyMs`) |
| A file | a question or a change 16 KiB, a step 64 KiB, 500 steps a database |
| A watch | 24 questions or tables, held 20 s, asked again at most every 500 ms |
| A page of `rows` | 100 rows, at most 200 (`pageRows`), within a question's 2 s and 256 KiB |
| A member's folder read | kept 10 s |
| A body | 1 MiB |
| A company's database | 1 GiB of its own data (without the record): the watcher closes its steps and its changes that write, questions still answer; `watchOnce` names a company past 80 % in `near` |
| The record of row changes | 100 MiB by its lines' bytes, the oldest go first (`qorpera_data.record_limit`) |
| A describe call's row counts | over within 1.5 s together (`countMs`), waits for a connection included; a table not counted shows `rowsAbout` or nothing |

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
