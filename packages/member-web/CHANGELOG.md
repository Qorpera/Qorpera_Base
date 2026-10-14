# Changelog

## [Unreleased]

### Added

- Independent static member web application using shared cloud clients for Files, explicit transfers, protected review, Company Computer controls, browser consent/private viewing and account cleanup.
- Public-only deployment configuration, PKCE sign-in, account/company cancellation, scoped sign-out storage, CSP headers and an enforced browser package boundary.
- Local package, targeted account/configuration/upload tests and Chromium proof with disposable service fixtures.

### Removed

- The governed Company File panel (snapshot-v1 only: Files, text edits, uploads, exports, binary review and presence), its upload helper and tests, the `objectGatewayUrl` setting and the Realtime origin in the CSP (step C, C2). Opening a company opens its Company Computer. The company list no longer needs `bootstrap_state`. The web app's folder view keeps the download helper.

### Fixed

- Revoke each browser profile's observed consent independently in account cleanup, while refusing consent that changed after it was displayed.
