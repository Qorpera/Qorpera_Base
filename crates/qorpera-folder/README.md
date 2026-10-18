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
its program keeps the old one. `/run` survives program and service restarts, not a VM restart.

For desktop view changes (F3 4c-3), keep one explicit `--state-dir` across atomic replacements of `--view-file`,
restarts and publisher calls. A private `view.json` beside the journal records the last accepted credentials. The
next hello proves that old view before checkpointing its successor; a crash between the primary file's replacement
and hello therefore retains the proof needed to move pending work. The node accepts only a same-company,
same-machine desktop transfer. Open handles, conflict bases and unreleased reads stay; every connection belongs to
one accepted epoch, so old replies and refusals cannot enter or close its successor. A closed desktop enters a fixed
one-minute grace awaiting an accepted successor, then exits 3. A bad replacement does not extend that grace.

The daemon holds a fixed private `daemon.lock` for its entire lifetime, before any state or connection mutation.
A publisher that finds it busy leaves open writers alone, even if all service streams disconnected. A publisher
that acquires it holds the lock through its authenticated `abandon` hello and boundary, excluding a daemon restart
while orphan handles are abandoned back to their last fixed saves. A writable mount sends the same request once, on
one IO hello after its feed accepts the view and before it serves a file, so what a program before it on the same
state left open (one systemd restarted after a crash) goes back too; no later hello of its own carries it.
Protocol-3 handles survive stream loss; only this explicit request abandons them. A publisher never creates missing
state or lock files. The service fences and
drains admitted old work before moving pending state, keeps a closed desktop for its fixed minute, restages files
under the successor's upload scope, and replays any unanswered commit with its original actor and operation key.
The office helper and live activation remain separate slices of `RUNTIME-FOLDER-COMPANY-MACHINES.md`.

The mount speaks protocol 4 (folder links LK4, `deploy/first-node/RUNTIME-FOLDER-LINKS.md`), so the company folder
holds links. `readlink` reads the target with `R` at the link's version and logs it as a read, as an open is; the
kernel caches no target (`FUSE_CACHE_SYMLINKS` stays off), so every readlink is logged. `symlink` keeps the target
exactly as written and refuses one that is not UTF-8 (`EINVAL`). `link` (a hard link) logs a read of the source at the
version shown and sends `J` with it; the new name is an inode of its own with one link, so the names are never joined.
A link shows as `l` with mode `0777`; `chmod` and `touch -h` on one change nothing. `mknod`, `mkfifo` and a socket's
bind stay `EPERM`.

Git on the mount (F3 step 5d; `RUNTIME-COMPANY-FOLDER.md` §6, `RUNTIME-FOLDER-CODING-MACHINES.md`). In a code area's
`code/<owner>/<name>/repo.git`, the session's own git files (`config`, `hooks/**`, `info/**` and each worktree's
`config.worktree`) live on the machine's disk under `--local-dir` (default `<state-dir>/local`, `src/local.rs`): seeded
from the published copy when first used, never published, so a hook one session writes runs in that session alone.
The company's code host keeps none of them on its disk: its `code_host` view (the node says so in its hello answer)
writes and publishes the copies the sessions seed theirs from. It writes the other shared files no lease guards
(`HEAD`, the probe files `git init` makes) as plain files too, so `git init` makes a new `repo.git` there; a ref,
`packed-refs` (and the `packed-refs.new` `git pack-refs` renames onto it), `shallow` and a ref's log change under their
lease for it, as for a session. A new `repo.git` reaches the folder at a boundary before its first ref's lease
publishes (the core makes only the folders below `repo.git`).
Cache folders in a worker's worktree (`node_modules`, `target`, `dist`, `build` and the rest of `src/git.rs`'s list)
live there too, kept out of the company folder. The program reads the worktree's index (`src/index.rs`) each time git
renames a new one into place; a name the index holds as a folder leaves that worktree's list for good
(`src/cache.rs`, kept in `local/cache-left.jsonl`), and its files move into the mount as pending files (its links as
the folder's links), each file written as a draft: in the folder only once its close lands it. A move
that fails is tried again every few seconds and at the worktree's next index, after a restart too; until none is left,
`<state-dir>/caches.moving` is there and `publish` refuses. Under
`repo.git`, objects aside, every lookup asks the node (no kernel cache), and an exclusive create of a ref's,
`packed-refs`' or `shallow`'s lock drops what the kernel holds of that file, its log and `packed-refs`, so git reads the
versions the node's lease answered with; under `packed-refs`' lock the mount also forgets its listings of `refs/` and
the folders below it, as git then walks the loose refs, which the node read the feed for (`src/mount/on_disk.rs`).
`objects/info/alternates` and changing an object's times answer EPERM. The lock protocol itself (the lease on a lock's
create, the publish on its rename or removal) is the folder service's
(`packages/object-gateway/src/folder-service/git.ts`).

The machine's caches (`deploy/first-node/RUNTIME-FOLDER-MACHINE-CACHES.md`) live in `<local-dir>/caches`, or, given
`--cache-dir <dir>`, in `<dir>/caches`, shared by every mount on the machine given that folder. Its starter makes the
folder: an absolute path of at most 80 bytes, a folder (not a link) only the mounting account can use, neither inside
the local folder nor holding it. The program never makes it; a writable mount given one it cannot use exits 1 with a
line starting `qorpera-folder: FOLDER_CACHE_DIR_UNUSABLE: <dir>:`. Every mount sharing it runs as the same account.
Each mount takes what it removes off the disk through its own `<dir>/gone/p-…` folder, which it holds locked; one that
starts takes off those no mount holds. A mount sharing the folder keeps the caches of a folder its own view has not,
as another view may have made that folder and not published it yet: they go when removing old caches finds the folder
gone ("Removing old caches"). A cache move seals its file for every mount sharing it: each handle that changes a cache
file's bytes holds a shared lock on it, which the seal takes exclusively, without waiting; a rename or removal of the
file in another mount waits for the seal, and so do a placed file and its undo. Every check and change of names in the
caches (a create, rename or removal, a cache move and the removal after it) holds an exclusive lock on `<dir>/names`,
so no mount changes a name between another's look and its change. A local file's folder is reached from its area's top
one folder at a time, never through a link, each checked to be the folder the kernel asked of (`ESTALE` if not), and
the change is made in that folder. Up to 64 folders reached lately are held open and used again only while the kernel
names each where the mount's names say (`/proc/self/fd`); one moved, or with a link or another folder in its place,
is walked to again. A local file's mode, size and times change, and a link's target is read, on
the file itself: through the handle the change came with, else by its name checked to be the inode the kernel asked of
(`ESTALE` if not), never through a link (a link's mode is `EOPNOTSUPP`); a create never follows a link (`ELOOP`). A
file on another disk than its area's (one mounted in the folder) is not shown (`EXDEV`). A node folder's rename moves
its caches under an exclusive lock on `<dir>/caches`, which a mount takes before it looks again for caches another
mount may have moved meanwhile, and the mount that moved them tells the others before its reply (`EIO` if one does not
answer).

Cache files have a kernel cache (`src/mount/kernel.rs`, the plan's "The kernel cache"): names, absent names and
attributes for `--ttl-seconds` (a cache top's while the feed is up), and the pages of a read-only open of a file as
this mount last opened it. A mount's own changes the kernel did not see raise its epoch. Every other mount on the
cache folder listens on `<dir>/programs/<pid>.<nonce>`, and each change is told to all of them before its reply; a
told mount drops the inode's attributes, raises its epoch for a name its kernel may hold, and answers, then drops the
pages on another thread. A mount keeps a table of the names in local folders it handed its kernel (lookups found and
absent, its own creates, renames and removals), each from before the disk read until 60 seconds past the time-out it
handed; a cache top's name always raises the epoch. The table holds at most 100 000 names (about 4.3 MB); full, it
lets go of the expired ones, or of all of them with an epoch. `QORPERA_FOLDER_TEST_NAMES=<n>` makes it smaller and
`QORPERA_FOLDER_TEST_SLOW_LOOKUP=<name>` holds a lookup of that name for 300 ms after its disk read, in tests. The
program uses the kernel cache only when the kernel granted `FUSE_AUTO_INVAL_DATA` and has the epoch
notify (FUSE 7.44), on a writable mount whose cache folder changes a file's times at each write; otherwise, and for
good after a notify fails, a told change comes late or a mount no longer hears the others, it runs without (zero
time-outs for cache tops, and for every cache name on a shared cache folder), and drops all it handed the kernel. Its
log says `qorpera-folder: kernel cache on` or `kernel cache off: <why>`. `QORPERA_FOLDER_TEST_KERNEL_OFF=<why>` turns
it off in tests. A mapping in another mount sees a change shortly after it (the page drop), not at once.

At its end (the view's close, a SIGTERM, a fall-back that exits, or the kernel ending the session; with or without the
kernel cache) the program first refuses every request (`EIO`, before any lock), then has the kernel drop the attributes
and pages of every inode ever opened through the mount (each open, of a file or a folder, and each create notes its
inode, then checks again before its reply), on a thread of its own while its loops go on answering, for at most 15
seconds; then it unmounts and exits. Its log says `qorpera-folder: closing: dropped the kernel's pages of <n> files in
<ms> ms`. A process holding the view then reads, stats and opens nothing more through the fds it holds, and a
mapping's next touch gets `SIGBUS`. A page a process pinned before the end stays its own, a shared mapping's pages not
written back are lost (`msync` and `fsync` give `EIO`), and a folder or file held without an open (a working folder,
an `O_PATH` fd) keeps its attributes until their time-out. A SIGKILL before the drop is done ends the session with the
pages not yet dropped still held.

Tests run in the pinned Rust image on the node 2 test machine (`node scripts/run-on-node.mjs changed`, step
`folder-program`); the FUSE tests need `QORPERA_FOLDER_FUSE_TESTS=1`, root and `/dev/fuse`. Release builds:
`node scripts/build-folder-program.mjs --out <file>`. Build output never goes in this folder (`CARGO_TARGET_DIR`).
