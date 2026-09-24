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
  working; `failed` shows the failure reason.

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
be drawn blue; none existed. A figure in its own shade has no colour of its own
to keep, so changing its figure in the picker brings the new figure's own shade;
a chosen colour is still kept, as on the desktop. The meet page keeps the stored
colour until a figure is picked there, so returning to it never replaces a
colour chosen in the details.
