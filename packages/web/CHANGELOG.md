# Changelog

## [Unreleased]

### Fixed

- Use a length-neutral email code hint so sign-in instructions remain accurate with the configured eight-digit codes.
- Accept valid Unicode pause reasons in runtime notifications using the public SQL character limit.
- Submit team-room messages through the public room-post contract, preserve room retry identity, and match room attachments/run displays to the supported interfaces.

### Added

- Add company pause/resume and observed-version execution ceilings through the documented member control plane, plus a member notification inbox with explicit acknowledgement.
- Add provider sign-in through the exported native login SDK when an accepted public gateway is configured; keep login capability handling outside the UI and require explicit recovery after uncertainty.
- Submit conversation work through the shared sponsored-turn API with explicit member account selection, exact retry identity, execution history and observed-run stop controls.
- Discover, enable and revoke existing member model accounts through the shared client SDK, with refresh recovery after uncertain changes.
- Connect the product web app's Computer panel to shared member runtime discovery, status, explicit start intents and screen viewing.
- Bind member requests and viewer cleanup to the selected company and account lifetime.
- Check browser dependency boundaries and the provenance of the shared screen renderer during builds.
- Add explicit desktop/shell permission controls, owned browser profiles, private sign-in and separate browser consent to the product Computer panel.
- Allow managers to cancel the observed pending computer start, and fence viewer replacement and late connections against panel teardown.
- Connect the web composer to bounded member prompt submission, with account/company/conversation checks after token refresh and preserved request identity for explicit retries.
- Connect Company File to shared governed reads, versioned writes, selected-file uploads, verified downloads, exact proposal review, exports and optional activity hints.
- Preserve File drafts on cancelled navigation, clear content when access ends, and offer explicit reload recovery without replaying uncertain writes.
- Stage selected conversation images against the exact member input before submitting a message, preserve explicit retry identity, and verify canonical image previews through the shared attachment API.
- Add account-level browser consent cleanup and private sign-in closure, including after leaving a company, with account and route cancellation.
- Bind deployed cloud endpoints and CSP to one validated public build configuration, require a viewer origin for release builds, and ignore stored preview overrides in configured builds.
