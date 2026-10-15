# Office image candidate

`scripts/build-office-image-candidate.sh` builds a candidate office image for F3 step 4e in
[`RUNTIME-FOLDER-COMPANY-MACHINES.md`](../first-node/RUNTIME-FOLDER-COMPANY-MACHINES.md). It is a nested proof on
node01's test machine, not an office image release. The coordinator builds and rolls the real image.

## Run

From a clean, pushed checkout:

```sh
node scripts/run-on-node.mjs --machine node01 --sudo --no-status -- \
  bash scripts/build-office-image-candidate.sh [--stage] </dev/null
```

It needs the default `--install` (esbuild and the packaged Playwright come from `npm ci`). It refuses any machine but
`qorpera-testvm-node01`, a remote LXD, a base that is not the staged split image named by
[`office-image-dependencies.json`](../lxd-company-computer-guest/office-image-dependencies.json), and less than
32 GiB free for LXD. KVM and `vhost_vsock` must already be loaded; the run never loads a module. Before it creates
the VM it waits until the test machine has 6 GiB available, so the 4 GiB VM never pushes a test run out of memory.

## What it does

1. It claims a new LXD project (`qoc-<random>`) with its own directory pool, imports the staged base there and boots a
   VM with no profile, so no network card. It checks that the VM has no link but `lo`.
2. The test machine fetches everything the VM installs. apt resolves the recipe's packages against the VM's own
   package database and archive sources, with private lists; the test machine's own apt state is neither used nor
   changed. apt checks each deb against the archive's signed lists. Each pinned download is checked against its
   sha256. The recipe's own Node.js fills an npm cache with `typescript` and `tsx`.
3. In the VM, [`install-office-image-dependencies.sh`](../lxd-company-computer-guest/install-office-image-dependencies.sh)
   installs them offline: the debs, Node.js under `/usr` (one `/usr/bin/node`), Chrome for Testing at
   `/usr/lib/qorpera-chromium`, uv, mise and `fd`. It masks the self-update units and turns swap off for good. Then
   it runs every toolbox check as root, and `fusermount3 --version`: FUSE is root's (the folder helper mounts), so it
   is not in the toolbox.
4. The office package installer runs from the checkout's package ([`INSTALLATION.md`](../lxd-company-computer-guest/INSTALLATION.md)):
   `--measure-dependencies`, a spec for uid and gid 20045 (the A1 office account), `--check`, then `--apply`. It
   leaves the office service disabled.
5. The toolbox probe (`packages/runtime/test/fixtures/company-computer-linux-toolbox-probe.ts`) runs as the office
   account in a `systemd-run` unit carrying the installed office unit's 31 confinement and limit settings. It starts a
   computer's shell host, which runs the image's `/usr/bin/node` through its read-only `/usr` and refuses any
   capability, a missing `no_new_privs` or limits above the office unit's. The shell finds that Node.js and no swap,
   then runs every toolbox check of the recipe; each must exit 0 and print a version. The build fails on any AppArmor
   `file_inherit` denial while the probe runs: the command lost a descriptor on exec, so its output may be missing
   although it exited 0. Then, as root and outside any sandbox, it records the VM's kernel, `fusermount3`'s AppArmor
   mode and its version through Node's stdio (UNIX socketpairs, as the shell host's) and through a pipe. That record is
   evidence only.
6. It checks that the office service is still installed, disabled and never started. The node's activation starts it
   (preparation, then the service-start request); its credentials exist only once preparation writes them for a boot.
7. It removes the build inputs, cleans cloud-init and the journal, stops the VM and publishes the candidate in the
   claimed project.

On exit it deletes the VM, every image in the project, the project and the pool. It compares the test machine's links,
nft tables, network sysctls, modules and the staged base before and after, and fails on any difference.

## What stays

Without `--stage`, nothing: the candidate is deleted with the project. With `--stage`, the candidate is exported
unified to `/var/lib/qorpera-office-stage/<first 12 of its fingerprint>/img.tar.gz` (root, `0400`, in a `0700`
directory) for the folder remount proof (`--image <fingerprint>`). A failed run deletes its own stage, never an earlier
one. Staged images stay on node01's test machine: never copy them off, import them into a node host's LXD or publish
them.

The evidence between `OFFICE_IMAGE_CANDIDATE_EVIDENCE_BEGIN` and `OFFICE_IMAGE_CANDIDATE_EVIDENCE_END` gives the base
and candidate fingerprints, the stage path, the recipe and package manifest hashes, the size of the apt closure, the
installer's dependency measurements, the toolbox's first lines as root and from the shell, root's `fusermount3`
version, the AppArmor denials while the probe ran, the `fusermount3` record as root, and the office unit's state.

## What it does not cover

- Until 4e-2, the image has no folder program, helper or folder units.
- Why `fusermount3 --version` printed nothing from a computer's shell (and exited 0) in an earlier candidate. On
  node01's test machine itself it prints through Node's stdio. The `fusermount3` record as root narrows it down;
  any change to the shell host or to an AppArmor profile is product design, outside this slice.
- The installer's measurements pin the office's own executables, not the toolbox. The recipe pins the inputs and the
  candidate's fingerprint pins the result.
- Provenance and signing are unchanged; the coordinator's release of the real image covers them.
