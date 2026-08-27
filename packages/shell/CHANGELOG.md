# Changelog

## [Unreleased]

### Added

- Added a run-scoped cloud `send_message` channel for explicit progress and final delivery. Provider output and reasoning remain private; delivery receipts are authority-checked and idempotent.
- Added agent-owned cloud routine editing with interval and advanced calendar triggers, active/inactive control, and run history.

### Changed

- Changed native cloud harness results to delivery-only receipts and required a final send before conversation jobs can complete.

### Fixed

- Fixed Company File opening with `ENOTEMPTY` when a tree update removes a directory containing separately managed staff instructions or dependency data. Such data remains in place, and incompatible file replacements are rejected.
- Fixed agent avatar color flicker and kept active-agent highlights blue.
- Fixed macOS sidebar chrome, compact add-agent alignment, and sidepanel pointer interactions.
