# Folder service and folder program: install

Design, protocol, security and acceptance: `deploy/first-node/RUNTIME-FOLDER-SERVICE.md`. This page is the
install reference. Every node and machine step is the coordinator's, at a cut.

## Files

| File | Where it runs | What it is |
| --- | --- | --- |
| `qorpera-folder-service.cjs` | node host, `qorpera-folder` | The folder service (from `packages/object-gateway/src/folder-service/`). Holds the service credential; never talks to LXD. |
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
	"storageRoot": "/srv/qorpera/canonical",
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

- Objects on the share are 0600, owned by the object gateway's account. Give the service that uid with a drop-in
  (`User=`) or a read grant on the storage server, and check with `sudo -u <account> head -c1 <one object>`.
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
