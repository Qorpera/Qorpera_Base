# Changelog

## [Unreleased]

### Added

- Settings → General → Language & region shows Language and a new Time zone as small buttons in one card, as the desktop reference does. Each opens a list with a search field and a check on the current choice: languages by their own name with the name in the interface language beside it, time zones by city with today's offset beside it (a zone is also found by region or by its name, such as "Central European Time"). Both start at Follow system. A chosen zone sets the clock for message times, the day breaks in a thread and the times in lists and cards, and new routines start in it. Like the language, it is kept in this browser.
- Connect Gmail, Google Drive and GitHub for the company in Settings → Connections → Services (runtime bundle v87). A connection belongs to the company: owners and admins connect it by signing in with the service (or, for GitHub, a pasted token) or disconnect it, every agent in the company can use it from its next run, new hires included, and the card names who connected it. A sign-in finishes only in the browser tab that started it, so a consent link passed to someone else connects nothing, and a crafted return link does nothing. Other members see the services read-only. The sign-in goes to the company's secret broker behind the shared broker origin (`?company=` routes it); no token reaches the web app or the database.
- Cards an agent raises in its thread (kernel bundle v70, runtime v71): a question with options, a computer takeover with Take over, I'm done and Skip, and the approval card's Approve and Decline now record the decision. A card shows who answered and what, stays in the thread once answered, and expires on its own time. Form and draft cards show their content and can be declined or discarded; filling a form waits for the vault fill step. A secret card takes the value in a masked field and saves it into the company's cloud vault straight from the browser (owners and admins for the company, other members for themselves; a saved secret with the same name is replaced), then marks the card provided; the agent only learns that it was saved. Group chats never carry cards.

### Fixed

- Show a failed or stopped run as one line right above the composer, in the same band as the company notices, instead of at the end of the thread. The thread keeps only the conversation; the card keeps its reason, Try again and Dismiss. Opening a conversation while such a line, or the composer, appears no longer leaves the thread a little short of its last message.
- Show the composer's "Chat settings and more" button in group chats too. Its menu keeps Attach files greyed out with a note that images are not supported in group chats and to use Company File; the model choice stays with single-agent conversations.
- Entering an agent's computer shows the guest screen inside a thin frame in full screen, a computer inside a computer, with the agent's name on the left and one exit button on the right, the exit-full-screen glyph named "Back to thread"; the separate toggle is gone. If the browser refuses full screen, or never answers, the same frame opens over the thread and says "Full screen unavailable"; the next Enter asks again.
- Make thread and rail text sharper and easier to read, above all on the dark theme and on 1x screens: the thread and composer are set in the system face (San Francisco on a Mac, as Messages and the rail already are) at 16px on a 21px line with no sub-pixel letter-spacing, the page renders without macOS font dilation, dark bubbles carry white text on a darker grey, dark text tokens are brighter, and rail role lines and timestamps step up a size and weight.
- Show what an agent is doing in its conversation the way the desktop does: hovering or focusing the working figure at the end of the thread reads "Nova is working" or "Nova is writing" with the ink wave, and the row no longer relies on a browser tooltip. The rail card's "Working" and "Writing" carry the same wave, and every wave on the page runs on one clock, so the card and the thread caption move together.
- Preserve agent metadata drafts and retry state across details-panel closes, serialize saves, and retire confirmed edits when the roster catches up so later changes by other members are not overwritten.
- Keep keyboard focus on an available execution-notice action when refreshes remove the previously focused control.
- Keep the rail's "Needs you" for runs waiting on a member decision, including a failed run that left Company File changes. An agent with a failed or stopped run nobody has dismissed now rests idle with a red status disc, the opposite of the green working disc; the rail link names the state in words, also in the compact rail.
- Render room replies with immutable server-projected staff identity and preserve accepted human messages even when no agent is eligible.

- Use a length-neutral email code hint so sign-in instructions remain accurate with the configured eight-digit codes.
- Accept valid Unicode pause reasons using the public SQL character limit.
- Submit team-room messages through the public room-post contract, preserve room retry identity, and match room attachments/run displays to the supported interfaces.
- Keep the rail's search field, keyboard focus and scroll position when the rail refreshes: dead-key, IME and phone-keyboard typing is no longer broken, and a collapsed rail stops filtering by a search it hides until it opens again. A refresh rebuilds only the rows that changed, so moving between agents keeps their figures and an error notice is not announced again, and figures repaint sharp when the window moves to a screen of another pixel density.
- Make primary buttons inside Settings readable; they rendered white text on the light grey settings button.

### Added

- Lay out the two agents' view-only conversation like a chat between two people: the coworker on the left, this thread's own agent on the right with the bubble tail mirrored; the chips in a thread are a small centered line, "Messaged" or "Message from" with the coworker's figure before its name, as the reference product shows them.
- Mark an agent's message that was left for a coworker without waking it: the pair conversation shows "Left for Helper's next turn" under it.
- Show an agent's coding sessions in its conversation (Order 9): a centered chip in the shape of a bot-to-bot handoff, "Bo started a coding session with you in ✳ Claude Code", with the agent's figure and the harness mark, and the live status under it ("Fix the delay after send · Working · 4 min · running vitest · 3 files changed"). The chip opens the session as its own thread over the conversation, with "Bo ⇄ Claude Code" in the header and Close in the footer; Show unfolds it in place. Both show the session's own steps, what the harness says, the question it asks with answer buttons and "Let Bo decide", the owner's input field, and the draft pull request with its checks and links. Only the session's owner can type into it; everyone else reads it and steers through the agent. Nothing shows until the cloud carries coding sessions.
- Show what agents say to each other. When one agent messages a coworker, the sender's thread gets a small chip "Messaged Helper" and the coworker's thread gets "Message from New Bot"; either chip opens the two agents' conversation over the thread, view-only, with both figures in the header, each message under the speaking agent's name, a lock line "This chat is view-only" and one Close Chat button. A line in that conversation says when an exchange has paused at its limit. These conversations never appear in the rail; members steer by writing in either agent's thread.

- Settings has a Plan & usage tab: the account's current plan (the freemium plan is now called "Free trial") with an Upgrade button that opens the three plans qorpera.com sells (Basis, Standard, Dedicated computer, with prices and what they include; choosing one says "Coming soon" until plan changes open), a Usage section with computer hours (a meter once the cloud reports them, "Not measured yet" until then) and the chosen company's storage, and a Billing card (price, next payment, payment method, invoices) that shows placeholders until billing lands. Nothing moved to General's loss except the plan card. The standalone account page keeps the plan below General.
- Appearance in Settings → General shows its choices as pictures instead of menus: Theme offers System, Light and Dark as miniature windows (System split down the middle), and Composer color offers Blue, Green and Grey as miniature conversations in the page's current theme. Each group is a radio group, so arrow keys move between cards.

- Resize the computer preview by dragging any of its edges or corners, from its resting size up to twice that, keeping its 16:9 shape and staying inside the thread. When the preview has keyboard focus, plus and minus resize it too.
- Present member-addressed execution notices inline in the workspace, with explicit acknowledgment and recovery after uncertain requests.
- Add a dark theme. Settings → General → Theme offers System default (follows the device's appearance), Light and Dark; the choice is kept per browser, follows changes made in other tabs, and a head script applies it before the first paint.
- Show a failed or stopped run in the agent's conversation with its error and a Dismiss action (the desktop's discard), so an old failure stops standing in for the agent's state; a run that left Company File changes links to them instead.
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

- Show only the name on the rail's Co-Founder card, which makes the card a line thinner. Its role and any state ("Working", "Needs you") stay in the card's tooltip and link name, the status disc and the figure still show a run, and other agents' rows keep their second line.
- Put the rail's search field on the same row as the new-agent button, both half again as large (46px field, 27px plus), and widen the default rail from 304px to 456px. Rail widths stored before this change are not carried over, resetting the rail width forgets the stored width, and the agent computer panel covers the conversation whenever the thread is too narrow for both side by side.
- Make the Settings window 20% larger, give its sections icons, and set their labels in whole-pixel, medium-weight dark ink so they no longer read soft.
- Move Friends into Settings as its own tab, together with the company invitations waiting for the account. The profile menu's Friends item opens that tab and carries the invitation count, and the company invite picker's "Add a friend" switches to it.
- Open an agent's routines and responsibilities as pages of its details popup, from two buttons beside the close button, each with a way back; routines left the Computer panel.
- Edit an agent's name, title and description in place, saving on Enter or when leaving the field, and change the figure from a picker under it that saves each choice, as on the desktop; the Edit agent button is gone and the description is taller.
- Replace the new-conversation page (agent cards, heading, Open/Cancel footer) with one list under the To: field: New agent, New group chat, then the agents. The field searches agent names, picking an agent opens its conversation, New group chat gathers agents as chips, and a name typed into the field carries into a new agent. Group conversations still cannot be started.

### Removed

- Remove the member notification inbox: the rail's Notifications row and its unread-count polling, and the Notifications page and route (old links open the company home). Execution notices and explicit acknowledgment remain available inline in the workspace.
- Remove the standalone Friends (`#/friends`) and Invitations (`#/invitations`) pages and the separate Invitations menu item; both live on the Settings Friends tab.
- Remove Stop sharing with agents, Share with all agents and Reconnect from a connected service in Settings → Connections → Services. A company connection is always available to every agent, new hires included, so a connected service shows that line and one action, Disconnect; a connection not yet marked for all agents reads the same.
