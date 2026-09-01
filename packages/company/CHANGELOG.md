# Changelog

## [Unreleased]

### Added

- Extracted staff, artifact, room, connector, and Company File locking primitives from the legacy local agent runtime.
- Added Company File memory and skill services with resumable scoped retrieval, rebuildable indexes, governed forgetting, attributed context, and exact-version skill loads. Runtime registration and deployed acceptance remain gated.

### Breaking Changes

- Replaced the unreleased padded `.skill` encoding with readable `.md` JSON front matter. Skill loading requires a host `fitsContext` check for the complete delivery envelope and token allocation; existing files are not automatically converted.
- Knowledge gateways must expose their admitted identity and supported scopes. Skill replay requires `assertRecordedLoad`; load keys now use the documented newline-delimited identity shared with the SQL recorder.
- Memory and catalog replay require current byte/item budgets and return frozen validated snapshots. Skill load records and semantic proofs now bind name/useWhen alongside body metadata; adopt the service and SQL changes together.
- Forgetting requires the requested preservation policy to match a current human-approved collection resource policy. Session options and tombstone metadata are references, not approval.

### Fixed

- Kept Company File runtime locks accessible across NAS-mapped guest identities.
- Preserved memory matches and continuation offsets across index eviction and invalidation, and rejected non-string memory kinds before writes.
- Separated bounded retrieval candidates from sources retained in runtime context, so tombstones and unrelated files no longer exhaust the durable run read set. Replaced body-based version probes with shared metadata fences.
- Rejected session/gateway identity mismatches and unsupported scopes before I/O. Required existing durable skill records and current delivery budgets when replaying contributions.
- Verified replayed memory content and skill catalog metadata against canonical sources, with bounded validation fingerprints, live access/version fences and immutable output snapshots.
- Kept failed or revoked preservation requests from changing memory indexes, current content, or skill catalogs; exact forget retries retain the original operation receipt.
