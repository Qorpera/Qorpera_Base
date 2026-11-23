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
  created_at, expires_at, used_at, program_sha256)`: claims of 15 minutes, each recording the `share_app` call that
  issued it. A claim is what the agent's command carries; the program trades it for a connection key at once, so the
  command text (which members see in the machine's list) holds nothing that works for long. A claim stays redeemable
  for 2 minutes after its first use (an answer lost on the way still lets the program connect), by the program that
  first redeemed it only (`program_sha256`: the sha256 of that program's per-process id), so a claim read off the
  machine takes nothing over; a newer share ends it at once.
- `qorpera_site_settings`: `apps_enabled boolean not null default false` (the apps' own switch; both switches must be
  on) and `app_host_suffix text not null default '-preview.qorpera.com'`. `qorpera_site_url(slug)` gives
  `https://<slug><suffix>/` for an app site.
- The relay's role `qorpera_site_relay` (nologin, granted to `authenticator`, usage on schema public; the relay's key is
  a JWT with this role): EXECUTE on `qorpera_site_app_connect`, `qorpera_site_app_session` and
  `qorpera_site_app_unlock` only, of every function in schema public (every other one is revoked from PUBLIC; test 562
  checks the whole schema), and no table.
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
  - `qorpera_site_app_connect(p_slug text, p_secret text, p_program text) returns jsonb` — `p_program` is the link
    program's per-process id (43 characters of base64url; anything else is refused). `p_secret` is the site's current
    key (read only; `key` null; `p_program` is checked for its form only) or a claim redeemable now (the site row
    locked; a new 32-byte key is minted, its sha256 stored, and returned once; each redemption's key replaces the last,
    so only the newest program connects). The first redemption stores `sha256(p_program)` on the claim; in the claim's
    2 minutes more only the same program id redeems it again. `{state: 'ok', key: text | null, port: integer,
    siteId: text}` or `{state: 'refused'}` (unknown, not live, switch off, company deleting, wrong or ended secret, a
    claim another program redeemed, a malformed program id: all alike). `siteId` is the site's uuid: the relay keeps it
    with the program and forwards a visitor only when the session's `siteId` is the same.
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
limit, so the tool's answer never holds the claim. The claim is a word of that command, so it shows on the machine and
in the members' command list; the program spends it within seconds, and only that program (by its per-process id) can
redeem it again in the next 2 minutes. The command it runs:

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
to start with any other role), `QORPERA_APP_HOST_SUFFIX` (`-preview.qorpera.com`), optional `QORPERA_WEB_ORIGINS` (JSON
array of exact `https://` web origins permitted to post member passes; defaults to `["https://app.qorpera.com"]`),
optional `QORPERA_APP_RELAY_MAX_BODY_BYTES` (default 10 MiB, configurable up to 100 MiB), and optional
`QORPERA_APP_RELAY_GRACEFUL_SHUTDOWN_MS` (default 30 s):

- The app host is `x-forwarded-host` as api-front sets it (the request's own name), matched against
  `^([a-z0-9][a-z0-9-]{1,46}[a-z0-9])<suffix>$` or a verified custom domain (`dns_verified` / `tls_active`) reported for
  a connected link program by `qorpera_site_app_connect`; anything else 404. (Note: Envoy front routing in
  `envoy-front-sites.yaml` currently routes `*-preview.qorpera.com` to `app_relay`; custom domains reach `app-relay`
  once routed to it by a front proxy.)
- `/.qorpera/` is the platform's on an app host: `connect` (WebSocket upgrade; `Authorization: Bearer <secret>` and
  `x-qorpera-program: <the program's id>` → `qorpera_site_app_connect(slug, secret, id)`, asked before the handshake
  completes; a refusal still completes it and closes with 4001, the only answer a WebSocket client can read; a secret
  or id that is not of the platform's form is refused without asking; the answer's key, the link's URL, its port, and
  the per-stream initial flow-control window go to the program in the first message), `client.mjs`, `unlock` (POST form
  `password`, `next`), `member` (`POST /.qorpera/member` and `POST /__qorpera/member`: accepts a one-use member pass
  `pass` + optional `next`/`path` posted ONLY from an exact origin in `QORPERA_WEB_ORIGINS`, redeemed once via
  `qorpera_site_app_unlock` into `__Host-qorpera_app`, then 303 redirect), anything else 404.
  Connects in flight are capped in all (512), with untrusted connects additionally capped per address and reserving
  capacity for trusted exit addresses so one cycling address cannot starve other links. Refused connects are counted per
  address (an IPv6 address by its /64) and link, 10 a minute (and per address across links), then 429; never for the
  agent exits' public addresses (`QORPERA_APP_RELAY_TRUSTED_ADDRESSES`, which every company's machines share).
- Auth modes (`app_auth_mode` on `qorpera_company_sites`, configured by owners/admins via
  `qorpera_set_company_site_app_auth_mode`):
  - `password` (default): cookie `__Host-qorpera_app` (HttpOnly, Secure, SameSite=Lax, Path=/, the session's max age),
    checked with `qorpera_site_app_session` (open answers kept 30 s LRU and locked answers 5 s in a separate cache so
    invalid cookies never evict active sessions, with concurrent cold lookups coalesced). No valid cookie: the password
    page (401, English or Danish as site-serve's, same look); `unlock` → `qorpera_site_app_unlock(slug, password,
    CF-Connecting-IP)` → cookie → 303 to `next` (a same-host path only). 429 when limited.
  - `company_member`: only redeemed `__Host-qorpera_app` member sessions (created by posting a one-use pass from
    `QORPERA_WEB_ORIGINS` to `POST /.qorpera/member` or `/__qorpera/member`) are accepted — never a non-`__Host-` cookie
    or an unredeemed pass. `qorpera_site_app_session` verifies live company membership and returns `memberId`, which the
    relay forwards as `X-Qorpera-Member-Id` after stripping all incoming `X-Qorpera-*` headers. Removing a member
    invalidates access immediately.
  - `public`: enabled only when `qorpera_site_settings.public_enabled` is true. Skips the cookie gate on HTTP and WS,
    bounded by a per-(IP, slug) token bucket (300 burst, 600 req/min refill) and `PUBLIC_MAX_CONCURRENT_PER_IP = 32`.
- A change from another site (step 5, release 5.1; SITE-HOSTS.md): before the gate, any method but GET, HEAD and
  OPTIONS whose `Sec-Fetch-Site` is `same-site` or `cross-site`, or whose `Origin` is there and is not exactly
  `https://<the app host>` (`null` passes only with `Sec-Fetch-Site: same-origin`), answers 403 (`no-store`): every
  company website is a same-site neighbour of every app link and could otherwise make a visitor's browser post into an
  app on the Lax gate cookie. The sole exception is `POST /.qorpera/member` (and `POST /__qorpera/member`), which passes
  only when `Origin` is strictly in `QORPERA_WEB_ORIGINS` (any missing, `null`, sibling, or other origin answers 403).
  The unlock form's own POST is same-origin and passes; a request with neither header passes as before.
- Forwarding, through the slug's one connected program (a newer connection replaces an older one), and only when that
  program connected for the very site the session opens (`siteId`). On a mismatch the session is asked again, past the
  kept answer: locked → 401; the program's site after all → forwarded; another site still → the program
  is checked with its key, dropped (4001) only when the database no longer takes it, and the visitor gets 503. The
  request line, headers and body travel as frames; the response streams back with per-stream credit-based flow control
  (`TYPE.window = 12`, initial window 256 KiB per stream, `WINDOW_UPDATE` sent after 64 KiB flushed or on `drain`) so
  one slow visitor never stalls sibling streams on the same tunnel. The relay enforces the granted credit on every
  `BODY` frame (closing a misbehaving program with 1002 if it exceeds its window) plus hard `res.writableLength` caps
  (512 KiB per stream, 2 MiB per program, 32 MiB relay-wide; when a program or relay cap trips, the relay evicts the
  heaviest stalled stream so fast readers finish uninterrupted) as a memory backstop; a stalled visitor is cut off after
  30 s (or 4 s without forward progress). No program: 503 "This app is not running right now". Timeouts separate
  first-byte (`FIRST_BYTE_TIMEOUT_MS = 60 s` before response headers → 504) from stream idle
  (`STREAM_IDLE_TIMEOUT_MS = 300 s` after response headers). For `Content-Type: text/event-stream` responses, the relay
  emits `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, and `CDN-Cache-Control: no-store` (non-public
  modes), and writes SSE keepalive comments (`: keepalive\n\n`) every 25 s while idle. Request bodies default to ≤ 10
  MiB (configurable up to 100 MiB via `QORPERA_APP_RELAY_MAX_BODY_BYTES`), streamed across the link socket with
  per-stream backpressure so concurrent upload bursts do not trip the 8 MiB send cap.
  Hop-by-hop headers dropped both ways. To the app: gate cookies taken out of `Cookie`, all incoming `X-Qorpera-*`
  headers stripped, `X-Forwarded-Proto: https`, `X-Forwarded-Host`, `X-Forwarded-For` = the visitor's CF-Connecting-IP
  only, `X-Qorpera-Member-Id` when authenticated as a company member, and `Transfer-Encoding: chunked` when the
  visitor's body came chunked (so the app never reads a body as a request of its own). From the app: safe browser
  caching directives (`private, max-age=...`, optional `must-revalidate`, `immutable`, `stale-while-revalidate`; and
  `public` only in `public` auth mode when requested) are preserved while keeping `CDN-Cache-Control: no-store` on all
  non-public modes and defaulting unannotated answers to `Cache-Control: private, no-cache` (`private, no-store` when
  the app said `no-store`); every answer held to its Content-Length (more or fewer bytes end the visitor's connection,
  which api-front shares between app hosts), and an answer that names its length twice or not in digits refused (502);
  `Domain=` taken out of every `Set-Cookie` (host-only cookies from the app's answers), and any `Set-Cookie` for gate
  cookies dropped.
- Visitor WebSockets: a visitor's `Upgrade: websocket` on any non-platform path passes the same host check, an exact
  same-origin CSWSH check (`Origin` must equal `https://<the app host>`, and `Sec-Fetch-Site` must not be `same-site` or
  `cross-site`; rejected with 403 before the gate — absent `Origin` is permitted ONLY in `public` mode with no `Cookie`
  header for non-browser CLI/SDK/mobile clients), the same session gate (`qorpera_site_app_session`; rejected with 401
  before upgrading), and the same `siteId` / live-program check (503 when not running). The relay waits for the link
  program to complete the upstream RFC 6455 handshake to `127.0.0.1:<port>` before answering `101 Switching Protocols`
  to the visitor (non-101 upstream responses reject the visitor before upgrade; handshake timeout answers 504).
  Forwarded upgrade headers preserve `Authorization` for app-level auth while stripping gate cookies, incoming
  `X-Qorpera-*` headers, visitor `Host`, hop-by-hop, `X-Envoy-*`, `Content-Length`, and
  `Sec-WebSocket-{Key,Version,Extensions,Accept}` (and injecting trusted `X-Qorpera-Member-Id` for `company_member`
  sessions and validated `Sec-WebSocket-Protocol` negotiation); 101 response headers strip hop-by-hop and cache headers
  and sanitize `Set-Cookie` host-only without gate cookies. Resource bounds: at most 256 concurrent visitor WebSockets
  per link (`MAX_WS_PER_SITE`, 503 when full, counted independently of HTTP streams), 1 MiB max message size
  (`MAX_WS_MESSAGE_BYTES`, closed with 1009), 2 MiB per-visitor send queue cap (`MAX_WS_QUEUED_BYTES`, slow consumers
  closed cleanly with 1013 without stalling other streams), per-stream `TYPE.window` flow control, and 25 s ping / 60 s
  idle timeout keepalive. Open visitor WebSockets re-verify their gate session every `sessionCacheMs` (30 s, cached and
  coalesced across sockets sharing a token) and close with 1008 ("session ended") when the session is revoked or no
  longer matches the link's site. Close codes are sanitized per RFC 6455 so non-wire codes (1005, 1006, 1015) are never
  sent on the wire. All open visitor WebSockets close cleanly with 1001 when the tunnel drops, a newer link program
  replaces it, the site is unpublished/retaken, or the relay finishes draining.
- Graceful shutdown: on `SIGTERM`/`SIGINT`, `server.drain(gracefulShutdownMs)` marks `/.qorpera/health` 503 (`draining`),
  refuses new requests, waits up to 30 s (`compose-service.yml` sets `stop_grace_period: 35s`) for in-flight HTTP and WS
  streams to finish, then closes remaining sockets with 1001.
- Every connected program is checked again every 5 minutes: a key that no longer holds or another site under the slug
  ends it (4001), `authMode` and verified custom domains sync live, and a changed port attempts a zero-downtime
  `TYPE.swapTarget` swap over the existing tunnel first (falling back to 1012 close only if the swap fails or times
  out). A program that lets more than 8 MiB pile up unread, exceeds its stream window (1002), or pings more than 10
  times a second (1008) is cut off.
- Never logged: a claim, key, token, password, cookie or the relay's JWT. `/.qorpera/health` (no host check) for the
  container's healthcheck.

Link program (`node client.mjs <slug> <port> <claim> [host suffix]`): makes a random id when it starts (32 bytes,
base64url, in memory only) and sends it on every connect; connects to `wss://<slug><suffix>/.qorpera/connect` with the
claim, keeps the key it gets (in memory only), reconnects with the key after a drop (backoff 1 s → 30 s), and serves
each request frame over a shared keep-alive `http.Agent` (`keepAlive: true, maxSockets: 256, maxFreeSockets: 64`) to
`127.0.0.1` on the port the relay's hello names (or updated via `TYPE.swapTarget`), honoring per-stream `sendCredits`,
O(1) upload buffer tracking, and event-driven socket `drain` backpressure. Probes `127.0.0.1:<port>` (HTTP GET to
`QORPERA_APP_HEALTH_PATH` or TCP connect every 10 s) and sends `TYPE.health` heartbeats; on `TYPE.swapTarget`, probes
the target port, switches new streams to it while draining in-flight streams on the old port, and acknowledges. On
`SIGTERM`/`SIGINT`, stops accepting new streams, waits up to 30 s for in-flight streams to drain, destroys the HTTP
agent, and exits cleanly. Exits 1 with a plain reason when the relay refuses (claim used or expired: ask the agent to
share again; or the link was turned off or shared again), 0 when a newer program took over.

Frames (WebSocket, binary): one byte type + 4-byte stream id + payload. Types: `1` request head (JSON
`{method, path, headers}`), `2` body chunk, `3` body end, `4` response head (JSON `{status, headers}`), `5` reset
(either side), `6` hello (relay → program, JSON `{key, url, port, window}`), `7` keepalive (stream 0, empty: the relay
sends one every 25 s and the program answers; either side drops a connection silent for 60 s), `8` visitor WebSocket
open (relay → program, JSON `{path, headers}`), `9` visitor WebSocket open ok (program → relay, JSON
`{protocol?, headers?}`), `10` visitor WebSocket data (either side, 1-byte opcode `1` text / `2` binary + message
payload ≤ 1 MiB), `11` visitor WebSocket close (either side, 2-byte uint16BE RFC 6455 close code + UTF-8 reason, or
2-byte HTTP 4xx/5xx status when sent program → relay before `9` to report a non-101 upstream rejection), `12` window
update (relay → program, 4-byte uint32BE bytes consumed on stream), `13` health heartbeat (program → relay, stream 0,
JSON `{healthy, port, lastStatus, lastLatencyMs, restartCount, checkedAt}`), `14` target port swap (stream 0; relay →
program JSON `{port, healthPath?, timeoutMs?}`, program → relay JSON `{ok, activePort, previousPort?, error?}`).
Headers as `[name, value]` pairs so repeated `Set-Cookie` survive. Close codes from the relay: 4001 refused and 4002
replaced (the program stops), 1002 protocol/flow-control violation, 1012 port changed (when live swap failed), 1001
relay stopping, 1008 too many pings (it connects again).

### 4. Routing (`deploy/sites/`)

- `envoy-front-sites.yaml`: a virtual host `apps` with `domains: ["*-preview.qorpera.com"]`, every path to cluster
  `app_relay` (`app-relay:8090`, `envoy-front-app-relay-cluster.yaml` with `idle_timeout: 360s` for long-lived SSE/LLM
  streams, in the kit file's `clusters:`), WebSocket upgrades on, `x-forwarded-host` = the request's own name; the api
  host gets `"api.qorpera.com"` first in its domains, and every other name under qorpera.com goes to a virtual host of
  its own, so a wildcard name never reaches the API (until 5.1 `others`, answering 404; since 5.1 `site-hosts`, a
  company site's own host, SITE-HOSTS.md). The `front` listener's connection manager gets `strip_any_host_port` and
  `strip_trailing_host_dot`, so a name with a port or a trailing dot is matched (and forwarded) by its bare name.
- `sites-route.mjs`: also the tunnel rule `*.qorpera.com → http://api-front:8080` (after the exact rules, before the
  catch-all), a Cache Rule bypassing Cloudflare's cache for `-preview.qorpera.com` hosts (made before the names exist;
  a token without Cache Rules permission is said plainly) and a proxied wildcard CNAME `*` → the tunnel, with
  `--check` checking the cache rule and probing an app host's `/.qorpera/health`.
- The compose service `app-relay` (snippet `deploy/sites/app-relay/compose-service.yml`, for the dbhome kit's
  `docker-compose.dbhome-front.yml`): pinned `node:24` image, `stop_grace_period: 35s`, read-only,
  `./front/app-relay:/app:ro`, `ANON_KEY`, `QORPERA_RELAY_JWT`, and optional `QORPERA_WEB_ORIGINS` from `.env` (the
  snippet's header says how the JWT is minted).

## Rollout (v195)

Migration → bundle 195 (the tool) → relay files + compose service → envoy block → tunnel rule + DNS →
`update qorpera_site_settings set apps_enabled = true`. Kill switch: `apps_enabled = false` (every app link answers
locked, no share), or stop `app-relay`.

## Not in v1

A custom domain, public (no password) links, a separate registrable domain for
previews (Jonas, 13 November 2026: sites and app links stay on qorpera.com; previews are host-only-cookie subdomains
of qorpera.com, which never uses a cookie for sign-in: SITE-HOSTS.md, "The invariant").
