# Folder service and folder program: install

Design, protocol, security and acceptance: `deploy/first-node/RUNTIME-FOLDER-SERVICE.md`. This page is the
install reference. Every node and machine step is the coordinator's, at a cut.

## Files

| File | Where it runs | What it is |
| --- | --- | --- |
| `qorpera-folder-service.cjs` | node host, `qorpera-objects` (a drop-in; see "Reading the objects") | The folder service (from `packages/object-gateway/src/folder-service/`). Holds the service credential; never talks to LXD. |
| `qorpera-folder` | node host (`bridge`), machine (`mount`) | The folder program (from `crates/qorpera-folder/`), built by `scripts/build-folder-program.mjs`; its recorded build is `folder-program-linux-x64.json`. |
| `qorpera-folder-service.socket` | node host | `/run/qorpera-folder/service.sock`, 0660, group `qorpera-folder-bridge`: only the bridge connects. |
| `qorpera-folder-service.service` | node host | The service, started by its socket. |
| `qorpera-folder-bridge.service` | node host, `qorpera-folder-bridge` (+ group `lxd`) | vsock port 5250 to the socket, naming each machine as LXD sees it. No credential. |
| `qorpera-folder-mount@.service` | execution host, from the shared-execution package | One read-only mount per instance: `/srv/qorpera-folder/<id>` from `/etc/qorpera-folder/mounts/<id>.json`. |
| `install-folder-service.sh` | node host | Verify the package, install, enable nothing. |

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
	"storageRoot": "/srv/qorpera/canonical/<the object gateway's folder>/objects",
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
	"runBoxHosts": []
}
```

`runBoxHosts` (step 2a) names the machines on this node that may present the core's run box views, as
`{"project", "name", "physicalId"}` (its execution host: `qn25b2`, `qorpera-exec-node02`, its `volatile.uuid`). It stays
empty until runs use the folder; any view kind presented from such a machine is accepted, so list only execution
hosts.

`storageRoot` is the object gateway's store (its `QORPERA_OBJECT_GATEWAY_STORAGE_ROOT`, laid out
`<profileId>/<sha256>`) as this host sees the share: today
`/srv/qorpera/canonical/.qorpera-acceptance-phqlfrkcvstmxlebljcj-7cf936a4/objects` on both nodes. The share's top
folder holds older objects that the core never names. The store is a folder under the share's mount, not a mount
itself: check that `findmnt --target <storageRoot>` names `/srv/qorpera/canonical` from the storage server and that
the folder holds profile folders. `RequiresMountsFor=/srv/qorpera/canonical` covers it. A share that is not mounted
fails reads as unavailable (the company's profile folder is missing), so a page never looks empty.

**Reading the objects.** The gateway writes them 0600, so the service reads them as the gateway's account:
`qorpera-objects`, a system account with the same uid and gid on both nodes (no shell, no home, no other groups, no
sudo, not a caller of the node's root helper). The gateway runs as it too. The unit keeps `ProtectSystem=strict` with
no `ReadWritePaths`, so the service still cannot write the share.
- Before the first use, probe on node 2 as root, in a scratch folder on the share: root can chown there (no root
  squash); a 0600 file owned by the new uid is read by that uid from both nodes and refused to `qorpera-folder`. If
  root cannot chown, the account takes the uid that owns the objects now (1002), after the account that holds it on
  node 1 moves to another uid along with the root helper's caller rule; 1002 must then be free on node 2 as well.
- Create the account on both nodes, with a uid and gid free on both; then move the gateway to it and chown its tree on
  the share and its files on node 1 (the coordinator's lane).
- `/etc/systemd/system/qorpera-folder-service.service.d/read-objects.conf`, the same on both nodes, gives the service
  the account and a process namespace of its own, and hides the gateway's tokens and log (on node 1's disk) and its
  state folder on the share from the service; `-` skips a path that is not on this node.
  - On node 1 the service shares the gateway's uid. The kernel lets a process follow `/proc/<pid>/root`, `cwd` and
    `fd` of any process with its own uid, and signal it. Through the gateway's `root` the service would reach the
    gateway's writable mount of the share and the paths the drop-in hides. `PrivatePIDs=` shows the service no
    process but its own. It needs systemd 257 or later; an older one ignores the line, which the last check below
    shows. A user namespace (`PrivateUsers=`) would not help: it keeps the uid, and the kernel compares uids first.
  - The service is ready to be its namespace's first process: it handles `SIGTERM`, starts no other process, and
    systemd sets `LISTEN_PID` to 1 inside the namespace, which is what the service checks.
  - Hiding the state folder needs root to reach it, which the probe shows; with the uid 1002 fallback, leave that path
    out (it holds object records and token hashes, no token).

```ini
[Service]
User=qorpera-objects
Group=qorpera-objects
PrivatePIDs=yes
InaccessiblePaths=-/var/lib/qorpera-acceptance-phql-a1 -/srv/qorpera/canonical/.qorpera-acceptance-phqlfrkcvstmxlebljcj-7cf936a4/state -/run/credentials/qorpera-gateway-phql-a3.service
```

- Check on both nodes: `sudo -u qorpera-objects head -c1 <one object>` works and `sudo -u qorpera-folder head -c1 <the
  same object>` is refused.
- Check on node 1 that nothing else of the gateway's is left to the account: `sudo find / /run /dev/shm -xdev \(
  -user qorpera-objects -o -group qorpera-objects \)` (and `/var` or `/opt` if either is its own filesystem) lists
  only paths under the hidden ones.
- Check on node 1, from inside the running service's sandbox (`systemctl start qorpera-folder-service.service`
  first): `sudo nsenter -t <its MainPID> -m -p -S "$(id -u qorpera-objects)" -G "$(id -g qorpera-objects)" sh -c 'ls
  /proc; ls /proc/<the gateway's MainPID>/root/; head -c1 <one object> | wc -c'`. It lists no process but `1` (the
  service) and the check's own, fails on the gateway's, and prints 1.
- `systemctl enable --now qorpera-folder-service.socket qorpera-folder-bridge.service`

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
qorpera-folder-bridge.service qorpera-folder-service.socket qorpera-folder-service.service`. Nothing else is kept.
