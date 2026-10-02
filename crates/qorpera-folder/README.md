# qorpera-folder

The company folder inside a Qorpera machine, and the node side of its link.

- `qorpera-folder mount`: shows one view of a company folder at a mount point, read-only (F3 step 1), over vsock to
  the folder service of the node the machine runs on. Memory and the kernel's page cache only. A run box's mount
  (`--reads systemd`, F3 step 2b) also logs every version the box opens or lists, with its read receipt, and gives
  the log to the run's native host on the socket systemd passes it (`src/reads.rs`: take after a number, acknowledge
  up to one, under the program's own log id).
- `qorpera-folder bridge`: on a node host, takes machines' vsock connections and hands them to the folder service's
  Unix socket, naming each machine's CID.

Design, protocol and rollout: `deploy/first-node/RUNTIME-FOLDER-SERVICE.md`. The node side of the protocol is
`packages/object-gateway/src/folder-service/`.

Tests run in the pinned Rust image on the node 2 test machine (`node scripts/run-on-node.mjs changed`, step
`folder-program`); the FUSE tests need `QORPERA_FOLDER_FUSE_TESTS=1`, root and `/dev/fuse`. Release builds:
`node scripts/build-folder-program.mjs --out <file>`. Build output never goes in this folder (`CARGO_TARGET_DIR`).
