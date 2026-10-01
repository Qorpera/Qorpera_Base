# Headless office provider installation

The installer consumes an already enrolled provider policy and an exact local package. It installs the provider, its fixed root namespace helper, systemd units and protected configuration. It does not enroll a provider, create or import an image, touch the NAS, start a VM, activate an office, or start/enable the provider service. This candidate has only been installed in disposable local acceptance environments.

## Inputs

Package with `node scripts/package-lxd-office-provider.mjs --out <owned-output-directory>`. The package manifest binds exactly five artifacts: the provider, namespace helper and installer CommonJS executables, the provider unit template and the namespace helper unit. The installer verifies every artifact and its own executable against that manifest. The package needs Linux and `/usr/bin/node` version 22.19.0 or later, systemd, util-linux `flock`, Bash and the standard account-management tools.

Supply a root-owned installation specification with schema `qorpera.lxd-office-provider-installation/v1` and these closed fields:

| Field | Meaning |
| --- | --- |
| `packageRoot` | Canonical absolute path to the staged package |
| `packageManifestSha256` | SHA-256 of the exact `manifest.json` bytes |
| `providerPolicySha256` | Canonical policy digest already enrolled in cloud authority |
| `documents` | Exactly `service`, `policy`, `provenance`, `registry`, `registryCa`; each has `path`, `bytes`, `sha256` |

All inputs must be bounded, single-link regular files on a local filesystem, with canonical root-owned directory ancestry and no group/other write access. The source registry credential must be root:root `0400`. The specification and package files remain outside guest and service writable trees. Hashes are commitments to reviewed inputs, not a substitute for release provenance or enrollment.

The service document uses `qorpera.lxd-office-provider-service/v1`. Its installed paths must be `/etc/qorpera/office-provider/policy.json`, `provenance.json`, `review.json` and `registry.credential` for the corresponding fields. The credential's byte length and digest must match the registry document. `review.json` is a later protected adoption review and is not created by installation. The policy/provenance pair is verified against the policy's image verification key. The registry origin must be HTTPS and the supplied registry CA must be a currently valid CA certificate. Registry requests never occur during installation.

Optional `passthroughPath` names the closed host passthrough document: the
provider then carries the viewer and native host ports itself and resolves the
guest's current address for every connection, so nothing forwards to a fixed
guest address. See [OFFICE-PASSTHROUGH.md](OFFICE-PASSTHROUGH.md).

## Host identity and custody

The policy's machine-ID digest and architecture must match the actual host. Its local journal filesystem, source and mount root must match the open filesystem descriptor. The journal mount must already exist; the installer can create its private state subdirectory and initial lock, but cannot create or mount infrastructure.

The fixed account `qorpera-office-provider` uses the policy's workbench UID/GID. These numeric identities must be reserved for this dedicated host account and match the intended guest/NAS mapping. Installation checks host identity exclusivity; actual NAS ownership, writer exclusion and durability remain physical acceptance requirements. It does not change NAS ownership. An existing interactive account, reused UID/GID, unlocked account, shared primary group or unexpected supplementary groups is rejected. The account has no home, a nologin shell, a locked password and only the enrolled LXD socket supplementary group. That socket group must already exist.

Installed executables are root:root `0444` under `/opt/qorpera/office-provider`. Configuration and provenance are root:root `0444`; the registry credential is root-owned `0440` with the private provider primary group. The journal directory is provider-owned `0700`, and its empty single-link `adoption.lock` is `0600`. Directory ancestry remains protected. The receipt `/opt/qorpera/office-provider/installation.json` records exact installed hashes, modes and identities without secret contents.

## Review and application

Run the staged installer as root with `--check --spec <absolute-spec-path>` to validate all inputs, host identity, mounts, accounts, units and existing state. This mode writes nothing and prints a bounded summary of the intended paths and policy digest.

`--apply --spec <absolute-spec-path>` performs the same checks, takes a root-owned installation flock, prepares the dedicated identity and empty journal if needed, then takes the existing adoption lock before publication. Internal preparation/commit stages verify inherited kernel flock descriptors; a lock file or command-line flag alone grants no access to those stages. The root mutex remains inherited by the commit process if its parent exits.

Installation creates missing files through private staging and fsyncs them before atomic publication. Existing files must have identical bytes, custody and modes and are not replaced. An identical stopped installation preserves journal and credential inodes. A nonempty journal with a missing lock or missing installed target requires explicit recovery. There is no automatic upgrade, credential rotation, journal migration or cleanup of uncertain operations.

Both units must have no running process or queued job; a completed namespace-helper oneshot is allowed. Service processes outside the unit also block installation. Alternate unit fragments, masks, loaded overrides and newly written unit/global/dash-prefix drop-ins are rejected. Successful application validates the actual units, reloads systemd, disables provider boot activation and confirms the provider remains stopped. It never starts either unit.

## Service lifecycle

The provider starts through the existing journal inode: Bash opens it without creation, then `flock --exclusive --nonblock --no-fork` execs Node. Literal percent signs, environment expressions and quotes in journal paths are escaped for systemd. A missing lock fails startup and is not recreated.

The provider has empty inherited, permitted, effective, bounding and ambient capability sets, `NoNewPrivileges`, MDWE, jitless Node and finite memory/PID/CPU ceilings. The separate fixed root startup helper alone has `CAP_SYS_PTRACE` to read PID 1's namespace and publish the boot-bound protected record. Neither unit creates a private mount namespace; the physical gate needs the actual host mounts and proc metadata.

Ordinary restart and on-failure restart preserve the journal lock inode. `KillMode=mixed` lets the main provider settle work on SIGTERM and kills remaining cgroup descendants on exit or after the 70-second stop bound. Provider shutdown is not proof of VM shutdown/deletion and never releases machine capacity. Guest invocation restart, reboot, replacement and safe power-off require their own authority and physical lifecycle implementation.

## Local acceptance

`QORPERA_OFFICE_SYSTEMD_TEST_IMAGE=<prepared-local-image-digest> node scripts/test-office-installation-systemd.mjs` packages this checkout and runs the installer against an actual private systemd manager and autoclearing ext4 loop-file journal. The image must already contain Node 22, systemd, util-linux, e2fsprogs, procps and account-management tools; the command never pulls an image. `scripts/fixtures/systemd-test-image.Dockerfile` builds one (`deploy/test-machine/README.md`). It uses disposable synthetic policies and loopback TLS authority with preparation disabled, no external network, no host cgroup bind and no production paths. The root fixture has container-scoped capabilities to run systemd and create its own loop filesystem; the actual provider unit is unchanged and has none. The container also runs without AppArmor, so run it on the operator test machine (`deploy/test-machine/README.md`) or a developer's Docker, never on a node that hosts companies.

The proof covers a read-only preview, changed artifacts and unsafe credentials, internal-stage lock requirements, competing installer/adoption locks, loaded/unloaded systemd overrides, exact disabled installation, real protected credential reads, exclusive process-owned locking, ordinary and crash restart, whole-cgroup cleanup, unchanged inode preservation, and refusal to recreate missing retained state. This does not establish NAS power-loss durability, real LXD/KVM image acceptance, guest lifecycle transitions, or production readiness.
