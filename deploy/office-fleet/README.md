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
- The dedicated non-root service user, host mount namespace service, local
  ext4 journal mount, journal directory and existing `adoption.lock` inode.
  Ownership, permissions, mount source and mount namespace must pass the
  existing physical gate and process-owned kernel flock checks.
- An authorized workbench NFS mount, with host-specific mount/source identity
  and dedicated destination/custody paths for this new office. Candidate
  inspection reads physical metadata and publishes only local journals and a
  registry offer. It does not create a VM or write the workbench. Only the
  selected host enters the existing reviewed adoption process; the losing
  host never becomes a second writer.
- Root-protected physical policy, image provenance and existing
  `qorpera.lxd-office-provider-service/v1` lifecycle service document, including
  exact registry credential path/length/digest, inventory limits and adoption
  plan path. Configure each possible host's viewer/native passthrough and
  routing. Optional software/reset/package lanes must also reference valid
  host-local protected files. These remain ordinary lifecycle configuration.

The node-wide singleton office installer is not used for fleet candidates.
The fleet installer below creates per-office, per-generation units and allows
multiple company computers on one node.

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

## A company's next computer

A company can run several Company Computers (migrations `20260928100000` and
`20260928100100`; `deploy/first-node/RUNTIME-COMPANY-COMPUTER-SCALE-OUT.md`).
When every running computer of a company is full, the database adds the next
one; it waits until a host offers it. `qorpera_runtime_office_setup_queue()`
(service role) lists every computer that needs a host, why it waits (`setup`,
`room`, or `unstarted` for a spare nobody started yet) and the company's
computer to copy (`template`).

The next computer copies the company's computer already on that host: the same
image and provenance, company account (workbench uid/gid), project, network,
pool, size, registry endpoint and provider credential. Only these are new:
provider id, computer identity, NAS working folder and its mount, journal
directory, host ports, mux routes and the fleet units. Two computers never
share a working folder: the single-writer rule of the workbench holds.

1. Write a request (read-only paths of the template's documents, the new
   computer from the queue, a new provider UUID, the host choices):

   ```json
   {
     "template": {
       "policyPath": "/etc/qorpera/offices/<first>/policy.json",
       "servicePath": "/etc/qorpera/offices/<first>/service.json",
       "passthroughPath": "/etc/qorpera/offices/<first>/passthrough.json"
     },
     "office": {
       "providerId": "<new uuid>",
       "companyComputerId": "<from the queue>",
       "logicalComputerId": "<from the queue>",
       "computerGeneration": 1
     },
     "host": {
       "nodeId": "<enrolled node uuid>",
       "configRoot": "/etc/qorpera/offices/<companyComputerId>",
       "workbench": { "mountPoint": "/srv/qorpera-workbench/<companyComputerId>", "source": "<nas>:/volume1/qorpera-runtime-workbench/<companyComputerId>" },
       "journalPath": "<template journal mount>/<companyComputerId>",
       "ports": { "viewer": 18545, "native": 18546 }
     }
   }
   ```

2. Run `node qorpera-office-next-computer.cjs /absolute/request.json` from the
   fleet package. It reads the three documents and prints a plan: the new
   `policy.json`, `service.json`, `passthrough.json` and `fleet.json` (exact
   bytes and digests), the provider enrollment, and the remaining root steps.
   It writes nothing, mints no credential and refuses to reuse the template's
   provider, computer, working folder, mount, journal or ports.
3. Follow the plan's steps as root: NAS folder and mount, journal directory and
   `adoption.lock`, publish the files, copy the provenance, enroll the
   provider, install the fleet units, add the mux routes, then start the stage
   and fleet units once the computer's start intent exists.
4. The new working folder is empty, so the adoption review carries nothing
   over: its adoption input has shared workbench, desktop and company `null`
   (layout 2), `legacy` null and no quarantine.

A computer that nobody has started yet can be set up the same way in advance
(a spare). Its fleet units wait for a start intent; it holds no node capacity
until placement reserves it.

Native routes: a company route
(`https://<front>/office/{companyComputerId}/native`) lets a run reach
whichever computer holds its screen; every computer of that company must then
accept the route's transport token. The browser sign-in store is kept in step
only between computers that see the same company directory; until that
directory is shared between them, each computer keeps its own sign-ins.

## Acceptance and rollback

For a physical acceptance test, register a new office in a new environment
(registration is unique per environment). Stage independent candidates on both
nodes. Make node 1 unavailable for new placement through its reviewed admission
configuration or consume its remaining usable capacity; retain its existing
office services. Request the new computer and verify:

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

Local proofs: `node scripts/test-runtime-office-fleet.mjs` exercises actual SQL
admission with synthetic host measurements. The focused
`test/lxd-office-fleet.test.ts` tests staged selection, cancellation, losing-host
behavior, lost replies, retained identities and unit rendering. These are not
a physical two-node acceptance result.
