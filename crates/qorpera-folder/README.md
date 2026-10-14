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
- `qorpera-folder publish --view-file <file> --state-dir <dir> [--final] [--json]`: hands over the mount's retained
  read log, then asks the node to publish what the view has pending. This works after the mount program died too.
  Use the mount's exact existing state directory: a missing directory fails locally without contacting the node or
  creating lost proof. A missing or damaged journal inside an existing state directory still marks that mount lost.
  `--final` asks a command's last boundary, and success requires its answered `closed: true` report. By default each
  path's outcome is printed; `--json` prints only the service report on stdout, with diagnostics on stderr. Exit 0
  means every path saved and the captured read prefix was released, 1 is failed or unknown, 2 is usage, 3 means the
  node closed/refused the view, and 4 means a path or the boundary was refused (including an unproven read log).
  An answered report is preserved even if its release poll or final closure check fails (exit 1), so unique conflict
  receipts and parked outcomes reach the caller. Exit 1 or 3 may have no JSON report; the exit code remains authoritative. A boundary without an answer is retried
  by the caller, never silently treated as an empty success.
- `qorpera-folder bridge`: on a node host, takes machines' vsock connections and hands them to the folder service's
  Unix socket, naming each machine's CID.
- `qorpera-folder relay`: on the execution host, carries a native host's connection (a Node program, without vsock)
  from its slot's socket to the node's bridge, byte for byte (the node's folder search).

Design, protocol and rollout: `deploy/first-node/RUNTIME-FOLDER-SERVICE.md`. The node side of the protocol is
`packages/object-gateway/src/folder-service/`.

Writable mounts on protocol 3 log each file open (including cached and empty files) and each non-root directory open before FUSE
answers it, with the version and authority receipt the mount showed. A failed append returns EIO. `src/reads.rs`
keeps one UUID and consecutive sequence in the private state folder, syncing each append. A fixed lock file excludes
mount threads and separate publishers across processes. The journal lock covers the same-connection `I`/`i` exchange
and every subsequent mutation's send, so every earlier completed open is taken before any save derived from it.

Each connection sends only the reads beyond both its own `taken` watermark and the journal's released prefix. It
sends an initial intake even when empty, then skips empty intakes unless the journal becomes lost. Batches jump
directly to their consecutive suffix. `taken` is only service memory: reconnects resend every retained entry. Only a synced `released` marker permits
forgetting a prefix; compaction replaces the journal while preserving the lock inode. After an ordinary `P`, an empty
`I` polls the released watermark before reporting success, including no-write boundaries. A torn unanswered final
append is trimmed, but a missing or damaged journal is permanently marked lost and sent as `lost: true` after each
reconnect. No later boundary can rehabilitate that mount. A fresh mount needs a new empty state folder; restarting
its program keeps the old one. `/run` survives program and service restarts, not a VM restart. Switching views and
helper-managed mount lifetimes are separate slices of `RUNTIME-FOLDER-COMPANY-MACHINES.md`.

Tests run in the pinned Rust image on the node 2 test machine (`node scripts/run-on-node.mjs changed`, step
`folder-program`); the FUSE tests need `QORPERA_FOLDER_FUSE_TESTS=1`, root and `/dev/fuse`. Release builds:
`node scripts/build-folder-program.mjs --out <file>`. Build output never goes in this folder (`CARGO_TARGET_DIR`).
