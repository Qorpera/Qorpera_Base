# Company databases

Jonas, 13 November 2026, after the kits preview: "the main two points are that 1; you can't act very much inside of
the interfaces and 2; the numbers are never live. since we now host our own database, I think it's obvious that as
long as we build the tools needed for companies to build their own databases on our servers too, we should absolutely
be able to provide live numbers. if a company folder/file could contain databases that lived on our servers, and the
interfaces could then project those numbers/values we would have it. that's a top priority item too. or maybe a form
of API based model fits better - I just like having the entire company inside the company folder/files, aiming for
full centralization of data." And: "if qorpera itself was hosted on qorpera [...] I would want live models over the
server analytics, user analytics etc."

Contract: the 2026-11-13 amendment "company databases" (section 19). It is the amendment the 2026-10-02 amendment
"interfaces project company state from the company folder", item 4, left open for the table store ("The store has its
own amendment, which says where it runs"). This file is the technical design.

**Status: decided, not live.** Jonas answered all three decisions on 13 November 2026 (§13). Nothing is on production
or a node yet; the slices are built and proven on test machines (§11, §12).

## Words

- A **company database** is a folder of the company folder, `data/<name>/`. Its files say everything the database is.
  Its rows live in the company data store.
- The **company data store** is a PostgreSQL on Qorpera's own nodes that holds companies' rows and nothing else. It is
  not the platform's database and shares no server process with it.
- A **step** is a numbered SQL file that makes or changes tables. A **question** is a named read. A **change** is a
  named write. Together the questions and changes are the database's API.
- The **data gateway** is the one service that connects to the store. Every caller goes through it.
- A **notice** says that rows of a database changed. It carries no rows.

## 1. What is in the folder

```text
data/
  shop/
    database.toml              what it is, who reads it, who changes it
    tables/
      001-orders.sql           steps: applied once each, in number order
      002-customers.sql
    queries/
      sales-this-month.sql     a named question: one read, with named parameters
    actions/
      mark-shipped.sql         a named change: one write, with the words a member is shown
    snapshot/                  written by Qorpera every night (§7)
```

`data/` is a top-level folder of the company's own work, like its area folders: agents and members write it, and
Qorpera writes `snapshot/`. Nothing uses the name today, and the rule that agents may not define the old tables
(`layout_authoring`, `20260930510000`, newest form `20260930534000:426-428`) names only `QorperaOS/interfaces/` and
`QorperaOS/tables`, so it does not reach `data/` and is not changed.

A database's name is 1 to 40 characters of `a-z`, `0-9` and `_`, starting with a letter, and not `qorpera` or a name
starting with `pg_` or `qorpera_`. A question's or a change's name is 1 to 60 characters of `a-z`, `0-9` and `-`. A
step's name is three digits, `-`, then such a name.

### `database.toml`

```toml
format = "qorpera.database/v1"
name = "Shop"                        # what members see, up to 60 characters
about = "Orders and customers of the web shop"   # one line, up to 200

[list]                               # optional (§5a): who gets the tables as a list in the Data app
members = "writers"                  # "readers" (every member who may read the folder) or "writers"
```

A database exists when its `database.toml` exists. Who may read it and who may change its files is the folder's own
path authority for `data/<name>/`: every member reads the company's shared work and owners, admins and contributors
write it, unless a path resource says otherwise. The file names no readers of its own; `[list]` only says which of
the folder's readers get whole tables in the Data app (§5a).

### Steps, questions and changes

- **A step** (`tables/NNN-<name>.sql`, at most 64 KiB) is any SQL the database's owner role may run: tables, indexes,
  views, functions in SQL or PL/pgSQL, seed rows. Qorpera applies each step once, in number order, each in its own
  transaction, and records it. A step that fails changes nothing and stops the ones after it.
- **A question** (`queries/<name>.sql`, at most 16 KiB) is one read statement. Parameters are written `:name`. Its
  leading `--` lines say what it answers; agents and members see them in listings.
- **A change** (`actions/<name>.sql`, at most 16 KiB) is one write statement (a statement may hold several writes as
  `with` parts, or call a function a step made). Its leading `--` lines are the words a member is shown before they
  say yes, with each `:name` replaced by its value: `-- Mark order :id as shipped.`
- **Names resolve in the database's own schema.** A file writes `orders`, not `shop.orders`.
- **One parameter is Qorpera's.** `:viewer` is the id of the member looking. The gateway fills it from the member's
  proven token; a page that sends it is refused. This is how a question shows a member only their own rows. An
  agent, which may read everything in the database anyway, says which member it asks for.
- **Other parameters** are text, numbers, booleans or null, at most 16 a call and 4 KiB together. PostgreSQL decides
  their types from the statement.

```sql
-- What the shop sold since a day.
select count(*) as orders, coalesce(sum(amount), 0) as total
from orders
where placed_at >= :since;
```

### The files are plain files

Nothing in the folder core changes for them: no new structured kind, no save check, no index in the platform's
database. Qorpera learns a file's text this way:

- Every file of the folder has the sha256 of its bytes in its entry (`fileSha256`), and a read of the entry runs with
  the reader's own rights.
- A caller that wants a question asked names it. The gateway reads the file's entry **as that caller** and so learns
  two things at once: that the caller may read the file, and the hash of its live text.
- If the gateway does not hold a text with that hash yet, it asks the caller for it, checks the hash, and keeps it in
  the company's own database beside the rows. A text is trusted only because its hash is the live file's.

So the folder stays the one truth, the gateway never reads the folder with rights of its own, and a changed file is
live at the next call. What would have been a save check is enforced where a file is used:

| Refused | When |
| --- | --- |
| a name outside the rules above, a file over its size | at the call that uses it |
| a second statement in a question or a change, a write in a question | by PostgreSQL when it runs (§3) |
| a step that was applied and then changed, moved or deleted | at the next apply, which stops and says which; the folder's history holds the applied text to put back |
| a new step numbered below an applied one | at apply |

Anyone may write under `snapshot/`, and the next night's snapshot replaces it; nothing reads a snapshot as truth.

## 2. The company data store

### Where it runs

A machine pair made the way `db-primary` and `db-standby` were made (30 October, `dbvm190.py`): its own LXD project
and bridge on each node, enrolled as infrastructure before it starts.

| | Primary | Standby |
| --- | --- | --- |
| Name | `data-primary` | `data-standby` |
| Node | node 1, beside the door members' calls come in by | node 2 |
| Size | 2 vCPU, 8 GiB, 40 GiB on the node's NVMe pool | 2 vCPU, 8 GiB, 40 GiB |
| Software | PostgreSQL 17.6, the pinned image the SQL tests run on | the same, streaming |

Why this size and place: under today's rule (`standard_cpu_millis ≤ cpu − headroom`) node 1 has room for 2,000 mCPU
more infrastructure and node 2 for 4,000 (7 November numbers). The platform's own database uses 3 % of one core, and
no production table holds a row today. The pair grows by re-enrolment when companies' data does. Node 1 because the
front door is there already: losing node 1 stops the product either way, so it adds no new way to fail.

Why not inside `db-primary`: the contract keeps companies' rows out of the platform's database, and one heavy read
froze agents' runs on that database once (27 September). A machine of its own bounds a company's worst query in CPU,
memory and disk before it can touch the platform. A second server inside the same machine would share its disk and
its failover.

Cost: no money. It takes node 1's last free infrastructure room under today's rule, and 2,000 mCPU and 8 GiB of each
node's budget for agents' machines.

### One database per company

- Each company gets one PostgreSQL database, named `c_` and the 32 hex digits of its folder's id (the environment
  id the folder core keys by), made from a template. Each `data/<name>/` is one schema in it. Database names say
  nothing about whose they are: a login can list them.
- Three roles per database folder, each a login of its own: an owner role owns the schema and runs its steps, a
  write role runs its changes, a read role runs its questions. The gateway connects **as the folder's own role**, with
  a password it derives from one key it holds and stores nowhere. A session's login is then a member of no other
  role, so no statement can become another folder's role, another company's, or a stronger one of its own folder:
  PostgreSQL checks `SET ROLE` against the session's login, and a shared login that is a member of many roles would
  let a step switch to any of them. A question so reads its own database only; reading another of the company's
  databases from it comes later, with a check that the caller may read both.
- The gateway's own logins are three: `qorpera_data_admin` makes and drops company databases and folder roles and
  is used for nothing else; `qorpera_data_keeper` keeps the gateway's records beside the rows and listens for
  notices, and never runs a company's SQL; `qorpera_data_watch` reads sizes and ends statements.
- Connecting to a company's database is revoked from everyone and granted to its folders' roles, the keeper and the
  watcher only.
- The template holds the schema `qorpera_data`: the trigger that says a table changed, the triggers that record what
  a step destroys, and the event triggers that put both on every new table, whoever makes it. A table's owner can
  switch a table's triggers off, so further event triggers, which no company role can touch, refuse a statement at
  the moment it disables, drops, renames or replaces one of Qorpera's triggers: after such a statement every trigger
  of Qorpera's on the table must still be there and be the same as on Qorpera's own model table (its function, when
  it fires, its condition), switched on. A table that is not kept logged is refused too: its rows would be in no
  backup.
- A company's roles cannot read or write server files, run programs, add an extension, a C function, a database or a
  role, or change server settings (proven). Extensions come from a short list Qorpera installs when `database.toml`
  asks; none in the first slice.
- A company's sessions leave nothing in the store's log: no statement, no error with its text or context, no lock
  wait, also when the watcher ends one. The log is read by whoever runs the store, so it must hold no company's rows
  or SQL. These are settings of the company's database that no company role can change; the gateway answers the
  caller with PostgreSQL's message instead (the store kit's drill proves it on the real compose project).

### Limits per company

Defaults, in the gateway's configuration. They are starting values, not prices.

| Limit | Value | Enforced by |
| --- | --- | --- |
| Connections | 12 a company database, and 1, 2 and 3 for a folder's owner, write and read role | PostgreSQL (`CONNECTION LIMIT`); one past it is refused, other companies are not touched |
| A question from an interface | 2 s, 2,000 rows, 256 KiB | the gateway's transaction (`set local statement_timeout`), then the gateway |
| A read by an agent | 15 s, 200 rows and 24 KiB a page | the same |
| A change | 5 s | the same |
| A step | 60 s, 5 s for a lock | the same |
| Temp files | 256 MiB a statement | the company database's `temp_file_limit`, which no company role can lift |
| Memory | `work_mem` 16 MiB, no parallel workers | the company database's settings |
| Size | 1 GiB a company | the watcher: agents are told at 80 %; at 100 % writes close and reads go on |
| Calls | an app's bridge budget (120 a minute), and 50 statements a second a company | the web, then the gateway |

A limit a login could lift for itself (a statement timeout on a later direct connection) is backed by the watcher,
which ends what runs too long (proven).

### Backups, standby, removal

- WAL goes to a new, empty folder on the NAS as each file finishes, at most 60 s apart; a base backup every night,
  the newest 7 kept; the standby streams over TLS. The scripts are `~/work/dbhome`'s with the names as parameters. No
  copy leaves the office (Jonas, 12 November: no paid off-site storage now).
- The store is the second stateful machine pair beside the platform's database. Every other node service stays
  stateless.
- **Deleting a database's folder** drops its schema. That destroys data, so it waits for a member (§4).
- **Deleting or erasing the company** drops its database and roles when the company's deletion runs. The backups hold
  them until they age out, 7 days at most.

## 3. The data gateway

One small service of our own, `deploy/company-data/gateway/` (Node 24, `pg`, no other dependency). It runs beside
the store in the store's own machine, one compose project (`deploy/company-data/kit/`), as the app relay runs beside
the platform's database: so the store's port is published to nothing but its standby, and the machine shows only the
gateway. Node 1's mux sends `/v1/company-data/` to it. It is the only thing with a login to the store.

Not PostgREST: a PostgREST serves one database, so each company would need its own process, 36 to 55 MiB and 3 held
connections each, and it serves tables directly (§11, P1).

### Who calls, and what proves them

| Caller | Road | What proves them |
| --- | --- | --- |
| A member, from an interface app | the web page, then `member-company-gateway` on `api.qorpera.com`, then node 1's mux: `/v1/company-data/<company>/…` | the member's own token. The gateway begins each call as the member: `qorpera_member_folder_read_many` with the member's token and the publishable key, as the coding executor begins a look at a screen. Then it reads the store as itself. |
| An agent's run | a tool in the run's provider host (a slot of its node's execution host) dials one address on its own node, `https://10.41.0.1:8481`, which the guest guard lets through; the node forwards it to the gateway's run door on the store's machine (node 2's through node 1); TLS ends at the gateway. A run on an overflow machine (a one-run VM) has no data tools yet | the node's private token says "a host of ours"; a data pass says which run. The tool gets the pass from the platform as the run (`qorpera_run_data_pass`: 32 random bytes, only their hash kept, one use, 60 s, as the folder's view passes are); the gateway redeems it once. |
| Qorpera itself | the gateway's own timers | nothing leaves the service |

The gateway holds no service key and no login to the platform's database. Everything it asks the platform, it asks
as the caller. It keeps what a member's read said for 10 s.

**Whose rights.** A member may ask a database's questions when the folder lets them read the question's file. An
agent's access is its requester's access and its own grant, as everywhere in the folder
(`qorpera_folder_actor_resource_allowed`). Applying steps needs no more than reading them: a step that is live in the
folder was put there by someone the folder let write it, and applying it only makes the store match the folder.

### A question

1. The entry of `data/<db>/queries/<name>.sql`, read as the caller. Not readable or not there: refused, the same
   answer for both.
2. The text for the entry's hash, from the gateway's keep or from the caller (above). The gateway finds the `:name`
   parameters outside strings, quoted names, dollar quotes and comments, and sends the statement with numbered
   parameters through the extended protocol, so PostgreSQL refuses a second statement in the text.
3. One transaction on a connection logged in as the database folder's read role: `begin read only`, the time limit,
   the search path, the statement.
4. The answer: `{ columns, rows, more, asOf, etag }`. Rows are arrays in column order. Whole numbers and decimals a
   double holds exactly are JSON numbers, larger ones are text; booleans are booleans; JSON is JSON; times are ISO
   8601 text; everything else is text. `etag` is a hash of the answer.

An agent may also send a read of its own instead of a question's name. It runs the same way: one statement, read
only, as the read role.

### A step

Steps are applied when `apply` is called for a database: by an agent's `data_apply` (§6), in order, on a connection
logged in as the folder's owner role, one transaction each. A step runs inside a function, so it cannot end the
transaction and go on outside it. The caller lists the step files with their hashes as the folder gave them; the gateway
checks each entry as the caller and asks for the texts it does not hold.

1. The step runs. Then its deferred work runs at once (`set constraints all immediate`): a deferred trigger or
   foreign key would otherwise run at commit, after the check.
2. The triggers of `qorpera_data` have recorded what it destroyed: a dropped table, column or schema, deleted rows
   with their count, an emptied table, also when the delete sits inside a function. A column or table is recorded
   whether the step named it or it went with something else: a column whose type or domain was dropped with
   `cascade`, a table of a dropped schema. The gateway reads the record and **seals** the transaction in the same
   call. The seal is one way: anything that destroys data after it, also at commit (a deferred trigger that queues
   another), aborts the transaction, so nothing is destroyed that the check did not see.
3. If it destroyed nothing, it commits and is recorded as applied, with its hash, in the company's own database in
   the same transaction.
4. If it destroyed something, it is rolled back and **held**. The caller is told exactly what it would destroy, and
   an `allow` for exactly that: the step, the hash of its text and the hash of what it would destroy, counted rows
   included. In the first slices a held step stayed held. Since slice 7 it becomes an approval of contract 16.2 that
   only a member can give, never the reviewer and never a rule; with the member's yes the same step is applied:
   - An agent calls `data_apply` with the held step's `allow`. Before anything is asked, the gateway runs the step
     once more, keeps nothing, and says what it would destroy now (`check`); a step that is no longer held as the
     `allow` says is refused there. What the gateway said is what the member's card shows.
   - That call is always asked on a card. A denial by the reviewer stands; nothing else it says, and no rule, lets
     the step through.
   - The gateway trusts no word of the run's for the yes. The platform says it: the run's data pass carries the
     `allow` only when a member answered Allow on the card of this agent's call and this very run used that answer
     (`qorpera_run_data_pass_approved`, 20260930764000).
   - The gateway applies the step only for a pass that carries its `allow`, and only while the step's text and all
     it destroys are still what the `allow` says. A row more or less to delete is another yes: the step is held
     again with a new `allow`. Rows that change all the time are better deleted by a named change (§8).

Updating rows in a step is not "destroying": last night's snapshot and the WAL hold what was there.

### Notices

- Every table carries a statement trigger that calls `pg_notify` with the table's name. PostgreSQL sends a notice
  once per table per transaction.
- A page that shows live values keeps one call open through the member gateway: `watch`, with the questions it
  shows and the `etag` it holds for each. The gateway answers at once if an answer differs. Otherwise it listens on
  that company's database, asks the watched questions again when a notice comes, at most twice a second, and answers
  when one differs, or after 20 s with "the same". The page then calls again.
- The gateway listens on a company's database only while such a call is open.

Nothing of this touches the platform's database: a notice travels store, gateway, member gateway, page. The member
gateway's bridge answers whole replies and allows 25 s, which a 20 s wait fits. Each open page with live values holds
one such call; when held-open connections from a node to the browser exist (the screens' stream), the watch can
move there.

### The watcher

Every 10 s the gateway reads sizes and running statements with `qorpera_data_watch`. It ends a statement past its
limit, and closes a company's writes at its size limit: later, when a company's product has a login of its own (§9),
that login's write role is taken away and its open sessions ended (proven). Reads go on, and so do deletes through
the gateway, so a company can make room.

## 4. Who may do what

- **Agents make and change databases** by writing the files, as they write any of the company's work, and call
  `data_apply`. No member is asked.
- **What destroys data waits for a member**: a step that drops or empties a table, drops a column or deletes rows; and
  deleting a database's folder. A step is held and applied on a member's yes (§3, "A step"); deleting a database's
  folder is refused with its reason until its own part of slice 7.
- **Interfaces and, later, the public reach rows only through questions and changes kept as files.** They never send
  SQL of their own. Agents may ask any read, because they analyse. The one exception is the built-in Data app (§5a),
  whose statements the gateway writes itself.
- **Nothing is public** unless a file marks it public (slice 8).
- Who reads a database is the folder's path authority for `data/<name>/`. Finer than that is a question's own work,
  with `:viewer`; a database with such a question gives whole tables to its writers alone (§5a).

## 5. Interfaces: live values

The bridge of an interface app (`packages/web/src/app/interface-apps.ts`, `public/page-preview/index.html`) gains:

- `qorpera.query(name, params?)`: `name` is `<database>/<question>`. It gives `{ columns, rows, more, asOf }` with
  the viewer's own rights.
- `qorpera.watch(name, params, listener)`: asks once, calls `listener(answer)`, and calls it again only when the
  answer changed. It returns a function that stops it. A page never polls and never handles notices itself.
- `qorpera.act(name, params)` (slice 7): the bar above the page shows the change's own words; the member's yes runs
  it. It rejects, with the reason, as `setRow` does when the member says not now.

`app.toml` names what an app uses: `data` in `reads`, and each change it may ask for in `writes` as
`data:<database>/<change>`. A `query` costs one of the app's 120 calls a minute. All watches of the open company
travel in one held call, at most 24 questions; a watch costs the app one call when it starts.

**Kits.** Wherever a kit's data file takes a number it may take a binding instead:
`{"query": "shop/sales-this-month", "params": {"since": "2026-11-01"}, "column": "total"}`, where `params` and
`column` are optional and the default is the first column of the first row. As the proof's page did it: the bridge's
`read` of a kit's data file gives the file with each binding replaced by its current number, and the page's
`onChange` listeners are called with `{ data: true }` when a watched value changes, so an engine keeps reading its
data file and redrawing, and knows nothing of questions; the one change in an engine is to redraw at once for such a
change and not wait its ten seconds. Proposed to the interfaces lead on 13 November; the engines and what a kit's
data may say are that lead's.

Latency: the store and the gateway add about 3 ms from a commit to a new answer (§11, P2); the answer's way back
through `api.qorpera.com` adds the rest (a request on that road took 139 to 354 ms on 4 November).

## 5a. The Data app: a member's list (slice 10)

A member sees and keeps the company's data in a built-in app, **Data**, beside Mailbox and Bank: one table at a time
as a list of rows, in the client's own look. The founder picked the list on 15 November 2026 ("a database fits best
as a list") and answered "Yes, both" to members seeing and changing whole tables there (§13). The pictures are on the
design canvas "Company data view".

### What a member may do there

- **See.** A member who may read `data/<name>/database.toml` sees that database: its tables as tabs, every row of a
  table, and each question they may read as a list of its own beside the tables.
- **Change.** A member who may write `data/<name>/` may add a row, change a row and remove a row. Removing asks
  first, on the bar above the list. A member who may only read sees the list and no way to change it.
- **Who gets the list.** `database.toml` says it in `[list] members`: `"readers"`, every member who may read the
  folder, or `"writers"`, only those who may write it. Without the line it is readers, unless a question of the
  database names `:viewer`: then it is writers, because such a database shows each member their own rows, and whole
  tables would undo that. The gateway reads the questions for this itself, so no database depends on an agent
  remembering the line; an agent that means every reader to see all rows writes `"readers"`.
- **One rule for every road to whole rows.** `rows`, a table's `watch`, `changes` and the tables in `describe` all
  apply it: a member who does not get the list gets none of them (`describe` then names the database, its questions
  and its changes, and no table).
- This is the one exception to §4's rule that rows are reached only through questions and changes kept as files. It
  holds for this built-in app alone: the gateway builds every statement itself, from the store's own catalog. A
  page an agent wrote keeps §4, §5 and §8 as they are.

### The member's calls

At the gateway, beside `query`, `watch`, `apply`, `describe` and `change` (§3):

- **`describe`** with no database answers every database the member may read (the names from the member's own
  listing of `data/`). Each table gains its `kind` (table or view), its `key` (the primary key's columns) and, for
  each column, whether a member's edit may set it (not generated, not an identity kept by the store). Each database
  gains the questions and changes the member may read, with their words, and `write`: whether the member may write
  the folder.
- **`rows`** `{database, table, order?, after?, limit?}` reads one page: at most 200 rows (100 unless asked), within
  a question's 2 s and 256 KiB, as the folder's read login. It orders by the column named (the key otherwise) and
  then by the key, and answers `next`, the place the following page starts after, so a list pages by key and never
  by offset. Each row carries `seen`, a hash of the row as it was read. Only relations in the folder's own schema are
  read. A relation with no primary key (a view, or a table made without one) is listed and cannot be changed: it
  gives its first page alone, ordered by the column named or else as the store returns it, with `more` and no
  `next`. The list says so, and Ask reaches the rest.
- **`edit`** `{database, table, op, key?, values?, seen?}`, `op` one of `add`, `change`, `remove`. The gateway
  writes one statement from the catalog (identifiers quoted, every value a parameter cast to its column's type) and
  runs it as the folder's write login under a change's rules (§8: 5 s, the watched tables, the company's size). A
  `change` or a `remove` names the whole key and the row's `seen`: it touches exactly one row, and a row changed or
  gone since is refused (409) with the row as it is now. It answers the row as written.
- **`watch`** takes a table as it takes a question: the list hears the table's notices and reads its page again.
- **`changes`** `{database, after?}` reads the record below for that folder's own schema and no other, newest first,
  in pages, as the gateway's keeper: no folder login reads the record.

The edge function lets `rows`, `edit`, `changes` and `change` through for members (today it refuses `change`).

**The write right.** Nothing proves today that a member may write a path: the gateway proves reads alone. A new
platform call, `qorpera_member_folder_may_write(p_environment_id, p_path)`, answers for the signed-in member what
the folder core's own `qorpera_folder_member_allowed` says for `write`. The gateway asks it for `data/<name>/` and
keeps the answer as it keeps a read's proof (10 s).

### Who changed what

Today nothing records who changed a row. Every write road gets a record: a member's edit, a named change (from a
member, a run or a machine), and an applied step.

- **The rows.** A model trigger on every table of a database folder (with `changed` and `rows_gone`, so the watcher's
  check for unwatched tables covers it) writes what a statement added, changed or removed to
  `qorpera_data.row_changes(txid, seq, schema, relation, op, key, before, after, rows, bytes)`: a line a row, for a
  change the columns that differ, with the bytes the line holds. It fires once a statement, on its transition tables, not once a row. The function runs
  with the store's rights. `row_changes` and `change_log` are granted to no one: not to `public`, as the rest of
  `qorpera_data` is, and to no folder login, so neither a named change nor an agent's own read can read or write
  them, in its own folder or another's. Only the keeper does.
- **Bounded.** A statement that touches more than 1,000 rows of a relation leaves one line for it with the count
  (`rows`) and no row. A row with no key (a table made without one) is kept whole, with `key` null. The record is
  not counted in the company's 1 GiB: it has 100 MiB of its own, counted as the sum of its lines' `bytes` (never as
  the tables' size, which a removed line does not make smaller), and past that the oldest lines go first, so the
  record can never close a company's writes and never empties itself. So the company's size, wherever it is read (the watcher's look, which
  tells agents at 80 % and closes writes at 100 %, `describe`, a change's room), is the database's size less the record's two tables with their
  indexes and TOAST. The gateway reads the record's size on its keeper connection to that company's database: with
  each write, where it holds that connection for the actor's line, and for the watcher's look whenever a company's
  whole size is over 80 % of its limit, where the watcher first speaks: the tables can hold more than the lines'
  100 MiB (room kept from removed lines, row headers, indexes), so no band bounds them, and only a company that
  large pays for the look. The actor's lines
  are small, are not counted in the 100 MiB, and go with their rows' lines. Part b changes those three places.
- **The actor.** Before a write commits, the gateway writes `qorpera_data.change_log(txid, at, by_kind, by_id, via)`
  on its keeper connection: `by_kind` member, agent, machine or step; `via` the list, the change's or the step's
  name. The actor is never read from the transaction that writes rows, so a statement an agent wrote cannot name
  another actor. A write that rolled back leaves a line for a transaction the store calls aborted
  (`txid_status`); the watcher removes those lines and no others, so a write still running keeps its actor.
- Kept 30 days. The live store gets the tables and the trigger with the kit's `update-store.sh`, as slice 7 did.

"What changed" in the app reads this record: who, when, and each change as one plain sentence. The web names the
member or the agent from the lists it already holds.

### The app in the web

- An interface page `data` (the cloud's list of pages and its checks gain it; one migration), shown in the apps row
  when `describe` lists a database. Its emblem is a chest of drawers.
- The list: tabs for the tables and the kept questions, column heads that sort, a row that opens with its fields.
  A new row and a changed field are written as the member makes them: the member's own typing is the ask. Only a
  removal asks first, on the bar above the page, as `qorpera.act` will ask (§5, §8).
- **Ask.** The box under the list sends the question to an agent with the list it was asked on. The answer comes as
  that agent's message. "Keep as a list" has the agent write the question as a file (`queries/`), and it then shows
  beside the tables.
- Not in this slice: safe copies (going back a night and taking a copy home need slice 6's snapshot, a restore and
  an export, each with its own design), and a named change as a button on a row (slice 7c's `act`).

### Parts

| Part | What | Tests |
| --- | --- | --- |
| a | The platform: the page `data`, `qorpera_member_folder_may_write` (one migration) | an SQL test |
| b | The store and the gateway, reading: the record's tables and trigger, `describe` for a member, `rows`, a table's `watch`, who gets the list | the gateway's tests against a real PostgreSQL: a reader of a `:viewer` database gets no table by any road; no folder login reads the record, in its own folder or another's; a company whose record holds more than its free room still writes, also with the record's tables larger than 100 MiB, and its agents are told at 80 % of its own data, not the record's; a record past its 100 MiB keeps its newest lines; what the trigger costs a statement, against P2's |
| c | Writing: `edit`, the actor's line for every write road, the edge function's routes | the gateway's and the function's tests |
| d | The agents' instructions: what `[list]` is, and that a database with private rows says `"writers"` | the runtime's pin tests |
| e | The web: the page, the list, a row, an edit, a removal. It goes live only after b, c and d are | web tests; pictures at several widths, both themes |
| f | What changed: `changes`, and its view | the gateway's and web tests |
| g | Ask from the list, and "Keep as a list" | runtime and web tests |

**Part b as built** (`deploy/company-data/`, its README says each call's shape). Where it differs from the text above:

- **Three record triggers, not one.** PostgreSQL refuses transition tables on a trigger with more than one event, so
  the model carries `qorpera_record_add` (after insert), `qorpera_record_change` (after update) and
  `qorpera_record_remove` (after delete), each once a statement on its transition tables, all calling one function;
  the guard holds them as it holds the others (every table carries all six of the model's triggers, given by
  `qorpera_data.give_triggers` from the model itself). A `truncate` has no transition table and leaves no line; in a
  step it is held as before.
- **Where the 100 MiB is kept.** Each writing backend adds its lines' bytes to its own row of
  `qorpera_data.record_bytes` (no two sessions wait on one row). When a backend has written another 1/1024 of the
  limit, the statement sums the rows, and past the limit it removes the oldest lines until the sum fits, never the
  newest line. The limit is `qorpera_data.record_limit`, which no folder login reads or writes.
- **Whose rights the record runs with.** Not the store's: `qorpera_data.recorded()` and `keep_record()` belong to
  `qorpera_data_recorder`, which logs in nowhere and reads and writes only the record's lines and counters, since
  building a row's JSON can call code a company wrote (a cast to json). And every new cast to `json` or `jsonb` is
  refused (`qorpera_no_json_cast`); `update.sql` stops on a store that holds one, and runs as one transaction.
- **A change pairs rows by place.** An update's old and new rows are paired in the order PostgreSQL captured them; a
  change that changes no column leaves no line.
- **`describe` with a database** answers the same shape as without one, narrowed to it. `rows` also takes `desc`, and
  its answer names the `key`. `seen` is the sha256 of the row's text (`row::text`, UTC, ISO dates), so part c can
  compare it in the statement that writes. A row larger than a page gives an empty page with `tooLarge` and the
  `next` past it.
- **Who gets the list, at its edges.** A `[list] members` value other than `"readers"` counts as `"writers"`, and so
  does a `database.toml` that is not one key, one header or one comment a line with every value on its line (a
  multi-line string or array, an escaped key: the gateway reads that much of TOML and no more), a `database.toml` or a
  question file too large to read,
  and a `queries/` listing that does not fit the platform's one page of 1,000 entries. The gateway sees only the question files the member
  may list: a question hidden from a member by a path resource does not make the database writers-only for them.
  Until part a is live, the platform has no write check (404) and a writers' list is shown to nobody.
- **The 80 % warning.** The watcher's look answers `near` (companies past 80 % of their own data) beside `full`;
  agents read the same own size in `data_describe`'s `companyBytes`. Nothing else tells them yet.
- **Granted now for parts c and f:** the keeper reads `row_changes` and reads, adds and removes `change_log` lines, so
  the store is updated once. Keeping lines 30 days is not built.

**Part c as built** (`deploy/company-data/`, `supabase/functions/member-company-gateway/`). Where it differs from the
text above:

- **The edge function** lets `rows`, `edit` and `change` through, with 1 MiB for `rows` and `edit` (they may carry the
  question texts the list's rule reads) and 64 KiB for `change`. `changes` stays refused until part f builds it.
- **What cannot be changed** answers 400: a view (also for an add: an updatable view would take one), and a change or
  a removal in a table without a primary key, whose rows can still be added. A trigger of the company's that keeps a
  changed row as it was answers 409 in its own words; one that keeps an added row out, 400.
- **A value is cast to its column's type without its length or precision** (`varchar`, not `varchar(4)`): an explicit
  cast cuts a value that is too long where storing it refuses it, so the column's own rule decides.
- **The same row prints the same text.** `rows` and `edit` both set `intervalstyle`, `extra_float_digits`,
  `bytea_output` and `lc_monetary` beside UTC and ISO dates, because the write login may give itself other defaults
  (a role sets its own, through a function a step made and a change that calls it), and `seen` must not change with
  the login that reads the row. Questions and named changes keep the database's own settings.
- **The answers.** An add or a change answers `{ columns, key, row: { values, seen } }`, a removal `row: null`; a
  refusal for a row changed or gone since is 409 `{ error, row }` with the row as it is now, or null. A row larger
  than a question's 256 KiB answers its `seen` with `values: null` and `tooLarge`.
- **The actor's line is written when the write's transaction has begun**, before its statement runs, so a write that
  runs long has its actor all the while; a write that is refused after that leaves an aborted line for the watcher. A
  step's line names in `by_id` whoever's `apply` ran it (the member, the run or the machine); a held step's dry run
  (`check`) writes none.
- **How the watcher finds aborted lines.** At each look it reads the lines of the writes this gateway began and has
  not seen end; once an hour, and at its first look on a company's database, it reads every line, so a line left by a
  gateway that stopped is removed too, and one it finds running is read again at the next look.

## 6. Agents

| Tool | What |
| --- | --- |
| `data_describe` | the company's databases: tables and columns, questions and changes with their words, sizes against the limit, steps waiting, held or failed with the reason |
| `data_apply` | applies a database's waiting steps now and answers each step's outcome: applied, failed with PostgreSQL's message and place, or held with what it would destroy |
| `data_query` | a question by name with parameters, or one read of the agent's own; 200 rows and 24 KiB a page, with `more` |
| `data_change` (slice 7) | a named change with parameters |

Agents write the files with the folder tools they have. Each tool is a call to the gateway from the execution host
with the run's identity; none holds a database login. A program on an agent's machine uses the command `data` (§9a). The instructions tell an agent when a database is the right
home (many rows, numbers that change, a thing members act on) and when a file is.

## 7. The nightly snapshot

Every night Qorpera writes each database that changed since its last snapshot into its folder:

```text
data/shop/snapshot/
  snapshot.toml          when, each table's rows and files, how to load it back
  schema.sql             the shape as SQL
  sequences.sql          where each sequence stood
  orders/0001.csv        rows in key order, cut at fixed key values, at most 16 MiB a part
  orders/0002.csv
  customers/0001.csv
```

- **Every table is written, whole.** A table with a primary key is cut into parts at key values that stay fixed from
  night to night, so a usual day (new rows, edits among the newest) changes a few parts: 3 % of the bytes of an
  834 MiB table (§11, P4). A part past 32 MiB is cut in two. A table without a primary key is cut by its rows'
  place on disk; its parts are complete and may all change from night to night.
- **One moment.** A database's whole snapshot, its shape, its sequences and every part, is read in one transaction
  that sees one moment (`repeatable read`), however many rows are written meanwhile. Before that moment the
  transaction takes a share lock on every table of the database and holds it to the end, because emptying a table or
  rebuilding it is not held back by a moment alone: such a statement by anyone else waits until the snapshot is
  written. Rows are written and changed freely meanwhile.
- **Nothing waits for good.** The shape is read by `pg_dump` on the same moment, and `pg_dump` takes its own share
  locks. A statement that queued for a table after the snapshot's lock stands ahead of them: it waits for the
  snapshot, `pg_dump` waits for it, the snapshot waits for `pg_dump`, and PostgreSQL sees no deadlock in that. So the
  shape is read first, before any part, and `pg_dump` waits 2 s for a lock at most. When it gives up, the snapshot
  lets its tables go, the waiting statement goes through, and the snapshot starts again with a new moment; after 8
  tries it gives up for the night and says so. The same restart happens when a table is made or dropped between
  listing the tables and locking them.
- **Sequences.** `sequences.sql` puts each sequence where it stood, read from the sequence itself (its last value
  and whether that value was given out yet), so the first row made after loading gets a new number and not an old
  one. A sequence is not part of the one moment (PostgreSQL gives its newest value), so it may
  stand past the newest loaded row, never before it.
- The worst day, edits spread evenly over all history, changes every part. The folder keeps every version of a file
  for good, so **old versions under `data/<name>/snapshot/` are pruned after 7 days**, the way old versions of git's
  objects are (`20260928569140_folder_git_expiry`). The newest snapshot is always a full copy.
- The platform writes it as the platform, in commits of its own, and replaces whatever else is there.
- The folder then holds everything: the files that define the database and its rows as of last night. A database made
  from `schema.sql`, the parts and `sequences.sql` alone holds the same rows and takes new rows (proven). The steps
  stay the truth for the shape.
- Writing 932 MiB took 4 to 5 s on a test machine. A database at the 1 GiB limit is about 60 parts.

## 8. Named changes and routines (slice 7)

- `qorpera.act` and `data_change` run a change: the change's file read as the caller, one statement as the write
  role, 5 s. A member who may read a database may run its named changes; a database only some members may change is
  a folder only they may read.
  Deleting rows inside a named change is the company's own defined act and runs; the file says what it does.
- The statement is an insert, an update, a delete, a merge or a select that calls a function a step made, and nothing
  else. What it did is read before it is committed, as a step's is: a change that dropped or emptied a table or
  dropped a column (which the write role can only do through a function a step made as its owner) is rolled back,
  because that is a step's work and waits for a member. A change's transaction is not sealed as a step's is: a seal
  is a row kept for good, one for every change, and a change may delete rows anyway. The answer is
  `{ changed, columns, rows, more, asOf }`: how many rows the statement wrote, and what it gives back (`returning`),
  cut as a question's answer is. A statement that sends back more than 1 MiB is stopped and rolled back.
- A member's change from an interface is asked on the bar the platform draws, with the file's words and values. The
  gateway gives the bar the words with the values in place, each value apart from the words, every value the
  statement takes, and the file's hash; the member's yes runs the file with that hash and no other.
- A step or a folder delete that destroys data becomes a member's approval (§3).
- A routine may wake on a database: `when: data-change` with `watch: data/shop` and optionally a table. The gateway
  listens on a database a routine watches and turns a notice into a wake, claimed once, at most one a minute per
  routine; the run reads the rows with `data_query`.

## 9. The product's doors (slice 8)

- **A server's connection.** A company's server on a machine (`share_app`) gets a login to its own database,
  limited by the server itself and by the watcher (§2), handed over the way the app relay's link key is: never in a
  file an agent wrote.
- **Public questions and changes.** A file marked `public` in `database.toml` may be called from the company's site
  without a member, with its own rate limit.
- **Hooks into tables.** A verified delivery (RUNTIME-EVENT-INTAKE.md) is handed to a named change.

Each gets its own design before it is built.

## 9a. A command on a company machine (slice 8a)

An agent's own programs reach the company's databases. A company machine (`machine_start`,
`deploy/machine/README.md`) has the command `data`:

```text
data describe [<database>]
data apply <database>
data query <database> <question> [name=value ...]
data query <database> --sql '<one select>' [name=value ...]
data change <database> <change> [name=value ...]
```

It does what the agents' tools do (§6, §8), with an agent's limits, and prints the gateway's answer as JSON. A value
is text; `name:=<JSON>` gives a number, `true`, `false` or `null`. It ends 0 with an answer, 1 with a refusal (its
words on standard error), 2 for a call it cannot read, and 3 when the databases cannot be reached from this machine.
A script, a build or a server on the machine calls it as it calls any program. No database login and no key is in
the machine. A step that is held is held here too: its yes is asked through `data_apply` (§3), never from a machine.
`data change` is slice 7's named change (§8): this slice comes after slice 7 is on the store, and until then the
command has the other three verbs.

### Who the command is

- A machine's one identity is its folder view (RUNTIME-FOLDER-TEST-MACHINES.md): each boot whose starter's agent and
  member read the company folder's root has one open `test_machine` view, and the node serves it to that machine
  only. The command acts as that view: what it may read under `data/<name>/` is what the view may read. A machine
  without `/company` has no databases to reach, and `data` says so.
- So a program on a machine reaches the company's databases as it reaches the company's files, and no further.
  Root on the machine is the agent's, every command started there is reviewed as an outside effect (`machine_run`),
  and the files of every database folder are already in `/company`. What is new: a program there can read rows and
  run changes, where before it could only read and write the files that define them. A database in a folder the
  company-wide view does not show (a member's private folder) is not reached.
- `:viewer` is the member the view names (the starter's), unless the call names one, as for a run.

### The road

1. `data` is a subcommand of the folder program (`qorpera-folder data`: the Rust program that mounts `/company`,
   `crates/qorpera-folder`; `/usr/local/bin/data` runs it). It reads the boot's view from
   `/run/qorpera-folder/view.json` (root's, 0600: the machine gets no new secret), opens AF_VSOCK to the node
   (`2:5250`) and says hello in a new role, `data` (protocol 5), as the `notices` role does: it mounts nothing, and no
   view is opened or held for it.
2. The node's bridge names the machine behind the connection (its CID, asked of LXD), as for every hello. The folder
   service takes a `data` hello only for a view it serves to that very machine now: a `test_machine` view, the
   caller its machine, the pass's hash the view's. Anything else gets the one refusal a hello has.
3. A request is one frame, `{verb, body}`, at most 1 MiB: the `data` role alone takes a request that large (any
   other role's requests stay at 64 KiB). The folder service asks the core for a data pass as the view (below) and
   sends the body with the pass to the gateway's run door on its own node, with the node's token and the kit's CA
   pinned, as a provider host does for a run (§3). The answer goes back as one frame, so it is at most 1 MiB (a
   frame holds 2 MiB); a larger one is refused with words that say to name one database.
4. The gateway redeems the pass: it names the company, the member and each file the view may read under the
   database's folder, with its hash. When the gateway asks for a file's text (`need`), the command reads it from
   `/company` and sends the call again. A text counts only by its hash, so nothing a machine sends is trusted. A
   file written a moment ago is used once it is saved to the folder (about two seconds after its last change): the
   command asks again for up to 10 s.

**What a machine read is recorded.** Rows and a file's words leave the folder by this road, and a machine's output
reaches models, so the road keeps RUNTIME-FOLDER-TEST-MACHINES.md's rules for reads ("Reads", rules 1, 3 and 4). The
pass answers, beside itself, the entries it kept as the view read them. Before an answer frame leaves, the folder
service records as reads served under the view, in memory, the files whose rows or words that answer can show:
`data/<name>/database.toml` of each database it shows, and the question's, the change's or the steps' files the call
used (for a describe, the questions' and changes' files whose words it lists). They are released as every recorded
read of the machine is: before any boundary is answered and before any save of the machine commits. So a run that is
handed a command's output with rows in it has taken in the read of that database, and output whose reads are no
longer readable to the run is held back, as for a file read through `/company`.

**What a machine writes is not a save of the folder.** A change and an applied step write rows, not files: they are
not credited to a command and do not recheck the view's read set, as a commit does. They need the view to be valid
and to read the change's or the step's file at that moment, which the pass proves. What a program learned earlier
and writes into a row is not followed, as a copy on the machine's disk is not.

The folder service gains two credentials on the node host, each a systemd credential of its own: the run door's token
and the CA's pin, as the provider hosts hold them. It forwards nothing but the four verbs with a JSON body. Whether
the node host itself reaches the run door's forward (it listens on the node's own `qorpera0` address for the provider
hosts) is read on a node before this is built; if it does not, the folder service gets a forward of its own.

### The pass

- `qorpera_machine_data_pass(p_environment_id, p_actor, p_database)` (migration `20260930775000`), for the service
  role: `p_actor` is
  `{"kind":"view", viewId, pass}`, and the view must be an open, valid `test_machine` view. It lists and keeps the
  files as `qorpera_run_data_pass` does (one listing, used by both), as the view may read them now, with the view,
  its machine, its agent and its member. `qorpera_data_passes.kind` gains `machine`; such a pass names no run and no
  job. It answers the pass and the entries it kept (above). It is refused while the company's execution is paused,
  as a run's pass is: a machine that keeps running through a pause reads and writes no rows.
- `qorpera_data_pass_redeem` answers a machine's pass once, within its 60 s, while its view is open and valid, with
  `kind: "machine"`. The gateway takes it at the run door as it takes a run's, with an agent's limits. A machine's
  pass never carries an `allow`.

### Limits

- At the folder service, a machine has 4 calls at once and 120 a minute; past them a call is refused at once and may
  be made again. 120 a minute is an interface app's (§5). 4 at once is half an app's 8: a database folder's read
  login holds 3 connections and its write login 2 (§2), so more at once would only wait for them. A body and an
  answer are at most 1 MiB each, a call 30 s (an apply 120 s).
- Each call makes a pass, and a pass lists the database's folder in the platform's database. That cost is what the
  120 a minute bound. A server that asks many times a second needs the direct connection of §9, or a pass that serves
  a machine for a short while. Neither is in this slice.
- The gateway's own limits hold as for a run: an agent's time, rows and bytes; a folder's logins and connections.

### What it does not do

- It gives no yes for a held step and deletes no database folder.
- It adds no listener in a machine and none on a node: the folder service stays the one host service on vsock, and
  `security.devlxd` stays off.
- The Company Computer's desktop (`computer_shell`) and a coding session's machine get no `data` in this slice: only
  a company machine's view is taken.
- No call is reviewed by itself. Starting a command on a machine is; what the command then writes, to the folder or
  to rows, is the command's.

### Parts and rollout

| Part | What | Tests |
| --- | --- | --- |
| 1 | The machine's pass and its redeem (one migration); the gateway takes a `machine` pass | an SQL test, with a paused company's pass refused; the gateway's tests against a real PostgreSQL |
| 2 | The folder service's `data` role: the hello's check, the limits, the reads it records, the run door's client, the two credentials | the folder service's tests, with a stand-in door |
| 3 | The folder program's `data` subcommand and its build record; the machine image with `/usr/local/bin/data`; one sentence in the agents' instructions | the program's tests; the image script's own checks |
| 4 | A proof on a test machine: a machine in a nested VM asks, changes and applies; a second machine with another view is refused; a `machine_run` whose output holds rows takes the database's read into its run | `scripts/` proof, on a test machine |

The parts build on slice 7: `change`, and the proof's change, need slice 7's gateway on the store. A release rolls the
migration, a later gateway on the store's machines, the node release with the folder service and its two credentials,
the folder program's new build (its pin moves wherever it runs) and the machine image. With part 2,
RUNTIME-FOLDER-TEST-MACHINES.md gains two sentences: in "The security line", that a machine reaches the company's
databases through its one view; in "Reads", that what the `data` role answers is recorded as the view's reads.

## 10. Qorpera's own data (slice 9)

What Qorpera already holds about a company (bank transactions, mail, todos, agents, usage) appears in the company's
database as read-only tables in the schema `qorpera`, copied one way, so one question joins money, work and sales.
Then Qorpera's own numbers on Qorpera.

## 11. Proofs

On a test machine, 13 November 2026, each against a throwaway PostgreSQL 17.6 capped at 2 CPUs and 4 GiB. Scripts:
`deploy/company-data/proof/` (P1 to P4 here; the end-to-end run with the gateway's slice). Nothing touched production
or a node.

| | What | Result |
| --- | --- | --- |
| P1 | one gateway of our own against a PostgREST per company, 50 company databases | ours: a call p50 1.5 ms, p95 2.8 ms, 142 MiB for all 50, idle connections given back. PostgREST: p50 1.1 ms, 36 to 55 MiB and 3 held connections for each company |
| P2 | a notice | commit to a new answer at the page p50 1.7 ms, p99 2.9 ms over 200 rows, every answer right; 10,000 rows in a statement give one notice; the trigger costs a writer about 10 microseconds |
| P2b | what the record's triggers cost a statement (slice 10 part b, `gateway.test.mjs`, a fresh database from the template, 15 November 2026) | a statement on a table with all six triggers against one with the two of before (notice, deleted rows) and one with none, in microseconds a statement: one row inserted 101 / 13 / 10, changed 151 / 22 / 24, removed 167 / 29 / 12; 100 rows inserted 766 / 181 / 97, changed 1,412 / 349 / 185, removed 673 / 62 / 38. So the record costs a statement about 90 to 150 microseconds and a row about 6 to 11 more, linear in its rows up to the 1,000-row cut |
| P3 | limits and walls, 135 checks | all pass. No company reaches another's database, role or statements. Inside a company, a session logged in as one folder's read, write or owner role cannot take another folder's role, read or write its rows, or reach it through `set_config` and a function of its own (39 tries, all refused, the other folder's rows unchanged). Connection, time and temp file limits hold. A read cannot write. A step that disables, drops, renames or replaces one of Qorpera's triggers, makes an unlogged table or says `commit` fails and leaves the rows as they were; deleted rows (also by a cascade, by `merge`, inside a function and by a deferred trigger), an emptied table and a dropped column, table or schema (also a column that goes with its type or domain) are recorded, so the step is held, and it lands after a yes. A deferred trigger that queues a second one to delete after the check aborts the commit; a step whose deferred work only inserts lands |
| P4 | the snapshot of a 1,020 MiB database, written to files and loaded back, 29 checks | 932 MiB in 60 parts in 7.1 s, one given-up lock wait and two restarts included (a quiet night: 4.5 s), while another connection committed 1,071 transactions (new rows, keys moved from a late part into an early one, deletes): the database made from the files alone equals what the export's own transaction saw and what a second connection counted at that moment, each moved row in it once at its old key. The export holds its tables: a truncate, a rewrite and a drop by another session each waited until it was done, then completed, and the files hold those tables' rows as of the moment; a table made between the list and the locks makes the export start again. A truncate queued before the shape was read did not lock the export: `pg_dump` gave up its lock wait after 2.1 s, the export let go, the truncate went through 6 ms later, and the next try's snapshot holds that table empty. A table without a key of 102 MiB came back whole from 8 parts read by their place on disk. Every sequence gives next what the source gives next (after `setval` with and without `is_called`, never used, an identity's, one no column owns). A usual day changes 2 of 51 parts of an append-mostly table (3 %), the worst day 50 of 51; loaded back in 14 s |
| E2E | the whole road for a member (`proof/e2e.mjs`, which arrives with the gateway's slice): the platform's database as the migrations build it with a test company's folder, a real PostgREST in front of it, the store, the gateway | 44 of 44 checks: database folders committed through the folder core, steps applied from the files by hash, members asking named questions with their own tokens (a stranger, a forged token and a folder private to another member refused), steps that destroy, fail or try to end the transaction not landing, a changed file used at the next read, and a held watch call answering a new row in 0.9 ms (p50) at the gateway. A model kit page with two bound values showed each new row without a reload |

## 12. Build order

Each slice is one reviewable PR with its migration, its tests and what a release rolls. Numbers are reserved in the
registry when a slice starts.

| Slice | What | Migrations and tests | A release rolls |
| --- | --- | --- | --- |
| 1 | The amendment and this design | none | nothing |
| 2 | The store: the machine pair, PostgreSQL, the template, roles, limits, backups, the standby | none; `deploy/company-data/store/` and `deploy/company-data/kit/` with a drill of the backup, the restore and the take-over on a test machine | both nodes: enrolment, then the machines; the same drill there |
| 3 | The gateway for members: questions, apply, the held watch, limits, the watcher; the member gateway's route | none; `deploy/company-data/` with tests against a real PostgreSQL in `changed`; function tests | the kit on the store's machines, node 1's mux route, the edge function |
| 4 | Interfaces: `query` and `watch` in the bridge, bindings in the kits | none; web tests | the web |
| 5 | Agents: the run's data pass, `data_describe`, `data_apply`, `data_query`, their instructions; removal with the company | one migration (the pass, the tools' names in the observation list, the removal's call), one SQL test | the migration, a runtime bundle and image, the node release |
| 6 | The nightly snapshot and the 7-day rule for its old versions | one migration, one SQL test | the migration, the node release |
| 7 | Named changes: `act`, `data_change`, the member's approval for what destroys, routines on a change. Built in parts: (a) the gateway's `change` call and `data_change`; (b) the member's approval for a step that destroys; (c) `act` and the bar; (d) routines on a change | a migration and an SQL test for each of (a) and (b) | bundle, node release, a later gateway on the store's machines, web |
| 8 | The product's doors, each after its own design | | |
| 8a | The `data` command on a company machine (§9a), in four parts, after slice 7 | one migration, one SQL test; the gateway's, the folder service's and the folder program's tests; a proof on a machine | the migration, a later gateway, the node release (the folder service and its two credentials), the folder program and the machine image |
| 9 | Qorpera's own data as tables | | |
| 10 | The Data app (§5a): a member's list of rows, in seven parts. Numbered after 9 and built before it | one migration, one SQL test; the gateway's, the function's, the runtime's and web tests | the migration, the store's update and a later gateway, the edge function, a runtime bundle, the web |

Slices 2 to 5 together are "live reads": a fresh company's agents make a database and an interface shows its numbers
live. Slice 6 follows at once, since the contract asks for the snapshot. Before slice 3 is cut, the whole path runs
on a test machine first. Live reads change nothing in the platform's database but slice 5's one migration.

## 13. Decisions (Jonas, 13 November 2026)

1. **A second PostgreSQL on the nodes for companies' rows.** To "Put a second Postgres on your nodes for companies'
   data?" he answered "Yes, go". Its shape, put to him with its cost (no money; node 1's last free infrastructure
   room and 2 CPUs of each node's machine budget): **a small machine pair of its own** (§2), not a second server
   inside the platform database's machine.
2. **Agents create and change databases themselves; only what destroys data waits for a member** (§4).
3. **Interfaces and the public reach rows only through named questions and changes kept as files; agents may ask any
   read** (§4).

To 2, 3 and the shape in 1, each put with a recommendation of yes, he answered: "Yes, all three".

**14 November 2026.** He asked whether agents have the tools to set up and manage their databases that they would
have on a hosted database service, and whether they have them as commands. They had three tools, as calls a model
makes, and no command; rows changed only through a new step, a held step could never be applied, and nothing a program
on an agent's machine ran could reach a database. To the order put to him (writing rows and a member's yes for a held
step, slice 7; then a `data` command on the agent's machine with the same reach as the tools, §9a; later a server's
direct connection, §9, and export and restore) he answered: "Yes, build them".

**15 November 2026.** He asked whether members have the views of their databases that a hosted database service
gives. They had none: pages show live numbers, and the files are in the company folder. Shown three ways in on a
design canvas (shelves of the company's own things, a flow of where data comes from and goes, one list), he picked
the list: "C, a database fits best as a list". To "May members see and change whole tables in the Data list?", put
with a recommendation of yes to both (see: a member who may open the database's folder sees all rows of its tables;
change: a member who may write there may add, change and remove rows, each change recorded with who did it, a removal
asked first; pages that agents build keep decision 3), he answered: "Yes, both". §5a is that design. It amends
decision 3 for the built-in Data app alone.

## 14. Not in this design

- Today's small tables (`QorperaOS/tables/`, CSV files of at most 64 KiB) stay as they are. No production table holds
  a row; moving one into a database later is a step and a copy.
- Rights finer than a database, set outside a question: none. A question does it with `:viewer`, and §5a keeps such a
  database's whole tables with its writers.
- A column store for heavy analytics. The folder shape does not name the engine, so one can sit behind the same
  files later.
- Prices for a company that outgrows its limits.
- A copy outside the office.
