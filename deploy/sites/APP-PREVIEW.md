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
  (the link program's current connection key). Check: a files site has no machine, port or key; an app site has a port,
  never a files version, and no key while it is off. An app site's `source_path` is the name of the machine it was
  shared from. An app site is **live** when `kind = 'app' and published_at is not null and machine_id is not null` and
  the machine is there: not removed and not being deleted (`desired_state <> 'deleted'`), the one rule `share_app`
  takes a machine by; a files site as before (`current_version_id is not null`). An app site that is off holds its name
  for a day after its last change, as an unfinished files site does; a shared one always holds it.
- `qorpera_company_site_app_claims (claim_sha256 pk, site_id fk cascade, run_id, call_id, first_share, new_password,
  created_at, expires_at, used_at)`: claims of 15 minutes, each recording the `share_app` call that issued it. A claim
  is what the agent's command carries; the program trades it for a connection key at once, so the command text (which
  members see in the machine's list) holds nothing that works for long. A claim stays redeemable for 2 minutes after
  its first use (an answer lost on the way still lets the program connect); a newer share ends it at once.
- `qorpera_site_settings`: `apps_enabled boolean not null default false` (the apps' own switch; both switches must be
  on) and `app_host_suffix text not null default '-preview.qorpera.com'`. `qorpera_site_url(slug)` gives
  `https://<slug><suffix>/` for an app site.
- The relay's role `qorpera_site_relay` (nologin, granted to `authenticator`, usage on schema public; the relay's key is
  a JWT with this role): EXECUTE on `qorpera_site_app_connect`, `qorpera_site_app_session` and
  `qorpera_site_app_unlock` only, and no table.
- **Agent calls** (native host calls with the run's binding, scope binding, as `qorpera_site_publish_*`):
  - `qorpera_site_share_check(p_binding jsonb, p_slug text, p_machine text, p_port integer) returns jsonb` — read
    only, before the automatic review. When `share_app` would refuse the machine (none of that name, removed or being
    deleted, or not always-on): `{state: 'refused', reason: 'APP_MACHINE_NOT_FOUND' | 'APP_MACHINE_NOT_ALWAYS_ON',
    needsReview: false}`, so no owner approves a card for a share that fails. Else
    `{state: 'new' | 'update' | 'taken', needsReview: boolean, url: text, machine?: text, port?: integer}`: `url` is
    the app link the slug has or would have; `machine` and `port` (the live link's, for an `update` only). `taken` =
    another company's slug, or a files site of this company (share never turns a files site into an app). Review is
    needed for a new app site and for an update whose live machine or port differs from `p_machine`/`p_port` (another
    port is another service). It raises as `share_app` does for a switch off, an invalid slug or port, and the site
    limit.
  - `qorpera_site_share_app(p_binding jsonb, p_call_id text, p_request jsonb, p_review_id uuid) returns jsonb` —
    request `{slug, title?, machine (the machine's name), port}`. The machine is the company's, there (as above), and
    `lifetime = 'always-on'` (refusal `APP_MACHINE_NOT_ALWAYS_ON` says why: a task machine sleeps;
    `APP_MACHINE_NOT_FOUND` otherwise). Creates or updates the site (published at once; a new site gets its password as
    `publish` does), issues a **new** claim (every older claim of the site ends), and returns
    `{slug, url, machine, port, firstShare, newPassword, claim, claimExpiresAt, clientUrl, connectUrl}` with
    `clientUrl = https://<slug><suffix>/.qorpera/client.mjs`, `connectUrl = wss://<slug><suffix>/.qorpera/connect`.
    `firstShare`: the link was not live before this call; `newPassword`: this call made the site and its password. A
    share that changes the machine or the port needs the review as a new link does, and ends the link's key at once
    (the program connected now is cut off; the new claim makes the next key); the same machine and port keep it. The
    same (run, call id) again returns the same site, as that call did, and a fresh claim. Refusals as
    `publish_begin`'s (no review, worker, wake, deleting company, switch off).
  - `qorpera_site_unpublish` works for both kinds (an app site: `published_at` null, its key, claims and visitors'
    sessions gone; the site, its name and its password stay for the next share). `qorpera_site_publish_check` and
    `qorpera_site_publish_begin` refuse an app site's slug (`SITE_NAME_TAKEN`).
- **Relay calls** (service_role and `qorpera_site_relay`):
  - `qorpera_site_app_connect(p_slug text, p_secret text) returns jsonb` — `p_secret` is the site's current key (read
    only; `key` null) or a claim redeemable now (the site row locked; a new 32-byte key is minted, its sha256 stored,
    and returned once; each redemption's key replaces the last, so only the newest program connects).
    `{state: 'ok', key: text | null, port: integer, siteId: text}` or `{state: 'refused'}` (unknown, not live, switch
    off, company deleting, wrong or ended secret: all alike). `siteId` is the site's uuid: the relay keeps it with the
    program and forwards a visitor only when the session's `siteId` is the same.
  - `qorpera_site_app_session(p_slug text, p_token text) returns jsonb` — `{state: 'open', siteId: text}` for a live
    app site's unexpired session of its current password version, else `{state: 'locked'}`.
  - `qorpera_site_app_unlock(p_slug text, p_password text, p_client text) returns jsonb` — a live app site's password,
    with `qorpera_site_unlock`'s limits on the same failure rows and its answers (`open` with `token` and `maxAge`,
    `wrong`, `limited` with `retryAfter`).
  - `qorpera_site_unlock` stays the files sites' alone (unchanged), and `qorpera_site_serve` never serves an app site
    (answers as locked).
- **Members**: `qorpera_list_company_sites` adds `kind`, `machine` (name, or null when the machine is gone) and `port`
  to each row, and the url per kind; an app site's `state` is `live` or `off`. A member's unpublish deletes an app site
  whole, as a files site.
- Observations: `share_app` joins the closed vocabulary beside `publish_site`.

### 2. Runtime: the `share_app` tool (`packages/runtime/src/cloud-site-tools.ts`)

Arguments `{slug, title?, machine, port}`. Flow as `publish_site`: `share_check` → automatic review when
`needsReview` (the card says: share a private, password-protected app link `<url>` from machine `<m>`, port `<p>`) →
`share_app` (the check also takes the port: a different machine or port needs the review again). The tool then
starts the link program itself on that machine, through the same receipted command `machine_run` uses, with no time
limit, so the one-time claim never reaches the model. The command it runs:

```
curl -fsS <clientUrl> -o /root/.qorpera-app-link-<slug>.mjs.tmp && mv -f /root/.qorpera-app-link-<slug>.mjs.tmp /root/.qorpera-app-link-<slug>.mjs && exec node /root/.qorpera-app-link-<slug>.mjs <slug> <port> <claim> <suffix>
```

The result tells the agent the link, whether the program started, and whether the password is new.

Its description: for a server app (a coding session's work too, at `/company/code/<owner>/<name>/worktrees/<id>`):
start an always-on machine, run the app there listening on a port, then `share_app`; static files go with
`publish_site`. The password is never in the result: members read it in Settings → Sites. `unpublish_site` turns the
link off. Registered where `publish_site` is (company agents' runs only, no workers), with its review kind and
observation name.

### 3. The relay and the link program (`deploy/sites/app-relay/`)

`relay.mjs` (Node 24, no dependencies) and `client.mjs` (the link program, Node 24, no dependencies; served by the
relay at `/.qorpera/client.mjs` on every app host, no password).

Relay, listening on `:8090` on the compose network; environment `QORPERA_API` (`http://api-gw:8000`),
`QORPERA_API_KEY` (the stack's anon key, the gateway's `apikey`), `QORPERA_RELAY_JWT` (a JWT with role
`qorpera_site_relay`, minted at rollout from the stack's JWT secret: the relay never holds the service role and refuses
to start with any other role), `QORPERA_APP_HOST_SUFFIX` (`-preview.qorpera.com`):

- The app host is `x-forwarded-host` as api-front sets it (the request's own name), matched against
  `^([a-z0-9][a-z0-9-]{1,46}[a-z0-9])<suffix>$`; anything else 404.
- `/.qorpera/` is the platform's on an app host: `connect` (WebSocket upgrade; `Authorization: Bearer <secret>` →
  `qorpera_site_app_connect`, asked before the handshake completes; a refusal still completes it and closes with
  4001, the only answer a WebSocket client can read; connect attempts limited per CF-Connecting-IP, 429; the answer's
  key, the link's URL and its port go to the program in the first message), `client.mjs`, `unlock` (POST form
  `password`, `next`), anything else 404.
- The gate: cookie `__Host-qorpera_app` (HttpOnly, Secure, SameSite=Lax, Path=/, the session's max age), checked with
  `qorpera_site_app_session` (an open answer kept 30 s in memory, a locked one 5 s). No valid cookie: the password page
  (401, English or Danish as site-serve's, same look); `unlock` → `qorpera_site_app_unlock(slug, password,
  CF-Connecting-IP)` → cookie → 303 to `next` (a same-host path only). 429 when limited.
- Forwarding, through the slug's one connected program (a newer connection replaces an older one), and only when that
  program connected for the very site the session opens (`siteId`): a program left from an earlier site of the slug
  is dropped (4001) and the visitor gets 503. The request line, headers and body as frames; the response streamed
  back. No program: 503 "This app is not running right now". No response head in 60 s: 504. Request bodies ≤ 10 MiB.
  A visitor who reads nothing for 30 s while the program waits on them is cut off, so the program serves everyone else
  again. Hop-by-hop headers dropped both ways. To the app: the gate cookie taken out of `Cookie`, `X-Forwarded-Proto:
  https`, `X-Forwarded-Host`, `X-Forwarded-For` = the visitor's CF-Connecting-IP only, and `Transfer-Encoding: chunked`
  when the visitor's body came chunked (so the app never reads a body as a request of its own). From the app: the
  app's cache headers (`Cache-Control`, `Expires`, `CDN-Cache-Control`, `Cloudflare-CDN-Cache-Control`,
  `Surrogate-Control`) replaced by `Cache-Control: private, no-cache` and `CDN-Cache-Control: no-store` (Cloudflare's
  cache sits in front of the password); every answer held to its Content-Length (more or fewer bytes end the
  visitor's connection, which api-front shares between app hosts); `Domain=` taken out of every `Set-Cookie`
  (host-only cookies from the app's answers; an app's script can still set cookies for qorpera.com with
  `document.cookie`, which is why the platform uses no cookie for sign-in on qorpera.com names), any `Set-Cookie` for
  `__Host-qorpera_app` dropped. A visitor's own WebSocket upgrade: 501 in v1.
- Every connected program is checked again every 5 minutes: a key that no longer holds or another site under the slug
  ends it (4001), a changed port closes it (1012) so it connects again and learns the port. A program that lets more
  than 8 MiB pile up unread, or pings more than 10 times a second, is cut off.
- Never logged: a claim, key, token, password, cookie or the relay's JWT. `/.qorpera/health` (no host check) for the
  container's healthcheck.

Link program (`node client.mjs <slug> <port> <claim> [host suffix]`): connects to
`wss://<slug><suffix>/.qorpera/connect` with the claim, keeps the key it gets (in memory only), reconnects with the key
after a drop (backoff 1 s → 30 s), and serves each request frame with `http.request` (a connection of its own, no
agent) to `127.0.0.1` on the port the relay's hello names, the one the link is shared for; when its own `<port>`
differs it says so ("This link is shared for port 3000, not 8080: serving port 3000."). Prints plain status lines
("Connected: <url>", "Lost the connection, trying again", "The app on port 3000 is not answering"). Exits 1 with a
plain reason when the relay refuses (claim used or expired: ask the agent to share again; or the link was turned off
or shared again), 0 when a newer program took over.

Frames (WebSocket, binary): one byte type + 4-byte stream id + payload. Types: `1` request head (JSON
`{method, path, headers}`), `2` body chunk, `3` body end, `4` response head (JSON `{status, headers}`), `5` reset
(either side), `6` hello (relay → program, JSON `{key, url, port}`), `7` keepalive (stream 0, empty: the relay sends
one every 25 s and the program answers; either side drops a connection silent for 60 s). Headers as `[name, value]`
pairs so repeated `Set-Cookie` survive. Close codes from the relay: 4001 refused and 4002 replaced (the program stops),
1012 port changed, 1001 relay stopping, 1008 too many pings (it connects again).

### 4. Routing (`deploy/sites/`)

- `envoy-front-sites.yaml`: a virtual host `apps` with `domains: ["*-preview.qorpera.com"]`, every path to cluster
  `app_relay` (`app-relay:8090`, `envoy-front-app-relay-cluster.yaml`, in the kit file's `clusters:`), WebSocket
  upgrades on, `x-forwarded-host` = the request's own name; the api host gets `"api.qorpera.com"` first in its domains,
  and a virtual host `others` with `["*.qorpera.com"]` answers 404, so a wildcard name never reaches the API. The
  `front` listener's connection manager gets `strip_any_host_port` and `strip_trailing_host_dot`, so a name with a port
  or a trailing dot is matched (and forwarded) by its bare name.
- `sites-route.mjs`: also the tunnel rule `*.qorpera.com → http://api-front:8080` (after the exact rules, before the
  catch-all), a Cache Rule bypassing Cloudflare's cache for `-preview.qorpera.com` hosts (made before the names exist;
  a token without Cache Rules permission is said plainly) and a proxied wildcard CNAME `*` → the tunnel, with
  `--check` checking the cache rule and probing an app host's `/.qorpera/health`.
- The compose service `app-relay` (snippet `deploy/sites/app-relay/compose-service.yml`, for the dbhome kit's
  `docker-compose.dbhome-front.yml`): pinned `node:24` image, read-only, `./front/app-relay:/app:ro`, `ANON_KEY` and
  `QORPERA_RELAY_JWT` from `.env` (the snippet's header says how the JWT is minted).

## Rollout (v195)

Migration → bundle 195 (the tool) → relay files + compose service → envoy block → tunnel rule + DNS →
`update qorpera_site_settings set apps_enabled = true`. Kill switch: `apps_enabled = false` (every app link answers
locked, no share), or stop `app-relay`.

## Not in v1

A visitor's WebSocket (live reload), a custom domain, public (no password) links, a separate registrable domain for
previews (Jonas's open decision on a sites domain: until then previews are host-only-cookie subdomains of
qorpera.com, which never use cookies for sign-in).
