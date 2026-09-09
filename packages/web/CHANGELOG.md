# Changelog

## [Unreleased]

### Added

- Connect the product web app's Computer panel to shared member runtime discovery, status, explicit start intents and screen viewing.
- Bind member requests and viewer cleanup to the selected company and account lifetime.
- Check browser dependency boundaries and the provenance of the shared screen renderer during builds.
- Add explicit desktop/shell permission controls, owned browser profiles, private sign-in and separate browser consent to the product Computer panel.
- Allow managers to cancel the observed pending computer start, and fence viewer replacement and late connections against panel teardown.
- Connect the web composer to bounded member prompt submission, with account/company/conversation checks after token refresh and preserved request identity for explicit retries.
- Connect Company File to shared governed reads, versioned writes, selected-file uploads, verified downloads, exact proposal review, exports and optional activity hints.
- Preserve File drafts on cancelled navigation, clear content when access ends, and offer explicit reload recovery without replaying uncertain writes.
