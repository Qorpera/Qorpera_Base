# Company sites on addresses of their own (step 5, release 5.1)

Jonas, 13 November 2026: "Use qorpera.com." Every company website gets an address of its own on the platform's domain,
`https://<slug>.qorpera.com/`, served at the top (so links that start with `/` work), and owners and admins look at
the next version first on `https://<slug>--next.qorpera.com/`. Nothing is bought and nothing changes at Cloudflare or
in DNS. The lead's calls: `lanes/own-code-storage/STEP5-BUILD.md` (rules D20 to D23); the reasons:
`lanes/own-code-storage/build5/PRE-5-QORPERA-COM.md`. This file is the operator's: how the hosts work, the rollout,
takedown, the name rule, the standing rules, and what to do when a site is reported.

## How the hosts work

```
visitor ──https──▶ Cloudflare (*.qorpera.com: the proxied wildcard record *, Universal SSL)
           ──tunnel qorpera-dbhome (*.qorpera.com → http://api-front:8080)──▶ api-front (envoy, listener front)
              sites.qorpera.com         → vhost sites      → site-serve (the old links, /<slug>/…)
              api.qorpera.com           → vhost api        → the API
              <slug>-preview.qorpera.com → vhost apps      → the app relay (app links, APP-PREVIEW.md)
              any other <name>.qorpera.com → vhost site-hosts → site-serve (own and next hosts)
```

- **The address forms.** A site's own host is `<slug>.qorpera.com`; its next host is `<slug>--next.qorpera.com`. One
  host rule, shared by SQL (`qorpera_site_host`), site-serve and the web: lower-case the host; it must end
  `.qorpera.com`; take the one label before it; a label ending `--next` is a next host and its slug is the label without
  that ending, else an own host; the slug matches `^[a-z0-9]+(-[a-z0-9]+)*$`, is 3 to 48 long and passes the name rule
  below. As one regex: `^([a-z0-9]+(?:-[a-z0-9]+)*)(--next)?\.qorpera\.com$`, the length checked apart.
- **The road in** is the one app links have used since v195: the wildcard record, the certificate for one level
  (`*.qorpera.com`) and the tunnel rule `*.qorpera.com → http://api-front:8080`. A name two levels deep
  (`a.b.qorpera.com`) has no certificate: its TLS handshake fails before anything is asked.
- **The front** (`envoy-front-sites.yaml`): Envoy picks a virtual host by exact name, then the longest wildcard suffix,
  then `*`. So `sites` and `api` win by name, `*-preview.qorpera.com` (app links) wins over `*.qorpera.com`, and every
  other first-level name lands on `site-hosts`. There every path goes to the site-serve function
  (`/functions/v1/site-serve/<path>`), with `x-forwarded-host` set to the name the request asked for (port and trailing
  dot taken off, a visitor's own value dropped), and nothing else of the stack is reachable: `/rest/v1/` on a site host
  is the site's path, not the API. A WebSocket upgrade on a site host is refused by Envoy itself (403). Proven in a real
  Envoy with api-front's image: `deploy/sites/envoy-front-sites.test.mjs`.
- **site-serve decides what a name shows**, through SQL (`qorpera_site_serve_host`): a site's files, its password page,
  its 410 page, or `none`. While `hosts_enabled` is false every site host answers `none`, so the front can change before
  hosts are on. `none` and a locked site look the same to a visitor (the private site's password page, 401): whether a
  site of that name exists never shows.
- **Between the front's change and `hosts_enabled`** (rollout steps 7 to 9), with the migration and the new site-serve
  in: every first-level name that is no exact host answers site-serve's own pages, a made-up name, a reserved one and a
  live site's own name alike. `https://<name>.qorpera.com/` and every site path under it: the private site's password
  page, 401 (`cache-control: no-store, no-transform`); its password opens nothing and counts nothing (the database
  answers `wrong` while hosts are off). `https://<name>--next.qorpera.com/`: "Not live yet", 401. `/robots.txt` on
  either: 200, `Disallow: /`. A site taken down answers the same there (hosts off, no site host is read); its old link
  on `sites.qorpera.com` answers 410. Every other old link on `sites.qorpera.com` answers as before. (Before the
  migration, if the order slipped, the new site-serve answers a site host today's 404 page; the old site-serve answers
  it 404 too.)
- **Names with a record of their own never reach the front through the wildcard:** `qorpera.com` and `www` (the
  marketing site on Vercel), `app` (Cloudflare Pages), `api` and `sites` (this tunnel, by exact rule), `objects` (the
  object gateway), `inbox` and `send` (mail), later `screens` (#1746). The reserved list holds all of them.
- **One origin per site.** No sandbox. The visitor's session is the host-only cookie `__Host-qorpera_site` (no Domain,
  `Path=/`, Secure, HttpOnly, SameSite=Lax). Private and next answers refuse to be read, framed or posted to by another
  origin (`Cross-Origin-Resource-Policy: same-origin`, a Fetch Metadata check, `frame-ancestors 'self'` with
  `X-Frame-Options: SAMEORIGIN`, the unlock's Origin check), service worker scripts are refused (404), and every answer
  carries its own `Cache-Control` with `no-transform` (the zone would otherwise add a 4-hour browser cache). That is
  part S1's (site-serve); listed here so an operator knows what a healthy site host answers.
- **App links keep their hosts** (`<slug>-preview.qorpera.com`). From 5.1 every website is a same-site neighbour of
  every app link, so a site's page could make a visitor's browser post into an app on the visitor's Lax gate cookie.
  The relay therefore refuses a **change from another site** before the gate, the database or the app see it: any
  method but GET, HEAD and OPTIONS whose `Sec-Fetch-Site` is `same-site` or `cross-site`, or whose `Origin` is there
  and is not exactly `https://<the app host>`, answers 403 with `cache-control: no-store`. `Origin: null` passes only
  together with `Sec-Fetch-Site: same-origin` (an app page under `Referrer-Policy: no-referrer`, helmet's default,
  sends `null` to its own origin). The password form's own POST is same-origin and passes. What it leaves open: a
  request with neither header (very old browsers, programs that hold no visitor's cookie) passes as before; GET, HEAD
  and OPTIONS pass whoever sent them, so an app that changes something on a GET can still be made to; a sibling can
  still load an app's scripts and pictures and frame it until 5.2 adds `Cross-Origin-Resource-Policy` and
  `frame-ancestors 'self'` to forwarded answers (the web app never frames an app link, so that change breaks nothing
  there).

## The invariant (D22)

**No cookie, HTTP auth or other credential a browser sends by itself is proof of who is calling on any qorpera.com
host**, except the two `__Host-` gates: site-serve's `__Host-qorpera_site` and the app relay's `__Host-qorpera_app`.
Customers' pages are sibling subdomains of the app and the API; `SameSite` separates nothing between them.

- The web keeps its session in `localStorage` on `app.qorpera.com` and calls the API with a bearer token; Auth sets no
  cookie. Keep it so.
- Auth's redirect list stays exact (`https://app.qorpera.com/`), never a wildcard: a wildcard would hand a magic link's
  code to any site.
- A future platform cookie is `__Host-` (host-only, no Domain), and a request that changes something also needs an
  Origin or Fetch Metadata check, as the relay's above.
- Origins are compared exactly (`QORPERA_WEB_ORIGINS`, `QORPERA_MEMBER_CLIENT_ORIGINS`), never by suffix.
- Review rule: a change that reads a cookie, `Authorization: Basic`, a client certificate or a referrer as proof on a
  qorpera.com host is refused in review.

## What a site's script can still do (the cookie answer)

A site's script can set cookies with `Domain=qorpera.com`. Every Qorpera host receives them and ignores them (nothing
reads them, the invariant above), but many large ones make every request to qorpera.com too big for that browser, and
`app.qorpera.com` stops working there until the cookies are cleared. Nothing on the server fixes it; only a separate
domain would. Support answer: "Clear this browser's cookies and site data for qorpera.com (Settings → Privacy → site
data, search qorpera.com), then open app.qorpera.com again." If one site does it on purpose, take it down (below).

## The name rule and the reserved list (D20)

A site's name (and an app link's) is `[a-z0-9-]`, 3 to 48 long, a letter or digit at both ends, **no `--`** anywhere,
**not ending `-preview`**, **not holding `qorpera`**, and none of the reserved names. One text, in the migration
`20260930756000_site_hosts.sql` (`qorpera_site_reserved_names()`), copied byte for byte into the coding executor
(`RESERVED` in `code-site.ts`); 118 names split by one space, 775 bytes, SHA-256
`e3f73121ff872bb8b690df2a702addf2b39285e2ef4543c8fc198fd1ffbc6745`:

```
api app www admin assets static qorpera login signin signup robots favicon sites site well-known help support status mail functions auth rest storage realtime objects inbox send screens edge coding noreply staging dev test preview next docs blog news account accounts billing pay payments checkout secure security sso id oauth my dashboard console portal cdn media files download downloads smtp imap pop mx autoconfig autodiscover abuse postmaster hostmaster webmaster ns1 ns2 vpn git code data db ws live screen desktop computer health metrics tunnel gateway relay hooks webhooks events invite invites join team teams company companies members cofounder agent agents chat email webmail calendar ftp m mobile wiki shop store home root system internal private public demo beta
```

Why each part: no `--`, so `<slug>--next` and `xn--` names are never a site; not `-preview`, so a site never lands on
the app links' host and cache rule; no `qorpera`, so no `qorpera-login.qorpera.com`; the reserved names, because an
exact record or Envoy host beats the wildcard and would take a live site's address without a word. A repository's
derived names drop `qorpera` and collapse runs of `-` (`qorpera_code_site_slugs`).

## Standing rule: a new platform name under qorpera.com (D20, D21)

**Before any new platform name under qorpera.com gets a DNS record, a tunnel hostname or an Envoy host:**

1. Read production for a site or app link of that name (read only):
   ```sql
   select site.slug, site.kind, site.published_at, site.taken_down_at
   from public.qorpera_company_sites as site where site.slug = '<name>';
   ```
   (`/Users/jonas/work/dbhome/window/newdb_check.py FILE`, never `--write` for this.) A row means a company holds the
   name: pick another platform name, or settle it with that company first (the founder decides).
2. Add the name to `qorpera_site_reserved_names()` in a new migration (it replaces the function whole; the guard in
   `20260930756000` shows the pattern: it raises if a stored slug breaks the rule), the same text in the executor's
   `RESERVED`, and the agents' words if they list names. The migration lands and is applied.
3. Only then make the record, the tunnel hostname or the Envoy host.

Then write it in the registry. The same holds for an exact Envoy virtual host on the `front` listener: it takes the
name from `site-hosts` as silently as a DNS record does.

## The wildcard stays; the platform holds no DNS token (D21)

The proxied wildcard record `*` (to the `qorpera-dbhome` tunnel) stays: it has carried app links since v195 and now
carries the sites. The platform makes **no record per site** and **never holds a token that may edit qorpera.com's
DNS**: Cloudflare tokens cannot be limited to some records of a zone, so such a token could move `api`, `app` and the
mail records. The operator's lane token (`com.qorpera.dbhome.cf-token` in the Mac's Keychain, used by
`sites-route.mjs`) stays on the operator's Mac.

## What a mistyped name answers

- **A first-level name that is no site** (`ap.qorpera.com`, `appp.qorpera.com`, `wwww.qorpera.com`, a site name with a
  typo): the private site's password page, 401, the same page a locked site shows. Nothing says whether a site exists.
  Someone who meant the app gets a password page they cannot use: the answer is "the app is at app.qorpera.com".
- **Two levels deep** (`a.b.qorpera.com`): the browser's TLS handshake fails (the certificate covers one level).
- **`http://`**: Cloudflare answers 301 to `https://` (Always Use HTTPS).
- **A mail typo** (`someone@inbx.qorpera.com`): the wildcard gives the name an address but no mail record, so senders
  retry for days instead of bouncing at once. Accepted (the price of the wildcard; per-name records are refused above).

## Takedown

From 5.1 an operator takes any site or app link down in seconds. Nothing is deleted; the site's name stays its own.

```sql
select public.qorpera_site_take_down('<slug>', '<reason, one line, 1 to 300 characters>');
  -- {"schema":"qorpera.site-take-down/v1","slug":"<slug>","state":"down"}; again: keeps its time, takes the new reason
select public.qorpera_site_restore('<slug>');
  -- {"schema":"qorpera.site-take-down/v1","slug":"<slug>","state":"up"}
```

Run them as `postgres` through `/Users/jonas/work/dbhome/window/newdb_check.py FILE --write` (no API role may call
them). Errors: 22023 for a reason that is not one line of 1 to 300 characters, P0002 "No site has this name".

**What a visitor sees:**
- A files site, on its own host, its next host and its old link (`sites.qorpera.com/<slug>/…`, hosts on or off): the
  "gone" page, status 410, from the next request (site-serve answers every request from SQL; private answers are never
  kept by Cloudflare, and a browser asks again each time). No service worker can keep an old page: site-serve refuses
  them.
- An app link: the password page, and the right password no longer opens it, within 30 seconds (the relay keeps an
  open session that long). Its link program is refused at its next check (within 5 minutes) and stops.

**What members see:** Sites shows the site's row as "Taken down" with the operator's reason, in place of its link and
password, and where to write if they think it is wrong (the address is one constant, `SUPPORT_ADDRESS` in
`packages/web/src/app/views/settings-sites.ts`: confirm it reaches someone, or set it to null to leave that clause out);
its menu keeps only Take offline. What's new offers no link to it and says it was taken down. The site does not go live
again: Put it live and Go back answer `SITE_TAKEN_DOWN`, and Look first answers `gone`, each said in plain words. The
reason comes from `qorpera_company_site_access` (every member). Tell the company's owner too, in plain words.

**What an agent sees:** nothing of it yet. An agent can still publish to the site (`publish_site`, `share_app`, a
project's next version for What's new): it stays down, but `publish_site` answers `"state": "live"` with the link, so
the agent may tell a member a link that shows the "gone" page. Tell the company's owner yourself.

**Restore** when the cause is gone: `qorpera_site_restore('<slug>')`; the site answers as before at once (its sessions
were kept). Write each takedown and restore in the registry with its UTC time from `date -u`.

## When a site is reported

Reports come to `abuse@qorpera.com` (the founder confirms it reaches someone), Google Search Console's mail for
qorpera.com, Cloudflare's abuse reports, or a member.

1. **Find the site.** The slug is the label before `.qorpera.com` (without `--next`); an app link's is the label
   without `-preview`. Read production (read only):
   ```sql
   select site.slug, site.kind, site.profile_id, site.published_at, site.taken_down_at, profile.display_name
   from public.qorpera_company_sites as site
   left join public.qorpera_profiles as profile on profile.id = site.profile_id
   where site.slug = '<slug>';
   ```
2. **Phishing, malware, a password or card form posing as another brand, or clearly illegal content: take it down
   first** (above), then look further. A bad page on `<slug>.qorpera.com` can get qorpera.com itself listed (Safe
   Browsing, domain blocklists), which would hit the app and every mail with a qorpera.com link.
3. **Anything else** (a complaint about wording, a copyright claim without a clear match): tell the founder, and the
   company's owner; take it down only on the founder's word.
4. **Answer the reporter**: received, and what was done.
5. **If qorpera.com is flagged** (Search Console, a browser warning): take the site down, then ask for a review in
   Search Console (the founder's account).
6. **Write it in the registry** (UTC time from `date -u`, the slug, the reason, the action).

## Rollout (release 5.1), in the lead's order

Each operator step is a tool with a read-only pre-check, an apply, a smoke and a way back (as `front-timeout` was for
v238). **Never** turn hosts on before E1a is live, before the relay's check (P1) is live, or before the front answers a
site host.

| # | Step | Check | Way back |
|---|---|---|---|
| 0 | Before the cut: `roll-fixes/` applied (V241-PREP-BRIEF.md, "Before part 1"); node 3 settled with its lane | the lead's | none needed |
| 1 | **E1a live** (web only, live on merge); then wait a day for open tabs | `node /Users/jonas/work/lanes/own-code-storage/build5/e1a-runs/e1a-live-marker.mjs` exits 0 (the `--check` line below says the same) | revert the web, only while hosts are off |
| 2 | **The migration** `20260930756000_site_hosts.sql` (inert: hosts stay off; the name rule holds at once) | `hosts_domain` null, `hosts_enabled` false; A1.md's reads | hosts stay off; the name rule needs a new migration to change |
| 3 | **The coding executor**, node 2 then node 1, no session publishing | X1's report | the previous executor |
| 4 | **The runtime bundle** (D1a) | the train's | the train's |
| 5 | **site-serve**: the kit's `functions/src/site-serve/` and `SOURCE`, `functions.sh install`, no turns in flight | `curl -sS -o /dev/null -w '%{http_code}\n' https://sites.qorpera.com/robots.txt` → 200 (`functions.sh check` cannot see site-serve) | the previous function files |
| 6 | **The relay (P1)**, below | a forged cross-origin POST answers 403 | the previous `relay.mjs`, below |
| 7 | **The front (R1)**, below; the API stops for seconds: no run and no coding turn in flight | a site host answers site-serve's 401 page | the previous `envoy-front.yaml`, below (hosts off first) |
| 8 | **The web** (E1b, Look first; in the release's pull request, live on merge, hidden until `preview` is true) | the web's | revert |
| 9 | **Operator SQL**: `hosts_domain`, `--check`, then `hosts_enabled`, below | the `--check` PASS, then a live site on its own host | `hosts_enabled = false`, below |
| 10 | Next cut: D1b (the agents' words) | | |

Gaps if the order slips: the function before the migration answers as today (PGRST202 reads as `legacy`); the front
before the function sends site hosts to the old site-serve, which answers its 404 page (as `others` did); hosts on
before E1a, before P1 or before the front: never.

### Step 6: the relay (P1)

Files: `deploy/sites/app-relay/relay.mjs` from the merged tree into `/opt/dbhome/front/app-relay/relay.mjs` on the DB
primary (mode 0644; the container's user only reads it). `client.mjs` does not change in 5.1. Run as root in
`/opt/dbhome` (`/Users/jonas/work/dbhome/window/dbp.sh` with the script on stdin).

1. **Pre-check (read only).** `sha256sum front/app-relay/relay.mjs` is the base the tool was built for (master's
   before 5.1); the new file's sum is the merged file's; `docker compose ps app-relay` is healthy; the forged POST below
   answers **401** today (the old relay forwards it to the gate, which shows the password page).
2. **Apply.** Copy the live file outside the mounted folder (`front/backup/relay.mjs.pre-5.1-<sha12>-<UTC>`), write the
   new file as `front/app-relay/.relay.mjs.new` (0644), check its syntax in the relay's own image
   (`docker compose run --rm --no-deps --entrypoint node app-relay --check /app/.relay.mjs.new`), then one rename
   (`mv -f front/app-relay/.relay.mjs.new front/app-relay/relay.mjs`) and
   `docker compose up -d --no-deps --force-recreate app-relay`. Node has the old code loaded, so the restart is what
   takes the new file. Its effect: app links answer 503 for the seconds the relay takes to start; connected link
   programs lose their connection and come back with their keys within 1 to 30 seconds; visitors keep their sessions
   (the database holds them), so nobody types a password again. Nothing else restarts; no run is in the relay's path.
3. **Smoke** (from the operator's Mac, through Cloudflare):
   ```
   curl -sS -o /dev/null -w '%{http_code}\n' https://qorpera-health-preview.qorpera.com/.qorpera/health   # 200
   curl -sS -o /dev/null -w '%{http_code} %header{cache-control}\n' -X POST -H 'Origin: https://probe.example' \
     --data 'x=1' https://qorpera-health-preview.qorpera.com/forged-post-probe                             # 403 no-store
   curl -sS -o /dev/null -w '%{http_code}\n' -X POST -H 'Sec-Fetch-Site: same-site' \
     --data 'x=1' https://qorpera-health-preview.qorpera.com/forged-post-probe                             # 403
   curl -sS -o /dev/null -w '%{http_code}\n' -X POST --data 'x=1' \
     https://qorpera-health-preview.qorpera.com/forged-post-probe                                          # 401 (passes the check, stops at the gate)
   ```
   And on the DB primary without Cloudflare:
   ```
   docker compose exec -T app-relay node -e 'require("http").request({host:"127.0.0.1",port:8090,method:"POST",path:"/forged-post-probe",headers:{"x-forwarded-host":"qorpera-health-preview.qorpera.com",origin:"https://probe.example","content-length":"0"}},(r)=>{console.log(r.statusCode,r.headers["cache-control"]);r.resume()}).end()'
   # 403 no-store
   ```
   No probe needs a session: the check comes before the gate. The relay writes no log line for a refusal (one line each
   would let any page fill the log).
4. **Way back.** Copy the backup to `.relay.mjs.new`, one rename, the same recreate; the forged POST answers 401 again.
   Hosts must be off first (`hosts_enabled = false`): without P1, every site is an unchecked neighbour of every app.

### Step 7: the front (R1)

The change to production's `/opt/dbhome/front/envoy-front.yaml` (service `api-front`): the virtual host `others`, these
five lines exactly,

```
                    # Every other name under qorpera.com: nothing.
                    - name: others
                      domains: ["*.qorpera.com"]
                      routes:
                        - { match: { prefix: / }, direct_response: { status: 404 } }
```

becomes the `site-hosts` block of the merged `deploy/sites/envoy-front-sites.yaml` (from its line `# Every other name
under qorpera.com: a company site's own or next host.` to its route line), and nothing else changes: no listener, no
cluster, no tunnel, no record, no certificate.

1. **Pre-check (read only).** The live file's sum is the base the tool was built for, and it holds the five lines above
   exactly once, `strip_any_host_port` and `strip_trailing_host_dot` under the `front` listener, and no other
   `*.qorpera.com` host. A made-up name answers Envoy's empty 404 today
   (`curl -sS -o /dev/null -w '%{http_code} %{size_download}\n' https://zz-check-$(openssl rand -hex 4).qorpera.com/`
   → `404 0`). Steps 2 and 5 are done. No run and no coding turn is in flight.
2. **Apply.** Build `front/envoy-front.yaml.new` (0644) from the live bytes with the block replaced; its diff against
   the live file is exactly those lines. Validate it in api-front's own image before it is put in place:
   ```
   docker compose run --rm --no-deps -v /opt/dbhome/front/envoy-front.yaml.new:/etc/envoy/new.yaml:ro \
     --entrypoint envoy api-front --mode validate -c /etc/envoy/new.yaml        # "configuration '…' OK"
   ```
   Copy the live file to `front/envoy-front.yaml.pre-5.1-<sha12>-<UTC>`, one rename
   (`mv -f front/envoy-front.yaml.new front/envoy-front.yaml`), then
   `docker compose up -d --no-deps --force-recreate api-front`. **Not a plain `up -d`**: the compose file did not
   change, so it would leave the old container running, and Envoy (started with `--disable-hot-restart`) reads its file
   only when it starts; the file is a single-file mount, so only a new container sees the renamed file. Effect: the API,
   app links and sites do not answer for the seconds Envoy takes to start (Cloudflare answers 502 meanwhile); the
   tunnel reconnects by itself; nothing else restarts. Make the same edit in node 2's kit.
3. **Smoke.** `node deploy/sites/sites-route.mjs --check` from the operator's Mac, then by hand:
   ```
   name=zz-check-$(openssl rand -hex 4)
   curl -sS -D - -o /dev/null https://$name.qorpera.com/          # 401, content-type text/html, x-robots-tag noindex, cache-control … no-transform
   curl -sS -D - -o /dev/null https://$name.qorpera.com/rest/v1/  # the same page (site-serve's), never the API's JSON 401
   curl -sS -o /dev/null -w '%{http_code}\n' --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
     -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' https://$name.qorpera.com/   # 403
   curl -sS -o /dev/null -w '%{http_code}\n' -H "X-Forwarded-Host: $name.qorpera.com" \
     https://api.qorpera.com/functions/v1/site-serve/               # 404
   curl -sS -o /dev/null -w '%{http_code}\n' https://api.qorpera.com/rest/v1/                       # 401 (the API, as before)
   curl -sS -o /dev/null -w '%{http_code}\n' https://qorpera-health-preview.qorpera.com/.qorpera/health   # 200
   curl -sS -o /dev/null -w '%{http_code}\n' https://sites.qorpera.com/robots.txt                  # 200
   ```
4. **Way back.** Hosts off first (`hosts_enabled = false`), else every site's own link dies. Then copy the backup to
   `envoy-front.yaml.new`, validate it, one rename, the same recreate; a made-up name answers `404 0` again.

### Step 9: the switch

Through `/Users/jonas/work/dbhome/window/newdb_check.py FILE --write`, one statement a file:

```sql
update public.qorpera_site_settings set hosts_domain = 'qorpera.com';   -- first; hosts stay off
```

Then `node deploy/sites/sites-route.mjs --check` from the operator's Mac. It reads the tunnel's rules, the records, the
app links' cache rule, `sites.qorpera.com/robots.txt` (its last group, the origin's own file), an app host's health,
the relay's refusal of a forged change from another site (P1: 403 with `no-store`; before P1 the gate's 401), the site
hosts (a made-up name's own host, next host and `/rest/v1/` answer site-serve's 401 page; the API name answers
404 for site-serve with that name forged) and E1a's marker in the live web. A token that may not read Cache Rules ends
in `check: PASS, with a warning: the cache rule was not readable`: the relay's own `cdn-cache-control: no-store` on every
forwarded answer is the first layer; read the rule in the dashboard (Caching → Cache Rules) once by eye. Anything else
not right ends in `check: FAILED` (exit 1), and its line says what was seen.

Only when the check passes (so P1 refuses the forged POST, the front answers a site host and E1a is live):

```sql
update public.qorpera_site_settings set hosts_enabled = true;          -- note the time: date -u
```

Smoke: production's site at `https://<slug>.qorpera.com/` shows its password page, its old link
`https://sites.qorpera.com/<slug>/` answers 308 to it, and a member who types the password sees the site whole.

**Way back:** `update public.qorpera_site_settings set hosts_enabled = false;` Links return to the path form at once.
Versions made while hosts were on may link from `/`, which breaks under the path until their next change; list them:

```sql
select site.slug, version.id, version.state, version.created_at
from public.qorpera_company_site_versions as version
join public.qorpera_company_sites as site on site.id = version.site_id
where version.created_at >= '<the time hosts were turned on, UTC>'
order by version.created_at;
```

## Later

- **5.2:** the relay adds `Cross-Origin-Resource-Policy: same-origin` and `frame-ancestors 'self'` with
  `X-Frame-Options: SAMEORIGIN` to forwarded answers; public sites; Cloudflare's managed robots.txt off for the zone (or
  the search words changed); `--check` reads that no Cache Rule makes the zone eligible.
- **5.3:** own addresses (a customer's domain) only through a new tunnel `qorpera-sites` whose catch-all is a
  sites-only listener (8081). The `qorpera-dbhome` tunnel's catch-all stays `http_status:404`: pointing it at 8080 would
  serve the API's `*` host on every customer's name.
