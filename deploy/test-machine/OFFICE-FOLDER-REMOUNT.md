# Office folder remount proof

This is the Q3 proof for F3 step 4d in
[`RUNTIME-FOLDER-COMPANY-MACHINES.md`](../first-node/RUNTIME-FOLDER-COMPANY-MACHINES.md):
when systemd restarts the office's company folder program, do the office
namespaces that are already running see the new mount? It is not completion of
4d, an office image release, or live-company acceptance.

The real `qorpera-folder` program runs under master's mount unit. Only the unit's
paths are moved to #1047's `/run` layout, and it talks to a synthetic protocol-3
node on a Unix socket. The office namespaces are started by the runtime's own
process gate (`cloud-company-computer-linux-process.ts`, types stripped) with
mirrored bubblewrap arguments, from a relay that carries every confinement line
of master's office unit. No plumber, credentials, vsock identity, SQL or model is
claimed.

## Run

All builds and checks run through `run-on-node`, not on a developer Mac. The
staged office images stay on node01's test machine, so the wrapper refuses any
other host. Start it from a clean, pushed tree:

```sh
node scripts/run-on-node.mjs --machine node01 --sudo --no-install --no-status -- \
  bash scripts/prove-office-folder-remount-vm.sh [--image <fingerprint>] </dev/null
```

The wrapper:

- checks the staged unified image `/var/lib/qorpera-office-stage/<fp12>/img.tar.gz`:
  a regular file, not a link, whose sha256 is the fingerprint;
- creates its own LXD project and directory-backed pool, imports the image into
  that project only, and boots a VM from it with no profile and no NIC
  (`-d root,size=81GiB`, since A1's disk is 80 GiB; the dir pool keeps it sparse);
- installs nothing in the guest. It loads the FUSE module only inside the nested
  VM, and only if `/dev/fuse` is missing (`fuse: loaded`, else `present`);
- builds the folder program and requires its sha256 to match
  `deploy/folder-service/folder-program-linux-x64.json`;
- runs `scripts/test-office-folder-remount.mjs --execute` against the VM.

Its trap deletes only what it created: the VM, every image in its own project,
the project and the pool. It then prints the evidence JSON between
`OFFICE_FOLDER_REMOUNT_EVIDENCE_BEGIN` and `OFFICE_FOLDER_REMOUNT_EVIDENCE_END`
and fails the run if the test machine changed. The before/after diff covers its
links, nft tables, forwarding and conntrack sysctls, `br_netfilter`, its kernel
modules (none gone; no bridge, tun, macvtap, vhost or fuse module new) and a
`stat` of the stage folder and its files.

The launcher refuses to run unless the guest is a separate KVM boot, the office
service is stopped, and both `/etc/qorpera-office/credentials` and
`/etc/qorpera-office/boots` are empty. It records the file names it finds there,
never their contents. The fixture's preflight checks again inside the guest.

## The image under test

The default image is A1: fingerprint
`9a4935f853ae27b80bb8d2fd8cbe33d1cb3db68bbfe0d47469bb0ebdbbf20f01`, built at
commit `c1ac31535`. **A1 predates folder-v2.** The proof therefore does not use
any folder program or folder unit the image may carry:

- the `qorpera-folder` program is built from this tree and pushed in;
- the mount unit is master's `deploy/folder-service/qorpera-folder-mount@.service`,
  pushed in, with only the lines that name `/etc` and `/srv` moved to #1047's
  `/run` layout, the synthetic node's socket, and no `[Install]`. It still runs
  as root with `CapabilityBoundingSet=CAP_SYS_ADMIN`, `Restart=on-failure`,
  `RestartSec=5s` and `RestartPreventExitStatus=3`;
- the relay takes its confinement lines from master's
  `deploy/lxd-company-computer-guest/qorpera-company-computer.service`, pushed in.

What A1 itself supplies is the kernel, systemd, bubblewrap, tini, node, python,
the mount tools and `fusermount`, the `qorpera-office` account, and how `/run` is
mounted. The record keeps what the image carries beside master's: the installed
office unit's sha256 and its diff against master (`officeUnitSha256`,
`officeUnitAgainstMaster`), what is in `/opt/qorpera-folder` and which
`qorpera-folder*` units exist (`imageFolder`), `/run`'s mount options
(`runMount`) and which of `fusermount` and `fusermount3` exist.

4d's acceptance reruns this harness on the 4d generation with
`--image <fingerprint>`, once that image is staged. Building that image is 4d's
work, not this proof's.
