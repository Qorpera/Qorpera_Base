# Changelog

## [Unreleased]

### Fixed

- Render room replies with immutable server-projected staff identity and preserve accepted human messages even when no agent is eligible.

- Use a length-neutral email code hint so sign-in instructions remain accurate with the configured eight-digit codes.
- Accept valid Unicode pause reasons using the public SQL character limit.
- Submit team-room messages through the public room-post contract, preserve room retry identity, and match room attachments/run displays to the supported interfaces.
- Keep the rail's search field, keyboard focus and scroll position when the rail refreshes: dead-key, IME and phone-keyboard typing is no longer broken, and a collapsed rail stops filtering by a search it hides until it opens again.
- Make primary buttons inside Settings readable; they rendered white text on the light grey settings button.

### Added

- Support bounded public JSON environment configuration for Pages release builds, with shared SDK checks and release artifact validation in web CI.

- Record the source commit and runtime bundle identity in web deployment artifacts; require clean source for release builds.

- Add company pause/resume and observed-version execution ceilings through the documented member control plane.
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

### Changed

- Put the rail's search field on the same row as the new-agent button, both half again as large (46px field, 27px plus), and widen the default rail from 304px to 456px. Resetting the rail width forgets the stored width, a stored 304px (the old default) counts as no choice, and the agent computer panel covers the conversation whenever the thread is too narrow for both side by side.
- Make the Settings window 20% larger, give its sections icons, and set their labels in whole-pixel, medium-weight dark ink so they no longer read soft.
- Move Friends into Settings as its own tab, together with the company invitations waiting for the account. The profile menu's Friends item opens that tab and carries the invitation count, and the company invite picker's "Add a friend" switches to it.
- Open an agent's routines and responsibilities as pages of its details popup, from two buttons beside the close button, each with a way back; routines left the Computer panel.
- Edit an agent's name, title and description in place, saving on Enter or when leaving the field, and change the figure from a picker under it that saves each choice, as on the desktop; the Edit agent button is gone and the description is taller.
- Replace the new-conversation page (agent cards, heading, Open/Cancel footer) with one list under the To: field: New agent, New group chat, then the agents. The field searches agent names, picking an agent opens its conversation, New group chat gathers agents as chips, and a name typed into the field carries into a new agent. Group conversations still cannot be started.

### Removed

- Remove the member notification inbox: the rail's Notifications row and its unread-count polling, the Notifications page and route (old links open the company home), and the client's notification list/acknowledge calls.
- Remove the standalone Friends (`#/friends`) and Invitations (`#/invitations`) pages and the separate Invitations menu item; both live on the Settings Friends tab.
