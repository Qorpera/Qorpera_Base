# Codex 0.155.1 (patched): the first production run

Date: 2026-10-16. **A production run on the pinned patched Codex 0.155.1 completed with a real model.** This
records the cloud acceptance of that one executable (P7 item P1-9).

`linux-x64-artifact.json` keeps its build-time `cloudAcceptance: not_performed`. It is an input to runtime bundle
generation (`scripts/generate-cloud-runtime-bundle.mjs`), so recording an acceptance there would change the bundle it
was accepted in. This file is the record instead.

## The executable

| | |
| --- | --- |
| Source | Codex `rust-v0.155.1` (commit `be2951ea34f0d295ed0becf97079f92fa5f6950e`) plus `0001-cloud-result-fence.patch`, as pinned in `source.json` |
| Executable | 318,891,312 bytes, SHA-256 `1c08fd015e7fe80bd813cccd73bc4331a01796479df77e16ac202d33ba3b460c` (`linux-x64-artifact.json`) |
| Test VM proof | [linux-x64-0.155.1-native-proof.json](linux-x64-0.155.1-native-proof.json): 34 of 34 native tests and the three entrypoints, scripted loopback provider, no login |

## The release

v179, live in production since 16 Oct 02:41Z: release ref `bdd776dbd` (#1178), runtime bundle `qorpera.cloud-runtime`
SHA-256 `d1e125c8bf6a72c6b4d6c89de6c1d5611de3c9d9c817f7fc14446f439fb19aeb`. That bundle's manifest
(`supabase/migrations/20260928549990_runtime_bundle_activation_v179.sql`) pins `nativeBinarySha256` =
`1c08fd015e7fe80bd813cccd73bc4331a01796479df77e16ac202d33ba3b460c`.

## The run

The coordinator ran it and read the results from production rows, read-only.

| | |
| --- | --- |
| Company | Qorpera Live Test, profile `10c3ee8c-184d-4884-9080-dbaaf46e6fb1` |
| Agent | Operations & Economics, `918a9323-3267-4381-a73f-05cb01b2ed22` (room `ed104232-4bb2-4e84-8955-a529658e5c0a`, session `d0c8a773-174d-4ad0-a90b-e0b04e42db8d`) |
| Run | `e2183782-fd2e-4a7a-bd01-04ad4ee4b524`, 16 Oct 02:55Z |
| Bundle on the run's row | `qorpera_execution_runs.runtime_bundle_id` `b4c64330-bcf9-4c26-b93a-cd4712f64e6b`, `runtime_bundle_sha256` `d1e125c8bf6a72c6b4d6c89de6c1d5611de3c9d9c817f7fc14446f439fb19aeb` |

Results:

- **P1-9: PASS.** The run completed.
- **Per-request usage rows (C4, #878): PASS.** The run has its per-request `model_request` usage rows.
- **Prompt cache within the run (C3a): PASS.** Later requests' cached share 0.956 (target ≥ 0.70).
- **Slow result fence (#839, #914): PASS, 15/15.** Every `native_result_fence` span that started also finished.

The tie between the run and the executable is the run's own bundle row: the run records bundle `d1e125c8…`, and that
bundle pins `1c08fd01…`. Nobody read the executable file on a node or in a guest for this record.

## What this does not cover

One run of one agent. It does not cover the cache across runs (C3b, C3c), the live compactor (C5), Codex's own
compaction (C6), or the later production items in the P7 run sheet. Runs later that morning are recorded separately.
