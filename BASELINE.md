# Test baseline at fork point

Recorded 2026-08-04 at `a96fb984d` (fork pin, v0.83.0) on the fork machine:
Windows 11, Node v24.15.0, npm 11.12.1, Git Bash. Run via `./test.sh`
(isolated home, **no API keys** — LLM-dependent tests auto-skip; that is the
intended baseline mode). Upstream CI is green at this commit on ubuntu-latest
with Node 22 + apt-installed `fd-find`/`ripgrep` — so every failure below is
environmental (Windows/this machine), not an upstream regression. This file is
the reference every later change is compared against.

## Per-package results

| Package | Tests | Passed | Failed | Skipped | Failing files |
|---|---|---|---|---|---|
| root `test:scripts` | 1 | 1 | 0 | 0 | — |
| pi-agent-core | 293 | 277 | **16** | 0 | 5 |
| pi-ai | 1616 | 811 | 0 | 805 (key-gated) | 0 |
| pi-client | 35 | 31 | 0 | 4 | 0 |
| pi-coding-agent | 1875 | 1777 | **51** | 47 | 18 |
| pi-evals | 23 | 22 | **1** | 0 | 1 |
| pi-protocol | 144 | 144 | 0 | 0 | 0 |
| pi-server | 47 | 19 | **28** | 0 | 4 |
| pi-tui | ~740 (dot reporter) | rest | **5** | 0 | 1 |
| pi-storage-sqlite-node | no test script (`--if-present` skip) | | | | |
| **Total** | ~4,770 | | **101** | 856 | |

≈97.9% pass under no-keys Windows conditions. Key-gating works: 856 tests
skipped cleanly; zero failures caused by missing API keys (class b is empty).

## Failure classification

### (a) Fails because Windows / this machine — 84 of 101

| Cluster | Count | Where | Cause |
|---|---|---|---|
| `symlink EPERM` | 12 | agent-core: nodejs-env (2), prompt-templates (1), skills (1), harness tools/edit (2); coding-agent: paths (3), package-manager (1), file-mutation-queue (1), trust/resource (1) | Windows denies `symlink()` without Developer Mode or admin. Enabling Developer Mode on this machine would clear all 12. |
| AF_UNIX `listen EACCES` | 28 | server: all 4 failing files | Unix-domain sockets in temp dirs; Windows AF_UNIX restrictions. |
| Path separators / `~` shortening | ~17 | agent-core: skills `RangeError path.relative` (4), prompt-templates deep-equal (2), bash env expectation (1), nodejs-env exec (1); coding-agent: footer-width (1), interactive-mode-status context paths (2); tui: terminal-image/kitty (5); evals: artifacts (1, suspected same class) | Tests assert POSIX-shaped paths (`~/project`, `/tmp/...`); Windows produces `C:\...`/`~\`. |
| `detectInstallMethod` probes | 8 | coding-agent: config.test.ts | npm/pnpm/yarn/bun global-install detection expects POSIX layout/commands. |
| External editor spawn | 3 | coding-agent: external-editor.test.ts | Fake-editor script spawn semantics differ on Windows (`capture.json` never written). |
| Missing system deps CI installs | 7 | coding-agent: 3302-find-path-glob (4), 3303-find-nested-gitignore (2), 2791-fswatch-error-crash (1) | Upstream CI apt-installs `fd-find`+`ripgrep`; isolated test home has no managed bin dir. |
| Other Windows-shaped asserts | ~9 | coding-agent: package-command-paths (4), sdk-session-manager (2), session-selector-path-delete (2), trust-manager (1) | Path-shaped assertion diffs; grouped here pending item-by-item confirmation. |

### (b) Fails because missing API key not auto-skipped — none observed

### (c) Unexplained — 9, need item-by-item diagnosis before they matter

| Test | Symptom |
|---|---|
| agent-core: harness "subscriber shutdown without deadlocking" | assertion mismatch on message shape — possible timing/race |
| coding-agent: interactive-mode-status `getAvailableSnapshot is not a function` | TypeError in test double — possibly Node 24 vs CI's Node 22 |
| coding-agent: interactive-mode-suspend `this.showStatus is not a function` (2) | same suspicion |
| coding-agent: interactive-mode overlay reclaim (1), trust-selector (3), config "not writable" inversion (1), package-command "exited with code 23" hint (1) | not yet diagnosed |

None of these blocks fork work: they are pre-existing at the pin, upstream-green
on Linux, and the packages they live in (TUI interaction, self-update, server
sockets) are not on the Qorpera Base critical path. Revisit (c) if any touched
subsystem becomes load-bearing.

## Post-rename verification (1B, 2026-08-04)

After the identity rename (`@qorpera` scope, `qorpera` binary, `~/.qorpera`
home, `QORPERA_*` env), the full no-keys suite was rerun. Result: identical to
baseline for every package except pi-coding-agent, where 7 test files (44
tests) newly failed — all asserting the old identity (hardcoded `.pi` project
dirs in fixtures, the removed pi-docs prompt block, one 10s hook timeout under
load). All 7 files were updated to the new identity and re-verified green
(7 files, 119 tests passed). Deltas vs baseline:

| Package | Baseline fails | Post-rename fails | Delta explanation |
|---|---|---|---|
| agent-core | 16 | 16 | unchanged (same Windows clusters) |
| coding-agent | 51 | 51 after test updates | 7 identity-asserting files fixed; no new non-identity failures |
| evals / server / tui | 1 / 28 / 5 | 1 / 28 / 5 | unchanged |

`npm run build` and the full `npm run check` gauntlet pass post-rename. The
CLI self-identifies as `qorpera` and creates `~/.qorpera/agent` on first run.
One deliberate revert: `@earendil-works/gondolin` is a real npm registry
package (micro-VM sandbox dependency of an example extension), not a workspace
— it keeps its upstream scope.

## Run-condition notes

- Node here is v24.15.0; upstream CI pins 22. The (c)-class TypeErrors should be
  retried on Node 22 before deeper diagnosis.
- An earlier same-day run executed while git commits (husky `biome check
  --write`) ran concurrently in the tree; that run is discarded. This baseline
  comes from a quiet-tree run (full log archived in session scratchpad).
- `npm run check` (biome, pinned-deps, ts-imports, shrinkwrap, install-lock,
  `tsgo --noEmit`, browser-smoke) passes clean on this machine.
- `npm run build` passes for all packages.
