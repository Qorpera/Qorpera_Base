# Folder service and folder program: install

Design, protocol, security and acceptance: `deploy/first-node/RUNTIME-FOLDER-SERVICE.md`. This page is the
install reference. Every node and machine step is the coordinator's, at a cut.

## Files

| File | Where it runs | What it is |
| --- | --- | --- |
| `qorpera-folder-service.cjs` | node host, `qorpera-objects` (a drop-in; see "Reading the objects") | The folder service (from `packages/object-gateway/src/folder-service/`). Holds the service credential; never talks to LXD. |
| `qorpera-folder` | node host (`bridge`), machine (`mount`) | The folder program (from `crates/qorpera-folder/`), built by `scripts/build-folder-program.mjs`; its recorded build is `folder-program-linux-x64.json`. |
| `qorpera-folder-service.socket` | node host | `/run/qorpera-folder/service.sock`, 0660, group `qorpera-folder-bridge`: only the bridge connects. |
| `qorpera-folder-control.socket` | node host with coding or test machines | `/run/qorpera-folder-control/control.sock`, 0600, user `qorpera-coding-executor`: only the executor connects, to ask its machines' boundaries and say when it restarted one (F3 5c), and to open and close a test machine's command windows (F3 6b). |
| `qorpera-folder-service.service` | node host | The service, started by its socket. |
| `qorpera-folder-bridge.service` | node host, `qorpera-folder-bridge` (no `lxd` group) | vsock port 5250 to the socket, naming each machine as LXD sees it. Asks LXD over its pinned loopback listener with the bridge's own client certificate (`/etc/qorpera-lxd-ids/listener.json` and `qorpera-folder-bridge/client.{crt,key}`, root's, written when the node is enrolled). No service credential. |
| `qorpera-folder-mount@.service` | execution host, from the shared-execution package | One read-only mount per instance: `/srv/qorpera-folder/<id>` from `/etc/qorpera-folder/mounts/<id>.json`. |
| `install-folder-service.sh` | node host | Verify the package, install, enable nothing. Refuses a host without `/usr/bin/git` and `/usr/bin/prlimit`: the service reads the git packs coding machines save with them (F3 5j-5). |

## Build and package (from the release commit, on the node 2 test machine or in the build space)

```bash
node scripts/build-folder-program.mjs --out /tmp/qorpera-folder
node scripts/package-folder-service.mjs --out /tmp/folder-service-package --folder-program /tmp/qorpera-folder
node scripts/package-shared-execution-service.mjs --out /tmp/shared-execution --folder-program /tmp/qorpera-folder
```

The build prints its record; it must equal `deploy/folder-service/folder-program-linux-x64.json` of the commit (the
same source in the same pinned image gives the same bytes; the scripts tests and the `folder-program` test step check
both). The shared-execution installer pins that program, and `rebuild-exec-host.sh` refuses any other before it
stops anything.

## Node host

```bash
sudo /tmp/folder-service-package/install-folder-service.sh
```

Then, as root, without echoing anything secret:
- `/etc/qorpera-folder-service/supabase-key` (0400): the service-role key, copied from the node's existing holder.
- `/etc/qorpera-folder-service/config.json` (0400):

```json
{
	"supabaseUrl": "https://<project>.supabase.co",
	"storageRoot": "/srv/qorpera/objects",
	"cacheMiB": 1024,
	"mounts": [
		{
			"id": "proof",
			"environmentId": "<the proof company's folder-v2 environment>",
			"actor": { "kind": "member", "userId": "<the operator's member user id>" },
			"machine": { "project": "qn25b2", "name": "qorpera-exec-node02", "physicalId": "<its volatile.uuid>" },
			"passSha256": "<sha256 of the pass in the machine's view file>"
		}
	],
	"runBoxHosts": [],
	"companyMachineProjects": [],
	"codingMachineProjects": []
}
```

`runBoxHosts` (step 2a) names the machines on this node that may present the core's run box views, as
`{"project", "name", "physicalId"}` (its execution host: `qn25b2`, `qorpera-exec-node02`, its `volatile.uuid`). It stays
empty until runs use the folder.

`companyMachineProjects` (F3 step 4a, `deploy/first-node/RUNTIME-FOLDER-COMPANY-MACHINES.md`) names the LXD projects
of this node's company machines. A machine there named `qorpera-office-<allocation id without dashes>` may present its
own desktop's and shell commands' views. It stays empty until company machines use the folder (which projects: the
plan's Q1).

`codingMachineProjects` (F3 step 5c, `deploy/first-node/RUNTIME-FOLDER-SERVICE.md`, "Step 5c") names the LXD projects
of this node's coding machines. A machine there named `qorpera-coding-machine-<coding machine id without dashes>` may
present its own coding sessions' views, and `codingExecutorUid` (`id -u qorpera-coding-executor`) is the only uid the
control socket lets ask their boundaries and say when it restarted one. Both stay unset until coding machines use the folder; a company's code host
needs neither (its project is `qorpera-codehost-<company id without dashes>`).

`testMachineProjects` (F3 step 6b, `deploy/first-node/RUNTIME-FOLDER-TEST-MACHINES.md`) names the LXD projects of this
node's agents' test machines (on our nodes `machines`). A machine there named `qorpera-machine-<placement id without
dashes>` may present its own boot's view; an image builder (`qorpera-machine-build-…`) never does. The same
`codingExecutorUid` is the only uid the control socket lets open and close a test machine's command windows and ask its
boundaries. A project listed here and in `companyMachineProjects` or `codingMachineProjects` stops the service at start.
It stays unset until test machines use the folder.

Which machine is served a core view is the core's to say: the view's first renewal says its kind and machine, and from
then on a run box is served only to a `runBoxHosts` machine (read-only), a computer desktop or a shell command's view
(step 4b) only to the company machine named after its allocation (read-write), a coding session's view only to its own
coding machine in a `codingMachineProjects` project and a code host's view only to its company's code host (step 5c,
read-write), a test machine's view only to its own instance in a `testMachineProjects` project (step 6b, read-write),
and any other kind to no machine yet. A renewal that says another kind or machine closes the view.

`storageRoot` is where the service sees the object gateway's store: `/srv/qorpera/objects`, a path inside the
service's own mount namespace. The drop-in below binds the store there ("Reading the objects"). The store is the
gateway's `QORPERA_OBJECT_GATEWAY_STORAGE_ROOT`, laid out `<profileId>/<sha256>`. On the host it is today
`/srv/qorpera/canonical/.qorpera-acceptance-phqlfrkcvstmxlebljcj-7cf936a4/objects` on both nodes (below, "the
store"). The share's top folder holds older objects that the core never names. The store is a folder under the
share's mount, not a mount itself: as root on the host, check that `findmnt --target <the store>` names
`/srv/qorpera/canonical` from the storage server and that the folder holds profile folders.
`RequiresMountsFor=/srv/qorpera/canonical` starts the service only after the share is mounted. If the store is not
there when the service starts, the bind fails, so the service does not start: systemd tries again every 5 s
(`RestartSec=5s`, no start limit) and machines get no answer meanwhile, never an empty page. The bind keeps the mount
the service started on. Stopping the share's mount through systemd stops the service first, and the socket's next
connection starts it again on the new mount; after the share is mounted again by hand, restart the service.

**Writes through the mount (F3 step 3, `deploy/first-node/RUNTIME-FOLDER-WRITES.md`)** are off until both of these:
- `"gatewayUrl": "https://<node 1's object gateway origin>"` in `config.json`, and the gateway's folder-service token
  (`QORPERA_OBJECT_GATEWAY_FOLDER_SERVICE_TOKEN` on the gateway, #859) at `/etc/qorpera-folder-service/gateway-token`
  (0400), loaded by a drop-in `LoadCredential=qorpera-folder-gateway-token:/etc/qorpera-folder-service/gateway-token`
  (the unit does not name it, so a node without writes needs no file);
- a mount with `"write": true`, and for a desktop's save rule `"quietMs": 2000` (500–60000): its pending changes are
  published that long after the last change; without it, only when the machine asks (`qorpera-folder publish`).

A member's or the platform's operator mount writes from step 3, a company machine's desktop view from step 4a (it
publishes 2 s after its last change, and when its last connection leaves), and a shell command's view from step 4b (it
publishes only when asked, or before a change that needs what is pending published first, is kept when its last
connection leaves, and its final publish closes it); a coding session's view and a code host's from step 5c (2 s after
the last change, and a coding machine's views at each boundary its executor asks for through the control socket; a
coding session's is kept until the core closes it); run box views
stay read-only until steps 5–6. Writes need P17's conflict copies and their erasure live (#783, #798), and step 3a (#855) for big files' chunks.

**Stopping (step 5c).** A stop or restart of the service ends nothing it serves for good: first it releases every read
its coding machines' views served and publishes every coding and code host view, for up to 45 s
(`TimeoutStopSec=60s`), then tells the core it stopped cleanly, and the next run serves those views. If it could not,
or a coding machine lost a read this run served and the executor has not said it restarted it since (`restarted` on
the control socket), the views stay marked as this run's: the core refuses them to the next run, and their machines
restart.

**Reading the objects.** The gateway writes them 0600, so the service reads them as the gateway's account:
`qorpera-objects`, a system account with the same uid and gid on both nodes (1500; no shell, no home, no other groups,
no sudo, not a caller of the node's root helper). The gateway runs as it too, and its tree on the share and its files
on node 1 are chowned to it (the coordinator's lane, 6 Oct: root on the host can chown on the share, there is no root
squash). A new node makes the account with the same uid and gid.

The storage server refuses a non-root uid a lookup in the share's top folder (`/srv/qorpera/canonical`), whatever the
uid. A non-root uid gets through it only for some 20 s after root walked it, while the client's cached names last; then
`stat` and `open` fail with `EACCES`. So the service never walks the host path, as the gateway never does (its unit
binds its own folder elsewhere). The drop-in gives the service the store alone: an empty read-only `/srv/qorpera`,
with the store bound read-only at `/srv/qorpera/objects`, its `storageRoot`. In the service's namespace
`/srv/qorpera` holds only `objects`: the share's top folder, the gateway's state folder and any other mount under
`/srv/qorpera` are not there. The unit also keeps `ProtectSystem=strict` with no `ReadWritePaths`, so the service
cannot write the share.
- `/etc/systemd/system/qorpera-folder-service.service.d/read-objects.conf`, the same on both nodes, gives the service
  the account, the store and a process namespace of its own, and hides the gateway's tokens and log (on node 1's
  disk); `-` skips a path that is not on this node. The bind's source has no `-`: a missing store fails the start
  (above), where a service started without it would keep that view until a restart, even after the share came back.
  - On node 1 the service shares the gateway's uid. The kernel lets a process follow `/proc/<pid>/root`, `cwd` and
    `fd` of any process with its own uid, and signal it. Through the gateway's `root` the service would reach the
    gateway's writable mount of the share and the paths the drop-in hides. `PrivatePIDs=` shows the service no
    process but its own. It needs systemd 257 or later; an older one ignores the line, which the last check below
    shows. A user namespace alone (`PrivateUsers=`) would close the `/proc` links (the kernel's capability check
    wants the same user namespace) but not signals, which compare uids only; `PrivatePIDs=` closes both.
  - The service is ready to be its namespace's first process: it handles `SIGTERM`, starts no other process, and
    systemd sets `LISTEN_PID` to 1 inside the namespace, which is what the service checks.

```ini
[Service]
User=qorpera-objects
Group=qorpera-objects
PrivatePIDs=yes
TemporaryFileSystem=/srv/qorpera:ro
BindReadOnlyPaths=/srv/qorpera/canonical/.qorpera-acceptance-phqlfrkcvstmxlebljcj-7cf936a4/objects:/srv/qorpera/objects
InaccessiblePaths=-/var/lib/qorpera-acceptance-phql-a1 -/run/credentials/qorpera-gateway-phql-a3.service
```

- Check on both nodes, through the same bind (`sudo -u` on the host path fails for every non-root uid, above):
  `sudo systemd-run --wait --pipe --quiet --collect -p User=qorpera-objects -p Group=qorpera-objects -p
  TemporaryFileSystem=/srv/qorpera:ro -p BindReadOnlyPaths=<the store>:/srv/qorpera/objects head -c1
  /srv/qorpera/objects/<a profile>/<an object> | wc -c` prints 1; the same as `qorpera-folder` (`User=` and `Group=`)
  is refused and prints 0.
- Check on node 1 that nothing else of the gateway's is left to the account: `sudo find / /run /dev/shm -xdev \(
  -user qorpera-objects -o -group qorpera-objects \)` (and `/var` or `/opt` if either is its own filesystem) lists
  only paths under the hidden ones.
- Check on both nodes from inside the running service's sandbox (`systemctl start qorpera-folder-service.service`
  first): `sudo nsenter -t <its MainPID> -m -p -S "$(id -u qorpera-objects)" -G "$(id -g qorpera-objects)" sh -c 'ls
  /proc; ls /proc/<the gateway's MainPID>/root/; ls -A /srv/qorpera; head -c1 /srv/qorpera/objects/<a profile>/<an
  object> | wc -c; touch /srv/qorpera/objects/probe'` (on node 2, without the gateway's `ls`). It lists no process
  but `1` (the service) and the check's own, fails on the gateway's, lists only `objects`, prints 1, and the `touch`
  fails with "Read-only file system" (were it to succeed, the bind is not read-only: remove the file as root).
- `systemctl enable --now qorpera-folder-service.socket qorpera-folder-bridge.service`
- On a node with coding machines (step 5c) or test machines (step 6b), once the `qorpera-coding-executor` account
  exists and `config.json` names its uid (`codingExecutorUid`) and the projects (`codingMachineProjects`,
  `testMachineProjects`): `systemctl enable --now
  qorpera-folder-control.socket`, then `systemctl restart qorpera-folder-service.service` if it is running (systemd
  passes the control socket only to a service it starts after the socket listens). The journal then says "serving the
  control socket from systemd". Check: `stat -c '%U %a' /run/qorpera-folder-control
  /run/qorpera-folder-control/control.sock` prints `root 755` and `qorpera-coding-executor 600`; the service refuses
  every connection while the file or a folder above it says otherwise, and logs why.
- Expected in the service's journal at each start: node's `Warning: disabling flag --expose_wasm due to conflicting
  flags`. The unit's `--jitless` turns WebAssembly off, as it means to (`RUNTIME-FOLDER-SERVICE.md`).

## Execution host

The shared-execution package carries the folder program and `qorpera-folder-mount@.service`, so every
`rebuild-exec-host.sh` installs them (to `/opt/qorpera-folder`, with `/srv/qorpera-folder` and
`/etc/qorpera-folder/mounts` root-only, both hidden from the slot units). Nothing mounts until a view file exists and
its unit starts.

Step 1's operator mount, inside the machine as root: make the pass, write the view file, and give its sha256 to the
node's config (the pass itself never leaves the machine):

```bash
umask 077
pass=$(head -c 32 /dev/urandom | basenc --base64url | tr -d '=')
printf '{"environmentId":"%s","viewId":"proof","pass":"%s"}\n' "<environment>" "$pass" > /etc/qorpera-folder/mounts/proof.json
printf %s "$pass" | sha256sum | cut -d' ' -f1
unset pass
systemctl start qorpera-folder-mount@proof
```

An image rebuild of the execution host replaces its disk: the package reinstalls the program, and these steps (the
view file and the start) are run again after one.

## Remove

Machine: `systemctl stop qorpera-folder-mount@proof` (it unmounts). Node: `systemctl disable --now
qorpera-folder-bridge.service qorpera-folder-service.socket qorpera-folder-control.socket
qorpera-folder-service.service`. Nothing else is kept.
