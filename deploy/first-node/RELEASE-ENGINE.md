# Declarative Release Engine (`scripts/release-engine/`)

Replaces per-release 312 KB bash script forks (`mk-laneNNN.py`, `cutNNN-roll.sh`,
`rolldrvNNN.sh`, `roll-dry-testNNN.sh`, `drv-stub-testNNN.sh`, and `fork-imageNNN.py`)
with one checked-in, tested, parameterized release engine driven by a small
declarative JSON manifest (`qorpera.release-manifest/v1`).

## Why

- **Eliminates the 33-42 minute per-release script-fork & review tax:** When the
  release engine lives once in `master` and is covered by `scripts/release-engine.test.mjs`,
  individual releases only author and audit a small declarative manifest (`release-vNNN.json`)
  plus migration anchors.
- **Eliminates bash SQL-quoting bugs permanently:** All SQL anchor and post-check
  queries use collision-free PostgreSQL dollar-quoting (`dollarQuote`), never
  bash double-quoted string interpolation (`v267` exit-87 class of bugs).
- **Enables fast release modes:**
  - `sql-only`: applies backwards-compatible SQL migrations with anchor checks,
    rehearsal, and post-checks (`target -> packets -> rehearse -> migrate -> models-read -> after-read`)
    without bumping the runtime bundle, rebuilding the 1.82 GB LXD image, or
    rolling either node (~2 minutes end to end).
  - `thin-runtime`: rolls a new runtime bundle and node release using the thin
    signed runtime bundle layer without rebuilding the base OS image.
  - `full-image`: runs the full rolling update and uses `lxc publish --compression zstd`
    instead of single-threaded gzip.
- **Adaptive watches:** `home-watch` (15 min) and `claude-watch` (15 min) only run
  when `codex-home` or `claude-box` files changed. All other runtime releases use
  a short `smoke-watch` that exits immediately once a real run completes cleanly,
  and still halts immediately (exit `83` / `85`) on any failure.

## Preserved Safety Invariants

- `armed: false` refuses live execution (`exit 2`), matching `CUT_VALUES=held`.
- `QORPERA_ROLL_TEST=1` refuses execution without `--dry-run` (`exit 2`).
- `WAY-BACK-STARTED` and `WAY-BACK-TAKEN` permanently lock the release directory
  from forward re-runs (`exit 2`).
- Non-retryable refusal exit codes (`77`, `78`, `79`, `81`, `82`, `83`, `84`, `85`,
  `87`, `88`) halt on try 1 with zero automatic retries; `web` runs at most once.
- `MERGE-HOLD` uses atomic temp-file + rename writes, restores prep holds on
  pre-write stops, keeps a 4-line truthful hold on post-write stops, and removes
  the hold only after `web` (or `after-read` in `sql-only` mode).

## Commands

```sh
node scripts/release-engine/cli.mjs init --from <prev-release-sha> --to HEAD \
  --prev-version 270 --prev-bundle <sha64> --prev-node-release 157 --out release-v271.json
node scripts/release-engine/cli.mjs validate --manifest release-v271.json
node scripts/release-engine/cli.mjs plan --manifest release-v271.json
node scripts/release-engine/cli.mjs anchor-sql --manifest release-v271.json
node scripts/release-engine/cli.mjs packets --manifest release-v271.json --out ./packets-v271
node scripts/release-engine/cli.mjs dry-run --manifest release-v271.json
```

For `sql-only` manifests, `packets` reads each migration directly from
`manifest.baseCommit` and writes a verified, single-transaction packet directory
(`00-check.sql`, `05-rehearse-migrations.sql`, `10-migration-*.sql`,
`20-post-check.sql`, and `packet.json`) ready for the coordinator's SQL packet
runner. Runtime cuts (`thin-runtime` and `full-image`) continue to emit full
rolling-update packets through `scripts/runtime-roll.mjs packets` (assisted by
`buildRuntimeRollPacketArgs` in `scripts/release-engine/adapters.mjs`).
