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

**Domain activated (founder decision: replace the Vercel record).** Cloudflare
swapped `app` CNAME `d20621a2248eb69c.vercel-dns-017.com` →
`qorpera-web.pages.dev`. About two minutes later `https://app.qorpera.com/`
answered `200` with the strict Content-Security-Policy and HSTS headers and the
Qorpera sign-in page. The second Pages build is live: `/assets/*` now carries a
single `Cache-Control: public, max-age=86400`. `SKIP_DEPENDENCY_INSTALL=true`
is set on the project so the build command's own `npm ci --ignore-scripts` is
the only install. Still owed by the runtime session before OAuth and gateway
reads work on this origin: contract requests 1 (gateway CORS) and 5 (Auth
redirect URLs) for `https://app.qorpera.com`.

**Open item: zone bot detection vs. the CSP.** On `app.qorpera.com` the
console shows one blocked inline script. It is Cloudflare's own JavaScript
Detections snippet (`__CF$cv$params`), injected zone-wide because the
`qorpera.com` zone runs Bot fight mode with "JS Detections: On". The app is
unaffected (all first-party script is external and allowed); the bot
fingerprint simply fails silently on this host. `pages.dev` shows no such
error. Options are a zone setting change (turn "JS Detections" off; Bot fight
mode itself keeps challenging), or living with the console error. Not changed:
it is a zone-wide security setting and the founder's call.

**Sign-in redesign (founder feedback: the first card was generic).** The web
sign-in now uses the desktop's public brand field from
`packages/shell/userland/onboarding.css`: the same radial gradient, white
24px card with the deep shadow, the creature mark, the 760-weight wordmark,
Google/GitHub provider cards with marks, the "or" divider and the inline email
form with a black Continue button; the one-time-code step reuses the same form
with a "Use a different email" link. Verified by headless Chrome screenshots at
1440×900 and 390×844 with no console errors.

**Sign-in, second pass (founder: the brand field was the old design).** The
current brand was found in `Qorpera_Website` (`brand/final`, landing tokens)
and `QorperaMobile` (sign-in structure, avatar rendering); recorded in
`DECISIONS.md`. The sign-in is now a split page: lockup, "Sign in", provider
buttons, an "or" divider and the email form on paper at left; the crown hero
on the grid floor at right, masked by the approved contour with its eye shapes
layered in ink and flipped to face the form; single column under 900px. The
top bar shows the approved lockup and the favicon is the final mark. Staff
avatars render as tinted silhouettes with eyes. Verified with headless Chrome
at 1440×900 and 390×844 plus an avatar test page; no console errors.

**Crown as a living vector character (founder feedback: more depth, much
more animation, no grid, see-through eyes).** `views/crown.ts` draws the
approved V24 contour as inline SVG with a gold gradient, rim shading and a
soft top highlight, punches the eyes through with a luminance mask so the
surface shows, and adds a ground shadow. Motion, all CSSOM and SVG attributes
under the strict CSP: the approved entry spring and "measured nod" loop, a
periodic hop with anticipation, stretch, landing squash and a squint at
launch, blinks on their own tempo, the approved screen-gaze sequence blended
with pointer tracking, a glance at whichever form field takes focus, and a
hover lift; still under prefers-reduced-motion, paused in hidden tabs, and it
retires itself when the sign-in leaves the document. The grid floor is gone.
Verified with a 24-frame strip (hop, landing, blink, gaze visible) and a
static capture; no console errors.

**Stale bundle in a long-open tab.** A tab opened before the redesigns kept
serving the first `main.js` from its browser cache even across a
re-navigation and a reload, while the network already served the new build
(`cf-cache-status: REVALIDATED`, fresh fetch new). Fix: production bundles are
now emitted as `build/main-<hash>.js` and `build/app-<hash>.css` with
`index.html` rewritten to them, and `/build/*` is cached as immutable for a
year while the HTML stays `max-age=0, must-revalidate`. A deploy therefore
always changes the file names the HTML points at; no browser can pin an old
bundle to a new page.

**Hover reaction removed (founder).** The crown no longer lifts or reacts when
the pointer is over it; the body stays put while the eyes look around. The
entry spring, the measured nod, the occasional hop, blinks, gaze and the
glance at a focused field remain.

**Centered sign-in; stylesheet asset URLs.** The sign-in block is centered in
its column at every width, with the lockup and footnote centered in the
single-column layout. Moving the stylesheet under `/build/` had broken its
relative asset URLs (fonts, avatar masks), which fell back to system fonts on
the deployed site; those URLs are now root-absolute.

**Sign-in email fixed at the source (founder signed in to Supabase; browser
pane).** The email came from Supabase's default mailer, carried no code, and
its link landed on the marketing site. Causes and fixes in the project's Auth
settings: (1) the redirect allow-list held only the desktop's loopback and
`qorpera://` entries, so an unmatched `emailRedirectTo` fell back to the Site
URL `https://qorpera.com` — added `https://app.qorpera.com/**` and the two dev
origins; (2) the "Magic link or OTP" and "Confirm sign up" templates lacked
`{{ .Token }}` — replaced with Qorpera-branded templates that lead with the
six-digit code (`packages/web/auth-email/`); (3) custom SMTP via Resend was
filled in except the API key, which only the founder pastes. The code step's
copy now says the link works only in the requesting browser (PKCE).
Custom SMTP saved by the founder (Resend, `smtp.resend.com:465`, sender
`Qorpera <no-reply@mail.qorpera.com>`); "Successfully updated settings".

**"Error sending magic link email" diagnosed.** The Auth log for the failing
`POST /otp` (02 Sep 04:09:09, referer `https://app.qorpera.com/`, status 500)
carries `error: 535 "Authentication credentials invalid"` — SMTP authentication,
not the sender or the template. Resend shows `mail.qorpera.com` verified, so the
sender address is right; host, port 465 and username `resend` match Resend's
SMTP contract. The remaining cause is the key value: Resend's API-key list
displays only a truncated prefix (`re_9dkbWYt5...`), and a value copied from
that table authenticates as invalid. Fix: a new key created from the Resend
dialog (its full value is shown once) pasted into the SMTP password field. An
earlier request at 03:51 had already rendered the new template and verified
successfully through the built-in mailer, so the rest of the pipeline is proven.

**Hub design (founder: the no-companies page needs work).** It was an unstyled
full-bleed notice with the create form crammed into the header, flush against
the window edge because `section.hub` had no layout rules at all. Rebuilt:

- The hub is now a centred, padded column (max 1040px) inside the main pane.
- **Welcome state** (signed in, no companies): the crown character, "Start your
  first company", one line explaining that Qorpera seeds the Company File and
  the Co-Founder, a prominent name field with a black Create company button,
  and a note about invitations. Vertically centred.
- **Invited variant**: the same stage leads with "You have been invited", the
  invitation cards with Accept/Decline, an "or" divider, then the create form.
- **Populated state**: header plus a company grid, both properly inset.
- Company cards now use the shared company artwork instead of a letter tile,
  chosen by the same name hash the mobile client uses (BigInt reproduces
  Swift's 64-bit wraparound), so a company looks the same in every client.
- `mountCrown` gained a `mirrored` option and is sized by its host, so the
  character is reusable outside the sign-in; the hub mounts it unmirrored.

Verified with a throwaway harness that renders the hub's three states against
the real stylesheet inside the app's frame; no console errors.
