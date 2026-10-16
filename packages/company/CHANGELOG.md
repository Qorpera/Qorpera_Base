# Changelog

## [Unreleased]

### Added

- Extracted staff, artifact, room, connector, and Company File locking primitives from the legacy local agent runtime.

### Fixed

- Kept Company File runtime locks accessible across NAS-mapped guest identities.

### Removed

- Removed the room and connector primitives (`company-rooms`, `company-connectors`). Only the deleted desktop app and PI coding agent used them.
- Removed the legacy local-runtime artifact records (`company-artifacts`, `qorpera.artifact/v1`: starter artifacts, metric observations, source assessments and connection transitions) and their re-exports from `company-staff`. Nothing in the repository used them.
- Removed the legacy local-runtime agent message ledger (`company-agent-messages`) and the local staff registry writers and readers in `company-staff` (`readStaffAgents`, `replaceStaffAgents`, `create`/`update`/`archive`/`restore`/`activate`/`deleteStaffAgent(s)`, the `staffAgent*Path` helpers and the create/update input types). Nothing in the repository used them. `company-staff` keeps the `StaffAgent` types and `staffRegistryPath`.
- The Company File runtime lock is gone (legacy sweep step C, CO-2; no SQL): `company-runtime-lock` (`claimCompanyRuntimeLock`, `releaseCompanyRuntimeLock`, `companyRuntimeLockPath`, `canonicalCompanyRoot` and `CompanyRuntimeLock`), its heartbeat worker `company-lock-heartbeat`, its test, the package's `./company-runtime-lock` export and its re-export from the index. Its last user was the snapshot-v1 tree module (`cloud-client`'s `node/cloud-company-snapshot`), which L1 deleted. The runtime bundle generator drops the `company-lock-heartbeat` entry point, so the ephemeral runner package and the LXD runner guest package no longer ship `company-lock-heartbeat.mjs`, and the guest's `install-image-contract.sh` no longer expects or installs it. This rides the next runner image (the LXD runner guest and the ephemeral runner package drop the file) and the next runtime bundle (the release cut regenerates the manifest and activation). The package's `test` script now passes with no test files: this was its only test.
