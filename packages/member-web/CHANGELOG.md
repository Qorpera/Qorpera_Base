# Changelog

## [Unreleased]

### Added

- Independent static member web application using shared cloud clients for Files, explicit transfers, protected review, Company Computer controls, browser consent/private viewing and account cleanup.
- Public-only deployment configuration, PKCE sign-in, account/company cancellation, scoped sign-out storage, CSP headers and an enforced browser package boundary.
- Local package, targeted account/configuration/upload tests and Chromium proof with disposable service fixtures.

### Fixed

- Revoke each browser profile's observed consent independently in account cleanup, while refusing consent that changed after it was displayed.
