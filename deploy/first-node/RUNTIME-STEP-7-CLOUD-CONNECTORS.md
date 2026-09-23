# Runtime Step 7 — Cloud connectors: Gmail, Google Drive, GitHub

Date: 2026-09-22. Branch `fable/step7-cloud-connectors` on master `fe4dd96b6`
(v58). **Components are implemented and verified offline; nothing is deployed.**
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
`supabase/migrations/20260922090000_cloud_connector_catalog.sql`; `npm run
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
captured through the existing `POST /v1/captures/<ticketId>` route. Member
routes now answer CORS preflight for allow-listed web origins; the runtime
operation route does not.

The broker service (`cloud-secret-broker-service-main.ts`) reads one optional
systemd credential, `qorpera-cloud-secret-connectors`
(`qorpera.cloud-connector-service/v1`: `publicOrigin`, `returnOrigins`,
`google` and/or `github` `{clientId, clientSecret}`). Absent, the broker runs
exactly as before Step 7, without connectors or OAuth routes. Present, it
serves the connectors whose provider has a client.

### SQL (`20260922090000_cloud_connector_catalog.sql`)

- `qorpera_cloud_secrets.account_label` (shown to members) and
  `available_to_all_agents`.
- A seven-argument `qorpera_complete_cloud_secret_capture` with the label,
  broker-login only; the six-argument signature keeps its guard and delegates
  (returning the legacy key set), so an older broker build still completes.
- The fifteen catalog rows.
- `qorpera_grant_cloud_connector(profile, environment, secret,
  staff_agent_ids default null)` for members: every current operation of the
  connection to every active agent (null; marks the connection shared) or to
  the named agents, idempotent, audited per grant. Founder decision
  2026-09-19/20: the gate is authority, never the client, so a connected
  account is available to the company's agents without a per-agent ceremony.
- Trigger `qorpera_cloud_connector_staff_grants`: a new active hire receives
  the grants of every shared connection; the existing archive trigger revokes
  them.
- `qorpera_list_cloud_secret_connections` also returns `accountLabel`,
  `availableToAllAgents`, `activeGrantCount`, `createdAt`, `updatedAt`.

Tests: `supabase/tests/380_cloud_connector_catalog.test.sql`; 306 now compares
distinct broker function names (two signatures of one custody call).

### Web (`packages/web`)

Settings → Connections gains a Services section (`settings-services.ts`,
`cloud/connectors.ts`) under the model accounts: a card per connector with
Connect, Reconnect (rotates the same connection), Disconnect, the account
label, and for GitHub a token alternative. After the provider redirect the
app reads the outcome from the hash, reopens Settings on Connections, and
shares a freshly connected account with all agents. Connections are
member-owned in this first step; the RPC already accepts company ownership
for owners/admins, only the switch in the page is missing.

### Runtime

`CLOUD_NATIVE_TOOL_COUNT_LIMIT` rises from 32 to 48 so all fifteen connector
tools fit beside the runtime's own. Observation names connector tools
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
  PostgreSQL, including 380.
- `npm run check`, `npm run test:scripts`.

## Live rollout gates (not done)

1. The cloud secret broker is not deployed in production (Step 2 gates 1–9
   remain). Provision it, its keyring custody, the company authority row and
   the runtime bearer first.
2. Give the broker a public TLS origin reachable by member browsers and
   providers (`/v1/oauth/callback`, `/v1/oauth/*/start`, `/v1/captures/*`),
   with the reverse proxy passing GET on the callback and OPTIONS on the
   member routes. Keep `/v1/operations` private.
3. Register a Google Cloud OAuth client (web application, redirect
   `<publicOrigin>/v1/oauth/callback`, scopes gmail.readonly, gmail.send,
   drive, userinfo.email; the sensitive/restricted scopes need Google's app
   verification before members outside the test-user list can consent) and a
   GitHub OAuth App (same callback). Put both into the
   `qorpera-cloud-secret-connectors` credential with the web return origins.
4. Apply the migration in the coordinator's slot (registry v61) and cut the
   bundle from a node 2 Linux build (guest host pin).
5. Acceptance: one member connects each service from the web app; an agent
   reads a mailbox thread, a Drive document and a GitHub issue, sends one
   email, creates one Drive file and one GitHub comment; a hire made
   afterwards holds the grants; Disconnect fences the next run; no token or
   code appears in Supabase, logs, receipts or the thread.

## Open decisions

- Company-owned connections in the page (owner/admin switch).
- Restricting a connection to chosen agents from the page (the RPC supports
  it).
- Drive scope: `drive` reads everything the member can; `drive.file` would
  see only files the app created. Kept `drive` for usefulness; verification
  cost noted above.
- Attachments and downloads (Gmail attachments, Drive binaries) stay out of
  scope; the operations report them as metadata only.
