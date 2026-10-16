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
  Its peer is a tiny synthetic protocol-4 Unix-socket folder service. It takes
  each read hand-over (`I`) as a consecutive prefix and releases it at once, like
  the crate's test node. It does not exercise the database, vsock identity, read
  release or production grants.
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
- One attacker process, as the office account, has `CAP_SYS_PTRACE` in its own
  user namespace and sees real PIDs. It records its own security label
  (`/proc/self/attr/current`) and capabilities. It first attaches to a
  **positive control**: a root process with the helper's security label that
  joins the attacker's user namespace and then makes itself dumpable. The attach
  must succeed (`ptracePositiveControl`). Otherwise the attacker's own
  confinement, for example an AppArmor profile that denies its capabilities,
  would explain any denial, and the run fails. The same process then tries the
  helper and a held helper child. Both must return `EPERM`
  (`helperAndChildPtraceDenied`). The helper and its child are nondumpable and stay
  in the initial user namespace. Yama's relationship restriction is lifted for
  the control, the helper and the child only, without changing a sysctl. The JSON
  records the control's uids as seen from the initial namespace, its user
  namespace and dumpability, and each attach's errno. A denial counts only when
  the control passed in the same run. No recorded run has reached this step yet
  (see below). Production helper peer/target authorization and command mount
  attachment are outside this candidate primitive.

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
The host-side run records and extracted JSON of both runs are kept byte for byte
in [`acceptance/2026-10-09-office-folder-substrate/`](acceptance/2026-10-09-office-folder-substrate/).
Its `MANIFEST.json` lists each file's Codex hand-off name, SHA-256 and size, and
the folder binary and fixture digests each run used. `OFFICE-ACCOUNT-*.json` are
`acceptance-vm-3.json` and `acceptance-vm-3.evidence.json`; `ROOT-DEFAULT-*.json`
are the earlier root-default run (`acceptance-vm-2.*`).

This run is older than the code it documents:

- #1005's last commit (4675c5187) changed one doc comment in
  `crates/qorpera-folder/src/mount.rs`. The rebuilt binary is now
  `7aa0ccbc718c2886569cbf06668ec1b02e722fe1fa2aa55ce78a6a2d309810a2`, not
  `3256df4f…`: the hash moved, the code did not.
- The run used fixture `97b525ae025839fb48bfa1190b4b38f879560d92e72d45f8729c05cbabc5a961`.
  The fixture has changed since then, including the ptrace positive control.
- Master's #1011 then moved the folder program to protocol 3. It refuses a hello
  answered with protocol 2, so this run's binary and the first 14 Oct rerun's
  (`7aa0ccbc…`) both speak a protocol master no longer has.

The last rerun below uses master's protocol-3 binary and the protocol-3 fixture.

The offline candidate remains **unproven**. Its namespace creation returned
`EPERM`. The process retained `SYS_ADMIN` in its effective, permitted, inheritable
and ambient sets, but its security label was `bwrap//&unpriv_bwrap (enforce)` and
the guest kernel recorded an AppArmor denial of that capability. The helper and
ptrace checks were not reached. This requires a reviewed office launcher/policy
or a different helper setup design; the probe neither disables AppArmor nor
relaxes its profile. These observations establish no built-office-image or live
company acceptance.

## Rerun at a clean head (2026-10-14)

The `office-account` probe was rerun on node01 at head
`59053c3bad81c4707502d8d7704cf8bbce56a3fc` with a clean tree (run
`20261014T161650-38323-c9940728`, source snapshot SHA-256
`b8d72d7ebbbb4d0d65fc63e978b5938a0bc1839f69632e7546e34a417313a379`). Until
master was merged in (c40d7b085, a protocol-3 folder program) and the fixture
moved to protocol 3 (551e23413, next section), later commits changed only this
document and the evidence folder. The run built folder
binary `7aa0ccbc718c2886569cbf06668ec1b02e722fe1fa2aa55ce78a6a2d309810a2` and
used fixture `0133118315f2a1861fa0a03d1fc5b1ce77dc44823be8785263ab7d9df50f06a6`,
on the same prepared Ubuntu image `fca42260aab1…` in nested VM UUID
`93676b87-cdb1-4802-8062-969712dc9a60`.

The mount result matches 9 Oct. All five mount checks passed: owner uid 999,
gid 986 and mode `0o755` before and after restart, the direct bind's fresh lookup
and write returned `ENOTCONN` (107), and the propagated namespace's fresh lookup
and write recovered in the same process. In both namespaces, closing the old
descriptor returned `ENOTCONN`.

The run's `result` is still `failed`, for the same reason as on 9 Oct: the
offline candidate's namespace creation returned `EPERM` under
`bwrap//&unpriv_bwrap (enforce)`, and the guest kernel recorded the AppArmor
denial of `sys_admin` (capability 21). The ptrace step comes after namespace
creation, so it did not run and `ptraceLogs` is empty. **No record yet shows the
ptrace positive control.** Getting past this denial is not enough for it: the
attacker is started through the same `/usr/bin/bwrap`, so it should get the same
`unpriv_bwrap` label, and that profile would deny its `CAP_SYS_PTRACE` too. The
control is expected to be denied (and the run to fail) until the attacker's setup
changes as well. A run that reaches the step shows which, in
`ptraceAttacker.securityLabel` and `ptrace.control.errno`.

An earlier attempt at head `70893ce62` (run `20261014T160923-30488-a2b8c8ed`)
stopped before any probe: the nested guest's lxd-agent returned `Error: EOF`
while the script pushed or installed the guest's packages. The script removed
its project and pool.

The run records, full logs and extracted JSON are in
[`acceptance/2026-10-14-office-folder-substrate/`](acceptance/2026-10-14-office-folder-substrate/),
with a `MANIFEST.json` like the 9 Oct one.

## Rerun on protocol 3 (2026-10-14)

After master (with #1011) was merged in, commit `551e23413` taught the synthetic
node protocol 3. The `office-account` probe was then rerun on node01 at head
`551e234132707eee050bc01f11f28e7a6d46dbb4` with a clean tree (run
`20261014T165304-74801-23846909`, source snapshot SHA-256
`40902e510c93bb3a43d9d7647d300437e7ad15849f5f6df797f3cbf20b3bab16`). Later
commits change only this document and the evidence folder. The run built folder
binary `11eda4a82f07c487874a027359d6385c4645d80be73cedaf548b9b18dccae445`, the
protocol-3 binary that master's build record pins. It used fixture
`4e0f98e97bd38d7ae91a0483c5402b7f61c0eb83a81c809538f9ef22c57005fe` and office
unit `af2f6a4063d5d71bff80ffddbed995bc36d389b5d1cd60c1993e8409c23af80f`, on the
same prepared Ubuntu image `fca42260aab1…` in nested VM UUID
`4ff228ec-3c6e-4a8f-8291-5de5dc4525c9` (project `qfs-fec058b4`).

The mount result matches the earlier runs:

- All five mount checks passed, with owner uid 999, gid 986 and mode `0o755`
  before and after restart.
- The direct bind's fresh lookup and write returned `ENOTCONN` (107). The
  propagated namespace's fresh lookup read `after remount` and its write
  succeeded, in the same process.
- In both namespaces, the old descriptor still read the cached `before`, and
  closing it returned `ENOTCONN`.
- Both mounts logged `view synthetic accepted at change 0, read-write` and FUSE
  ABI 7.45. The synthetic node recorded no protocol errors.

The `result` is `failed` for the same reason as before: the offline candidate's
namespace creation returned `EPERM` under `bwrap//&unpriv_bwrap (enforce)`, with
the kernel's AppArmor denial of `sys_admin` (capability 21). The ptrace step was
not reached. The script removed its project and pool. Its before/after
comparison of the test machine printed no difference, and its module checks
reported none appearing or disappearing.

The run record, full log and extracted JSON are in
[`acceptance/2026-10-14-office-folder-substrate-v3/`](acceptance/2026-10-14-office-folder-substrate-v3/),
with a `MANIFEST.json`.

## Unprivileged checks

```sh
node scripts/run-on-node.mjs --no-install --no-status -- \
  node --test scripts/test-office-folder-substrate.test.mjs </dev/null
```

These check fail-closed target/provenance validation, the synthetic service's
framing/write behavior, and that the ptrace checks fail without a passing
positive control. They do not start a VM or prove any privileged mechanism.
