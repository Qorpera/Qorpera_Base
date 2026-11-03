# Runtime Step 7 — Cloud connectors: Gmail, Google Drive, GitHub

Date: 2026-09-22, re-slotted 2026-09-24 as bundle **v87** together with the
Step 9 coding route (branch `fable/coding-connectors-v86`, superseding #202
and #223). **Components are implemented and verified offline; nothing is
deployed.**
The Gmail draft extension and its additional rollout requirements are described
in [RUNTIME-EMAIL-DRAFTS.md](RUNTIME-EMAIL-DRAFTS.md).

The first goal of Order 7 is deliberately narrow: offer three production
connectors through the Step 2 custody kernel, with a member sign-in flow and
company-wide agent access. No plugin marketplace, no company-authored
connectors, no browser escalation product flow yet.

This supersedes the unmerged Codex component set of 2026-08-28
(`codex/step-7-cloud-connector-handoff`), which targeted the desktop shell and
duplicated custody, authorization and receipts that the Step 2 kernel already
owns on master. Nothing of it is reused.

## What exists on master before this step

Order 2 (`deploy/first-node/RUNTIME-STEP-2-SECRET-CUSTODY.md`) already gives
the runtime every model-facing piece: `qorpera_cloud_connector_operations` is
the governed catalog, `qorpera_cloud_secret_operation_grants` hands one tool
per granted operation to an agent, `describeCloudSecretTools` and
`cloudSecretTools` turn those grants into closed native tools inside the run,
the durable receipt ledger admits every call, and the separate cloud secret
broker (`cloud-secret-broker.ts`, `cloud-secret-broker-http.ts`) is the only
component that unwraps a credential and invokes a compiled adapter. What was
missing was everything member- and provider-facing: real adapters, an OAuth
sign-in, a way to grant a connection to the whole company, and a page.

## What this step adds

### Catalog (`packages/runtime/src/cloud-connector-catalog.ts`)

One source of truth for three connectors and fifteen operations. Each
operation declares its tool name, description, closed input schema (the exact
shape `parseCloudConnectorInputSchema` accepts at run time; property names are
snake_case because the runtime's identifier rule forbids capitals), read/write
effect and a request recipe. The adapter hash the catalog pins is the SHA-256
of that declaration (destination, credential placement, input schema, recipe
text), so a changed declared request, schema or destination is a changed
adapter. It does not hash the handler code: a handler that drifts from its
recipe text keeps the same adapter hash, and the compiled handlers are pinned
only by the broker artifact's SHA-256 (built from reviewed source on node 2).

| Connector | Credential field | Operations (tool names) |
| --- | --- | --- |
| `github` (api.github.com) | `access_token` | `github_list_repositories`, `github_search_issues`, `github_get_issue`, `github_create_issue`, `github_comment_on_issue`, `github_read_file`, `github_get_pull_request`, `github_create_repository` (since `20260930556000`) |
| `gmail` (gmail.googleapis.com) | `refresh_token` | `gmail_search_messages`, `gmail_read_message`, `gmail_read_thread`, `gmail_send_message` |
| `google_drive` (www.googleapis.com) | `refresh_token` | `google_drive_search_files`, `google_drive_read_file`, `google_drive_create_file`, `google_drive_update_file` |

`scripts/generate-cloud-connector-catalog.mjs` renders the SQL rows into
`supabase/migrations/20260924040000_cloud_connector_catalog.sql`; `npm run
check:connector-catalog` (part of `npm run check`) refuses drift. A shipped
row is never edited: a changed operation gets version 2 in a new migration.

### Adapters (`cloud-connector-github.ts`, `cloud-connector-google.ts`)

Compiled into the broker process through `defineConnectorAdapters`
(`cloud-connector-adapter.ts`), which re-checks destination, credential name
and the closed schema before a recipe runs. Every request is pinned to the
connector's origin, refuses redirects, is bounded in time and bytes
(`cloud-connector-http.ts`), and is reduced to a small result: bodies are
clipped by characters and by JSON bytes (multi-byte characters and escapes
counted), lists keep only the items that fit and say how many were left out,
and comment/thread text shares a budget, so every result stays under the
broker's 32 KiB result limit; anything still larger becomes a closed
`result_too_large` failure instead of an opaque error. Expected provider refusals (404, 403,
429, 401, 400/422) become a closed failure result
(`qorpera.connector-result/v1`, `status: "failed"`, `reason`, short
`detail`); transport faults stay generic. Google adapters exchange the sealed
refresh token for an access token on every call and keep neither. A revoked
Google grant surfaces as `authorization_required`, which tells the agent to
ask the member to reconnect rather than retry. The broker's existing
reflected-secret fence still runs on every result.

### GitHub repositories (v194, 3 November 2026; migration `20260930556000`, SQL test 557)

In the founder's company-building test the Co-Founder had to ask the founder to create `wristband-shop` by hand.
`github_create_repository` (`create_repository` v1) creates one: `name`; `owner`, an organization (left out, or the
connected account's own login, it is the account itself: the adapter reads `GET /user` to tell); `description`;
`private`, default true; `auto_init`, default true (a README, so a default branch). It posts `POST /user/repos` or
`POST /orgs/{owner}/repos`.

- **Review.** A write, so an outside effect for the automatic review. The card reads "Create a GitHub repository"
  (or "Create a public GitHub repository") with the account or organization, who can see it, its description and what
  it starts with. A public repository is a built-in access check whatever the reviewer called it
  (`repositoryAccessCheck` in `cloud-action-review.ts`): an owner or admin approves it on a card unless a company Allow
  rule covers it.
- **Permission at GitHub.** The OAuth App sign-in has asked for `repo` since this step, and `repo` lets the token
  create repositories for the account and in its organizations, as far as each organization's policy lets that
  account: existing sign-ins need no reconnect. A typed token needs Administration read and write (fine-grained) or
  `repo` (classic; `public_repo` covers only public repositories). An organization with OAuth App access restrictions
  must approve Qorpera's app, and one that stops members creating repositories must allow it.
- **Refusals the agent can relay.** A 403 or 404 for the account answers `forbidden`: "GitHub refused to create the
  repository: the GitHub connection needs to be connected again with permission to create repositories (GitHub: …)".
  For an organization, a 403 says an owner of it must allow it or the connection be connected again, and a 404 that no
  such organization takes repositories from the account. A taken name answers GitHub's own words ("name already exists
  on this account"); a rate limit stays `rate_limited`.
- **Grants.** New shares and hires issue every active operation, so they carry it. For connections shared before it,
  the migration's `qorpera_backfill_connector_operation_grants('github', 'create_issue', 'create_repository', 1)`
  issues it to every active agent holding a live `create_issue` grant on a shared company connection, under the same
  issuer (still an owner or admin) and expiry, one `grant_issued` audit row each, never restoring a revoked one. The
  function is kept for the next catalog addition; no API role may call it.
- **Release, in this order.** (1) The migration and (2) the v194 runtime bundle active, then (3) the secret broker
  (vault) build with the adapter, last. The forced access check for a public repository lives only in the runtime
  (`repositoryAccessCheck`); the database records the `builtIn` the runtime sends, and neither the vault nor the
  database reads `private`. Once the migration has run, a run on an older bundle already holds the tool and reviews it
  without that check, so the adapter must not reach the vault until no such run can call it: until then the vault has
  no adapter for the operation and refuses every call, public or private.

### Call shape (v194, 3 November 2026)

A connector tool takes the tool's fields on their own or inside `input` (`cloud-secret-tools.ts`). A read of the
runtime's own catalog shows the model only its fields and needs no key: without one it is keyed by its call, so each
call asks the provider. A write shows the `{idempotencyKey, input}` envelope and always needs the model's key ("a new
key for each new write, the same key when retrying the same write"); a key made from the write's fields would answer a
later identical write in the run (undoing a change, a second reminder) from the first one's receipt. On 30 October a
Co-Founder run's bare `github_list_repositories` call was refused until it was wrapped in the envelope.

### OAuth inside the broker (`cloud-connector-oauth.ts`, broker HTTP routes)

Contract §11.5: OAuth completion goes from a typed member interaction
straight to the broker. The web app asks the cloud for a capture ticket
(`qorpera_begin_cloud_secret_capture`, unchanged), then posts the ticket to
`POST <broker>/v1/oauth/<ticketId>/start` with the capability, the page to
return to and the SHA-256 of a random browser proof. The broker confirms the
ticket (`CloudSecretBroker.describeCapture`, nothing committed; a ticket that
is not company-owned is refused), remembers a single-use state for ten
minutes and answers with the provider consent URL (Google: offline access,
forced consent, PKCE; GitHub: `repo read:user user:email`).

**The sign-in is bound to the browser that started it.** The proof stays in
that tab's session storage. The provider redirects the browser to
`GET <broker>/v1/oauth/callback`; the broker exchanges nothing there: it
consumes the state, parks the code for five minutes under a fresh one-time
confirmation id and sends the browser back to the return page
(`#/c/<id>?connector=gmail&connection=confirm&confirmation=…`, or
`connection=failed&reason=…`). The app then posts
`POST <broker>/v1/oauth/<ticketId>/confirm` with the confirmation id and the
proof. Only a matching proof lets the broker exchange the code, read the
account identity (mailbox address or GitHub login) as a non-secret label and
seal the token into the ticket; a missing or different proof is refused
(`browser_mismatch`) and the parked code is dropped (one attempt per
confirmation id). So a consent link an admin of one company sends to someone
else ends in a browser without the proof: nothing of theirs is sealed into
that company, and the starter never sees the confirmation id. The app acts
on a returned fragment only when its own tab started that sign-in, so a
crafted `#…connection=…` link does nothing, and it shares the connection with
all agents only after its own confirmation succeeded.

Why a proof in the app and not a broker cookie: the web app's CSP allows no
cross-origin form (`form-action 'self'`, which Chrome also applies to the
form's redirect to the provider), and a cookie the broker set on the app's
cross-site fetch would be a third-party cookie that Safari drops. The proof
gives the same binding with the app's own storage. Codes and tokens never
reach the web app, Supabase, logs or the model. A replayed callback finds no
state; a replayed confirmation finds nothing parked. A GitHub fine-grained token can still be typed and
captured through the existing `POST /v1/captures/<ticketId>` route. The
member routes (capture, sign-in start and confirm) answer CORS only for the broker's
`memberOrigins` (config v2, the list the capture route already used); the
runtime operation route never does.

The broker service (`cloud-secret-broker-service-main.ts`) reads one optional
systemd credential, `qorpera-cloud-secret-connectors`
(`qorpera.cloud-connector-service/v1`: `publicOrigin`, and `google` and/or
`github` `{clientId, clientSecret}`). Absent, the broker runs exactly as
before Step 7, without connectors or OAuth routes. Present, it serves the
connectors whose provider has a client, and a sign-in may return only to one
of the broker config's `memberOrigins` (the broker refuses to start with the
credential but no member origin). Every company's broker gets the same
credential: one Google client and one GitHub OAuth App serve all companies.

The company bank (Bank interface part 2, migration `20260930523000`): the
same credential may carry `enableBanking: {applicationId, privateKeyPem}`,
Qorpera's Enable Banking application (production app "Qorpera",
`1c5dff8a-a15b-4987-b1d7-8457d0653e03`; its RSA key is the `.pem` the control
panel generated, kept off chat and out of git). It may be the only entry. With
it the broker serves the connector `bank`: a company ticket's start names the
bank (`bank: {name, country, psuType}`), Enable Banking sends the member to
the bank's own sign-in (MitID), and the bank comes back to the same
`/v1/oauth/callback`, routed by the same state prefix, so nginx needs nothing
new. The application's whitelisted redirect URL is exactly
`https://company41-node-01.tailbb15c7.ts.net:10000/v1/oauth/callback`. The
broker then keeps each connected company's bank summary current
(`cloud-bank-sync.ts`): a single-company broker checks once a minute, the
shared vault asks once a minute which companies are due. Until Enable
Banking activates the application beyond restricted mode, only the accounts
its owner linked in the control panel can be read.
The summary reaches the company folder through the object gateway (part 3,
migration `20260930528000`): with `QORPERA_BANK_SUMMARY_WRITER=1` the gateway
writes each new summary to `bank/summary.json` as the platform, which is what
the Bank page draws.

Digital Post (`RUNTIME-DIGITAL-POST.md`, migration `20260930529000`): the same
credential may carry `digitalPost: {environment, certificatePem, privateKeyPem}`,
Qorpera's OCES3 organisation or system certificate from MitID Erhverv (`test`
for Digital Post's test environment, `production` for the real one; the key
stays off chat and out of git). It may be the only entry. The broker checks
that the key matches the certificate when it starts. With it the broker
fetches the Digital Post of every company that saved a `digital_post` key
(`cloud-digital-post-sync.ts`): a single-company broker checks once a minute,
the shared vault asks once a minute which companies are due. Every call goes
from the node's own address to `api.test.digitalpost.dk` or
`api.digitalpost.dk` over mutual TLS; a company's recipient system lists that
address, so the broker must run where that address is stable. Like the bank
sync, it opens a company's key without a run, only to call Digital Post's
fixed origin.

### Routing behind the one public origin (production)

All companies' brokers sit behind ONE public origin,
`https://company41-node-01.tailbb15c7.ts.net:10000` (the only broker origin in
the web app's CSP). Node 1's nginx picks the company's broker process per
request; the authority's `service_origin` stays that bare origin.

- **Member routes carry the company in the query.** The web app posts
  `/v1/captures/<ticket>?company=<profileId>` (secret cards, web #236) and, for
  connectors, `/v1/oauth/<ticket>/start?company=<profileId>`,
  `/v1/oauth/<ticket>/confirm?company=<profileId>` and
  `/v1/captures/<ticket>?company=<profileId>` (typed GitHub token). The
  existing `$qorpera_capture_broker` map on `company=` routes all of them.
- **The provider callback carries the company in the state.** Google and
  GitHub return only `code` and `state` to
  `GET /v1/oauth/callback?code=…&state=…`, so the broker issues
  `state = <profileId>.<43 base64url characters from 32 random bytes>`
  (`CLOUD_CONNECTOR_OAUTH_STATE` in `cloud-connector-oauth.ts`). nginx routes
  by the prefix; the broker accepts the callback only when the whole state is
  one it issued, unexpired and unused, for that same company (a pending entry
  is keyed by the SHA-256 of the full state and removed before any network
  call). The prefix is not a secret and grants nothing; the random part stays
  single-use and unguessable, as before.
- **Runner operations carry the company in the query.** A guest or exec host
  posts `/v1/operations?company=<profileId>` (`HttpCloudSecretBrokerClient`).
  The company is the provider host's own: its compute identity's company from
  the recovery authority, matched against the identity volume at startup, the
  same on an LXD guest and on the shared execution host (both run
  `qorpera-native-provider-host.mjs`); never model input. The broker routes by
  path and ignores the query. Every operation is still authorized in the
  database against the run's grant and the broker authority that sealed the
  secret, so a request that reaches another company's broker is refused
  there ("cloud secret broker does not own this envelope", SQL test 398). A
  guest older than v87 sends no query; the map routes it to the acceptance
  broker as before.
- **One runtime token.** Each node provider (and the exec host) hands its
  guests exactly one broker runtime token, and a broker accepts exactly one
  (`qorpera-cloud-secret-runtime`). Every company broker is configured with
  that token; the per-company boundary is the database authorization above.
  This works only while every provider that runs connector work (node 1,
  node 2, the node 2 exec host) carries the same token; a broker cannot hold
  two.
- **A separate coding executor token (bundle v88).** The repository credential
  route (`/v1/repository-credentials`) releases a plaintext GitHub token, so it
  does not accept the runtime token: every guest holds that one, and every
  guest (LXD guest units, exec host slots) also holds the Supabase service-role
  key, with which it could claim a queued coding session
  (`qorpera_claim_coding_session`, service_role) and learn its lease token. The
  lease token is therefore not a secret from guests; it binds the request to a
  live session, it does not authenticate the caller. The route accepts only the
  coding executor's own token, `qorpera-cloud-secret-coding-executor` (32
  random bytes, base64url, distinct from the runtime token, the capability and
  the database password; the broker refuses to start otherwise). The executor
  holds the same value as `qorpera-coding-broker-executor`; no guest, provider
  or exec host ever receives it. Since 5j-3 the same token, and only it, also
  opens `/v1/coding-environment`, which returns a leased session's environment
  variables opened from its `environment` secrets (`{schema, environment,
  mask}`, `Cache-Control: no-store`; since 5j-4 `mask` holds the older values
  its member used on the session's machine, for masking only). Since 5j-6b it
  also opens the relay, which sends a running session's request on with a
  sign-in the session never holds:
  `/v1/coding-mcp` (GET, POST, DELETE) to the MCP server named in
  `x-qorpera-mcp-url`, with that server's API-key sign-in as its header, and
  `/v1/coding-repository-fetch/refs` (GET) and `/upload-pack` (POST) to the
  session's own GitHub repository, with the company's GitHub token (never
  receive-pack). Each request names the session in `x-qorpera-coding-worker`,
  `x-qorpera-coding-lease` and `x-qorpera-coding-executor`, costs one database
  read, and streams both ways; the answer keeps its status (a redirect becomes
  the refusal), its content type, the MCP session id and
  `Cache-Control: no-store`. A broker without the credential answers 404 on
  all of these routes; the executor's token opens nothing else
  (`/v1/operations` stays runtime-token only). Give it only to the brokers of
  companies that run coding sessions, in a drop-in:
  `LoadCredential=qorpera-cloud-secret-coding-executor:/etc/qorpera-secret-broker/coding-executor`.
  Follow-up (not in v88): move the coding claim and lease RPCs off
  service_role to a dedicated executor authority, so a guest's service-role key
  can no longer claim sessions at all.
- **Redirect URI** registered at Google and GitHub:
  `https://company41-node-01.tailbb15c7.ts.net:10000/v1/oauth/callback`
  (= `publicOrigin` + `/v1/oauth/callback`; Google compares it exactly).

nginx lines the coordinator adds on node 1 (in the file that holds
`map $args $qorpera_capture_broker`; one map line per company, the same
upstreams as the capture map):

```nginx
# The OAuth state is "<company profile id>.<random>": route the provider's
# callback to that company's broker. Anything else matches no broker.
map $arg_state $qorpera_oauth_state_company {
    default "";
    "~^(?<qorpera_state_company>[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.[A-Za-z0-9_-]{43}$" $qorpera_state_company;
}
map $qorpera_oauth_state_company $qorpera_oauth_broker {
    default "";
    b116763d-de5c-4c73-a253-deeef5243730 127.0.0.1:18448;   # acceptance company (qorpera-phql-broker)
    4168e335-3ac0-4354-99f0-5dfc33428209 127.0.0.1:18547;   # company Qorpera (qorpera-prod-broker)
}
# Runner operations: ?company=<profileId>; no args = a guest older than v87.
map $args $qorpera_operations_broker {
    "" 127.0.0.1:18448;
    "company=b116763d-de5c-4c73-a253-deeef5243730" 127.0.0.1:18448;
    "company=4168e335-3ac0-4354-99f0-5dfc33428209" 127.0.0.1:18547;
    default "";
}
```

```nginx
# Inside the :10000 server block, beside the /v1/captures/ location.
# The callback's query carries the provider's code and the state: never log it.
# Upstream failures (broker down, timeout) are logged at level "error" with the
# full request line, so this location logs only "crit" and above; use the
# error log path the server block already uses.
location = /v1/oauth/callback {
    access_log off;
    error_log /var/log/nginx/error.log crit;
    limit_except GET { deny all; }
    if ($qorpera_oauth_broker = "") { return 404; }
    proxy_pass http://$qorpera_oauth_broker;
}
# The sign-in start and confirm are member routes like a capture: POST and
# the CORS preflight (OPTIONS), routed by the same ?company= map.
location ~ "^/v1/oauth/[0-9a-fA-F-]{36}/(start|confirm)$" {
    limit_except POST OPTIONS { deny all; }
    if ($qorpera_capture_broker = "") { return 404; }
    proxy_pass http://$qorpera_capture_broker;
}
location = /v1/operations {
    limit_except POST { deny all; }
    if ($qorpera_operations_broker = "") { return 404; }
    proxy_pass http://$qorpera_operations_broker;
}
# Bundle v88: the coding executor's repository token, routed by the same
# ?company= map as operations. The answer carries a token (the broker marks it
# Cache-Control: no-store); never add body logging or a proxy cache here.
location = /v1/repository-credentials {
    limit_except POST { deny all; }
    if ($qorpera_operations_broker = "") { return 404; }
    proxy_pass http://$qorpera_operations_broker;
}
# F3 5j-3: a coding session's environment variables, for the same executor
# token, routed by the same ?company= map. The answer carries the values (the
# broker marks it Cache-Control: no-store); never add body logging or a proxy
# cache here. Buffering stays off: with it on, an answer larger than the
# memory buffers going to a slow executor spills to a file under
# proxy_temp_path, values included. Off, nginx passes it through in memory.
location = /v1/coding-environment {
    limit_except POST { deny all; }
    if ($qorpera_operations_broker = "") { return 404; }
    proxy_buffering off;
    proxy_pass http://$qorpera_operations_broker;
}
# F3 5j-6b: a running coding session's relay to its MCP servers and its own
# repository, for the same executor token, routed by the same ?company= map
# (the MCP server's URL travels in a header, so the query is the company
# alone). Both ways stream: an MCP event stream and a git pack pass through as
# they arrive, so buffering is off for the request and the answer, the body
# has no size limit, and the read timeout outlasts the broker's own idle
# timeout (5 minutes for MCP, 2 for git). The request carries the session's
# lease and the answer its data; never add body logging or a proxy cache here.
location = /v1/coding-mcp {
    limit_except GET POST DELETE { deny all; }
    if ($qorpera_operations_broker = "") { return 404; }
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_request_buffering off;
    client_max_body_size 0;
    proxy_read_timeout 600s;
    proxy_pass http://$qorpera_operations_broker;
}
location = /v1/coding-repository-fetch/refs {
    limit_except GET { deny all; }
    if ($qorpera_operations_broker = "") { return 404; }
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_request_buffering off;
    client_max_body_size 0;
    proxy_read_timeout 600s;
    proxy_pass http://$qorpera_operations_broker;
}
location = /v1/coding-repository-fetch/upload-pack {
    limit_except POST { deny all; }
    if ($qorpera_operations_broker = "") { return 404; }
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_request_buffering off;
    client_max_body_size 0;
    proxy_read_timeout 600s;
    proxy_pass http://$qorpera_operations_broker;
}
```

The executor always sends `?company=<profileId>`. The operations map's empty
query line (`"" 127.0.0.1:18448`, for pre-v87 guests) also routes a request
without `company=` to the acceptance broker; that broker refuses any session
outside its company in the database ("coding session is unavailable to this
broker", SQL test 399), so the fallback releases nothing.

All of these up to bundle v88's pass `nginx -t` (nginx 1.28.3, node 2's build,
in a scratch prefix with a stand-in capture map). 5j-3's passes too (nginx
1.28.3, the `nginx:1.28-alpine` image on the test machine, scratch prefix,
stand-in map). There, a 16 MiB synthetic answer to an executor that read nothing
for 5 s logged no "buffered to a temporary file" warning, and the same block
without `proxy_buffering off;` logged one. 5j-6b's three relay locations pass
too (the same image, prefix and stand-in map). PUT, a GET to upload-pack and a
POST to refs got 403, an unknown company 404. An event stream reached the
reader event by event, a 4 MiB chunked upload reached the upstream as it was
sent, and a 16 MiB answer to a reader that stalled 5 s arrived whole, with no
temporary-file warning either way; the same blocks without the two buffering
lines logged one for the upload and one for the answer. nginx unlinks a temporary file as
soon as it opens it, so look for that warning, not for files under
`proxy_temp_path`. A regex with `{}` must stay quoted. The callback's
`error_log … crit` was chosen over accepting the leak: with the broker down,
nginx's default "error" level would record `request: "GET
/v1/oauth/callback?code=…&state=…"`; at "crit" a scratch run with a refused
upstream recorded nothing for the callback, while the other locations still
log such failures. They were
also run in a scratch nginx on node 2 with `return` in place of
`proxy_pass`: operations with no query or the acceptance company went to
18448, company Qorpera to 18547, an unknown company 404, GET 403; the
callback routed by the state prefix, a bare state 404. The operations map
matches the whole query exactly, which is all a v87 runner sends.
If `$qorpera_capture_broker` falls back to the acceptance broker for
requests without `company=` (as it does today for captures), the start route
may keep that fallback; the callback must not fall back, because a state
without a known prefix belongs to no broker.

### Company first (founder, 2026-09-24)

Everything is company first; members are only bolted on. A connector
connection belongs to the company:

- The web page opens company-owned tickets (`p_owner_kind = 'company'`), so
  only owners and admins connect, reconnect, share or disconnect (the Step 2
  kernel already required owner/admin for company-owned secrets). Other
  members see the services read-only.
- The member who connected is attribution only: `created_by_user_id`, listed
  as `connectedByUserId` and shown as "Connected as … by <name>".
- Only a company-owned connection can be shared with the company's agents:
  `qorpera_grant_cloud_connector` refuses member-owned secrets, and a check
  constraint keeps `available_to_all_agents` company-only. A new hire's grants
  are issued by the hire's author when that member is an owner or admin, else
  by the member who connected the account (a company grant holds only while
  its issuer is an owner or admin; the kernel rechecks it at every call).
- The kernel's member-owned mode is untouched and not extended: a member's own
  secret still works through per-operation grants in runs that member
  sponsors, and secret cards may still save one. The Services page never shows
  or shares it.

### SQL (`20260924040000_cloud_connector_catalog.sql`)

- `qorpera_cloud_secrets.account_label` (shown to members) and
  `available_to_all_agents` (company-owned only).
- A seven-argument `qorpera_complete_cloud_secret_capture` with the label,
  broker-login only; the six-argument signature keeps its guard and delegates
  (returning the legacy key set), so an older broker build still completes.
- The fifteen catalog rows.
- `qorpera_grant_cloud_connector(profile, environment, secret,
  staff_agent_ids default null)` for owners and admins: every current
  operation of a company-owned connection to every active agent (null; marks
  the connection shared) or to the named agents, idempotent, audited per
  grant. Founder decision
  2026-09-19/20: the gate is authority, never the client, so a connected
  account is available to the company's agents without a per-agent ceremony.
  A company grant holds only while its issuer is an owner or admin (the
  kernel rechecks at every call), so a share re-issues, under the caller,
  every grant of the connection whose issuer left or was demoted; live grants
  are left alone.
- Always shared (bundle v88, founder 2026-09-24): capture completion shares a
  company connection with every active agent as it seals it, first capture
  and rotation alike (`qorpera_share_company_connection`, under the owner or
  admin who captured it). A company connection is exactly what the Services
  page creates: company-owned, named `primary`, for a connector of the
  connector catalog. Other company-owned secrets (secret cards, typed vault
  entries) are never shared automatically, and an agent's secret card can no
  longer name a catalog connector (the native card append and the runner
  transcript validator refuse it; the catalog table decides), so a card can
  neither take a connection's tools nor rotate it in place.
  `qorpera_unshare_cloud_connector` ("Stop sharing with agents", v87) is
  dropped; `qorpera_grant_cloud_connector` remains only as the idempotent
  repair. A single grant can still be revoked and Disconnect still revokes the
  connection with all its grants. Since 20260928269500 Disconnect also cancels
  the connection's tokens at Google or GitHub (RUNTIME-COMPANY-DELETE.md, D6).
- Trigger `qorpera_cloud_connector_staff_grants`: a new active hire receives
  the grants of every shared company connection, issued by the hire's author
  if an owner or admin, else by the member who connected the account if still
  one, else by a current owner (or admin); the existing archive trigger
  revokes them.
- `qorpera_list_cloud_secret_connections` also returns `accountLabel`,
  `connectedByUserId`, `availableToAllAgents`, `activeGrantCount`,
  `createdAt`, `updatedAt`.

The migration replaces two functions. Both were checked against master's
effective definitions (all migrations through v85 applied, then
`pg_get_functiondef`): the seven-argument completion is exactly master's
six-argument body (including the broker-role guard of 20260828018100 and
PT412 of 20260828019960) plus the label, and the list function is master's
body plus the new keys. No later migration on master touches either.

Tests: `supabase/tests/397_cloud_connector_catalog.test.sql` (company-owned
connect, contributor refused, member-owned secret not shareable, hire issued
by an owner, revoke fences) and `398_cloud_secret_broker_company_routing`
(on a real admitted run: another company's broker refused; a demoted
issuer's tools disappear and a re-share by another admin restores them; a
later hire's grants come from a current owner; since v88, Stop sharing no
longer exists and a later hire still receives the connection); 306 compares the broker's exact function
signatures (`oid::regprocedure`), which now include the two signatures of the
capture completion.

### Web (`packages/web`)

Settings → Connections gains a Services section (`settings-services.ts`,
`cloud/connectors.ts`) under the model accounts: a card per connector with
Connect and, once connected, one action, Disconnect, plus the account label,
who connected it and the line that it is available to every agent in the
company, new hires included; for GitHub a token alternative. Connections are
always shared (web #243, kernel v88): Share with all agents, Stop sharing with
agents and Reconnect are gone. Owners and admins get the actions; other
members see the cards read-only. After the provider redirect the app reads the
outcome from the hash, reopens Settings on Connections and confirms the
sign-in with this tab's proof; sealing the connection shares it (v88), and the
page's follow-up `qorpera_grant_cloud_connector` call is an idempotent
repair. Broker requests carry `?company=<profileId>`.

### Runtime

`CLOUD_NATIVE_TOOL_COUNT_LIMIT` rises from 32 to 48 so all fifteen connector
tools fit beside every runtime-owned tool (29 today, an upper bound). Observation names connector tools
`connector` already. The constitution's escalation order (connector before
browser) was already in place; no prompt change.

## Verification

- `packages/runtime/test/cloud-connector-{catalog,github,google,oauth,oauth-http}.test.ts`
  and the existing `cloud-secret-*` tests: adapters against fake providers
  (request shape, reduction, refusals, injection, origin pinning), OAuth
  begin/complete/replay/decline/expiry, broker routes with CORS and redirects,
  service composition.
- `packages/web/test/settings-services.test.ts` plus the updated connections
  and lifecycle tests.
- `npm run test:hosted-db`: all migrations and SQL tests in disposable
  PostgreSQL, including 397.
- `npm run check`, `npm run test:scripts`.

## Live rollout gates (not done)

1. Brokers: company Qorpera's (`qorpera-prod-broker`, 18547) and the
   acceptance company's (`qorpera-phql-broker`, 18448) run on node 1 behind
   the public origin (2026-09-23). Roll both to the v87 broker build (sha in
   the PR) and give each the `qorpera-cloud-secret-connectors` credential
   (`publicOrigin` = `https://company41-node-01.tailbb15c7.ts.net:10000`,
   plus the OAuth clients). Their config v2 `memberOrigins` already names
   `https://app.qorpera.com`.
2. nginx on node 1: the two maps and two locations above.
3. Founder: register a Google Cloud OAuth client (web application, redirect
   `https://company41-node-01.tailbb15c7.ts.net:10000/v1/oauth/callback`,
   scopes gmail.readonly, gmail.send, drive, userinfo.email; Gmail scopes are
   restricted, so the app stays in testing mode, at most 100 test users and
   7-day refresh tokens, until Google verifies it) and a GitHub OAuth App
   (same callback URL). The client secrets go straight into the root-only
   credential file on the broker host, never through a chat or a repo.
4. The operations map and location above, and every company broker's
   `qorpera-cloud-secret-runtime` set to the nodes' one runtime token.
5. Apply the migration and cut v87 (coordinator).
6. Acceptance: an owner connects each service from the web app; an agent
   reads a mailbox thread, a Drive document and a GitHub issue, sends one
   email, creates one Drive file and one GitHub comment; a hire made
   afterwards holds the grants; a contributor sees the cards read-only;
   Disconnect fences the next run; no token or code appears in Supabase,
   logs, receipts or the thread.

## Accepted risks and follow-ups (bundle v88 review)

- **S2, token scope.** The GitHub OAuth token carries `repo`: it reaches every
  repository the connected account can reach, not only the session's, and the
  executor's network Git stages have open egress. The session's pushes are
  fenced to the fixed session branch and the SQL repository grant, but the
  token itself is account-wide. Follow-up: per-repository GitHub App
  installation tokens, or network Git limited to github.com.
- **S3, revocation under always shared.** Revoking one agent's grant lasts only
  until the next rotation (reconnect) or share repair re-shares the connection.
  The v88 migration also re-shares connections that were stopped under v87.
- **N1, audit order.** `repository_credential_used` is written when the kernel
  authorizes, before the broker opens the envelope; a release that fails in
  the broker (digest, keyring, token shape) still leaves the event.
- **N4, executor unit.** `qorpera-coding-executor.service` loads
  `qorpera-coding-broker-executor` unconditionally: install
  `/etc/qorpera/coding-broker-executor.key` before starting the v88 executor,
  even when every repository still names a static credential.
- **Coding claim authority.** `qorpera_claim_coding_session` and the lease RPCs
  stay on service_role in v88 (see the executor token above); moving them to a
  dedicated executor authority is a follow-up.

## Open decisions

- If node 1, node 2 and the exec host ever carry different broker runtime
  tokens, a broker needs to accept a short list of tokens (a small broker
  change); today it accepts one.
- Company connections are always shared with every agent (founder,
  2026-09-24); restricting one to chosen agents is not offered.
- Drive scope: `drive` reads everything the member can; `drive.file` would
  see only files the app created. Kept `drive` for usefulness; verification
  cost noted above.
- Attachments and downloads (Gmail attachments, Drive binaries) stay out of
  scope; the operations report them as metadata only.
