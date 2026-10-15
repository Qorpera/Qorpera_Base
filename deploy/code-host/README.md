# The code host image (5e)

Every company's code host starts from this image: the one VM per company and node where the coding executor works on
the company's code area through its folder (`packages/runner-orchestrator/src/code-host.ts`). The executor makes it
in the company's own LXD project, `qorpera-codehost-<company hex>`, with no NIC, no profile, no `/dev/lxd`, the
policy's image and limits and a scratch root disk; the code area itself lives in the folder.
`build-code-host-image.sh` builds the image on a node and `test/prove-code-host-image.sh` proves it, with the
executor's code hosts and the node observer's view of them, on a test machine. It is a small image of its own, not
the coding machines' (`../coding-machine/`): a code host runs only git and the folder program.

## What the image holds

| Part | Why |
|---|---|
| Ubuntu 26.04 minimal without cloud-init | A code host has no `/dev/lxd`, so cloud-init would wait for it at every boot. The image brings what is left of its work: the hostname `qorpera-code-host` and `qorpera-grow-root.service` (from `../coding-machine/`), which grows the root file system to the code host's disk at boot. There is no network configuration (no netplan file) and nothing waits for a network (`systemd-networkd-wait-online.service` is masked). The executor reaches the code host only through LXD exec; the LXD agent runs without cloud-init. |
| git 2.56.0, the only git | Built from the coding machines' pin (`../coding-machine/coding-image.json`) into `/usr/local`, with its Rust parts, as there. A code host has no network, so it has no transport but local files and bundles: no curl, expat or OpenSSL, and no Perl, Python, Tcl/Tk or translations. `/etc/gitconfig` is its system configuration, and the image has none. The build checks what 5e's jobs do with it: a bundle in, a locked worktree, a ref transaction, gc and fsck. |
| The folder program and FUSE | `/opt/qorpera-folder/qorpera-folder`, root's and mode 0555: exactly the build `../folder-service/folder-program-linux-x64.json` records (size and sha-256 checked before the builder starts and again inside it). `fuse3` for its mounts (`/dev/fuse`, `fusermount3`); it reaches the node over the VM's vsock. |
| Places for 5e's jobs | `/company` (empty, mode 0755), where the company folder is mounted (the jobs' `companyRoot`), and `/var/lib/qorpera-code-host` (root's, mode 0700), the jobs' `scratchRoot`. `/usr/local/libexec/qorpera-coding` holds the grow-root script. |
| What is gone | apt's five self-update units are masked. snapd, openssh-server, the cloud image's own git, cloud-init, the `ubuntu` account and cloud-init's sudoers file are removed, and so are the cloud image's LXD metadata templates, which would write `/etc/hostname`, `/etc/hosts` and cloud-init's seed into every code host, naming each after its instance. The packages the build installed to make git (the compilers among them) are purged again, exactly those: the build refuses if the image's package list differs from before it. The build's logs, caches, apt lists, machine id and SSH host keys are cleared before the image is published. |

## Build it on a node

The coordinator runs these on the node, at a cut:

1. The folder program: `node scripts/build-folder-program.mjs --out qorpera-folder` (in Docker, with the pinned Rust
   image). The same source and image give the same bytes, the ones the folder program's record names; the image
   build refuses any other.
2. The image, in the node's image build space while it is empty (on node 2, `qorpera-build` and `qorpera0`):
   `deploy/code-host/build-code-host-image.sh qorpera-build qorpera0 qorpera-vm qorpera-folder > code-host-image-build.json`
   - The builder is a build machine as `../coding-machine/build-coding-image.sh`'s is: no profiles, its own 10 GiB
     root (the smallest code host disk, since a VM's root can't be smaller than its image), 4 CPUs and 4 GiB, the
     isolation NIC, `boot.autostart=false`, `user.qorpera.image_builder=true`, and it is deleted on every exit path.
     The script refuses while the space holds anything else.
   - Code host projects use the default project's image store, so the image goes there (exported and imported, with
     the same fingerprint, when the build space has its own store; the build space keeps no copy).
3. The record (`qorpera.code-host-image-build/v1`) names the alias, the image's fingerprint, the bootstrap digest (the
   script, the git pin, the folder program's record and every file it installs), git's version, the folder program's
   sha-256 and the 10 GiB root minimum.
4. The fingerprint goes into the node inventory policy's `codeHosts.imageFingerprint` and the coding executor
   configuration's `codeHost.imageFingerprint`, with the same block in both (`storagePool`, `cpus`, `memoryBytes`,
   `rootDiskBytes` of at least 10 GiB, `running`). Without that block the executor makes no code host and the
   observer accepts none.

## Proof on the test machine

```
node scripts/run-on-node.mjs --machine node02 --sudo --build --no-status -- \
  bash deploy/code-host/test/prove-code-host-image.sh </dev/null
```

It runs only on a test machine (`qorpera-testvm-*`), as root. It builds the folder program, then the image in a
throwaway build project with its own image store, with the builder's NIC filters off (`QORPERA_BUILDER_NIC=plain`, so
LXD adds no nft rule) and downloads through `../coding-machine/test/proof-proxy.py`, as the coding image's proof does.
The image goes into the test machine's default store, as on a node.

Then `test/prove-code-host.ts` (Node, from the repository's TypeScript, hence `--build`) makes three new companies'
code hosts with the executor's own `LxdCodeHosts` on the test machine's LXD, under a policy of one code host running
at a time, and checks each step against LXD and against the node observer (`reconcileRuntimeNodeInventory`):

- A's first job makes A's project, with exactly the code host settings, and A's code host, exactly as the policy makes
  it (no NIC, no profile, only its root disk). `test/prove-in-code-host.sh` runs inside it: only the loopback link and
  no `/dev/lxd`; it booted to running without cloud-init and grew its root to the disk; its own machine id and the
  policy's processors; git, a git round trip in the scratch place, the recorded folder program, FUSE and vsock; no
  cloud-init and no compilers; apt's self-updates masked; the commands the jobs run. The observer accepts the code host
  under the policy, and calls it unregistered under other limits or with no code hosts in the node policy. A's code
  host is not removed while its job runs.
- B's first job stops A's idle code host first; B's has a machine id of its own and no network. The observer accepts
  both. The executor's end stops B's, and a closed executor starts no job.
- A new executor under wider limits (a cut) makes A's code host again, with the new limits; the observer then calls
  B's old one unregistered. The next executor's housekeeping stops A's, deletes B's outdated code host (keeping its
  project) and refuses C's project, which the proof made with one setting changed: it touches nothing there, and a job
  for C is refused.
- Removing the companies deletes A's code host and project and B's empty project, refuses C's, and finds nothing the
  second time.

The test machine's modules, sysctls, nft ruleset, links and LXD state are listed before and after
(`../coding-machine/test/host-state.sh`, shared with the coding image's proof); any difference fails the run. The
proof's projects, code hosts and image are deleted at the end, also when it fails. Other runs that make links on the
test machine's bridge or add images to its default store at the same time would fail the comparison, so it runs alone
there (not together with the coding image's proof).
