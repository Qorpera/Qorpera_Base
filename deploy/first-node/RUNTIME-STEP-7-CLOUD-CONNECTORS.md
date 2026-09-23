# Runtime Step 7 — Cloud connectors: Gmail, Google Drive, GitHub

Date: 2026-09-22, re-slotted 2026-09-24 as bundle **v87** together with the
Step 9 coding route (branch `fable/coding-connectors-v86`, superseding #202
and #223). **Components are implemented and verified offline; nothing is
deployed.**
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
of that whole promise, so a changed request, schema or destination is a
changed adapter.

| Connector | Credential field | Operations (tool names) |
| --- | --- | --- |
| `github` (api.github.com) | `access_token` | `github_list_repositories`, `github_search_issues`, `github_get_issue`, `github_create_issue`, `github_comment_on_issue`, `github_read_file`, `github_get_pull_request` |
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
clipped and comment/thread text shares a budget so a result stays readable
inside the 8 KiB the model receives. Expected provider refusals (404, 403,
429, 401, 400/422) become a closed failure result
(`qorpera.connector-result/v1`, `status: "failed"`, `reason`, short
`detail`); transport faults stay generic. Google adapters exchange the sealed
refresh token for an access token on every call and keep neither. A revoked
Google grant surfaces as `authorization_required`, which tells the agent to
ask the member to reconnect rather than retry. The broker's existing
reflected-secret fence still runs on every result.

### OAuth inside the broker (`cloud-connector-oauth.ts`, broker HTTP routes)

Contract §11.5: OAuth completion goes from a typed member interaction
straight to the broker. The web app asks the cloud for a capture ticket
(`qorpera_begin_cloud_secret_capture`, unchanged), then posts the ticket to
`POST <broker>/v1/oauth/<ticketId>/start` with the capability and the page to
return to. The broker confirms the ticket (`CloudSecretBroker.describeCapture`,
nothing committed), remembers a single-use state for ten minutes and answers
with the provider consent URL (Google: offline access, forced consent, PKCE;
GitHub: `repo read:user user:email`). The provider redirects the browser to
`GET <broker>/v1/oauth/callback`; the broker exchanges the code, reads the
account identity (mailbox address or GitHub login) as a non-secret label,
seals the refresh or access token into the ticket, and sends the browser back
to the return page with the outcome in the hash fragment
(`#/c/<id>?connector=gmail&connection=connected|failed&reason=…`). Codes and
tokens never reach the web app, Supabase, logs or the model. A replayed
callback finds no state. A GitHub fine-grained token can still be typed and
captured through the existing `POST /v1/captures/<ticketId>` route. Both
member routes (capture and sign-in start) answer CORS only for the broker's
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

### Routing behind the one public origin (production)

All companies' brokers sit behind ONE public origin,
`https://company41-node-01.tailbb15c7.ts.net:10000` (the only broker origin in
the web app's CSP). Node 1's nginx picks the company's broker process per
request; the authority's `service_origin` stays that bare origin.

- **Member routes carry the company in the query.** The web app posts
  `/v1/captures/<ticket>?company=<profileId>` (secret cards, web #236) and, for
  connectors, `/v1/oauth/<ticket>/start?company=<profileId>` and
  `/v1/captures/<ticket>?company=<profileId>` (typed GitHub token). The
  existing `$qorpera_capture_broker` map on `company=` routes all three.
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
    <company Qorpera profile id>         127.0.0.1:18547;   # company Qorpera (qorpera-prod-broker)
}
```

```nginx
# Inside the :10000 server block, beside the /v1/captures/ location.
location = /v1/oauth/callback {
    limit_except GET { deny all; }
    if ($qorpera_oauth_broker = "") { return 404; }
    proxy_pass http://$qorpera_oauth_broker;
}
# The sign-in start is a member route like a capture: POST and the CORS
# preflight (OPTIONS), routed by the same ?company= map.
location ~ ^/v1/oauth/[0-9a-fA-F-]{36}/start$ {
    limit_except POST OPTIONS { deny all; }
    if ($qorpera_capture_broker = "") { return 404; }
    proxy_pass http://$qorpera_capture_broker;
}
```

If `$qorpera_capture_broker` falls back to the acceptance broker for
requests without `company=` (as it does today for captures), the start route
may keep that fallback; the callback must not fall back, because a state
without a known prefix belongs to no broker. `/v1/operations` stays as it is
(see open items: per-company operation routing).

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
- Trigger `qorpera_cloud_connector_staff_grants`: a new active hire receives
  the grants of every shared company connection; the existing archive
  trigger revokes them.
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
by an owner, revoke fences); 306 now compares distinct broker function names
(two signatures of one custody call).

### Web (`packages/web`)

Settings → Connections gains a Services section (`settings-services.ts`,
`cloud/connectors.ts`) under the model accounts: a card per connector with
Connect, Reconnect (rotates the same connection), Disconnect, Share with all
agents (when a connection is not shared yet), the account label and who
connected it, and for GitHub a token alternative. Owners and admins get the
actions; other members see the cards read-only. After the provider redirect
the app reads the outcome from the hash, reopens Settings on Connections, and
shares a freshly connected account with all agents. Broker requests carry
`?company=<profileId>`.

### Runtime

`CLOUD_NATIVE_TOOL_COUNT_LIMIT` rises from 32 to 48 so all fifteen connector
tools fit beside every runtime-owned tool (29 today, an upper bound). Observation names connector tools
`connector` already. The constitution's escalation order (connector before
browser) was already in place; no prompt change.

## Verification

- `packages/shell/test/cloud-connector-{catalog,github,google,oauth,oauth-http}.test.ts`
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
4. Per-company operation routing (open, see below) before an agent of company
   Qorpera can call a connector.
5. Apply the migration and cut v87 (coordinator).
6. Acceptance: an owner connects each service from the web app; an agent
   reads a mailbox thread, a Drive document and a GitHub issue, sends one
   email, creates one Drive file and one GitHub comment; a hire made
   afterwards holds the grants; a contributor sees the cards read-only;
   Disconnect fences the next run; no token or code appears in Supabase,
   logs, receipts or the thread.

## Open decisions

- Per-company `/v1/operations` routing: guests get one broker URL and runtime
  token per node, and the router sends every operation to the acceptance
  broker. The operation request names no company in its URL today, so a
  company's connector calls need either per-company runtime tokens plus an
  nginx map on the Authorization header, or the company in the operation URL
  (a runtime change for a later bundle).
- Restricting a connection to chosen agents from the page (the RPC supports
  it).
- Drive scope: `drive` reads everything the member can; `drive.file` would
  see only files the app created. Kept `drive` for usefulness; verification
  cost noted above.
- Attachments and downloads (Gmail attachments, Drive binaries) stay out of
  scope; the operations report them as metadata only.
