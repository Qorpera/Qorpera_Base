# Office image production

F3 step 4, slice 4e-3 ([`RUNTIME-FOLDER-COMPANY-MACHINES.md`](RUNTIME-FOLDER-COMPANY-MACHINES.md) "Slices"). Three
scripts take the office image from the recipe the candidate proves
([`OFFICE-IMAGE-CANDIDATE.md`](../test-machine/OFFICE-IMAGE-CANDIDATE.md)) to a signed image that a physical office
policy can pin:

1. `scripts/build-office-image-production.sh` builds and publishes it on node01's host;
2. `scripts/accept-office-image.sh` boots a copy of it once, cold, and proves it from inside;
3. `scripts/sign-office-image-provenance.mjs` signs its provenance and writes the policy's image fields.

The coordinator runs them. Each step marked **PROD CHANGE** changes node01's host.

## Before anything runs

- **Nothing here runs before P2's proof and v179**, and not before #1098 and #1110 are on master. Build from a master
  commit that has them.
- node02 is out of scope. The image goes into A1's layout on node01: project `qofleet01`, pool `qorpera-vm`.
- The host's checkout is clean and at that commit. Root runs git there, so the checkout is root's or is in root's
  `safe.directory`. It needs Node.js 22.19 or later and `npm ci` (esbuild and the packaged Playwright); the recipe
  packages the office there, and the signer bundles the repository's verifier with esbuild.
- The folder program is built from the same commit with `node scripts/build-folder-program.mjs --out <file>`, where
  Docker may run, never on the node's host, and copied to the host. The builder takes only the build that
  [`folder-program-linux-x64.json`](../folder-service/folder-program-linux-x64.json) pins.
- KVM and `vhost_vsock` are already loaded. Nothing here loads a module or changes an nft table or a sysctl: both
  scripts compare the host's nft tables, network sysctls and modules before and after, and fail on any difference.
- While the build or acceptance VM exists, the node's inventory may list an instance it does not know
  (`UNREGISTERED_INSTANCE`) and report the node unavailable. Run them when no office needs to start.
- Admission stays on: each VM is created only with 16 GiB `MemAvailable`. Under that, the script refuses; it never
  waits.

## Run

### 1. The signing key, once (PROD CHANGE)

```sh
sudo node scripts/sign-office-image-provenance.mjs --generate-key /etc/qorpera-office-signing
```

As root only. It creates `/etc/qorpera-office-signing` (`0700`) and writes the ed25519 private key there as
`office-image-signing.pem` (root, `0400`). It never replaces a key (`OFFICE_IMAGE_SIGNING_KEY_EXISTS`) and refuses a
directory that is not root's alone. It prints only the public half, `verificationKeySpki` (base64 SPKI), and `keyId` (its
sha256); put those in the registry. The private half never leaves the host: never copy, print or back it up elsewhere.
A lost key means a new key, a new signature and a policy with the new SPKI.

### 2. Build (PROD CHANGE)

```sh
sudo bash scripts/build-office-image-production.sh --hostname <node01's hostname> \
  --folder-program <built qorpera-folder> --evidence /root/office-image/build.json </dev/null
```

`--project` (`qofleet01`), `--pool` (`qorpera-vm`) and `--root-size` (`80GiB`, 24 to 2048 GiB) have A1's defaults.

It refuses: not root, another hostname, a test machine, no KVM or `vhost_vsock`, a remote LXD, a missing project or
pool, a dirty checkout, a folder program that is not the pinned build, and an evidence path that exists or lies inside
the checkout.

1. It finds the base [`office-image-dependencies.json`](../lxd-company-computer-guest/office-image-dependencies.json)
   pins, by its full fingerprint, in the host's LXD. Only when the project cannot see it, it copies it in (and deletes
   that copy on exit).
2. It creates `qorpera-image-build-<random>` with no profile, so no network card: Secure Boot, no autostart, 2 CPUs,
   4 GiB, the root size, and only a build machine's keys (`user.qorpera.image_builder`, `user.qorpera.purpose`).
3. It runs the candidate's recipe unchanged (`scripts/office-image-recipe.sh`, steps 2 to 7 of
   [`OFFICE-IMAGE-CANDIDATE.md`](../test-machine/OFFICE-IMAGE-CANDIDATE.md)): the host fetches, the VM installs
   offline, the toolbox probe runs from a computer's shell, the office and folder units stay unstarted, and the seal
   cleans and stops the VM.
4. It checks the installation receipt, `/opt/qorpera-office/installation.json`, against the spec and the measured
   dependencies. Its sha256 is the image's bootstrap (a policy's `guest.bootstrapSha256`).
5. It publishes the image in the project with A1's labels, no alias, not public and no auto-update, and clears any
   profile LXD gave it. The labels are `description`, `os`, `release`, `architecture`, `qorpera.purpose`
   (`production-office-4e`), `qorpera.packageManifestSha256`, `qorpera.baseFingerprint`, `qorpera.sourceCommit` and
   `qorpera.installationReceiptSha256`; nothing reads them. It checks the image as `lxd-client.ts`
   `inspectOfficeImage` does, and that the checkout is still clean at the same commit.
6. On exit it deletes the VM and the base copy it made, never another image. A run that fails after publishing leaves
   the image and says so: check it, then delete it by hand.

The evidence (`qorpera.office-image-build/v1`, written `0444` only on success, and printed between
`OFFICE_IMAGE_PRODUCTION_EVIDENCE_BEGIN` and `OFFICE_IMAGE_PRODUCTION_EVIDENCE_END`) names the host, the commit and
`tree: clean`, the base, project, pool and root size, the office ids, the receipt's and spec's sha256, the published
image's record, the recipe and package manifest sha256, the apt closure, the dependency measurements, the toolbox, the
office unit's state, the folder program's sha256 and the folder's unit files.

### 3. Cold-boot acceptance (PROD CHANGE: a project and a VM while it runs)

```sh
sudo bash scripts/accept-office-image.sh --hostname <node01's hostname> \
  --evidence /root/office-image/acceptance.json <image fingerprint> qofleet01 </dev/null
```

1. It checks the image as `inspectOfficeImage` does, and reads the receipt and package manifest sha256 from its labels.
2. It creates its own project, `qoa-<random>`, copies the image there, and creates a VM with no profile and only its
   root disk (checked): Secure Boot, 2 CPUs, 4 GiB, the same root size.
3. It boots it once and checks it has no link but `lo`. Inside, as root, A1's verifier (guest-proof-v3) proves:
   - KVM, UEFI and Secure Boot: exactly one `SecureBoot` variable, the global one, set to 1; the SMBIOS product UUID is
     this VM's;
   - the office account, 20045: locked, sharing no id, running nothing;
   - the office, preparation, private-mount and folder helper units loaded, unmodified and never started, the office
     service disabled, and no folder mount;
   - every file of the installation receipt, and its measured dependencies;
   - empty custody directories and boot credentials, and no identity path;
   - the apt units masked;
   - no JWT- or Supabase-secret-shaped string in any regular file outside `/proc`, `/sys` and `/dev`. A hit names its
     path and kind, never the value;
   - both office services refused to start without configuration, and the private tmpfs (64 MiB, `nodev`, `nosuid`,
     `noexec`, `0700`);
   - Chromium in its bubblewrap AppArmor profile, every renderer under seccomp and `no_new_privs`, with no capability
     and in nested namespaces, and a screenshot;
   - the receipt and the custody again afterwards.
4. On exit it deletes the VM, the image copy and the project. The image stays in `qofleet01`.

The evidence (`qorpera.office-image-acceptance/v1`, `0444`) and the screenshot (`<evidence>.png`) are written only on
success. A secret-shaped hit fails the run and lists the paths. A person decides from them: a real secret means a fixed
recipe and a new build; a published example (an npm package's README) is a question for 9f.

### 4. Sign

```sh
sudo node scripts/sign-office-image-provenance.mjs sign --build /root/office-image/build.json \
  --acceptance /root/office-image/acceptance.json --key /etc/qorpera-office-signing/office-image-signing.pem \
  --out /root/office-image/signed
```

It changes nothing in LXD. It holds the two evidence files against each other: one image (the same record in the same
project), the same receipt, package manifest and spec, the build's labels, and an acceptance root no smaller than the
build's. Then it signs the `qorpera.lxd-office-image-provenance/v1` statement over its canonical JSON. The statement's
`evidenceSha256` is the acceptance file's sha256. It checks the envelope with the repository's own
`verifyLxdOfficeImageProvenance` and `assertLxdOfficePhysicalImage`, writes `statement.json`,
`office-image-provenance.json` (the envelope) and `policy-image.json` (each `0400`) into a new `0700` directory, and
checks the written envelope again. A refusal is one `OFFICE_IMAGE_SIGNING_*` code, naming the field it refused.

### 5. Pin the image (PROD CHANGE)

`policy-image.json` holds the fields of a physical policy (`lxd-office-physical-policy.ts`) that name the image:
`guest.imageFingerprint`, `guest.bootstrapSha256`, `host.architecture`, and `image.bytes`,
`image.guestPackageManifestSha256`, `image.statementSha256` and `image.verificationKeySpki`. The policy's
`guest.rootDiskBytes` must be at least its `minimumRootDiskBytes`.

As for A1 (its policy preparation, then `installOfficeFleetService` and the provider's enrolment): write those fields
into `qofleet01`'s policy, install it as `policy.json` with the envelope as `provenance.json` under
`/etc/qorpera/office-provider` (the office installation's documents; the spec pins the policy's sha256), and install the
fleet service. Review the policy's diff before applying it.

Add the new fingerprint to node-tidy's `keepFingerprints` before its 48 hours run out, and keep A1's there for the
rollback.

## Rollback

A1's image stays in `qofleet01`: `9a4935f853ae27b80bb8d2fd8cbe33d1cb3db68bbfe0d47469bb0ebdbbf20f01` (bootstrap
`f041e371…`). Keep A1's `policy.json` and `provenance.json`; installing them again, as in step 5, rolls back. Delete
the new image only after nothing names it.

## What it does not cover

- The workbench account of `qofleet01`'s policy (A1: 20048) is the host's; the image's office account is 20045 inside
  the guest, as in A1.
- The build evidence's sha256 is printed by the signer, not signed; the statement signs the acceptance's.
- node02, and any image but the office's.
