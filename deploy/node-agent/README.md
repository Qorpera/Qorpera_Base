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
/opt/qorpera-node/current -> releases/<n>   the newest applied release
/opt/qorpera-node/previous -> releases/<m>  the rollback
/opt/qorpera-node/roles/<role> -> ../releases/<k>   what each role runs (a deferred role keeps its old release)
/opt/qorpera-node/agent/qorpera-node-agent.mjs
/usr/local/libexec/qorpera-node/qorpera-node-launch.py
/etc/qorpera-node/node.json                 per-role settings (root, 0444)
/etc/qorpera-node/keys/release.pem          the enrolled release public key (Ed25519)
/var/lib/qorpera-node-agent/journal/        fsynced intent and receipt records, one file each (root, 0700)
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
| `apply <revision> [--defer <role>]… [--wait <s>]` | Runs the quiet gate (no run or login machine running; the exec host does not count), then points `previous` at the old release and `current` at the new one. Then, **per role whose program or values changed**, it re-checks quiet, points the role's link at the release, and restarts and verifies the role (see below). |
| `rollback [--defer <role>]…` | Swaps back to `previous` and moves the roles that differ, the same way. A failed rollback is recorded. |
| `restart <role>` | Points one role at `current`, then restarts and verifies it. This is how a deferred role catches up after resume. |
| `status` | JSON: current, previous, staged, and each role's unit, process and health. |
| `gc` | Deletes releases that no role, `current` or `previous` uses, and prunes their journal records. Newer staged releases stay, and leftovers of interrupted operations (`.stage-*`, `.link-*`) are removed. |

**Verification after a restart.**
- Within one minute (polled every 500 ms), the unit's main process becomes exactly the role's `exec` plus the program of
  the release its link names. The launcher runs as that process first and then execs node, so a single early read would
  see the launcher.
- The role's health URLs answer.
- The journal since the restart has no launcher refusal (`QORPERA_NODE_ROLE_START_REFUSED`).

**When a check fails:**
- If the release keeps the runtime bundle, the agent swaps back, restarts and reports `APPLY_ROLLED_BACK`.
- If the release changes the bundle, the agent stops and reports `APPLY_FAILED_NO_AUTOMATIC_ROLLBACK`. Rolling back after
  an activation is a release decision: re-activate the previous bundle and move every node back, under a pause.

**Other rules:**
- **Lock.** Mutating commands hold an flock on `/run/lock/qorpera-node-update.lock`. `/run/lock` is world-writable, so
  the agent refuses a lock file that is not root-owned and root-only-writable (`NODE_LOCK_UNSAFE`), and a held lock
  refuses with exit 75. There is no environment bypass.
- **Deferral.** `--defer <role>` keeps a role's link, and so its release, where it was. A systemd restart of the role
  (a crash, or `RuntimeMaxSec`) starts that old release again, never the new one. `node.json` lists
  `pauseDeferredRoles` (the orchestrator, while #212 is not live), and a release with order `pause` that changes one of
  them must defer it. `restart <role>` after resume catches it up. An `apply` refuses while a role still differs from
  `current` (`APPLY_ROLES_STILL_DEFERRED`). Unknown `--defer` names are refused.
- **Quiet.** Quiet is checked at the gate and again right before each role restart. Nothing closes node admission yet
  (phase C), so a machine that starts in the seconds between the check and a restart is the one remaining window.

## The fixed launcher

`qorpera-node-launch.py <role>` replaces the versioned launchers. It keeps their guards:
- **Process** (checked before it reads any file): not root, all capability sets empty, NoNewPrivs; then no
  supplementary groups where `node.json` says so.
- **Every guard setting is required in `node.json`:** exec, env schema, and token, sha256, JWT-role and denied-value keys.
  A missing key refuses; it does not silently drop a check.
- **Files it reads:** root-owned, an exact mode, one link, no symlinks, and every parent root-owned and not writable by
  group or other.
- **Env file:** the exact key set, fixed values equal to `node.json`, and token, sha256, JWT-role and denied-value checks.
- **Program:** its sha256 must equal the release's entry.
- **State folders:** owned by the role user, mode 0700.

It then execs `exec + [program]` with `PATH`, `HOME`, `LANG`, `LC_ALL` and the role's values, the same clean environment
as before. The role's link must name `../releases/<n>`, and that folder must be 0555 root. A refusal prints one JSON line
with `state: QORPERA_NODE_ROLE_START_REFUSED`, the role, the error type and the frames.

The launcher does not verify the signature, because Python's standard library has no Ed25519. The agent verifies it
before it writes the immutable, root-owned release folder. That is the same trust root as today's root-installed pins.

## Install

`install-node-agent.sh --release-key <public PEM> --release-key-sha256 <hex from the registry>` does three things:
- copies the agent, launcher and key into a root-only temp folder, verifies those copies against its pins (a test checks
  the pins), and installs exactly those copies;
- enrolls the key;
- creates the folders.

It changes no unit.

## Tests

`node --test deploy/node-agent/qorpera-node-agent.test.mjs` and
`python3 -m unittest discover -s deploy/node-agent -p 'test_*.py'`. The CI workflow `step2-lxd` runs both.
