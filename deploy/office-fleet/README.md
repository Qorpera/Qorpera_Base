# Company computer fleet

New office generations can choose any enrolled, physically ready node with
enough shared capacity. The controller's location does not constrain that
choice. Existing office providers, allocations, journals and storage ownership
remain attached to their original host.

This is a staged provisioning workflow. Registering a computer in the product
does not manufacture protected host configuration, install an image, or grant
NAS access. Prepare the candidates below for each new office before starting
their fleet units. An operator or provisioning system must perform this
preparation; the current web registration path does not dispatch it remotely.

## Host prerequisites

Each candidate needs its own provider UUID, local journal and protected
configuration. Both candidates reference the same registered office scope,
generation, image fingerprint and bootstrap digest. Never copy a bound office
generation to another host and never share its lifecycle journal over NFS.

On each host, prepare the existing office installation inputs:

- A measured physical policy using that host's machine ID, LXD certificate,
  server identity, socket GID, project, storage pool and network. Enroll this
  exact provider policy and resource size with
  `qorpera_enroll_runtime_node_provider`; keep the node inventory observer
  running with fresh, complete inventory. A hardware heartbeat alone is
  insufficient.
- The exact signed office image, its verified provenance and the expected
  bootstrap. Import the image into the policy's project on both hosts before
  publishing either offer. Existing LXD project/network names alone do not
  establish image readiness.
- The dedicated non-root service user, local journal mount (ext4, xfs, btrfs or zfs), journal
  directory and existing `adoption.lock` inode. Ownership, permissions, mount
  source and mount namespace must pass the existing physical gate and
  process-owned kernel flock checks. The host mount namespace record comes from
  `qorpera-node-host-namespace.service`, installed with the node observer (on
  both nodes since the v145 observer); fleet units require it. They no longer
  need the single-office installer's `qorpera-office-host-namespace.service`.
- An authorized workbench NFS mount, with host-specific mount/source identity
  and dedicated destination/custody paths for this new office. Candidate
  inspection reads physical metadata and publishes only local journals and a
  registry offer. It does not create a VM or write the workbench. Only the
  selected host enters the existing reviewed adoption process; the losing
  host never becomes a second writer. The NFS export is this office's alone:
  never the same, an enclosing or an enclosed export of another office's
  workbench, on any host. A deleted company's retirement empties it
  (RUNTIME-OFFICE-RETENTION.md, "Office retirement"); it refuses a sharing
  it can see on its own host, but not one on another host.
- Root-protected physical policy, image provenance and existing
  `qorpera.lxd-office-provider-service/v1` lifecycle service document, including
  exact registry credential path/length/digest, inventory limits and adoption
  plan path. Configure each possible host's viewer/native passthrough and
  routing. Optional software/reset/package lanes must also reference valid
  host-local protected files. These remain ordinary lifecycle configuration.

The node-wide singleton office installer is not used for fleet candidates.
The fleet installer below creates per-office, per-generation units and allows
multiple company computers on one node.

## Node base (automatic setup, step 1)

The node-specific part of every machine's physical policy is measured from the
node itself, never copied from another machine (design page "Company Machine
Setup"). Declare once per node, root-owned and not writable by others, for
example `/etc/qorpera-node/office-node-base.json`:

```json
{
  "schema": "qorpera.office-node-base-config/v1",
  "nodeId": "<runtime node id>",
  "socketPath": "/var/snap/lxd/common/lxd/unix.socket",
  "project": "<machines' LXD project>",
  "network": "<machines' managed network>",
  "storagePool": "<pool>",
  "journal": { "mountPoint": "<local mount holding the machines' journals>" },
  "workbench": { "serverAddress": "<NAS IP>", "mountRoot": "<folder under which scratch folders mount>" },
  "ports": { "from": 18600, "to": 18699 }
}
```

Then, as root (the tool only reads; the two file steps store its output):

```sh
node qorpera-office-node-base.cjs measure /etc/qorpera-node/office-node-base.json > /root/office-node-base.measured.json &&
  install -o root -g root -m 0444 /root/office-node-base.measured.json /etc/qorpera-node/office-node-base.measured.json
node qorpera-office-node-base.cjs check /etc/qorpera-node/office-node-base.json /etc/qorpera-node/office-node-base.measured.json
```

Both files are read as protected files: absolute paths, root-owned, not group- or
other-writable, no hard or symbolic links, every parent directory root-owned
and not group- or other-writable (so not under `/tmp`).

- `measure` prints the base and its digest:
  - the host identity (machine id, LXD socket and its group, the daemon's
    certificate, name, version, architecture);
  - the digests of the project, network and pool, exactly as the office gate
    compares them;
  - the journal mount (one local, whole, writable ext4/xfs/btrfs/zfs mount);
  - the NAS address, the scratch mount root and the port range.
- It refuses unless it runs in the host's own mount namespace, and unless the
  node observer's configuration (`/etc/qorpera/node-observer.json`) exists and
  names the same node id and host.
- `check` measures again and compares with a stored base. Exit 0: same.
  1: the node changed. 2: usage or an error; errors print one short code with
  no values. A stored file that cannot be read safely (missing, wrong owner or
  mode, unsafe folder) gives `OFFICE_NODE_BASE_STORED_UNREADABLE`; one that is
  not exactly what `measure` printed gives `OFFICE_NODE_BASE_STORED_INVALID`.
  Use it as the pre-check before any machine is prepared.
- A machine's physical policy takes `host`, `infrastructure` and the journal
  mount from the base, `guest.project/network/storagePool` from `guest`, and
  `workbench.serverAddress` from `workbench`. The waiting machine and its size
  fill the rest. The same base shape on both nodes, with the parity check
  (`deploy/node-parity`), is how the nodes stay identical for machines.

## Install and stage

Apply the placement inventory readiness and office fleet migrations first.
The three fleet RPCs require the infrastructure `service_role` credential;
the underlying table has no direct API grants. Guest bundle activation is
independent of the host fleet service.

Package from the reviewed checkout:

```sh
node scripts/package-lxd-office-fleet.mjs --out /absolute/new/package-directory
```

Copy the package to a protected root-owned directory on each host and verify
its manifest hashes. Create a root-protected fleet document for that candidate:

```json
{
  "schema": "qorpera.office-fleet-service/v1",
  "nodeId": "<enrolled node UUID>",
  "servicePath": "/etc/qorpera/offices/<office>/service.json",
  "serviceConfigSha256": "<sha256 of exact service.json bytes>"
}
```

As root, invoke the packaged installer with absolute paths:

```sh
node qorpera-office-fleet-install.cjs FLEET_CONFIG FLEET_BINARY BINARY_SHA256 REGISTRY_CA
```

It verifies protected inputs, installs the binary under its content hash and
writes two units, then runs `systemctl daemon-reload`. It does not start or
enable either unit. Existing different unit contents cause a conflict requiring
an explicit reviewed upgrade; they are not silently overwritten.

After the owner or an authorized native operation creates the office start
intent, start `qorpera-office-fleet-stage-<office UUID>-g<generation>.service`
on both hosts. The stage unit inspects the physical host, persists its local
creation identity and publishes an immutable candidate offer. It never selects
a winner. Offers are valid for 60 seconds; refresh staging if preparation takes
longer. The stage and provider units share the same local lock and must run
sequentially on each host.

Start and enable `qorpera-office-fleet-<office UUID>-g<generation>.service`
on each candidate. Each refreshes its own offer before selection. SQL locks
candidate nodes in deterministic order, evaluates their shared capacity using
the exact offered size, and atomically binds the provider and reserves both
company and node capacity. The selected host continues the existing lifecycle
under the same kernel lock; other candidates exit successfully. Equal capacity
uses node/provider UUID ordering, so starting the controller on a node gives
it no placement priority.

The original lifecycle still performs its storage inventory and reviewed
adoption plan checks. If a plan is awaiting review, finish that existing
procedure for the selected candidate. Fleet placement does not bypass custody,
mount fencing, boot configuration or activation checks. Repeated calls and
lost replies retain the exact selected allocation. A missing selected journal
fails closed; it cannot manufacture a replacement or switch hosts.

## Acceptance and rollback

For a physical acceptance test, register a new office in a new environment
(registration is unique per environment). Stage independent candidates on both
nodes. Make node 1 unavailable for new placement: empty it with the serving
switch (`qorpera_set_runtime_node_serving`, which keeps its running machines),
or use its reviewed admission configuration, or consume its remaining usable
capacity; retain its existing office services. Request the new computer and
verify:

1. Fleet status selects node 2, with exactly one provider, start allocation,
   reserved node demand and selected offer. The losing node creates no VM.
2. The selected lifecycle completes its existing inventory/adoption/boot and
   activation procedure. Viewer and native endpoints route to node 2, and an
   ordinary company computer operation succeeds.
3. Restarting the selected fleet unit retains the same VM/allocation and
   journal. Disabling a candidate or retrying placement never moves it.
4. Existing node 1 offices retain their providers, allocation IDs, workbench
   source and lifecycle services. Restore node 1's admission configuration and
   confirm a later new office can also select node 1.

Stopping an unselected candidate unit is safe and does not move a computer.
After placement, keep the winning fleet unit and its protected configuration
available; it is now the ordinary lifecycle service owner. Do not delete offers,
journals, demands or allocations as rollback, and do not infer capacity release
from stopping a systemd unit. Use the existing explicit lifecycle and retirement
procedures for a selected computer.

**Proof run before automatic setup.** This fleet path has not run on real
hardware yet. Automatic setup (step 3 on the design page) builds on it, so run
the acceptance above once by hand first, with a test company. Fill the node
parts of both candidates' policies from each node's measured base. Record the
fleet status, the selected node, the unit states and the first ordinary
computer operation, and hand them over with the proof run (PR comment and registry line).

Local proofs: `node scripts/test-runtime-office-fleet.mjs` exercises actual SQL
admission with synthetic host measurements. The focused
`test/lxd-office-fleet.test.ts` tests staged selection, cancellation, losing-host
behavior, lost replies, retained identities and unit rendering. These are not
a physical two-node acceptance result.
