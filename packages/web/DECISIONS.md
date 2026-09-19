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

## 2026-09-02 — Verification method for RPCs

The contract's SQL query needs a database credential this session does not
have. Verification is therefore: (1) replay every `grant`/`revoke` in the
migrations in statement order to derive the authenticated surface (matches the
contract's 151 exactly, plus 14 granted-but-undocumented functions), then
(2) probe the target project anonymously with each function's exact named
parameters (`PGRST202` = missing), and (3) the in-app `Cloud check` page
repeats the probe with the member's token. Recorded as a limitation in the
session log; the SQL check should still be run by whoever holds a credential.

## 2026-09-02 — Stay in the monorepo; serve from `app.qorpera.com` on Cloudflare Pages

**Decision (founder, 2026-09-02).** The web app stays in `packages/web` of the
`Qorpera_Base` monorepo and is deployed from it. The production origin is
`https://app.qorpera.com`.

**Why the monorepo.** The web app's only coupling is the client contract and
the migrations that define its wire shapes, and both live here; the daily
rebase and the Requests workflow only work on shared history. It imports no
workspace package at runtime (supabase-js only) and copies design assets from
the shell package at build time, so a later split stays cheap. The repository
is private; a separate public repository becomes the reason to split if the
client is ever open-sourced on its own.

**Why Cloudflare Pages.** `qorpera.com` is already on Cloudflare DNS and
`objects.qorpera.com` is proxied there, so the custom domain is a one-step
setting in the same account. A GitHub Actions workflow
(`.github/workflows/web-client.yml`) checks, builds and publishes
`packages/web/dist`; the site is static, hash-routed, and needs no server.
`packages/web/public/_headers` carries a strict Content Security Policy that
pins `connect-src` to the production project and the object gateway; the
Account page's preview-project override therefore works on localhost and on
Pages preview deployments, not on the production origin. That is intended.

**One-time setup outside the repo.** A Cloudflare Pages project named
`qorpera-web`, the custom domain `app.qorpera.com` attached to it, and two
repository secrets: `CLOUDFLARE_API_TOKEN` (Pages: Edit) and
`CLOUDFLARE_ACCOUNT_ID`. Until those exist the workflow's deploy job is
skipped and the build job still proves the package.

**Amendment, same day, after setup.** The Pages project was created through
Cloudflare's Git integration rather than a wrangler publish from GitHub
Actions: no API token has to be created or pasted anywhere, and every push to
the production branch (`web/client-app` for now) builds and publishes on
Cloudflare. Settings: root `/`, build command
`npm ci --ignore-scripts --no-audit --no-fund && npm run build --workspace packages/web`,
output `packages/web/dist`, `NODE_VERSION=22`. The first build succeeded and
serves `https://qorpera-web.pages.dev` with the `_headers` policy verified
live. The GitHub workflow is therefore checks-only. Two follow-ups: set
`SKIP_DEPENDENCY_INSTALL=true` on the project so Cloudflare does not run a
second, script-enabled `npm ci` before the build command; and the custom
domain, which is on hold because `app.qorpera.com` already resolves through a
CNAME to a Vercel deployment (see SESSION-LOG.md).

## 2026-09-02 — Brand source of truth is `Qorpera_Website`, not the desktop tree

**Decision.** The web client takes its brand from the marketing site's
repository (`Qorpera/Qorpera_Website`, `landing/public/brand/final` and
`landing/src/styles.css`): the approved lockup and outlined wordmark (never
set as text), the material crown icon, the crown hero render with its contour
mask and eye shapes, paper `#ffffff` / ink `#161615` / line
`rgba(11,11,11,0.11)` / cobalt `#2d6ff2`, Source Sans 3, 8px buttons, 14px
cards, and the faint 88px grid floor. The desktop `userland/onboarding.css`
brand field in this branch is the earlier design and must not be ported.

**Avatars.** The seven staff creatures are current on desktop and mobile, but
they are drawn as the agent's colour through the silhouette mask plus two
white capsule eyes at per-creature positions (QorperaMobile
`CreatureEyeLayout`); the web client now does the same in CSS, with the mobile
colour alias table.

## 2026-09-02 — The agent characters are the approved vector figures, and the
## avatar entry above supersedes itself

**Correction.** The entry above is wrong about the avatars. The seven flat
creatures it describes (bloom, brain, folio, halo, pebble, ribbon, wisp) are
the previous roster. The approved agent visual system replaced them with seven
figures — Planet, Acorn, Flame, Rocket, Crown, Heart, Ghost — and it landed on
`origin/master` in "adopt the approved agent visual system", which the runtime
handoff branch this client is based on does not contain. That is why the
client still ships the old art. Storm and Folio are retired and not
selectable.

**Decision.** The web client draws agents as the **vector** figures from the
visual workspace (`Qorpera_Base-step2/.artifacts/qorpera-avatar-assets`, Vector
design section), not the raster masters: `vector-figures.js` builds one from
its baked trace, `vector-rig.js` drives it, and both sit on `motion-model.js`,
`motion-visuals.js` and `avatar-appearance.js`. The rig runs with **part
motion 0**: the body holds still and the life is in the eyes. No figure ever
follows the pointer, on any surface. The website vendors the same six scripts
under `landing/public/avatars`, so the client vendors them too rather than
reimplementing any of it — every earlier attempt to approximate this by hand
was wrong.

**Figure and colour are independent settings.** The palette is the eleven
colours in `avatar-appearance.js`; a figure's native shade bypasses recolouring
entirely. The selector is seven figures in one row, each in its own shade, then
the colours in centred rows of six and five.

**Shell.** The company shell follows the approved V24 product preview
(`Qorpera_Website`, `landing/src/ProductPreview.jsx`, `v24.css`) in the system
face, not the web client's Source Sans 3, and not the rail this client
currently renders. The client's present rail — Approvals, Company File,
Organization, Team — exists in no Qorpera surface and must be replaced.

**The approved first-run screen** is `packages/web/design/cofounder-first-run.html`.

## 2026-09-05 — Port all four desktop settings tabs into the web client

**Decision (founder).** The sidebar profile popup contains account settings,
Friends, Invitations and Sign out. Company navigation belongs in settings.
Adapt the desktop's General, Company, Connections and Policy tabs in PR #110,
using its modal, gray navigation, account cards, people rows and policy icons.
Keep the conversation mounted beneath the modal and preserve its draft.

**Cloud behavior.** General reads account entitlement and retains feedback and
endpoint configuration. Company embeds the member controls and links to the
existing Company File, Organization and Approvals pages. Connections starts
member-owned native provider login, enables requested-work sponsorship, and
revokes accounts; Services lists and revokes existing cloud secret connections.
Desktop-local connector setup, local-computer controls and unsupported billing
actions do not become pretend browser actions. Creating new service connections
still requires the cloud's registered connector and secure capture machinery.

**Policy.** The four Ask/Act/Auto choices live in protected `authority.toml`,
not browser storage or a second settings table. Browser reads verify scoped
object hashes and the current path version. Saves preserve unrelated TOML and
use the human path-command review/apply protocol with exact version, content,
operation key and plan digest. A successful save is read back from the cloud.
New native runs read the same file through the governed path gateway before
composition. Only validated choices, source version/hash and read observation
references enter context; arbitrary TOML text is not a runtime instruction.
Missing choices default to Ask. Malformed, stale or unauthorized reads stop
composition. These choices never expand technical permissions or privacy consent.

**Deployment boundary.** The web UI requires the member-route CORS changes in
the object gateway and native-provider-login Edge Function. Policy consumption
also requires a matching native runtime bundle rollout and activation. The Pages
preview alone cannot verify those backend changes. Local browser checks use a
fake cloud boundary; adapter and runtime tests exercise the real parsers and
protocols without live credentials or company mutations.

## 2026-09-06 — Restore desktop conversation surfaces before runtime integration

**Decision (founder).** Port the approved desktop interactions in a first UI
pass: compact agent header and details, figure/name/title/description drafts,
integrated composer, local attachment previews, new-conversation and agent
setup screens, and the computer panel. The shell uses the system face and
the supplied Messages reference colors: header `#FBF7F4`, sidebar `#E8E4E1`,
search `#DBD8D6`, selection `#007AFF`. The header is 48px with a 32px figure;
scope badges do not belong in it. Approved vector figures remain unchanged.

**Boundary.** Production supplies no agent-creation or metadata-write adapter
to these new forms. They allow draft preparation and explicitly disable
unavailable saves. Selected files stay in the current company's in-memory
conversation draft; previews use revocable object URLs, never uploads.
Attachments block text submission until removed, so no bytes are silently
dropped. Existing text submission still uses the established append protocol.
The computer panel reports unavailable access and has no run, wake, screen,
routine-creation or provider-control connection. Injectable UI action ports
exist for isolated tests and later reviewed integration only.

**Messages.** Explicitly delivered agent messages render GFM using the existing
repository-pinned `marked` lexer and DOM nodes. Raw HTML stays text; links are
limited to HTTP(S) and mailto; remote images become links and do not load
automatically. Transcript admission rules are unchanged. The diagnostic count
of hidden runtime entries is removed from the conversation UI, superseding
that display choice in the 2026-09-02 entry.

**Verification.** Tests cover permission changes, unavailable write paths,
late async completions, IME/newline behavior, file validation, preview cleanup,
conversation-scoped drafts and inert Markdown content. Browser fixtures cover
desktop/mobile geometry, focus, native dialogs and the unchanged text-send
path without using a live company. Declaring the already-pinned Markdown
dependency updates the root lockfile and its generated bundle provenance;
this does not activate or deploy a runtime bundle.

## 2026-09-06 — Keep this work within the web client shell

**Correction (founder).** Porting all four settings tabs authorizes their UI,
not integration with the runtime being built separately. This supersedes the
Connections, Policy and deployment behavior above, and the earlier decision
to retain live text submission from the composer.

**Boundary.** Connections displays unavailable account/service controls with
no provider login, sponsorship, revocation, service API calls or polling.
Policy offers local Ask/Act/Auto previews, explicitly labeled as unsaved and
not the active company policy. Changing company or closing settings discards
those choices. The composer retains local text and attachment drafts; message
submission, agent creation and metadata saves have no production action
adapter. Computer controls remain unavailable. Fixture adapters may exercise
UI flows without live credentials or runtime calls.

**Scope.** Existing cloud account and company management and read projections
remain available. Runtime policy consumption, object-gateway CORS, provider
login CORS and runtime packaging changes have been removed from this PR.
The previously deployed login CORS wrapper was rolled back. No runtime,
tunnel or NAS deployment is required to publish this shell. The repository's
generated bundle checksum files still reflect the web dependency lockfile;
they are source provenance only and must not be deployed or applied as part
of this work.

## 2026-09-17 — Agents are written through the Company File

**Decision.** Creating an agent, saving agent edits and saving the
Co-Founder's figure are governed Company File writes of the agent's document
(`organization/agents/<id>.json`), using the codec the desktop uses, now in
`@qorpera/cloud-client/cloud-company-agent`. The browser never writes the
staff roster; the cloud projects the document onto it. Agent paths are
protected, so these actions are offered to owners and admins only.

**Removed.** The Policy settings tab was a local draft with no backend and is
gone. The direct roster write for figures is gone; governed companies refuse
it.

## 2026-09-17 — Routines live in the agent's Computer panel

**Decision.** The web client is the first client of the cloud routine calls
(`@qorpera/cloud-client/cloud-routines`). An owner or admin creates, edits,
pauses and resumes an agent's routines from the Routines section of that
agent's Computer panel. A routine has one trigger: chosen days at a time,
every so often, or a change under a Company File path, plus a reply choice
(always, only when useful, silent). The cloud schedules and delivers; nothing
runs in the browser.

**Whose account.** A routine runs while nobody is present, so it names the
model account of the member who saves it. Saving records that member's
consent to unattended use of that account and binds one sponsor per account
version, reused on later saves. The cloud has no member delete for routines;
"Pause" is the removal a member has.

## 2026-09-17 — No private member browsers in the web client

**Decision (Jonas).** The company comes first: agents are the primary workers
against it, and members are mounted on the agents as reviewers. A member's
private browser on the Company Computer does not fit that, so the web client
has none: the "Your browsers" panel (browser profiles, private sign-in,
per-agent browser consent) and the account's "Browser access" page are
deleted, together with the per-agent computer permissions form. Computer
access is a default for every agent (migration 20260917045000), and the
Computer panel offers one action, Open computer.

**Still in the backend and runtime.** The privacy challenge, private display
and browser-profile grant machinery of contract section 12 is untouched; no
client reaches it now. Removing it is a contract amendment, not a web change.

## 2026-09-19 — Friends and company invitations share one Settings tab

**Decision (Jonas).** Friends and the company invitations waiting for the
account live together on one Friends tab in Settings, not on pages of their
own. The profile popup holds Account and settings, Friends (with the count of
waiting invitations), Feedback and Sign out. The separate Invitations item and
the `#/friends` and `#/invitations` pages are gone; old links land on the
company hub. The Company tab's "Add a friend" opens the Friends tab. This
replaces the popup contents in the 2026-09-05 entry.

**Settings look.** The window is 20% larger (1200×816), and each section in
its menu has an icon and a 13px medium-weight label.

## 2026-09-19 — Agent details hold routines and responsibilities; edits are in place

**Decision (Jonas).** Routines leave the Computer panel for the agent's details
popup. Two buttons sit left of its close button: Responsibilities, then
Routines. Each turns the popup into that page, with a back arrow to the
details; Routines keeps the whole manager (list, pause and resume, create and
edit). The Computer panel holds only the computer again. This moves where the
2026-09-17 routines entry put them; the rest of that entry stands.

**Edits are in place.** The "Edit agent" button is gone. For owners and
admins, name, title and description are always editable where they stand:
Enter or leaving a field saves it, Escape puts the saved text back. The figure
edits as on the desktop: on hover it darkens inside a pale outline with a
pencil, a click opens a picker under it, and each choice saves at once and
keeps the agent's colour (the Co-Founder chooses a figure only). Changes made
while a save is out follow it as one more write. Closing the popup keeps a
change that was being typed; leaving the conversation, changing company or
losing access drops it. Members without write access see the same popup read
only. The description is taller: at least five lines, growing to thirteen.

## 2026-09-19 — New conversation is one list under the To: field

**Decision (Jonas).** The new-conversation screen follows Grok's bot picker:
a "To:" field with one short list under it, replacing the page of agent
cards. The list starts with New agent and New group chat, then every active
agent. The rows show names only, so the field searches names only. Picking an
agent opens its conversation at once. New group chat turns the rows into
checkboxes and puts the chosen agents in the field as chips. A name typed
into the field carries into New agent.

**Still missing.** No client can start a group conversation yet (`room:create`
in CLIENT-CONTRACT.md). The Start group chat row stays disabled and says "Not
available yet", as the old screen's Open button did.

