# Private app links (v195)

Jonas, 3 November 2026, after Codex built the SAML shop as a Node server: "Yes, build it" (a private preview link so
he can open apps like this from his browser). Company sites (`publish_site`, migration `20260930550000`) serve static
files only; a server app (Node, Python, Docker) runs on a machine, and "nothing can reach it from outside". This adds
one way in: an agent shares one port of one of the company's **always-on machines** as a private link, behind the
site's password, exactly as a static site is.

## What the member sees

- The agent says: "Your app is live at https://saml-shop-preview.qorpera.com/". The link shows the same password page
  as a site. The password is in Settings → Sites, where the member also changes it or turns the link off.
- The first share asks for approval, as a new site does (an access-change card: "Share a private app link …").
- While the app's machine runs and its link program runs, the app answers. Otherwise the link shows "This app is not
  running right now" (503).

## The parts

```
visitor ──https──▶ Cloudflare (*.qorpera.com, Universal SSL)
           ──tunnel qorpera-dbhome──▶ api-front (envoy, vhost apps: *-preview.qorpera.com)
           ──▶ app-relay (Node, db-primary's compose)  ◀──wss── link program in the machine ──http──▶ 127.0.0.1:<port>
                         │
                         └── RPCs (service role) on the DB: connect, session, unlock
```

The machine dials out (machines reach the internet through the agent exit; nothing new comes in). The relay never
reaches a node or a VM.

### 1. SQL: migration `20260930562000_company_app_sites.sql`, test `562_company_app_sites.test.sql`

An app link **is a company site** with `kind = 'app'`: the same slug space, password, sessions, unlock limits,
members' list, password change and unpublish. Only serving differs.

- `qorpera_company_sites`: `kind text not null default 'files' check (kind in ('files','app'))`; `machine_id uuid`
  (references `qorpera_company_machines(id)` on delete set null); `app_port integer` (1–65535); `app_key_sha256 text`
  (the link program's current connection key). Check: a files site has no machine, port or key; an app site has a port.
  An app site is **live** when `kind = 'app' and published_at is not null and machine_id is not null` (the machine not
  removed); a files site as before (`current_version_id is not null`).
- `qorpera_company_site_app_claims (claim_sha256 pk, site_id fk cascade, created_at, expires_at, used_at)`: one-time
  claims, 15 minutes. A claim is what the agent's command carries; the program trades it for a connection key at once,
  so the command text (which members see in the machine's list) holds nothing that still works.
- `qorpera_site_settings`: `apps_enabled boolean not null default false` (the apps' own switch; both switches must be
  on) and `app_host_suffix text not null default '-preview.qorpera.com'`. `qorpera_site_url(slug)` gives
  `https://<slug><suffix>/` for an app site.
- **Agent calls** (native host calls with the run's binding, scope binding, as `qorpera_site_publish_*`):
  - `qorpera_site_share_check(p_binding jsonb, p_slug text) returns jsonb` — read only, before the automatic review:
    `{state: 'new' | 'update' | 'taken', needsReview: boolean, machine?: text, port?: integer}`. `taken` = another
    company's slug, or a files site of this company (share never turns a files site into an app). Review is needed for
    a new app site and for an update that names another machine than the live one (as a files update from another
    source folder).
  - `qorpera_site_share_app(p_binding jsonb, p_call_id text, p_request jsonb, p_review_id uuid) returns jsonb` —
    request `{slug, title?, machine (the machine's name), port}`. The machine is the company's, not removed, and
    `lifetime = 'always-on'` (refusal `APP_MACHINE_NOT_ALWAYS_ON` says why: a task machine sleeps). Creates or updates
    the site (published at once; first share makes its password as `publish` does), issues a **new** claim (any older
    unused claim of the site ends), and returns
    `{slug, url, machine, port, firstShare, claim, claimExpiresAt, clientUrl, connectUrl}` with
    `clientUrl = https://<slug><suffix>/.qorpera/client.mjs`, `connectUrl = wss://<slug><suffix>/.qorpera/connect`.
    The same (run, call id) again returns the same site and a fresh claim. Refusals as `publish_begin`'s (no review,
    worker, wake, deleting company, switch off).
  - `qorpera_site_unpublish` works for both kinds (an app site: `published_at` null, key and claims gone).
- **Relay calls** (service_role only, like `qorpera_site_serve`):
  - `qorpera_site_app_connect(p_slug text, p_secret text) returns jsonb` — `p_secret` is an unused, unexpired claim
    (marked used; a new 32-byte key is minted, its sha256 stored, and returned once) or the site's current key.
    `{state: 'ok', key: text | null, port: integer}` or `{state: 'refused'}` (unknown, not live, switch off, company
    deleting, wrong secret: all alike). A new claim's key replaces the old key, so only the newest program connects.
  - `qorpera_site_app_session(p_slug text, p_token text) returns jsonb` — `{state: 'open'}` for a live app site's
    unexpired session of its current password version, else `{state: 'locked'}`.
  - `qorpera_site_unlock` (patched): unlocks a live app site as it does a files site.
  - `qorpera_site_serve` never serves an app site (answers as locked).
- **Members**: `qorpera_list_company_sites` adds `kind`, `machine` (name or null) and `port` to each row, and the
  url per kind.
- Observations: `share_app` joins the closed vocabulary beside `publish_site`.

### 2. Runtime: the `share_app` tool (`packages/runtime/src/cloud-site-tools.ts`)

Arguments `{slug, title?, machine, port}`. Flow as `publish_site`: `share_check` → automatic review when
`needsReview` (the card says: share a private, password-protected app link `<url>` from machine `<m>`, port `<p>`) →
`share_app`. The result tells the agent the next step in plain words, with the exact command to run on that machine
with `machine_run` and no `timeoutMs` (it keeps running; the link works while it runs):

```
curl -fsS <clientUrl> -o /root/.qorpera-app-link.mjs && exec node /root/.qorpera-app-link.mjs <slug> <port> <claim>
```

Its description: for a server app (a coding session's work too, at `/company/code/<owner>/<name>/worktrees/<id>`):
start an always-on machine, run the app there listening on a port, then `share_app`; static files go with
`publish_site`. The password is never in the result: members read it in Settings → Sites. `unpublish_site` turns the
link off. Registered where `publish_site` is (company agents' runs only, no workers), with its review kind and
observation name.

### 3. The relay and the link program (`deploy/sites/app-relay/`)

`relay.mjs` (Node 24, no dependencies) and `client.mjs` (the link program, Node 24, no dependencies; served by the
relay at `/.qorpera/client.mjs` on every app host, no password).

Relay, listening on `:8090` on the compose network; environment `QORPERA_API` (`http://api-gw:8000`),
`QORPERA_SERVICE_KEY` (the service role key), `QORPERA_APP_HOST_SUFFIX` (`-preview.qorpera.com`):

- The app host is `x-forwarded-host` as api-front sets it (the request's own name), matched against
  `^([a-z0-9][a-z0-9-]{1,46}[a-z0-9])<suffix>$`; anything else 404.
- `/.qorpera/` is the platform's on an app host: `connect` (WebSocket upgrade; `Authorization: Bearer <secret>` →
  `qorpera_site_app_connect`; the answer's key goes to the program in the first message), `client.mjs`, `unlock`
  (POST form `password`, `next`), anything else 404.
- The gate: cookie `__Host-qorpera_app` (HttpOnly, Secure, SameSite=Lax, Path=/, the session's max age), checked with
  `qorpera_site_app_session` (an open answer kept 30 s in memory). No valid cookie: the password page (401, English or
  Danish as site-serve's, same look); `unlock` → `qorpera_site_unlock(slug, password, CF-Connecting-IP)` → cookie →
  303 to `next` (a same-host path only). 429 when limited.
- Forwarding, through the slug's one connected program (a newer connection replaces an older one): the request line,
  headers and body as frames; the response streamed back. No program: 503 "This app is not running right now".
  No response head in 60 s: 504. Request bodies ≤ 10 MiB. Hop-by-hop headers dropped both ways. To the app: the gate
  cookie taken out of `Cookie`, `X-Forwarded-Proto: https`, `X-Forwarded-Host`, `X-Forwarded-For` = the visitor's
  CF-Connecting-IP only. From the app: `Domain=` taken out of every `Set-Cookie` (host-only cookies; previews never
  set cookies for other qorpera.com names), any `Set-Cookie` for `__Host-qorpera_app` dropped. A visitor's own
  WebSocket upgrade: 501 in v1.
- Never logged: a claim, key, token, password or cookie. `/.qorpera/health` (no host check) for the container's
  healthcheck.

Link program (`node client.mjs <slug> <port> <claim>`): connects to `wss://<slug><suffix>/.qorpera/connect` with the
claim, keeps the key it gets (in memory only), reconnects with the key after a drop (backoff 1 s → 30 s), and serves
each request frame with `http.request` to `127.0.0.1:<port>`. Prints plain status lines ("Connected: <url>",
"Lost the connection, trying again", "The app on port 3000 is not answering"). Exits 1 with a plain reason when the
relay refuses (claim used or expired: ask the agent to share again).

Frames (WebSocket, binary): one byte type + 4-byte stream id + payload. Types: `1` request head (JSON
`{method, path, headers}`), `2` body chunk, `3` body end, `4` response head (JSON `{status, headers}`), `5` reset
(either side), `6` hello (relay → program, JSON `{key, url}`). Headers as `[name, value]` pairs so repeated
`Set-Cookie` survive.

### 4. Routing (`deploy/sites/`)

- `envoy-front-sites.yaml`: a virtual host `apps` with `domains: ["*-preview.qorpera.com"]`, every path to cluster
  `app_relay` (`app-relay:8090`), WebSocket upgrades on, `x-forwarded-host` = the request's own name; the api host
  gets `"api.qorpera.com"` first in its domains, and a virtual host `others` with `["*.qorpera.com"]` answers 404, so a
  wildcard name never reaches the API.
- `sites-route.mjs`: also the tunnel rule `*.qorpera.com → http://api-front:8080` (after the exact rules, before the
  catch-all) and a proxied wildcard CNAME `*` → the tunnel, with `--check` probing an app host's `/.qorpera/health`.
- The compose service `app-relay` (snippet `deploy/sites/app-relay/compose-service.yml`, for the dbhome kit's
  `docker-compose.dbhome-front.yml`): pinned `node:24` image, read-only, `./front/app-relay:/app:ro`, the service key
  from `.env`.

## Rollout (v195)

Migration → bundle 195 (the tool) → relay files + compose service → envoy block → tunnel rule + DNS →
`update qorpera_site_settings set apps_enabled = true`. Kill switch: `apps_enabled = false` (every app link answers
locked, no share), or stop `app-relay`.

## Not in v1

A visitor's WebSocket (live reload), a custom domain, public (no password) links, a separate registrable domain for
previews (Jonas's open decision on a sites domain: until then previews are host-only-cookie subdomains of
qorpera.com, which never use cookies for sign-in).
