# Web client session log

Dated work blocks for the Qorpera web app (`packages/web`). Every block closes
with what works against the real cloud, what is blocked, and what was
requested from the runtime session (in the Requests section of
`supabase/CLIENT-CONTRACT.md`). Plain language; no claims beyond what was run.

## 2026-09-02 — Block 1: read, decide, scaffold, build order steps 1–2 (and read-only 3–5)

**Read.** `supabase/CLIENT-CONTRACT.md` in full; runtime contract §2, §6,
§12.2, §14.5, §16.2, §21; `SESSIONS.md`; `CLOUD-CONTROL-PLANE.md`;
`QORPERA-CLOUD-V1.md`; the desktop `preload.cjs` bridge, `renderer.js`
structure, `hosted-primary.ts` parsers, `cloud-realtime-sync.ts`,
`cloud-presence.ts`, `cloud-company-organization.ts`, `cloud-object-store.ts`,
`cloud-company-snapshot.ts`, the object gateway routes, and the migrations
that define every RPC the app calls.

**Decided.** Fresh web stack rather than porting `renderer.js` behind a cloud
adapter; reasons recorded in `DECISIONS.md`. Feature gating by deployed
machinery at runtime. Transcript projection rules per §6.

**Built** (`packages/web`, TypeScript + esbuild + supabase-js, no framework):

- Sign-in: email one-time code or link, GitHub/Google OAuth (PKCE), session
  persistence, sign-out.
- Hub: companies from `qorpera_list_hosted_profiles`, incoming invitations
  (accept/decline), new company via `qorpera_create_cloud_company` with
  idempotent bootstrap polling.
- Company shell: rail rebuilt from cloud state in the §14.5 order
  (Co-Founder → responsibilities → active projects/rooms → staff; inactive
  collapsed), company switcher, Realtime health badge.
- Conversations: adopt-or-create staff sessions (`qorpera_ensure_staff_session`),
  the member-private Co-Founder session when the cloud has it, full replay
  through `qorpera_read_session_events` (paged), queued/processing/failed
  inputs from `qorpera_list_session_inputs`, sending through
  `qorpera_append_session_input` with optimistic echo, Realtime invalidation on
  `qorpera-profile-{profileId}` with polling as the recovery path, staff
  activity indicator from `qorpera_list_staff_execution_activity`. Only member
  inputs and `qorpera.agent-send/v1` sends render; hidden entries are counted.
- Approvals inbox: read-only; gathers `authorization_request` /
  `authorization_decision` across the company's sessions.
- Company File: summary, published snapshots, tree browsing and file reading
  through `qorpera_authorize_profile_object_download` + the profile object
  bucket with SHA-256 verification, proposals (open/accepted/rejected) with
  reviews, comments, accept/reject for authorizers.
- Organization: Co-Founder, responsibilities with accountable agents and
  measures, projects, staff; explicit "not deployed" / "not seeded" states.
- Team: members, role changes, removal, invitations (cancel/retry), invite,
  leave/delete with typed confirmation. Account: entitlement, feedback,
  preview-project endpoint override.
- Cloud check page: probes every RPC the app uses with the member's token.
- Unit tests for the transcript projection and parsers (13 passing).

**Verified against the real cloud (`wovsmjvghnbcbfazdtvr.supabase.co`).**
Anonymous existence probe with exact parameter names, plus a statement-ordered
replay of every `grant`/`revoke` in the migrations (derived surface = the
contract's 151 exactly, plus 14 granted-but-undocumented functions):

- Present: every RPC the app uses for auth/profiles/membership, conversations,
  activity, Company File snapshots/objects/proposals, presence, feedback.
- **Missing** (PGRST202): `qorpera_company_organization_json`,
  `qorpera_company_organization_bootstrap`,
  `qorpera_ensure_member_private_staff_session`,
  `qorpera_company_uses_path_gateway`, `qorpera_read_company_path`. Order 0 is
  not on this project yet; the app shows those areas as not deployed.
- Not yet verified: any call under a member token (this session cannot sign
  in on the member's behalf). The signed-in `Cloud check` page and a first
  real conversation are the next verification step for the account owner.

**Blocked.**

- Downloads and uploads through the object gateway from a browser: the gateway
  sends no CORS headers, so any cross-origin call is refused before it reaches
  the gateway's authority checks. Snapshot reads work only for companies whose
  objects are admitted through the profile object bucket.
- Recording an approval decision: the RPC the desktop uses
  (`qorpera_append_account_event`) is granted but not in the client contract,
  so the web inbox is read-only.
- Co-Founder home, responsibilities, live logical paths: waiting on the Order 0
  migration on the target project.
- Attachments in prompts (images): need the gateway attachment route, hence
  CORS.
- Presence (typing, who-is-viewing): not built in this block; the desktop
  signs presence broadcasts with Ed25519 and registers device keys; the web
  port will use WebCrypto.

**Requested from the runtime session** (see CLIENT-CONTRACT.md → Requests,
2026-09-02): gateway CORS for web origins; the approval-decision RPC and a
pending-approvals read RPC in the contract; documentation of
`qorpera_read_company_path` and the profile object bucket path; Supabase Auth
redirect URLs for the web origins; the Order 0 deployment date on the target
project and confirmation of the target project; early design of the
browser-facing screens websocket gateway (Order 4); a decision on the 14
granted-but-undocumented functions.

**Rebase.** Rebased `web/client-app` onto `codex/steps-0-2-fable-handoff` at
`ebbd1e734` (six new runtime commits: Order 1 provider usage-limit signals,
connection concurrency policy, company execution ceilings). No conflicts. The
client contract file is not on the runtime branch; it travels with this branch
until the runtime session adopts it. Two new `authenticated` RPCs appeared in
the migrations (`qorpera_list_member_notifications`,
`qorpera_company_execution_ceiling_json`); they are not in the contract, so the
web app does not call them yet (request 8). Typecheck, tests, build, Biome and
the repo import/pinned-dependency checks pass after the rebase.
Anonymous probe: neither new RPC is deployed on the target project yet
(`PGRST202`).

## 2026-09-02 — Block 2: home and hosting decided

**Decided (founder).** The web app stays in the monorepo; production origin is
`https://app.qorpera.com`. Reasoning and the one-time setup are in
`DECISIONS.md`.

**Built.**

- `.github/workflows/web-client.yml`: on pushes to `master` and
  `web/client-app` (and on pull requests touching the package) it installs
  without lifecycle scripts, typechecks, tests, lints and builds
  `packages/web`; on pushes it publishes `packages/web/dist` to the Cloudflare
  Pages project `qorpera-web` with a pinned `wrangler`, and skips the publish
  with a clear message when the two Cloudflare secrets are absent.
- `packages/web/public/_headers`: strict Content Security Policy pinned to the
  production project and the object gateway, plus the usual hardening headers.
  The rail's hierarchy indentation moved from inline styles to data attributes
  so `style-src 'self'` holds.
- Contract requests 1 and 5 now name the exact origins
  (`https://app.qorpera.com`, `http://127.0.0.1:5180`, `http://localhost:5180`).

**What works against the real cloud.** Unchanged from block 1; nothing new
was exercised under a member token.

**Blocked.** The first real deploy needs the Cloudflare Pages project, the
custom domain and the two repository secrets, which only the account holder
can create. Until the gateway CORS and Auth redirect requests are answered
for `app.qorpera.com`, the deployed site can sign in only through the email
code path and cannot read gateway-served objects.

**Requested.** No new items; requests 1 and 5 updated with the origin.

## 2026-09-02 — Block 3: first deployment

**Done (browser pane, founder signed in to Cloudflare and approved the GitHub
App).** Pushed `web/client-app` to origin. Created the Cloudflare Pages project
`qorpera-web` from `Qorpera/Qorpera_Base` with production branch
`web/client-app`, root `/`, the monorepo build command, output
`packages/web/dist`, `NODE_VERSION=22`. First build passed (24 files, 2 header
rules) and the site is live at `https://qorpera-web.pages.dev`: sign-in screen
renders, no console errors, and the response carries the strict
Content-Security-Policy, HSTS, `X-Frame-Options: DENY` and no-referrer headers.

**Stopped before activating the custom domain.** Cloudflare's confirmation
step showed an existing record: `app` CNAME `d20621a2248eb69c.vercel-dns-017.com`.
Activating would replace a live Vercel-hosted site at `app.qorpera.com`; that
is the founder's call, so nothing was changed in DNS.

**Fixed.** Cloudflare joins `_headers` values from parent and child paths, so
`/assets/*` had two `Cache-Control` values; the child rule now unsets the
parent's first. The GitHub workflow no longer publishes (Pages does), it only
checks and builds.

**What works against the real cloud.** The deployed site reaches the target
project's Auth endpoint for the email code flow; nothing was exercised under a
member token yet.

**Blocked.** Custom domain (decision above). Gateway CORS and Auth redirect
URLs for the final origin (requests 1 and 5).
