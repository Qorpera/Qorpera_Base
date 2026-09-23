# Node agent

Phase B of the node auto-update plan (`NODE-AUTO-UPDATE-PLAN-20260923.md` in the runtime takeover workspace, sections
B.0–B.9). Today every cut installs a new versioned launcher (`provider-launch-vNN.py`), env file
(`provider-env-vNN.json`), program file and systemd drop-in next to the old ones. The agent installs a signed **release**
*in place* of the running one instead, and keeps exactly one earlier release to roll back to.

This folder holds the agent, the fixed launcher, the release builder and their tests. Moving a node's roles onto it (a
release 0 built from what runs now, plus new units) is the separate migration step.

## Layout on a node

```
/opt/qorpera-node/releases/<revision>/     release.json, release.sig and the release files; folder 0555, files 0444, root
/opt/qorpera-node/current -> releases/<n>   what runs
/opt/qorpera-node/previous -> releases/<m>  the rollback
/opt/qorpera-node/agent/qorpera-node-agent.mjs
/usr/local/libexec/qorpera-node/qorpera-node-launch.py
/etc/qorpera-node/node.json                 per-role settings (root, 0444)
/etc/qorpera-node/keys/release.pem          the enrolled release public key (Ed25519)
/var/lib/qorpera-node-agent/journal/        one intent and receipt record per operation (root, 0700)
```

Each role's env file stays where and as it is today (root:<role group>, 0440) and keeps the node constants and secrets.
Token files the programs read themselves keep their paths, owners and modes.

## Release (`qorpera.node-release/v1`)

`release.json`, signed with the release key as `release.sig` (base64 Ed25519 over the exact bytes):

```
{ "schema": "qorpera.node-release/v1", "revision": 7, "previousRevision": 6,
  "sourceCommit": "<40 hex>", "runtimeBundleSha256": "<64 hex>",
  "order": "code-first" | "schema-first" | "either" | "pause",
  "files": [ { "name": "qorpera-lxd-provider.mjs", "sha256": "…", "bytes": 467376 }, … ],
  "roles": { "provider": { "component": "qorpera-lxd-provider.mjs",
                           "env": { "QORPERA_LXD_IMAGE_FINGERPRINT": "…",
                                    "QORPERA_LXD_IMAGE_PROVENANCE": "${release}/image-provenance.json", … } } } }
```

- `env` holds only per-release values: the image pin, provenance, guest manifest, runner and software version. The
  launcher replaces `${release}` with the release folder.
- `make-release.mjs --spec <spec.json> --key <private PEM> --out <folder>` builds and signs one.
- Until phase C, the release key is on the Mac next to the provenance key, a separate key, 0600. The coordinator signs
  after its go.

## Agent commands (root)

| Command | What it does |
|---|---|
| `stage <folder>` | Verifies the signature and every file, and that `previousRevision` is the current revision, then writes `releases/<revision>`. No service is touched. |
| `adopt <revision>` | Migration only: points `current` at the first release without restarting anything. |
| `apply <revision> [--defer <role>]… [--wait <s>]` | Runs the quiet gate (no run or login machine running; the exec host does not count), points `previous` at the old release and `current` at the new one, then restarts **only the roles whose program or values changed**. It verifies each role (see below). |
| `rollback` | Swaps back to `previous` and restarts what differs. |
| `switch <role> <old unit>` / `unswitch …` | Migration: moves a role from its old unit to its new one, or back (see below). |
| `restart <role>` | Restarts one role on the current release and verifies it. |
| `status` | JSON: current, previous, staged, and each role's unit, process and health. |
| `gc` | Deletes releases older than `previous`. Newer staged releases stay. |

**Verification after a restart.** The unit has a main process whose command line is exactly the role's `exec` plus the
current release's program. The role's health URLs answer. The journal since the restart has no launcher refusal
(`QORPERA_NODE_ROLE_START_REFUSED`).

**When a check fails:**
- If the release keeps the runtime bundle, the agent swaps back, restarts and reports `APPLY_ROLLED_BACK`.
- If the release changes the bundle, the agent stops and reports `APPLY_FAILED_NO_AUTOMATIC_ROLLBACK`. Rolling back after
  an activation is a release decision: re-activate the previous bundle and move every node back, under a pause.

**Other rules:**
- Mutating commands re-run themselves under `flock --nonblock /run/lock/qorpera-node-update.lock`. A held lock refuses
  with exit 75.
- `--defer orchestrator` keeps the orchestrator on its old process. While #212 is not live, a release with a pause
  restarts the orchestrator only after resume, with `restart orchestrator`.

## The fixed launcher

`qorpera-node-launch.py <role>` replaces the versioned launchers. It keeps their guards:
- **Process:** not root, all capability sets empty, NoNewPrivs, and optionally no supplementary groups.
- **Files it reads:** root-owned, an exact mode, one link, no symlinks, and every parent root-owned and not writable by
  group or other.
- **Env file:** the exact key set, fixed values equal to `node.json`, and token, sha256, JWT-role and denied-value checks.
- **Program:** its sha256 must equal the release's entry.
- **State folders:** owned by the role user, mode 0700.

It then execs `exec + [program]` with `PATH`, `HOME`, `LANG`, `LC_ALL` and the role's values, the same clean environment
as before. `current` must name `releases/<n>`, and that folder must be 0555 root.

The launcher does not verify the signature, because Python's standard library has no Ed25519. The agent verifies it
before it writes the immutable, root-owned release folder. That is the same trust root as today's root-installed pins.

## Migration: moving a role onto the agent (B.1, B.6, B.9)

These steps run per node: node 2 first, then node 1. They cover the provider and orchestrator, and the observer later
(B.9). Each step runs in a coordinator window, never while a cut lane is staged. The migration helper
`qorpera-node-migrate.py` (root) changes nothing by itself except `split-env`, which writes one new file.

1. **Release 0.** It describes what runs now:
   - the live provider bytes, and the orchestrator bytes on node 1;
   - the live image provenance JSON and PEM;
   - the per-release values from the live env file (fingerprint, provenance, guest manifest, runner version, software
     version, fence), with the provenance paths written as `${release}/…`.

   `make-release.mjs` signs it with the release key, `previousRevision: null`. Then run `agent stage <folder>` and
   `agent adopt 0`. Nothing restarts.
2. **Env and node config.**
   - Provider: `split-env --source <live env> --dest /etc/qorpera-node/provider.env.json --release-keys …` writes the env
     file without the per-release values, with the same owner, group and mode. The orchestrator's env file has no
     per-release values and stays as it is.
   - `role --launcher <live launcher> --release-keys … --unit qorpera-node-<role>.service [--env-file …]` prints each
     role's `node.json` entry from the launcher's pinned values. Write `/etc/qorpera-node/node.json` (root, 0444) with
     `restartOrder: ["provider", "orchestrator"]`.
3. **Launcher equivalence** (conditions b and c). `compare --old-launcher <live launcher> --role <role> --unit <old unit>`
   runs both launchers as the unit's user, with no capabilities and NoNewPrivs, and captures execve instead of executing
   it. It requires everything to match except the program path and the per-release keys: the same exec prefix, the same
   env keys, the same values. Values are never printed.
4. **New unit.**
   - `unit --old <old unit> --new qorpera-node-<role>.service --exec /usr/local/libexec/qorpera-node/qorpera-node-launch.py --role <role>`
     prints the old unit's effective settings, applying fragment and drop-ins with systemd's reset rules. An explicit
     `Key=` is kept. `ExecStart` runs the fixed launcher, and `Conflicts=<old unit>` is added.
   - Install it (0644 root) and run `daemon-reload`, without starting it.
   - `show-diff --old … --new …` must report no unexpected differences.
5. **Switch** in a quiet window: `agent switch <role> <old unit>`.
   - It stops and disables the old unit, then enables and starts the new one.
   - It verifies the command line (exactly `exec + current program`), health and the absence of refusals.
   - It records both command lines for the condition (c) diff.
   - A failed check switches back at once. `agent unswitch <role> <old unit>` does the same by hand.
6. **After the first real release applies cleanly** under the new units, archive the old unit, its `.d` folder and the
   versioned launcher, env and program files.

## Install

`install-node-agent.sh --release-key <public PEM> --release-key-sha256 <hex from the registry>` does three things:
- verifies the agent and launcher against its pins (a test checks the pins);
- enrolls the key;
- creates the folders.

It also installs the migration helper `qorpera-node-migrate.py` next to the launcher, and it changes no unit.

## Tests

`node --test deploy/node-agent/qorpera-node-agent.test.mjs` and
`python3 -m unittest discover -s deploy/node-agent -p 'test_*.py'`. The CI workflow `step2-lxd` runs both.
