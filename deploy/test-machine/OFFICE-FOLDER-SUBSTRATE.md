# Office folder substrate probe

This is a reproducible candidate-mechanism probe for F3 step 4d in
[`RUNTIME-FOLDER-COMPANY-MACHINES.md`](../first-node/RUNTIME-FOLDER-COMPANY-MACHINES.md),
“A restarted program must reach its users” and “Who makes the namespaces”. It is
not completion of 4d, an office image release, or live-company acceptance.

The launcher refuses the shared test machine as its guest. It only targets a
running, explicitly marked, disposable nested KVM VM through local LXD, with its
full base-image fingerprint and physical UUID supplied by the provisioning owner.
It checks that the installed office unit matches the checked-out source, that no
office is active or starting, and that there are no boot credentials. It checks
the legacy credentials directory too, and refuses credential-path symlinks. It checks
all copied artifact digests again in the guest. It neither creates VMs nor
installs packages. The provisioning wrapper is a separate operation.

## Run

All builds and checks run through `run-on-node`, not on a developer Mac. The
provisioning owner reviews the wrapper and selects the test machine first:

```sh
node scripts/run-on-node.mjs --machine node01 --sudo --no-install --no-status -- \
  bash scripts/prove-office-folder-substrate-vm.sh </dev/null
```

The wrapper creates its own LXD project, directory-backed pool and VM from an
immutable resolved Ubuntu image. The VM has no NIC. It downloads packages on the
shared test machine and installs them only inside the nested guest. The FUSE
module is loaded only inside that guest. It supplies the exact production office
unit and an unprivileged `qorpera-office` account. This is recorded as
`imageKind: prepared-substrate`, **not a built office image**. Its trap deletes
only the resources it created, prints the probe JSON between evidence markers,
and checks the shared test machine's network/kernel state.

For an already prepared disposable VM, the launcher can be run through the same
runner with these arguments (replace every placeholder with a reviewed value):

```text
node scripts/test-office-folder-substrate.mjs
  --project <local-project>
  --vm qorpera-substrate-<unique-name>
  --uuid <full-physical-uuid>
  --image <full-base-image-sha256>
  --image-kind prepared-substrate
  --folder-binary <absolute-linux-binary-path>
  --folder-sha256 <full-binary-sha256>
  --record <absolute-output-json-path>
```

Without `--execute`, this only performs preflight and writes the local plan. With
`--execute`, it creates one UUID-scoped directory below `/run`, temporary units
and mounts in the nested VM. The root probe has a 150-second systemd lifetime;
each sandbox has a 120-second lifetime. Cleanup stops their cgroups and removes
their mounts and files. On an interrupted operator session the provisioning
owner must still inspect/delete its disposable VM; bounded service lifetime is
not a promise that a disconnected provisioning shell ran its trap.

Guest prerequisites: Python 3, bubblewrap, systemd, iproute2, util-linux (`mount`,
`umount`, `setpriv`), FUSE support with `/dev/fuse` already present, the office
account, and `/etc/qorpera-office/credentials` present but empty. Set
`user.qorpera.acceptance=office-folder-substrate` on the VM. `--image-kind
office-image` is reserved for an actual reviewed office-image fingerprint; it is
operator provenance, not an automatic attestation of every installed file.

## What the JSON establishes

- A real pinned `qorpera-folder` binary mounts FUSE as root, with `allow_other`.
  Its peer is a tiny synthetic protocol-v2 Unix-socket folder service. It does
  not exercise the database, vsock identity, read release or production grants.
- Two unprivileged clients use the installed office unit's confinement settings
  in transient units, followed by the runtime's bubblewrap namespace pattern.
  The write allowance is the probe's `/run` directory. The office application,
  graphical desktop, credentials and production startup bindings do not run.
  The copied `InaccessiblePaths` value contains `%b`, which `systemd-run
  --property` does not expand; those boot-specific paths are therefore not a
  proof of the production unit's expanded path restrictions. The credential
  preflight requires this disposable guest to contain no office credentials.
- One client binds the FUSE root directly. After the daemon is killed, detached
  and remounted, its fresh pathname lookup must fail with `ENOTCONN`: the negative
  control. The other binds the shared parent and uses `/company` as a symlink to
  its mount beneath that parent. The same client stays alive across the restart;
  it must read a new pathname and persist writes before and after the remount.
  Mountinfo and daemon/unit logs are retained to diagnose propagation failures.
- Old open descriptors are recorded separately. They remain associated with the
  old FUSE connection; pathname recovery does not rescue their buffered writes.
  Q3's loss-policy decision remains necessary whichever remount mechanism is
  chosen: a successful new pathname lookup does not recover old descriptors.
- The offline shell keeps only `CAP_SYS_ADMIN` in its own user namespace, creates
  a child mount/network namespace and waits. A root candidate helper joins only
  the network namespace and raises `lo`. The command drops effective, permitted,
  inheritable and ambient capabilities, sets no-new-privileges, proves a real
  loopback connection, and fails to route or change the link. The namespace
  bounding set is not a claim of held privilege after those drops.
- The office account attempts to ptrace both helper and a held helper child,
  while it has `CAP_SYS_PTRACE` in its own namespace and can see their actual
  PIDs. Both must return `EPERM`. Yama's relationship restriction is disabled for
  these two processes only, without changing a sysctl. Both remain in the initial
  user namespace. Production helper peer/target authorization and command mount
  attachment are outside this candidate primitive.
  These denials alone do not establish helper protection: this candidate lacks
  a dumpable positive control under the same confinement. A denial can come
  from AppArmor regardless of the helper. The ptrace claim remains unproven
  until that control is implemented and passes; no current record proves it.

`result: passed` requires every listed mechanism check. `failed` includes a
mechanism failure; `harness-error` includes setup, execution or cleanup failure.
All records deliberately say `officeIntegrationAccepted: false`. Passing on a
prepared substrate must be repeated on the actual office image and integrated
desktop/command paths before satisfying the plan's real-image prerequisite.

The current root-owned FUSE attributes and `default_permissions` can deny writes
to the office account even with `allow_other`. The probe records that as a failed
check. It does not chmod the mount or weaken the sandbox to hide the failure.

The default `--owner-mode root-default` preserves this negative evidence. An
explicit `--owner-mode office-account` asks the folder binary for virtual mount
ownership using `--owner-uid` and `--owner-gid`, resolved from the guest's actual
office account. It requires a binary supporting those flags; it does not silently
fall back. The daemon remains root, and its view file and state remain root-only.
The JSON records the mode, requested IDs, daemon UID and actual mount ownership
before and after restart. Keep each mode's output in a separate record: mapped
ownership must not overwrite or be presented as the unchanged default behavior.
The wrapper accepts this mode as its optional positional argument:

```sh
node scripts/run-on-node.mjs --machine node01 --sudo --no-install --no-status -- \
  bash scripts/prove-office-folder-substrate-vm.sh office-account </dev/null
```

The binary built by that checkout must include the ownership flags. Early command
errors and all control JSON records are retained, including the shell's actual
capability sets before namespace creation. A capability or namespace setup failure
must be diagnosed under the recorded confinement before changing the candidate.

## Recorded substrate result (2026-10-09)

The prepared Ubuntu 26.04 VM probe with folder binary SHA-256
`3256df4f65338b7c89f620d1beba1a3edb06d1af8d9c8f39f69ea7a92a60232a`
passed all five mount checks in `office-account` mode: expected ownership/mode,
the direct-bind negative control, a fresh lookup in the running propagated
namespace, and writes before and after remount. Its earlier root-default run
recovered lookups but returned `EACCES` for writes. In both modes, a cached old
descriptor read succeeded while closing that old descriptor returned `ENOTCONN`;
only fresh lookups and new writes count as recovery.

The mapped-ownership evidence is node01 run
`20261009T131030-53082-28d87d18`, source snapshot SHA-256
`ba9fe6cb6ce18f6774310dff37b42ba6b4cd5cf4ec0b1fa560cae7fadc6dcb70`.
It used prepared Ubuntu image
`fca42260aab1da12d0e0cf4cdd96ae36487daa94da0aec601d2cfe1275c1ca2e`
and nested VM UUID `23e92732-4975-49c3-9ebd-71bde3d63e55`.
The host-side run record and extracted JSON were retained in the Codex handoff
as `acceptance-vm-3.json` and `acceptance-vm-3.evidence.json`.

The offline candidate remains **unproven**. Its namespace creation returned
`EPERM`. The process retained `SYS_ADMIN` in its effective, permitted, inheritable
and ambient sets, but its security label was `bwrap//&unpriv_bwrap (enforce)` and
the guest kernel recorded an AppArmor denial of that capability. The helper and
ptrace checks were not reached. This requires a reviewed office launcher/policy
or a different helper setup design; the probe neither disables AppArmor nor
relaxes its profile. These observations establish no built-office-image or live
company acceptance.

## Unprivileged checks

```sh
node scripts/run-on-node.mjs --no-install --no-status -- \
  node --test scripts/test-office-folder-substrate.test.mjs </dev/null
```

These check fail-closed target/provenance validation and the synthetic service's
framing/write behavior. They do not start a VM or prove any privileged mechanism.
