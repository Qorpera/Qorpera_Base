# The company data store kit

The company data store (`deploy/first-node/RUNTIME-COMPANY-DATABASES.md` §2) and its data gateway (§3) as one Docker
Compose project per machine, with WAL archiving, nightly base backups, a point-in-time restore and a streaming standby.
It is the same whether the store gets a machine pair of its own or runs inside the platform database's machine: it
needs Docker, a folder of its own and a backup folder. It is proven by a drill on a test machine (below). Nothing of
it is installed anywhere yet.

## Files

| File | What |
| --- | --- |
| `docker-compose.yml` | `data-db`: PostgreSQL 17.6, the pinned image the SQL tests run on, data on a named volume, its port not published. `data-gateway`: the pinned Node 24 image running `gateway-main.mjs`, its port published on `DATA_GATEWAY_LISTEN` only. The settings it takes are listed at its top |
| `replication.yml` | the primary's machine only: the database's port on the machine's private address, for the standby |
| `postgres/postgresql.conf` | the whole server configuration: memory for 2 vCPU and 8 GiB (`shared_buffers` 2GB, `effective_cache_size` 5GB, `max_connections` 200), `wal_level replica`, archiving every 60 s at most, TLS, scram, and a log that never holds a parameter's value |
| `postgres/pg_hba.conf` | the superuser over the socket only; the gateway by address (the compose network); replication over TLS from the standby's address only (`hba-standby.conf`, written by `standby.sh allow`) |
| `postgres/archive-wal.sh`, `restore-wal.sh` | each finished WAL file to `/backup/wal/<name>.gz` (gzip, flush, rename, flush the folder), and back |
| `gateway-main.mjs` | the gateway's entry: settings from the environment, its secrets from one file each |
| `lib.sh` | what the scripts share, and the list of the gateway's secrets (`GATEWAY_PASSWORDS`, `GATEWAY_KEYS`) |
| `tls.sh` | the kit's own CA, and the server cert it signs |
| `init.sh` | the first start on an empty volume: secrets, CA and cert, `store/cluster.sql`, `store/template.sql`, the replication login, then the gateway. Refuses to run twice |
| `base-backup.sh` | a base backup into `base/<UTC>`, keeps the newest 7, removes WAL older than the oldest kept |
| `restore.sh` | a point-in-time restore into a new project: a base backup, the archived WAL up to a time, then promoted |
| `standby.sh` | `allow`, `pack` and `unpack` (what the standby needs, from the primary's machine), `seed`, `status`, `promote` |
| `drill.mjs`, `drill/` | the drill, its compose overlay and a stand-in for the platform's API |

The scripts run as root and take every name and path from the environment (or a `.env` beside
`docker-compose.yml`): no node, address or NAS path is written in them.

## The machine's folder (`DATA_LOCAL`, root only, 0700)

| Path | What | Needed to rebuild the machine |
| --- | --- | --- |
| `ca/ca.key`, `ca/ca.crt` | the kit's CA. The key is never mounted and never copied to the standby | yes, to renew the cert under the same pin |
| `secrets/gateway/*` | the gateway's secrets, one file each, the gateway's user's (65534), 0400 | yes: the same on the primary and the standby |
| `secrets/replication` | the replication login's password | yes |
| `secrets/superuser` | the superuser's password, read by initdb only; nobody logs in with it | no |
| `postgres/tls/` | the server's key (root, group postgres, 0640) and cert, and the CA's cert | yes (or a new one from `ca/`) |
| `postgres/hba-standby.conf`, `standby.conf`, `replication.pgpass`, `restore.conf` | written by `standby.sh` and `restore.sh` | no |

When the gateway's change to per-folder logins lands (the lead's note of 13 November), `secrets/gateway/` holds
`admin`, `keeper`, `watch` and `folder-key`. The folder key derives every database folder's login password: it must be
the same on both gateways, and a store whose folder key is lost needs every folder's password set again.

## Running it on a machine

The primary's machine (node 1's):

```sh
cd /opt/company-data/kit          # the kit, beside ../gateway and ../store, as in the repository
cat > .env <<'EOF'
COMPOSE_PROJECT_NAME=company-data
COMPOSE_FILE=docker-compose.yml:replication.yml
DATA_LOCAL=/opt/company-data/local
DATA_BACKUP=/mnt/nas/company-data       # a new, empty folder on the NAS
DATA_GATEWAY_LISTEN=127.0.0.1:8480
DATA_DB_LISTEN=<this machine's private address>:5432
DATA_PLATFORM_URL=https://api.qorpera.com
DATA_PLATFORM_KEY=<the publishable key>
DATA_NODE_MODULES=<see "The gateway's package">
EOF
./init.sh data-primary.qorpera.internal data-standby.qorpera.internal
./standby.sh allow <the standby's address>
```

The standby's machine (node 2's), with the same kit and its own `.env` (without `replication.yml`):

```sh
ssh root@<primary> /opt/company-data/kit/standby.sh pack | ./standby.sh unpack
./standby.sh seed data-primary.qorpera.internal 5432
./standby.sh status
```

A take-over: stop the primary for good first (`docker compose stop` there, or the machine proven off), then on the
standby's machine `./standby.sh promote`. It promotes the store, forgets its upstream and starts its gateway with the
same secrets. The old primary is then seeded again as a standby from a new, empty volume.

A point-in-time restore, for a look or for a rebuild: a new project and folder, the same backup folder:

```sh
COMPOSE_PROJECT_NAME=company-data-restore DATA_LOCAL=/opt/company-data/restore ./restore.sh latest '2026-11-13 02:00:00+00'
```

## Backups

As the design names them: WAL as each file finishes, at most 60 s apart (`archive_timeout`); a base backup every
night (`base-backup.sh`, as `~/work/dbhome`'s timer runs it at 02:17 UTC); the newest 7 kept, and WAL older than the
oldest kept removed, so a restore reaches back about 7 days. The standby streams over TLS with a slot; a standby that
falls more than 1 GiB behind loses its slot and catches up from the archive.

## The gateway's package

In the drill the gateway's container mounts `deploy/company-data/gateway/`, `gateway-main.mjs` and the repository's
own `node_modules` (which holds `pg` 8.23.0, as `packages/runtime` pins it). On a machine there is no repository.
The node release will bundle `gateway-main.mjs` with `gateway.mjs` and `pg` into one file with esbuild, as
`scripts/package-cloud-secret-broker.mjs` bundles the secret broker, and the container then mounts that one file and
no `node_modules`. That script is not written yet.

## The drill

```sh
node scripts/run-on-node.mjs --no-status --sudo -- node deploy/company-data/kit/drill.mjs </dev/null
```

Root (`--sudo`), because the scripts are. Three compose projects on one test machine stand in for the primary's node,
the standby's node and a restore; a local folder stands in for the NAS folder, one internal docker network for the
office LAN (`drill/drill.yml`), and a small server for the platform's API (`drill/platform-standin.mjs`, which takes
any token of the drill's one member: it proves nothing about the platform). Every container is capped, every published
port is on 127.0.0.1, nothing is pulled, and everything is removed at the end, also after a failure.

It proves: (a) init, a second init refused, the settings, the secrets' modes, and the gateway making a company database
through an `apply` call and answering a question; (b) the database's port published nowhere, the gateway's on
127.0.0.1 only, the superuser refused over the network; (e) a slow question and a failing one with a parameter
logged without the value; (c) rows, a base backup, rows, the time, rows, then a restore to that time with exactly the
rows up to it (count and hash); (d) a standby seeded over TLS with a slot, streaming, a replication login without TLS
refused, the primary stopped, the standby promoted, and its gateway answering with every committed row; (f) nothing
left.

Last result: 13 November 2026, node02's test machine, against the gateway and SQL files of commit 3eaac5135: 31 of
31 checks passed in 89 s. Init 13.5 s, apply 0.2 s, base backup 1.0 s, restore 2.8 s (to the time, promoted), standby
seed over TLS 2.9 s (streaming 3 s after the start, replay lag 18 ms), promote and the gateway answering 7.0 s.

## Not done here

- **The machines.** A machine pair (§2) or the platform database's machine: the choice is open. A pair needs
  `dbvm190.py`'s copy with new names, enrolment as infrastructure and a headroom change on both nodes before it
  starts. Either way the machine needs Docker with the two pinned images pulled, and the kit's files.
- **The node's road to the gateway.** The gateway listens on `DATA_GATEWAY_LISTEN`. Node 1's mux route for
  `/v1/company-data/` and, on a machine of its own, a NAT rule from the node to it are not written.
- **The road between the machines.** `replication.yml` publishes the database on the primary's private address; the
  node's firewall must let only the standby's machine reach it (as `qorpera_dbhome`'s DNAT does for the platform's).
  The drill uses a shared docker network instead, so this road is not drilled.
- **The NAS folder.** A new, empty folder on the NAS mounted on both machines (a subfolder, as the platform's is),
  writable by uid 999. The drill uses a local folder.
- **Timers.** A systemd timer and service on the primary's machine for `base-backup.sh` nightly (as
  `dbhome-basebackup.timer`), and the restore drill run regularly. Not written.
- **The gateway's package** (above), and the gateway's own health and metrics.
- **A sealed copy of the machine's folder** (`DATA_LOCAL`): without its gateway secrets a rebuilt gateway cannot log
  in. Today it would be kept as the platform's are (`~/work/dbhome/SEALED-COPY.md`).
