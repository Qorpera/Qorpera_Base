# Changelog

## [Unreleased]

### Added

- Extracted staff, artifact, room, connector, and Company File locking primitives from the legacy local agent runtime.

### Fixed

- Kept Company File runtime locks accessible across NAS-mapped guest identities.

### Removed

- Removed the room and connector primitives (`company-rooms`, `company-connectors`). Only the deleted desktop app and PI coding agent used them.
