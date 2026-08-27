# Changelog

## [Unreleased]

### Fixed

- Fixed cloud job cancellation violating terminal-state constraints; cancellation now atomically records its actor and timestamp and rejects further sends from the revoked lease.
- Added private-output-safe native startup diagnostics and a real Codex CLI regression covering progress delivery, lost-receipt retries, and private reasoning and output.

## [0.20.42] - 2026-08-27

### Added

- Added a run-scoped cloud `send_message` channel for explicit progress and final delivery. Provider output and reasoning remain private; delivery receipts are authority-checked and idempotent.
- Added agent-owned cloud routine editing with interval and advanced calendar triggers, active/inactive control, and run history.

### Changed

- Changed native cloud harness results to delivery-only receipts and required a final send before conversation jobs can complete.

### Fixed

- Fixed Company File opening with `ENOTEMPTY` when a tree update removes a directory containing separately managed staff instructions or dependency data. Such data remains in place, and incompatible file replacements are rejected.
- Fixed agent avatar color flicker and kept active-agent highlights blue.
- Fixed macOS sidebar chrome, compact add-agent alignment, and sidepanel pointer interactions.
