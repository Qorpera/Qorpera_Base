# qorpera-folder

The company folder inside a Qorpera machine, and the node side of its link.

- `qorpera-folder mount`: shows one view of a company folder at a mount point (F3 step 1), over vsock to the folder
  service of the node the machine runs on. Memory and the kernel's page cache only. A view the node lets write is
  mounted read-write (F3 step 3, `deploy/first-node/RUNTIME-FOLDER-WRITES.md`): each change goes to the node as it is
  made and stays pending until a boundary publishes it; a file open for writing keeps only the chunk being written in
  memory (`src/writer.rs`); the mount's version map (`src/versions.rs`, in `--state-dir`, under `/run`) gives each save
  its base.
  Reading an existing empty file records its version at the read-only open, because the kernel can answer EOF
  without asking the program for bytes. A stale save still conflicts, both in place and through a temporary file.
  Writable files and folders belong to the mounting account by default. A root daemon can give their virtual
  attributes an explicit owner with `--owner-uid <uid> --owner-gid <gid>`; both are required together, and another
  account still needs `--allow-other yes` to access the mount. Only virtual ownership changes: the daemon keeps its
  identity and private view credentials and state files. Read-only views stay root-owned, with no writable bits.
- `qorpera-folder publish`: asks the node to publish what the view has pending, and prints each path's outcome.
- `qorpera-folder bridge`: on a node host, takes machines' vsock connections and hands them to the folder service's
  Unix socket, naming each machine's CID.
- `qorpera-folder relay`: on the execution host, carries a native host's connection (a Node program, without vsock)
  from its slot's socket to the node's bridge, byte for byte (the node's folder search).

Design, protocol and rollout: `deploy/first-node/RUNTIME-FOLDER-SERVICE.md`. The node side of the protocol is
`packages/object-gateway/src/folder-service/`.

Tests run in the pinned Rust image on the node 2 test machine (`node scripts/run-on-node.mjs changed`, step
`folder-program`); the FUSE tests need `QORPERA_FOLDER_FUSE_TESTS=1`, root and `/dev/fuse`. Release builds:
`node scripts/build-folder-program.mjs --out <file>`. Build output never goes in this folder (`CARGO_TARGET_DIR`).
