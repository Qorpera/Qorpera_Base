# Web client decisions

Dated, append-only. Each entry records what was decided, why, and what it
rules out. The client contract (`supabase/CLIENT-CONTRACT.md`) and the runtime
contract (`QORPERA-RUNTIME-CONTRACT.md` §2, §6, §12.2, §14.5, §16.2, §21) are
the authorities these decisions serve.

## 2026-09-02 — Fresh web stack; do not port `renderer.js` behind a cloud adapter

**Decision.** `packages/web` is a new, small web app: TypeScript, no UI
framework, bundled with esbuild (already a repo devDependency), talking to the
cloud with `@supabase/supabase-js` (same pinned version as the desktop). It
reuses the desktop's *design* (tokens, fonts, staff creature art, icons, copy)
and *cloud parsing logic* (ported from `packages/shell/src/cloud-*.ts` and
`hosted-primary.ts` to browser TypeScript), but not the desktop's view code.

**Why not reuse `packages/shell/userland` with an adapter replacing the IPC
bridge.** Reading the 12.8k-line `renderer.js` against the contract:

1. Its state does not come from the cloud. The renderer reads a *local backend
   read model* over HTTP (`authorizedBackendPost` to a per-company backend
   port, `runtimeStream`) and a *local kernel RPC pipe* (`rpcSend`,
   `onRpcEvent`, `onRpcLog`) that streams the provider's content. A browser
   adapter would have to emulate a kernel and a backend to satisfy those call
   sites — the exact thing runtime contract §2 forbids a client to be.
2. It renders provider output. `pendingAssistantTextByIndex` and the RPC event
   handlers paint the provider's streaming assistant text and tool activity.
   §6 says only send operations are public; a web app must never have that
   code path at all, not merely leave it unreached.
3. Its identities are local. `currentSession` is a trail *file path*;
   companies are folder roots; the hub is a local company registry with
   `materialize`/`migrate` flows. Cloud identity is session UUID plus
   client-session UUID, profile UUID plus environment UUID. Every state
   transition would be rewritten anyway.
4. Roughly a third of the 90 bridge methods are transitional or desktop-only
   by design (open local folder, materialize/migrate profile, local execution
   permission, updater, local connection requests, native execution info).
   They would become dead or lying UI.
5. It carries the department model (287 references in `renderer.js`, a wizard
   in `index.html`, strings in `localization.js`). Departments no longer exist
   (contract §14.3) and must not be ported.
6. It orders the sidebar by recency and pinning; §14.5 requires the
   Co-Founder → responsibilities → active projects/rooms → staff hierarchy
   rebuilt from canonical state.

**What transfers.** `tokens.css` (palette, radii, type scale, glass recipe —
MIT-licensed adaptations from T3 Code, attribution kept), the Source Sans 3
fonts, `staff-creatures/*.png`, the SVG icons, and — later — the Danish
strings. The strict parsers for profiles, teams, invitations, sessions,
events, staff, Company File, snapshots, proposals, and the organization
hierarchy projection are ported one-to-one so the web and desktop accept the
same wire shapes.

**Why no framework.** The repo has none; the desktop UI is vanilla DOM; the
app is a thin projection of cloud state with a handful of views. Vanilla
TypeScript keeps the bundle small, keeps the dependency set to one runtime
package, and passes `check:pinned-deps` and `min-release-age` without new
entries.

**Ruled out.** Vite/React/Svelte toolchains (new pinned dependencies for no
contract benefit); a shared "userland" package between desktop and web (the
desktop UI is being replaced, not generalized).

## 2026-09-02 — Feature gating by deployed machinery, checked at runtime

**Decision.** Every cloud-backed feature is gated on the RPCs it needs
*existing on the target project*, detected at runtime: a PostgREST `PGRST202`
("function not found") marks the feature as *not deployed* and the view renders
a plain read-only notice instead of the feature. A `Cloud check` page runs the
probe with the signed-in member's token and lists present / denied / missing
per RPC.

**Why.** Rule 2 (never render missing machinery, §14.5) and the verification
result of 2026-09-02: on `wovsmjvghnbcbfazdtvr.supabase.co` the contract's
`qorpera_company_organization_json`, `qorpera_company_organization_bootstrap`,
`qorpera_ensure_member_private_staff_session`,
`qorpera_company_uses_path_gateway` and the undocumented
`qorpera_read_company_path` are not deployed (Order 0 is "pending live
production migration" per `deploy/first-node/RUNTIME-STEP-0-ORGANIZATION.md`).
The contract list is derived from migrations, not the deployed schema, and
says so; the app must not assume parity.

**Superseded in part (2026-09-24).** The Cloud check page, its RPC probe and
the browser endpoint override in Settings were removed. Features still gate
on `PGRST202` where they call the RPC; every build uses the endpoints compiled
into it.

## 2026-09-02 — Transcript projection rules (what the web app renders)

Per §6 and launch acceptance item 8, from `qorpera_read_session_events`:

- `message` events whose body is `qorpera.runner-transcript-entry/v1` with
  `entry.message.role = "user"` and a `session_input_id` → a member message,
  attributed to `actor_user_id`.
- `message` events with `entry.message.role = "assistant"` **and**
  `entry.delivery.schema = "qorpera.agent-send/v1"` → an agent message with
  its `progress`/`final` phase. Any assistant-role text without a send
  delivery record is *not* rendered; the view shows only a count of hidden
  non-send entries so members know history exists.
- `qorpera.shared-trail-entry-part/v1` (legacy desktop multipart entries) are
  reassembled; user-role entries render as member messages, everything else is
  hidden and counted.
- `authorization_request` / `authorization_decision` → typed cards; today
  read-only (see Requests in the client contract).
- `session_info`, `run_receipt`, `artifact_receipt` → never rendered.
- Queued inputs from `qorpera_list_session_inputs` not yet in the transcript
  render as *pending* member messages; `processing` shows the agent is
  working; `failed` shows the failure reason. A pending message stands before
  the first member message sent after it, else at the end, so one the cloud
  never takes does not sink under newer messages. Agent output is no measure:
  a taken input is written at the next sequence with its send time, so a
  message sent while the agent works stays below the agent's output, where it
  lands once taken.

## 2026-09-22 — Coding sessions in the thread (Order 9, part 2)

A coding session is not a transcript event. `qorpera_list_coding_sessions`
names the sessions the agent dispatched from a conversation, and the thread
places each one where it was started: before the first message written after
it. The element (`ui/coding-session.ts`) has the shape of a bot-to-bot handoff
line: a centered chip, "Bo started a coding session with you in ✳ Claude
Code", with the agent's figure and the harness mark, and the live status under
it (title · state · time · last step · diff size). The chip opens the session
as its own thread over the conversation (`ui/coding-session-thread.ts`: header
"Bo ⇄ Claude Code", the session unfolded, a footer that says who may type);
Show unfolds it in place. Both show the session's own steps and the harness's
voice from `qorpera_read_coding_session`, the owner's input and the pull
request. (The first cut carried dashed rules around the line; they were
dropped the same day for the handoff-line shape.)

- Every word in the captions comes from the session view (agent, owner, harness,
  phase, PR); nothing comes from the agent's prose.
- Only the owner types into the session; other members see the same body with
  a lock line ("This session is view-only" in the thread view). The kernel
  enforces this too.
- The element persists per session across renders and follows its own stream
  (2.5 s while working, 6 s while it waits, 30 s after it settled, 20 s while
  the tab is hidden). A missing list RPC means no sessions; the thread renders
  as before.

## 2026-09-24 — No company execution controls, no Organization or Approvals pages

**Decision (Jonas).** Settings → Company no longer carries Company execution
(pause/resume, monthly spend and token limits, hourly wake limit, the usage
line) or the Organization and Approvals cards, and the client has no pages or
routes for them. The limits go as policy, not just as settings: the runtime
removes the spend, token and wake ceilings themselves in its own change.

**Why.** Jonas asked for all of it to go, the limits as policy and not only
as settings. A provider's own usage limits still bound subscription work. The
Approvals list only gathered `authorization_request` events, which the cloud
runtime never emits (its harness runs with approvals set to never); approval
cards an agent raises in its thread are a different thing and stay.

**Rules out.** Re-adding a pause, limit or approvals surface in the client
without a new decision. Notices of a tripped company limit or a pause/resume
that already exist in a member's list are skipped, never shown and never a
failed read; the machine-capacity notice, which shares the
`company_ceiling_tripped` kind, still shows.

## 2026-09-24 — The Co-Founder's colour can be changed

**Decision (Jonas).** The Co-Founder's figure picker offers the colours and
Reset like every other agent's, and the Co-Founder is drawn in the colour it
was given. This replaces the 2026-09-12 rule (PR #115) that the Co-Founder
always wears its figure's own shade, as in the trailer.

**Why.** Jonas reported that the Co-Founder's colour could not be changed. The
desktop client and the cloud never had the rule; it was a web rendering rule.

**How.** The cloud seeds every Co-Founder with the token `qorpera-blue`, which
nobody chose, and a colour picked in a client is saved as a palette hex, never
as that token. A Co-Founder that still carries the seed token keeps its
figure's own shade (`agentColor` in `ui/avatar.ts`), so no Co-Founder changes
colour just because this shipped. The first-run meet page still offers figures
only; each figure brings its own shade there.

**Follow-up after review (same day).** Production held six Co-Founders: four on
the seed token, one planet in `#5ec0b5` and one crown in `#fcb51b`, all drawn as
before. A Co-Founder saved as `#2047bd` without anybody choosing blue (the meet
page of 2 to 12 September, or the desktop picker on a figure change) would now
be drawn blue; none existed.

A figure in its own shade has no colour of its own to keep. So when the
details picker opens on an agent in its own shade, changing the figure brings
the new figure's own shade until a colour is clicked; Reset returns to that.
The rule is decided when the picker opens or the look changes elsewhere, never
on the member's own changes, so a colour chosen in the session survives passing
through a figure whose own shade it is.
Saved data cannot tell a chosen Gold on a crown from the crown's own shade, so
such an agent follows its figure. This deliberately differs from the desktop
picker, which always keeps the current colour. The meet page keeps the stored
colour until a different figure is picked there, so returning to it never
replaces a colour chosen in the details.

**Superseded in part (2026-10-04).** On the company folder a colour is a
name in the agent's file (`colour: blue`), which the index keeps as
`qorpera-blue`, and founding (P15, #789) seeds the Co-Founder's file with
no colour, which the index keeps as `native`. A member who picks Blue for the
Co-Founder is therefore stored as the old seed token, so the seed-token rule
is gone: the Co-Founder is drawn by the same rule as every agent, and its
own shade comes from `native`.

## 2026-09-24 — Rail menu, pinned cards and sections (Grok Bot's rail)

Jonas asked for Grok Bot's right-click menu on agents, pinned agents as square
centered cards right below the Co-Founder card, sections created from the rail
or from Move to, drag between sections and into the pinned row with invisible
containers that light up, and agents moving each other into sections.

- **Sections are the company's; pins and hiding are the member's.** Agents
  organize sections (the `organize_sidebar` tool), so sections must be shared
  cloud state (`qorpera_company_sidebar_*`; one revision row per company is the
  only published, member-readable table, so a move is one hint). A pin
  or a hidden agent only changes one member's view, so it lives per member
  (`qorpera_member_sidebar_agents`) and follows the member across devices.
  Nothing is kept in `localStorage`.
- **One RPC answers the whole sidebar.** Every change returns the member's full
  sidebar; the rail draws the change at once from the same rules
  (`applySidebarRequest`) and replaces it with the answer. Changes go one at a
  time; a refusal puts back what the cloud has and says why in the rail.
- **Order is explicit, and hidden agents keep theirs.** A drag sends the whole
  order of the container it lands in, computed from the full container, not the
  visible rows, so hiding or pinning never reshuffles another member's view.
- **Degrade, never lie.** A cloud without the sidebar RPCs (web deploys before
  the bundle cut) shows the single list of before and a menu of Rename, Copy
  conversation ID and Delete. The sidebar's Realtime channel is its own, so a
  missing table cannot degrade the company's live updates.
- **Not built: Mark as Unread.** The rail has no unread state at all yet (no
  per-member read cursor in the cloud); a menu item for it would render
  machinery that does not exist (runtime contract §14.5). It is its own feature.
- **Moving a pinned agent to a section unpins it**, from the menu as from a drag,
  so the move is visible; choosing the section an agent is already in does nothing.
- **Dragging has keyboard twins.** Alt+Up / Alt+Down move the focused agent one
  place in its section or in the pinned row; Move to covers sections. Shift with a
  mouse right-click keeps the browser's own link menu.
- **Hidden agents stay reachable** (Jonas, after the live test): a "Hidden agents"
  group with the count folds at the foot of the list and opens to list them; showing
  one again is the menu's Show in sidebar, a pin, a Move to, or a drag out of it.
- **Delete is permanent**, as in Grok Bot: it deletes the agent's document
  (owner or admin; the Co-Founder never), after a confirmation that says so.

## 2026-09-24 — The web app is offered in English and Danish

**Decision.** Every piece of interface text goes through `t(source, values)`
(`src/ui/preferences.ts`) with the English as the key and the Danish in
`src/ui/danish/<area>.ts`. English stays the source language. Values fill
`{placeholders}` and are never translated: names, messages, file names, roles
typed by members and server error text are company content. A sentence with a
value is one key, never glued fragments, because Danish word order differs;
plurals are two keys. Text kept in a table before it is drawn (labels by code,
menu items) is marked with `phrase("…")`, which returns it unchanged. Choosing a
language redraws the screens in place (application.ts `onLanguage` /
`redrawScreens`): drafts, chosen images and edits live in the stores and
survive; Settings reopens on the same tab. The data layer returns codes
(`sessionAttachmentProblem`, `ObjectAccessError.reason`) and views translate
them; never match English message text.

**Checks.** `test/translations.test.ts` reads the source: every key written
in `t()`/`uiText()`/`phrase()` has Danish, placeholders match, a key lives in
one area file, no Danish is left that no code asks for, and no English literal
sits unwrapped where interface text goes (aria-label, placeholder, title, text
children of `h()`, `button()`, `notice()`, `badge()`, `spinner()`, `confirm()`).
`test/setup.ts` fails any test file whose screens drew text without Danish
(keys built at run time). So a new label needs `t()` and its Danish in the
same change.

**Wording.** Plain, short Danish in the du-form, matching qorpera.com and the
desktop (`packages/shell/userland/localization.js`): Company File is
"Virksomhedsfilen", Co-Founder stays a name, a thread is a "tråd", a run a
"kørsel", a draft a "kladde".

**Out of scope.** Error text written by the cloud layer (`src/cloud/*.ts`,
`describeError`) stays English, as the server's own messages do. The computer
screen viewer (`member-web/ui/screen-viewer.js`) is copied unchanged from the
desktop, so `ui/computer-viewer.ts` translates its fixed text inside its own
overlay. The live Company File panel (`member-web/src/file-panel.ts`) takes
`t` as an option so member-web stays independent.

## 2026-09-24 — The web app is drawn at 130% (design pixels)

**Decision.** Jonas found the app better at the browser's 125% zoom, then at
150%; 140% shipped and was too much, so 130% is the default (2026-09-25). The stylesheets keep writing design pixels; the build
(`scripts/design-px.mjs`, an esbuild plugin over every stylesheet) turns each
px value of 2 or more into `calc(N * var(--px))`, and `tokens.css` sets `--px`
to `--ui-scale` pixels: 1.3 with a mouse or trackpad, 1 on a coarse pointer
(phones and tablets, whose layout was drawn for 100%). Each width breakpoint in
`@media` is written by the build for each pointer: as written for a coarse one,
multiplied out for a fine one or none (spelled out, since older browsers cannot
parse `not (pointer: coarse)`), so layouts switch at the widths the browser's
zoom switched them. Hairlines under 2px and SVG stroke geometry stay as written.

**Keeping a size.** A part that keeps its old size sets `--px: 1px` for itself
and everything inside it: the minimized computer preview (Jonas kept its size;
it also pins the 14px text it used to inherit) and the picture cropper's view,
which is laid out in its own units and scaled by script.

**Scripts.** A script that sizes or places something in design pixels
multiplies by `uiScale()` or writes `designPx(n)` into an inline style
(`src/ui/scale.ts`); pointer positions and measured boxes are screen pixels
already. Rail widths, stored and shown, are design pixels. The computer
preview's drag and resize code (`computer-drag.ts`) stays in screen pixels,
since the preview keeps its size.

**Not CSS zoom, not rem.** `zoom` on the root changes what
`getBoundingClientRect`, pointer positions, `left`/`top` and viewport units mean,
differently in Chrome and Firefox (standardized zoom) than in Safari, which
would put menus, drags and full-height dialogs off by the scale. Rewriting the
stylesheets in rem would have touched every line under the open web PRs and
left new px unscaled.

**Rules.** Keep writing px in the web stylesheets. A `@media` query with pixel
widths must be a plain condition such as `(max-width: 760px)` (the build stops
otherwise); `@container` queries with pixel widths stop the build until they are
needed. Pair two breakpoints on the same number (`max-width: 760px` against
`min-width: 760px`, or range syntax), never 760/761: scaled, 761 becomes 989.3
and leaves a gap. A script that compares a measured size with a design size
reads that size from the computed style where the stylesheet has it (the
composer does), and otherwise multiplies its constant by `uiScale()`; either
way it rounds up where the browser rounds (`scrollHeight`).
`scripts/design-px.test.mjs` checks that no design pixel in the stylesheets
escapes the scale. Breakpoints were set for 100%; check the widths where a
layout switches at the new scale (Settings' smaller rail moved from 1100 to
1000 design pixels, 1300 on screen, so 13" and 14" laptops keep the large one).
The rail's default narrowed with each step (456 → 410 → 369 design pixels); at
369 three pinned cards share a row.

## 2026-09-25 — Interface size in Appearance

Settings → General → Appearance offers Big (the default, current 130% desktop
scale) and Small (the original 100% scale). The browser stores the choice in
`qorpera.web.ui-size`, restores it before paint, and follows changes from other
tabs. Phones and tablets keep their 100% scale in either choice.

Responsive pixel queries have two mutually exclusive, zero-specificity root
gates: Big uses the existing pointer-aware breakpoints, Small uses the original
breakpoints. The build lowers the generated CSS nesting. A size change also
dispatches resize so measured rail widths, composer heights, menus, dialogs,
and navigation accessibility state update together.

An unset rail width follows the size: 369 design pixels for Big, the original
456 for Small. An explicitly resized width is kept across size changes; resetting
the rail clears that choice and follows the current size's default again.

## 2026-09-25 — Rules and approval cards for agents' actions

**Decision (Jonas).** The web client gets Settings → Rules and live approval
cards for agents' actions (runtime bundle v130, contract amendment
2026-09-25). Grok Bot's Auto-review is the reference; Qorpera adds the
multiplayer scope: a rule is the member's own ("only me") or, written by an
owner or admin, the company's. An approval card is answered by the member it
waits for, as the card names: a personal rule's owner, or any owner or admin
for a company rule or a built-in check. Allow once, Deny, and on a built-in
check's card Always allow, which saves the proposed rule as a company rule.

**Why.** Jonas asked for the rule behaviour "in the runtime architecture",
with personal and global rules. This is the new decision the 2026-09-24 entry
asked for before any approvals surface returns: approvals come back as cards
in the thread where the agent works, not as a separate Approvals page.

**Rules out.** An Approvals page or inbox; answering these cards through
`qorpera_answer_interaction` (its approval surface is owner/admin-only and does
not know the review); live controls on a card for a member it does not wait
for; controls the live kernel refuses (before v130 the tab says rules are not
available and no card has buttons, because no such card exists).

## 2026-09-26 — A member's Stop is not a failure

**Decision (Jonas).** A run a member stopped reads as stopped: no red disc, no
"did not finish this run" line and no Try again. The agent shows its other
work, or idle. To repeat a stopped message, the member sends it again. The one
exception is a stop that left an open Company File proposal of the run's own:
it reads as "Needs you" with Review, ranked below all of the agent's work,
queued runs included.

**Why.** The activity list keeps one run per agent and ranked a stopped member
turn or room post above the run the agent was still working on. The agent read
as failed, and the composer lost its Stop for the agent's other runs (a routine
run in the same thread) until the member dismissed the line.

**How.** Every cancelled job is a member's Stop: the job table requires
`cancelled_by_user_id` whenever the status is `cancelled`. The cloud leaves a
stopped run out of `qorpera_list_staff_execution_activity` unless its own
proposal is open, and ranks that decision lowest (migration
`20260926192436_member_stop_settled_activity`). A proposal review a member
stopped (only possible through the job-id cancel) drops out too; its proposal
still waits in the Company File. The web reads a listed stop as a decision, and
as settled once its details show no proposal. An older cloud still lists every
stop above the agent's live work, so there a member who can write acknowledges
such a stop as soon as its details are read, and the work it hid shows again.

**Rules out.** Try again for a stop (`qorpera_retry_room_delivery` still accepts
one from its author; the web never offers it), and a grey "You stopped this
run" line with Try again, the option Jonas did not pick.

## 2026-09-27 — Routines as cards with a switch, opened in place

**Decision (Jonas).** An agent's routines show as Grok Bot's do: one card per
routine with its name, when it runs and a switch. Clicking a card opens it for
more: the instruction and the actions. Height is short in the popup, so the
open card uses width instead, and scrolls.

**How.** The card opens in place (one at a time) rather than as its own page:
the instruction on the left, when it runs, the next run and the last run on the
right, Edit beside the switch. An open card is exactly as tall as the page under
its heading, so the instruction scrolls inside it (8 lines at 13px) and Edit and
the facts never leave view; the list scrolls the card into view as it opens.
The popup keeps one size on every page (the 2026-09-22 rule) and is now
880 design px wide instead of 720 on the details page too. On a phone the card
stacks and the page alone scrolls.

**Rules out.** A separate detail page per routine (Grok Bot's phone layout), a
Pause button beside the switch, and a delete button: the cloud has no member
delete for a routine (`CloudRoutineClient.save` says so), so trash waits for
that call.

## 2026-09-27 — Rules live in Settings → General

**Decision (Jonas).** The rules leave their own tab for Settings → General,
simplified to Grok Bot's Auto-review rules form (without its "Auto-review
Rules" title and hint) plus Qorpera's "Applies to:" choice, and one table of
rules with edit and remove icons. The rules are the company Settings show
(the one whose page is open, or the account's only company); with none,
General says "Open a company to see its rules." in their place.

## 2026-10-04 — A quote of outside content is one piece of the draft

**Decision.** A message button's email values travel as quotes (contract, the
2026-10-02 amendment "quoted outside content in a member's message"; Interfaces
step I5d-4). In the composer a quote stays in the plain textarea and is set
apart in the coloured copy that already lies over it for skill names: its «»
marks and words are tinted as quoted, and a line under the field says agents
read it as quoted, never as the member's words. The caret never rests inside a
quote: arrow keys step over it, a click lands at its nearer edge, a selection
takes it whole or not at all, and Backspace or Delete that reaches one of its
marks removes the whole quote.

**How.** The draft keeps each quote's record (its words and mail thread)
beside the text, and finds the quotes wherever a record's words stand in «»
marks, as the cloud finds a draft's kept quotes. So the member's own marks
around the same words as a quote carry that quote's record, an undo or paste
that puts a quote back makes it a quote again, and a save never keeps a quote's
words without its record (which the cloud would refuse). The records go once
the message is sent. Since one record stands for its words, a message button
that would quote the same words from another email (two emails with one
subject) while the draft still quotes them is refused with a line saying so,
rather than giving the new quote the other email's thread.

**Rules out.** A rich-text composer with quote chips (a larger change to the
field, its caret handling and shared drafts' text merging), and a row's value
filled in as plain words when it can't travel as a quote: a row without its
mail thread id gets no message button at all.
