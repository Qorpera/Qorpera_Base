# The company data store kit

The company data store (`deploy/first-node/RUNTIME-COMPANY-DATABASES.md` §2) and its data gateway (§3) as one Docker
Compose project per machine, with WAL archiving, nightly base backups, a point-in-time restore and a streaming standby.
The store runs on a machine pair of its own (decided, §13 of that design). The kit asks little of a machine:
Docker, a folder of its own and a backup folder. It is proven by a drill on a test machine (below). Nothing of it is
installed anywhere yet.

## Files

| File | What |
| --- | --- |
| `docker-compose.yml` | `data-db`: PostgreSQL 17.6, the pinned image the SQL tests run on, data on a named volume, its port not published. `data-gateway`: the pinned Node 24 image running the packaged gateway (below) only if it matches its sha256, its port published on `DATA_GATEWAY_LISTEN` only. The settings it takes are listed at its top |
| `replication.yml` | the primary's machine only: the database's port on the machine's private address, for the standby |
| `run-door.yml` | the gateway's run door for agents' tools, published on `DATA_RUN_LISTEN` only. The scripts add it by themselves when `DATA_RUN_LISTEN` is set (`lib.sh`); a machine never names it |
| `postgres/postgresql.conf` | the whole server configuration: memory for 2 vCPU and 8 GiB (`shared_buffers` 2GB, `effective_cache_size` 5GB, `max_connections` 200), `wal_level replica`, archiving every 60 s at most, TLS, scram, and a log that never holds a parameter or a failed statement's text (an operator sees an error without its STATEMENT line) |
| `postgres/pg_hba.conf` | the superuser over the socket only; the gateway by address (the compose network); replication over TLS from the standby's address only (`hba-standby.conf`, written by `standby.sh allow`) |
| `postgres/archive-wal.sh`, `restore-wal.sh` | each finished WAL file to `/backup/wal/<name>.gz` (gzip, flush, rename, flush the folder), and back |
| `gateway-main.mjs` | the gateway's entry: settings from the environment, its secrets from one file each; it serves the gateway and starts its watcher (every 10 s) |
| `lib.sh` | what the scripts share, and the list of the gateway's secrets (`GATEWAY_PASSWORDS`, `GATEWAY_KEYS`) |
| `env.sh` | reads the kit's `.env` as docker compose reads it: quotes, a ` #` comment after an unquoted value, `export`; nothing is expanded |
| `tls.sh` | the kit's own CA, the server cert it signs, and the run door's cert (`tls.sh door`) |
| `init.sh` | the first start on an empty volume: secrets, CA and cert, `store/cluster.sql`, `store/template.sql`, the replication login, then the gateway. Refuses to run twice |
| `base-backup.sh` | a base backup into `base/<UTC>`, keeps the newest 7, removes WAL older than the oldest kept |
| `restore.sh` | a point-in-time restore into a new project: a base backup, the archived WAL up to a time, then promoted |
| `compose.sh` | `docker compose` for this machine with the files the scripts use (the `.env`'s `COMPOSE_FILE`, plus `run-door.yml` when `DATA_RUN_LISTEN` is set). Every compose command by hand goes through it: a bare docker compose would bring the gateway back without its run door |
| `run-door.sh` | `status`: whether the run door is on, or off and why (the gateway's own last word, the secrets, the port); `make`: what is missing of its secrets, for a machine whose kit came before the door |
| `standby.sh` | `allow`, `pack` and `unpack` (what the standby needs, from the primary's machine), `seed`, `status`, `promote` |
| `drill.mjs`, `drill/` | the drill, its compose overlay and a stand-in for the platform's API. Never on a machine (below) |
| `kit.test.mjs`, `.gitattributes` | the test that an archive of the kit leaves the drill out, and the rule that does it |

The scripts run as root and take every name and path from the environment, then from a `.env` beside
`docker-compose.yml` for what the environment does not set (the environment wins, as for docker compose). No node,
address or NAS path is written in them. They work from any current folder: a compose file or a folder named relative
in `.env` is the kit's (`lib.sh`), so a systemd unit that runs them from `/` finds everything.

### What never goes onto a machine

`drill.mjs`, `drill/` (its platform stand-in takes any token; `own-file.mjs`) and `kit.test.mjs`. `.gitattributes` marks them
`export-ignore`, so `git archive <commit> deploy/company-data/kit` leaves them out (`kit.test.mjs` checks that it
does). A machine gets the kit from such an archive, never from a working tree or a copy of the repository folder.

## The machine's folder (`DATA_LOCAL`, root only, 0700)

| Path | What | Needed to rebuild the machine |
| --- | --- | --- |
| `ca/ca.key`, `ca/ca.crt` | the kit's CA. The key is never mounted and never copied to the standby | yes, to renew the cert under the same pin |
| `secrets/gateway/*` | the gateway's secrets, one file each, the gateway's user's (65534), 0400 | yes: the same on the primary and the standby |
| `secrets/replication` | the replication login's password | yes |
| `secrets/superuser` | the superuser's password, read by initdb only; nobody logs in with it | no |
| `postgres/tls/` | the server's key (root, group postgres, 0640) and cert, and the CA's cert | yes (or a new one from `ca/`) |
| `secrets/run-door/` | the run door's `token` (43 base64url characters), `door.key` and `door.crt`, the gateway's user's (folder 0500, files 0400, the cert 0444) | the token yes: both nodes hold it; the cert can be made again from `ca/` |
| `postgres/hba-standby.conf`, `standby.conf`, `replication.pgpass`, `restore.conf` | written by `standby.sh` and `restore.sh` | no |

`secrets/gateway/` holds `admin`, `keeper` and `watch` (the store's three logins) and `folder-key` (32 random bytes as
hex). The folder key derives every database folder's own login password: it must be the same on the primary's and the
standby's gateway (`standby.sh pack` carries it), and a store whose folder key is lost needs every folder's password
set again.

## Running it on a machine

The primary's machine (node 1's):

```sh
cd /opt/company-data/kit          # the kit, beside ../store (init.sh runs its SQL), as in the repository
cat > .env <<'EOF'
COMPOSE_PROJECT_NAME=company-data
COMPOSE_FILE=docker-compose.yml:replication.yml
DATA_LOCAL=/opt/company-data/local
DATA_BACKUP=/mnt/nas/company-data       # a new, empty folder on the NAS
DATA_GATEWAY_LISTEN=127.0.0.1:8480
DATA_RUN_LISTEN=<this machine's private address>:8481   # the run door; leave it out and none listens
DATA_DB_LISTEN=<this machine's private address>:5432
DATA_PLATFORM_URL=https://api.qorpera.com
DATA_PLATFORM_KEY=<the publishable key>
DATA_GATEWAY_PACKAGE=/opt/company-data/gateway-package   # see "The gateway's package"
EOF
./init.sh data-primary.qorpera.internal data-standby.qorpera.internal
./standby.sh allow <the standby's address>
```

The standby's machine (node 2's), with the same kit and its own `.env` (without `replication.yml`, with its own
address in `DATA_RUN_LISTEN`, so its gateway opens the run door when it takes over):

```sh
ssh root@<primary> /opt/company-data/kit/standby.sh pack | ./standby.sh unpack
./standby.sh seed data-primary.qorpera.internal 5432
./standby.sh status
```

A take-over: stop the primary for good first (`./compose.sh stop` there, or the machine proven off), then on the
standby's machine `./standby.sh promote`. It promotes the store, forgets its upstream and starts its gateway with the
same secrets. The old primary is then seeded again as a standby from a new, empty volume.

A point-in-time restore, for a look or for a rebuild: a new project and folder in the environment, which win over the
kit's `.env`; the rest (the backup folder among it) comes from `.env`. `restore.sh` uses `docker-compose.yml` alone,
whatever `.env`'s `COMPOSE_FILE` says, so the copy never publishes a port and never starts a gateway:

```sh
COMPOSE_PROJECT_NAME=company-data-restore DATA_LOCAL=/opt/company-data/restore ./restore.sh latest '2026-11-13 02:00:00+00'
```

## The run door

Agents' tools call the gateway's run door (`../README.md`, "The run door"). With `DATA_RUN_LISTEN` set, the gateway
also listens on 8481 inside its container, over TLS only, and the port is published on `DATA_RUN_LISTEN` and nowhere
else (`run-door.yml`); without it nothing listens there and the gateway holds no run token.

`init.sh` makes `secrets/run-door/` whether or not the door is on (`lib.sh make_run_door`): the token from 32 random
bytes, never printed and never made again once it is there, and a cert from the kit's CA for the one name every
provider host dials: `10.41.0.1`, the `qorpera0` bridge's own address, the same on both nodes, where each node's
forward takes the call to the door (lanes: `nodework/road-run.md`). TLS ends at the gateway; the forwards pass TCP.
`standby.sh pack` carries the folder, so a promoted standby's door takes the same token.

A door that cannot start (a secret missing or unreadable) stays shut: the gateway still serves members and logs one
line, `data gateway: run door: off (<why>)`; `./run-door.sh status` shows it and exits 1. Every compose command by hand
goes through `./compose.sh`, which adds `run-door.yml` as the scripts do.

On a machine whose kit came before the door: `./run-door.sh make && ./compose.sh up -d data-gateway` (the CA must be
there: the primary's machine; a standby's door comes from `standby.sh pack`, so it needs a pack made after `make`).

**The token is the nodes' too.** Both nodes' exec staging holds a copy as the credential `qorpera-company-data`. A
primary rebuilt from its sealed copy of `DATA_LOCAL` must get the same `secrets/run-door/token` back (the sealed copy
must hold it); a new token means both nodes' staged tokens are stale, every agent's data call answers 401, and the
staging is redone before the next cut. The nodes' provider hosts
hold the token as their systemd credential `qorpera-company-data` and pin the kit's `ca/ca.crt` by its sha256
(`deploy/shared-execution/shared-execution.env.example`).

## Backups

As the design names them: WAL as each file finishes, at most 60 s apart (`archive_timeout`); a base backup every
night (`base-backup.sh`, as `~/work/dbhome`'s timer runs it at 02:17 UTC); the newest 7 kept, and WAL older than the
oldest kept removed, so a restore reaches back about 7 days. The standby streams over TLS with a slot; a standby that
falls more than 1 GiB behind loses its slot and catches up from the archive.

## The gateway's package

`scripts/package-company-data-gateway.mjs --out <new-folder>` bundles `gateway-main.mjs`, `gateway/gateway.mjs`,
`gateway/sql-text.mjs` and `pg` (as the lockfile pins it, 8.23.0) into one file, `qorpera-company-data-gateway.mjs`,
with `qorpera-company-data-gateway.mjs.sha256` beside it and a `manifest.json`, the way
`scripts/package-cloud-secret-broker.mjs` packages the secret broker. Its test is
`scripts/package-company-data-gateway.test.mjs`: the file runs alone, with no `node_modules`, and answers.

A machine gets it as it gets the other node services' packages: the release makes the folder from the release commit
and copies it to the machine (root's, 0755, the file 0644) at `DATA_GATEWAY_PACKAGE`. The container mounts that folder
read-only at `/app` and starts the file only if `sha256sum --check` passes. A new gateway is a new folder and
`./compose.sh up -d data-gateway`. The drill packages it the same way and runs it.

## The drill

```sh
node scripts/run-on-node.mjs --no-status --sudo -- node deploy/company-data/kit/drill.mjs </dev/null
```

Root (`--sudo`), because the scripts are. Three compose projects on one test machine stand in for the primary's node,
the standby's node and a restore; a local folder stands in for the NAS folder, one internal docker network for the
office LAN (`drill/drill.yml`), and a small server for the platform's API (`drill/platform-standin.mjs`, which takes
any token of the drill's one member: it proves nothing about the platform). Every container is capped, every published
port is on 127.0.0.1, nothing is pulled, and everything is removed at the end, also after a failure.

It proves: the gateway packaged into one file; (a) init, a second init refused, the settings, the secrets' modes, and the
gateway, started from the packaged file, making a company database through an `apply` call and answering a question;
(b) the database's port published nowhere, the gateway's on 127.0.0.1 only, the superuser refused over the network;
(e) a slow question and a failing one with a parameter logged without the value; (g) the run door: the secrets' modes,
the cert's one name `10.41.0.1` signed by the kit's CA, a call over TLS with the CA pinned and that name checked and the
right token reaching it (describe and a question), a pass that redeems to nothing, a wrong token and no pass all
answered 401 alike, a wrong token never spending the pass, a pass redeemed once, no trust without the CA, no plain
HTTP, the documented upgrade (`compose.sh up -d data-gateway` from `/`) keeping the door, a door whose token cannot be
read shut while members are served and `run-door.sh status` saying why, the same gateway without `DATA_RUN_LISTEN`
with no run door at all, the token in no log, and after the take-over
the promoted standby's door answering a run's question with every committed row; (c) rows, a base backup, rows, the
time, rows, then a restore to that time with exactly the rows up to it (count and hash); (d) a standby seeded over TLS
with a slot, streaming, a replication login without TLS refused, the primary stopped, the standby promoted, and its
gateway answering with every committed row; (f) nothing left. Every script runs from `/`. The primary's settings are in
the kit's `.env` alone, with a relative `COMPOSE_FILE`; the restore runs as the README's line does, with that `.env`
present.

It also checks: no company value in the database's log, while the server's own lines (start-up, checkpoints, a refused
superuser login) are there. What stays out: a parameter, a value a cast failed on, a row's value a constraint named, a
word in a slow statement's text, a word inside a company function that catches every cancel until the gateway's
watcher ends its backend, and the values of two of the company's sessions that wait on each other's row lock (a
deadlock). The company's database carries every setting the gateway's `LOG_SETTINGS` names (read from its code).
It also checks retention with KEEP=2 in a backup folder whose path has a space, removing only backups' own names, and
a WAL archive with a cut gzip trailer never acknowledged, then replaced.

Last result: 13 November 2026, a test machine, the run door's PR after review 2 (a status that answers with no
run-door folder, a lost key made again): 66 of 66 checks passed. Log: lanes
`company-databases-20261113/rundoor/drill-5.log`.

## Not done here

- **The machines.** Decided (Jonas, 13 November 2026; `deploy/first-node/RUNTIME-COMPANY-DATABASES.md` §13): the
  store runs on a machine pair of its own, the primary on node 1 and the standby on node 2, never inside the
  platform database's machine. Making the pair is not done: it needs `dbvm190.py`'s copy with new names, enrolment
  as infrastructure and a headroom change on both nodes before it starts. Each machine needs Docker with the two
  pinned images pulled, and the kit's files.
- **The node's road to the gateway.** The gateway listens on `DATA_GATEWAY_LISTEN`. Node 1's mux route for
  `/v1/company-data/` and, on a machine of its own, a NAT rule from the node to it are not written. The run door's
  road (each node's forward on `10.41.0.1:8481`, node 1's DNAT from node 2) is lane tooling, not in this kit.
- **The road between the machines.** `replication.yml` publishes the database on the primary's private address; the
  node's firewall must let only the standby's machine reach it (as `qorpera_dbhome`'s DNAT does for the platform's).
  The drill uses a shared docker network instead, so this road is not drilled.
- **The NAS folder.** A new, empty folder on the NAS mounted on both machines (a subfolder, as the platform's is),
  writable by uid 999. The drill uses a local folder.
- **Timers.** A systemd timer and service on the primary's machine for `base-backup.sh` nightly (as
  `dbhome-basebackup.timer`), and the restore drill run regularly. Not written.
- **The release step** that makes the gateway's package and copies it to the machine, and the gateway's own health
  and metrics.
- **A sealed copy of the machine's folder** (`DATA_LOCAL`): without its gateway secrets a rebuilt gateway cannot log
  in. Today it would be kept as the platform's are (`~/work/dbhome/SEALED-COPY.md`).
