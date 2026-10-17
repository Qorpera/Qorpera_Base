# Model logins in the vault (Stateless Compute step 1)

Founder approval: 28 September 2026, page "Logins in the Vault"
(https://claude.ai/artifact/TWG18JBqjkLvkyY3PiaYdv). Contract: section 19, 2026-09-28 amendment
"model logins live in the vault". This file is the technical design; the page is the plain one.

## Before (v141)

- A login is `codex/auth.json` sealed as a capsule (`QNC1 | nonce | tag | AES-256-GCM`, AAD
  `qorpera.native-credential-capsule/v1:<capsuleId>`) under a per-identity 32-byte master key, in the
  Supabase Storage bucket `qorpera-native-compute-capsules`.
- The master key is the pin: it lives on the LXD volume `phql-a1-identity-<uuid>` of one node,
  escrowed to the company's recovery authority. The identity home is derived from completed
  login/refresh allocations at the current recovery epoch (`qorpera_runtime_identity_home_allocation`)
  and used by the claim predicate and the native branch of `qorpera_runtime_node_placement_decide`.
- Every run resealed and uploaded the capsule (last writer wins). PR 0 (#412) saves only a changed
  login, only while the store still holds the login the run started from.

## Codex facts the design relies on (rust-v0.155.1)

- `AuthManager::auth()` renews proactively only when the access JWT `exp` is within 5 minutes
  (else when `last_refresh` is older than 8 days); a failed proactive renewal keeps the cached auth.
- `refresh_token()` first re-reads `auth.json` and uses it if it changed (same account); the 401
  recovery path does the same. So a host that writes a fresh copy into the run's Codex home before
  the last 5 minutes means Codex never renews.
- Refresh tokens are single use (`refresh_token_reused`).
- `account/read {refreshToken: true}` forces a renewal through the normal flow.
- `account/login/start` `chatgptAuthTokens` is marked "FOR OPENAI INTERNAL USE ONLY - DO NOT USE"
  and is not used. `use_agent_identity` (writes into `auth.json`) is off by default and stays off.

## Storage and the renewal lock (change 1, migration `20260928160000`)

- `qorpera_model_logins`: one row per vault login, bound 1:1 to a pointer capsule row
  (`credential_capsule_id`, reference `model-login/<login id>`), the company's broker authority,
  `status active|needs_sign_in|revoked`, `current_version`, the current pass's issue and end times
  (read by the broker from the access JWT; not secret), `renewal_token`/`renewal_until`.
- `qorpera_model_login_versions`: immutable envelopes (`sealCloudSecretFields`, one field
  `codex_auth_json`, identity `{companyId, environmentId: computeIdentityId, secretId: loginId,
  version, keyId}`), `origin sign_in|renewal`.
- No table privileges for anyone; the broker role executes three functions:
  - `qorpera_issue_model_login(authority, capability, binding, knownVersion, allowRenewal)`: checks the
    run with `qorpera_model_login_run_binding`, the native lease validator's own conditions read
    without company-wide locks (exact binding; job leased and unexpired; assignment accepted and unexpired; lease
    live; sponsor and compute available; connection, version, capsule and policy active; identity
    and runner at the current epoch; company not paused). Past half the pass life and with
    `allowRenewal`, the first caller takes the lock (`update … where renewal_until is null or < now()`
    and the backoff after failures has passed: 1, 2, 4 ... minutes, at most an hour). Returns the
    envelope, or `unchanged` when the host already holds the current version and no renewal was
    granted.
  - `qorpera_commit_model_login_renewal(…, token, baseVersion, keyId, envelope, sha, issuedAt, expiresAt)`:
    compare-and-swap on `(current_version = base, renewal_token = token, the new pass ends later)`
    under the authority's current key. A token is written anew each time the lock is taken, so a
    matching token proves nobody took the lock over, even after it lapsed. A repeat after a lost
    answer finds its own version (same digest) and succeeds.
  - `qorpera_release_model_login_renewal(…, token, baseVersion, permanent, reason)`: gives the lock
    back and records the failure time; a permanent failure sets `needs_sign_in` only while the login
    is still at `baseVersion` (a newer version, such as a fresh sign-in, is never marked; a revoked
    login stays revoked).
- Locks: the login row only, for one short statement. No company row, fence or authority row is
  locked for update (a saved version's foreign key takes a key-share lock on its authority). A run
  no member started takes, like the lease validator, a share lock on its member's connection row.
  The run's host keeps validating its lease with the company fence every 15 s, as today.

## The broker (change 1)

- `CloudModelLoginVault` (`packages/runtime/src/cloud-model-login-vault.ts`): opens the envelope and
  builds the run's copy from the login's known fields only, with an empty renewal token
  (`accessOnlyCodexLogin`; a stored login with unknown fields is refused). When it holds the lock it
  first checks it can seal under the lock's key, gives the renewer at most 35 s, checks the result
  (same `account_id`, later pass), seals version `base + 1` and saves it with up to three tries on
  its own 15 s deadline. Every way out gives the lock back: refused or unsaved (the old renewal token
  is spent) as permanent, anything else as transient. The run always keeps the newest pass it has
  that has not ended.
- `POST /v1/model-logins?company=<profile>` under the runtime token, with the run's lease as
  `x-qorpera-identity: job.<job id>.<lease token>` (G2-6a; see `RUNTIME-NATIVE-HOST-KEY.md`, "G2-6"), body
  `{schema: "qorpera.model-login-request/v1", binding, knownVersion}`, answer
  `{schema: "qorpera.model-login/v1", version, accessExpiresAt, authJson | null}`, never cached,
  no CORS. Client: `issueModelLogin` in `cloud-secret-broker-http.ts`.
- Change 1 ships with no renewer, so the broker never asks for the lock.

## The helper (change 2)

A separate service beside each broker, `qorpera-model-login-helper` (the broker unit's
`RestrictNamespaces=yes`, `MemoryMax=256M` and `TasksMax=32` cannot host Codex). It holds no key,
no database login and no service key; it sees a login only for one operation and keeps nothing.

- **Part A, renewal** (`cloud-model-login-renewal.ts`, `cloud-model-login-helper.ts`,
  `cloud-model-login-helper-main.ts`): the broker posts the full login to the helper's Unix socket
  (`/run/qorpera-model-login-helper/helper.sock`, mode 0660, group `qorpera-login-helper`, plus a
  bearer token). The helper writes it into a fresh private `CODEX_HOME` under its runtime
  directory (memory, not disk), starts the pinned official Codex as `codex app-server` in the
  existing bubblewrap launcher (egress only to `auth.openai.com` and `chatgpt.com`), sends
  `initialize` and `account/read {refreshToken: true}`, and wipes the home. A changed `auth.json` is
  the renewed login. Otherwise Codex's own error line decides: 401, `refresh_token_reused|expired|
  invalidated` (from the JSON body, any case, as Codex reads it) or a 400 `invalid_grant` is refused
  (the login needs a new sign-in), anything else is retried later. At most 4 renewals run at once.
  Budgets nest: Codex 25 s, helper answer 28 s, broker wait 30 s, vault renewal 35 s; once asked, a
  renewal runs to its budget whatever the member's request does, because only it can save the new
  login. Stopping the unit lets renewals in flight finish (`KillMode=mixed`, 40 s).
- **Part B, sign-in** (migration `20260928184000`, `cloud-model-login-sign-in.ts`,
  `cloud-model-login-vault-sign-in.ts`): a member signs in to the vault; the web client is unchanged.
  - An operator switches a company with `qorpera_set_model_login_sign_in(company, true)` (service
    role). It refuses until runs take their login from the vault (change 3's
    `qorpera_compute_identity_login_in_vault` exists) and the vault reads usage (Part C's
    `qorpera_describe_model_login_account_refresh` exists), and while the company has no active
    broker authority. Switch a company only after change 3 and Part C are live on every node. The login gateway chooser then answers a pending Codex sign-in of that company with
    `<broker service origin>/v1/model-logins/<company>/` (reason `MODEL_LOGIN_VAULT`); Claude
    sign-ins and unswitched companies keep the node path.
  - The web client's edge function posts its unchanged `qorpera.native-provider-login/v1` request to
    `<that base>login`, with the sign-in's capability as bearer. The broker asks the database
    (`qorpera_describe_model_login_sign_in`, broker role) for the pending sign-in that capability
    names, checks the request against it field by field (login, connection, identity and its owner,
    expiry, the capability in the body), and asks the helper to start or report the sign-in. A slow
    helper is answered as `preparing`; a sign-in that is no longer pending ends the helper's copy.
  - The helper runs the same `codex login --device-auth` driver a node uses
    (`OfficialCliNativeHarnessDriver`, in the same isolation, its scratch under the helper's runtime
    directory, the pinned binary checked before each launch) in a private home. A sign-in is bound
    to its company, identity and capability digest; a newer sign-in of the same identity ends the
    older one (also when two members share a company identity: the second sign-in ends the first);
    at most 6 run at once, 2 per company. The binding is a consistency check: the company brokers on
    one host share the helper's token; the shared vault has its own (Vault By Default, part 3), and the
    helper answers a sign-in only to the client that began it. Codex stops after 10 minutes at the latest;
    its home is wiped as soon as it stops. The answer is the node gateway's
    `qorpera.native-provider-login-result/v1`: `preparing`, `awaiting_member` with the link and code,
    or `completed`.
  - The web client stops asking once it shows the link and code, so the broker collects finished
    sign-ins itself: every 2 s it lists its company's finished sign-ins at the helper
    (`qorpera_model_login_broker_company` names the company), checks the login has known fields
    only, seals it under the company's broker key as version 1 of a new vault login, completes the
    sign-in in one transaction (`qorpera_complete_model_login_sign_in`, broker role: the pointer
    capsule `model-login/<login id>`, the vault login with `sign_in_session_id`, its version 1
    (`sign_in`), and the connection version pointing at the pointer capsule, recorded exactly as a
    node sign-in records it), then ends the helper's copy. A broker that restarted finds finished
    sign-ins on its first pass; the helper keeps a finished login at most 5 minutes, and ends it
    after three refused lookups (`42501` or `22023`, or an answer it cannot read: the company was
    switched back or its broker authority changed meanwhile). An outage or a timeout neither counts
    nor resets the count; a successful lookup resets it. A node may still create the identity's key
    later: a vault login never counts as a login sealed under a node key. An ended
    sign-in is never started again by a late poll. The recovery
    pin still fences a recovering identity, but asks no node key backup of a sign-in that created a
    vault login. A repeat after a lost answer finds its own login.
  - Deploy: the broker's public front must route `POST /v1/model-logins/<company>/login` and
    `POST /v1/model-logins/<company>/account-refresh` to that company's broker by path (the edge
    function adds no query). On node 1 (2026-09-28): `map $uri $qorpera_model_login_broker` (one line
    per company: its broker's port, no fallback) and `location ~ ^/v1/model-logins/<uuid>/(login|account-refresh)$`
    (POST only, no query, 64k body, `proxy_pass` without a URI). The helper must run beside the
    broker (without it the route answers 404). A helper restart ends sign-ins in flight; the member
    signs in again.
- **Part C, usage** (migration `20260928185000`, `cloud-model-login-vault-usage.ts`): the vault reads
  the usage of the logins it keeps; the web client is unchanged.
  - The account refresh chooser answers a refresh of an identity whose Codex usage is the vault's
    (`qorpera_model_login_usage_in_vault`: it has a vault login behind an active pointer, in any
    state, and no Codex login a node would read, by the node's own list rule) with `<broker service origin>/v1/model-logins/
    <company>/` (reason `MODEL_LOGIN_VAULT`) when the company has an active broker, whether or not
    it still takes new sign-ins in the vault. A Claude login stays on a node and does not count
    (nodes read Codex usage only); a vault login that needs a new sign-in reads nothing there and
    boots no machine. An identity still moving (a Codex login on a node beside its vault login)
    keeps the node path, which reads its node logins and skips the vault ones. The edge function
    posts its unchanged `qorpera.native-account-refresh/v1` to `<base>account-refresh` with the
    refresh's capability.
  - The broker reads the refresh (`qorpera_describe_model_login_account_refresh`, broker role) with
    the node route's checks (live, the member still owns the identity with a role that may
    refresh, the broker's own company), and while it is pending the current version of up to 8
    active vault logins of that identity that the latest version of an active connection uses
    (never read first, then the longest unread). It opens
    them all at once, reads each one's usage with the pass (the node's own `wham/usage` reader,
    8 s each, inside the route's 25 s), records the display metadata (email, account identity
    digest, usage) for that connection version with the node record's checks
    (`qorpera_record_model_login_account_metadata`), and completes the refresh
    (`qorpera_complete_model_login_account_refresh`). A login that cannot be read is unknown usage;
    the refresh still settles. The pass is never renewed here, only display metadata leaves the
    vault, and the envelopes are wiped. No helper and no machine is involved.
- **Part D, idle renewal** (migration `20260928236000`, `cloud-model-login-upkeep.ts`; founder
  decision 2026-09-28): the vault renews idle logins itself, so a login nobody used does not lapse
  before its next run and runs rarely wait for a renewal at start.
  - Every 5 minutes (the first pass 30 s plus a random part of 5 minutes after start, so brokers
    sharing a helper do not all renew at once) a broker with a helper takes, one login at a time,
    the renewal lock of its company's most urgent login past half its pass
    (`qorpera_take_idle_model_login_renewal`, broker role). The conditions are a run's: active, no
    renewal running (or a lapsed one), the failure back-off passed. The login's pointer must be
    active and used by an active version of an active connection: a login the member disconnected,
    or whose connection was disabled or revoked (the member left), is not renewed and lapses.
  - It renews through the helper exactly as a run's renewal does and saves or gives back the lock
    with the same commit and release; at most 12 logins per pass. A refusal marks the login
    `needs_sign_in` days before its next run would have found out.
  - Locks: the login row only, by one conditional update (`qorpera_model_login_take_idle_lock`, which
    re-checks a run's lock conditions on the row itself). The taking marks nothing as used.
  - Deploy: reinstall the broker unit from this build. `TimeoutStopSec=90` lets a stop wait for a
    renewal in flight (35 s, then its save), where 15 s could lose the new login.

### Installing the helper (operator, per vault host)

1. Codex: the official release `codex-x86_64-unknown-linux-musl.tar.gz` of `rust-v0.155.1`
   (SHA-256 of the archive `a0ef8b2debc3bf747e07b1a039354de31300ac0dcc2276498ba281470b5d9115`).
   Verify, extract the single binary to `/opt/qorpera-model-login-helper/codex`, root-owned 0555,
   and record its own SHA-256 for the configuration. The helper refuses to start on any other
   bytes or on a path that is not root-owned.
2. Isolation: root-owned `/usr/bin/bwrap` and `/usr/bin/node`, and unprivileged user namespaces.
   The helper checks these, its isolation entry point and the Codex binary at start and refuses to
   run on a bad install.
3. `npm run pack:model-login-helper -- --out <dir>`; install `qorpera-model-login-helper.mjs` and
   `qorpera-native-isolation-child.mjs` (shipped with the helper) to `/opt/qorpera-model-login-helper/`,
   root-owned 0444, and the unit; create the `qorpera-login-helper` user and group.
4. `/etc/qorpera-model-login-helper/config.json`:
   `{"schema": "qorpera.model-login-helper/v1", "socketPath": "/run/qorpera-model-login-helper/helper.sock",
   "codexPath": "/opt/qorpera-model-login-helper/codex", "codexSha256": "<binary sha256>",
   "temporaryRoot": "/run/qorpera-model-login-helper", "isolationEntryPoint":
   "/opt/qorpera-model-login-helper/qorpera-native-isolation-child.mjs"}` and `/etc/qorpera-model-login-helper/token`
   (43 base64url characters, distinct from every broker token).
5. Broker drop-in: `SupplementaryGroups=qorpera-login-helper` and
   `LoadCredential=qorpera-cloud-secret-login-helper:/etc/qorpera-secret-broker/login-helper.json`
   with `{"schema": "qorpera.model-login-helper-client/v1", "socketPath": "/run/qorpera-model-login-helper/helper.sock",
   "token": "<the helper token>"}`. Without that credential the broker never asks for a renewal lock.
6. Start the helper. Before it serves anything it runs the pinned Codex with `--version` inside the
   sandbox, under the real unit, and logs `Model login helper: sandbox self-check ok (<version>)`;
   a failure stops the unit visibly (binary pin, bubblewrap, the isolation child and the unit's
   system-call filter). Egress is not part of that check.
7. Before any login moves, prove one real sign-in and one real renewal through the product: switch
   the test company, a member signs in from the web client, and the vault login is renewed once
   (after half its pass life, or on demand). Nobody handles a login by hand. Measure the unit's
   memory, task and CPU use during that sign-in: its limits are sized for 4 renewals and 6
   sign-ins but not yet measured, and `CPUQuota=100%` is shared by every Codex it runs (a renewal
   has 25 s). Re-run this step whenever the sign-in driver, the isolation launcher or the unit
   changes. A renewal that
   cannot start Codex records `codex_launch_failed`, and a binary changed since start records
   `codex_changed` and restarts the helper.

## Runs (change 3, migration `20260928180600`)

- An identity's login is in the vault when it has an active vault login behind an active pointer
  capsule `model-login/<login id>` and no other active capsule (one that still needs a node key):
  `qorpera_compute_identity_login_in_vault(identity)`, service role only, stable, no locks.
- Claim: `qorpera_claim_runner_job_for_orchestrator`'s identity-home predicate gains
  `or qorpera_compute_identity_login_in_vault(run.compute_identity_id)` as its last arm (asked only
  for a run whose home is elsewhere), so any orchestrator may claim such a run. Placement: the native identity-home branch of `qorpera_runtime_node_placement_decide`
  is skipped for such an identity, so it falls through to the least-loaded choice. Both patches are
  anchor-checked (exactly one match). The identity runtime state keeps its exact shape (older nodes
  parse it with a fixed field list).
- The native host: a run whose authority names a `model-login/` capsule asks `POST /v1/model-logins`
  (binding = its lease, run, job, runner, assignment, capsule and identity; since G2-6a also the job's lease
  token in `x-qorpera-identity`, from `NativeHostDispatch.holderHeader()`) instead of opening a
  capsule, refuses a copy that carries a renewal token, writes the copy as `codex/auth.json` in the
  run's private root (staged beside the Codex home, which must hold `auth.json` alone, then renamed
  into it), asks again every minute with the version it holds, and swaps the file whenever the vault
  answers with a copy. It never uploads a login; the lease is still validated at the start, every
  15 s and at the end. A warm root keeps its vault version and asks for the current one at the next
  run. The account usage list accepts vault logins and the host skips them (the vault reads usage,
  change 2C).
- Host start-up (`cloud-native-provider-service-main.ts`): `QORPERA_NATIVE_LOGIN_CUSTODY=vault` means
  no capsule key, no epoch file and no key backup. The key credential must be empty; the host starts
  only when the identity is not fenced and the cloud confirms the vault custody, and needs the
  company runtime and the broker address.
- Node 2 (shared execution service): at acquire the service asks the vault custody check. For a
  vault identity it attaches no identity volume and hands the run host empty key and epoch credential
  files with `QORPERA_NATIVE_LOGIN_CUSTODY=vault`; a warm slot is reused only for the same custody.
- Node 1 (one-run VMs): the custody is decided once per acquisition and sealed into the journal
  (`lxd.loginCustody`) and the bootstrap digest. A vault guest has no `compute-identity` device (a
  guest that gains one is refused as drifted) and no identity volume is created. The bootstrap
  carries `company_runtime.login_custody = "vault"` and the host environment line; the guest's
  start-up refuses a mounted identity volume or any identity material, checks the identity is not
  fenced, and writes empty key and epoch credential sources for the unchanged host unit. The guest
  bootstrap unit no longer has a mount condition on the identity path (it would skip the bootstrap
  silently); the bootstrap requires the mount for a node login itself.
- Deploy: the runtime front that runs reach (`QORPERA_CLOUD_SECRET_BROKER_URL`, node 1's `:10000`) must
  route the run form `POST /v1/model-logins?company=<company>` to that company's broker by the query, as
  it routes operations: on node 1 (2026-09-28) `map $args $qorpera_model_login_run_broker` (one line per
  company, no fallback) and `location = /v1/model-logins` (POST only, 64k body, `proxy_pass` without a
  URI). Without it every vault run fails at `credential-download` (step 7's second run did).
- Deploy order: free. A database without the check answers 404, and the orchestrator, exec host and
  LXD provider then keep the node path, as before.
- Activation: move no login into the vault until every node's orchestrator, exec host and guest
  image carry this change. Before that, `qorpera_compute_identity_login_in_vault` is false for every
  identity and nothing changes.

## Vault by default for new companies (founder decisions 2026-09-28)

Every company created after the shared vault starts serves from it by itself: no hand-made authority, key
or switch. Existing companies keep their own brokers (or none) and are switched one by one as before.
Picks: one shared vault; each company's capability and key derived from the vault's own secrets (nothing
new stored); new companies only; node 1 serves, node 2 stands ready with the same secrets.

- **Part 1, database** (migration `20260928248930`): `qorpera_cloud_secret_broker_principals` is the
  shared vault's identity (service origin, the key id its companies get, a capability hash, and the time
  after which the companies it registers were created). Broker role only:
  - `qorpera_broker_principal_companies`: the principal's key id, the companies it serves (authorities
    with its `principal_id`) and, at most 50 at a time, the companies created after its start time that
    have no authority at all. The served list is not paged: about 1 MB at 8,000 companies, fine until then.
  - `qorpera_register_company_with_broker_principal`: creates the company's authority row (the
    principal's origin and key id, the capability hash the broker derived for the company, `principal_id`)
    and its row in `qorpera_model_login_sign_in_companies`. A repeat with the same capability, by either
    copy of the shared vault and at the same moment too, answers the same authority and changes nothing
    (an operator's later switch-off stays). Another capability, another principal, a company created at or
    before the start time, or a company with a vault of its own (retired included) is refused (`23505` or
    `42501`); a capability hash that names another company's authority is refused with `22023`. It runs at
    read committed only (`25000` otherwise): its race handling re-reads the other copy's committed row.
  - Every existing broker function then serves the company unchanged: each call names the company's own
    authority and capability. Locks: the new authority row and the switch row, plus the key-share locks
    their foreign keys take on the company's profile row and the principal row (a registration waits at
    most 2 s behind a lock on the company's profile).
  - Null-safe checks: every broker and the shared vault share one database login, so the capability is the
    only proof that a call is for the company. Every broker function checks it, and every other proof the
    caller sends (capture capability, tokens, digests, operation facts), so that a NULL argument is refused:
    for example `is distinct from` against a NOT NULL column, `coalesce(<test>, true)` around a pattern or
    length test, an explicit `is null` check, or a match in `where … = p_…`. A plain `<>`, `!~` or
    `not between` is unknown for a NULL argument and skips the refusal. Migration `20260928429988` fixed the
    last three functions that did not (capture describe and seal, operation authorization); SQL test 806
    sends them NULLs. A new broker function follows the same rule and gets the same kind of test.
  - An operator creates the principal once (`insert` with the capability hash and the start time). One
    principal is active at a time; a second with an overlapping start time is harmless (the two race to
    register each new company and the loser is refused) but serves no purpose. Retiring a principal stops
    its vault; its companies' authorities stay active until each is retired too.
- **Part 2, the broker** (`cloud-secret-broker-shared.ts`): config `qorpera.cloud-secret-broker-service/v3`
  names the principal (`principalId`, `port`, optional `memberOrigins`) and loads two credentials instead
  of one company's capability and keyring: `qorpera-cloud-secret-principal` (32 random bytes, base64url)
  and `qorpera-cloud-secret-master-keys` (`{"schema":"qorpera.cloud-secret-master-keys/v1","keys":[{"keyId":
  "<the principal's key id>","keyBase64url":"<32 bytes>"}]}`). The runtime token, database login, CA,
  login helper, connectors and coding executor credentials are the same as a one-company broker's.
  - Capabilities: the principal's is HMAC-SHA256(principal secret, `qorpera.broker-principal/v1`), a
    company's HMAC-SHA256(principal secret, `qorpera.broker-authority/v1:<company>`), both base64url
    (`sharedBrokerCapability`); the database holds only their sha256. Keys: a company's wrapping key is
    HKDF-SHA256(master key, salt `qorpera.company-kek/v1`, info `<company>`). Both copies of the vault
    derive the same ones, and nothing new is stored.
  - Every 10 s it registers the companies the principal lists and serves every registered company with
    its own broker, login vault, sign-ins and usage on that company's authority. It registers only while
    it holds the principal's key (registering switches a company to vault sign-in), and it serves a
    company only while it can derive that company's key. A company it does not know yet (created a moment
    ago) is looked up again at most every 2 s; a request that arrives while a refresh runs (the first one
    after a start included) waits for it. A refused registration logs one fixed line.
  - Each request's company comes from the path (sign-in, account refresh) or the `?company=` every
    client adds; a company it does not serve gets 404. Every database call still names the company's
    own authority and capability.
  - Background work per company: finished sign-ins every 2 s for a company whose member is signing in
    (20 minutes after the member's last poll) and every 30 s for all; each company's upkeep pass
    (accounts, switch-off, idle renewals) in turn every 5 minutes. The database pool has 8 connections.
    A stop ends the company pass in hand after its current renewal and save, inside the unit's 90 s.
  - A member's sign-in marks its company for frequent collection only once the database accepted it.
  - Connector sign-ins: one set of flows for all companies (256 started, 256 back from the provider), at
    most 32 per company across both; a confirm routed to one company refuses another company's flow
    before anything is exchanged.
  - One-company brokers (config v2) are unchanged, except that the 32-per-company share of connector
    sign-ins applies to them too.
- **Part 3, deploy**: the shared vault's unit and private files, a default route on the fronts for every
  company without a map line of its own, and node 2 as a warm standby. No secret passes through the
  coordinator's machine or a chat: each is made or copied on a vault host, node 2 takes them from node 1
  host to host, and only hashes and "match"/"mismatch" come back.

### Installing the shared vault (coordinator, through the root helper)

The package (`npm run pack:cloud-secret-broker`) also carries `qorpera-shared-vault.service` and
`shared-vault-secrets.py`. The vault runs the same service file as the company brokers
(`/opt/qorpera-secret-broker`), so the host needs the broker build with part 2, under its own system
user `qorpera-shared-vault` (a company broker's process cannot read the vault's credentials). Its files
live in `/etc/qorpera-shared-vault` (root, 0700; every file root-owned 0400). Every step below writes
under temporary names and renames only when all is written, so a failed step leaves nothing behind and
can simply be run again.

| File | From |
|---|---|
| `principal-secret`, `master-keys.json` | made on node 1 by `shared-vault-secrets.py generate` |
| `database-url`, `runtime`, `connectors.json`, `coding-executor` | the company brokers' own files on node 1 (one database login, one runtime token, the same OAuth clients and coding executor token for every broker) |
| `login-helper.json` | each host's own, by `shared-vault-secrets.py helper-token` |
| `config.json` | written by the coordinator; holds no secret |

The vault uses the host's login helper with a token of its own: `helper-token` writes it both as the
helper's `vault-token` credential and as the vault's `login-helper.json`. The helper answers a sign-in only
to the client that began it, so the company brokers on the host (which share the helper's other token)
never see the vault's members' sign-ins, nor it theirs. Every new company shares that helper; its config
takes `signInLimit` (default 6) and `signInCompanyLimit` (default 2, at most the total), each 1–64. Raise
them only with the helper unit's memory, task and CPU limits, once a real sign-in is measured.

Prerequisites on each host: the broker build and the CA file
(`/etc/qorpera-secret-broker/supabase-prod-ca-2021.crt`); the `qorpera-shared-vault` user and group
(`useradd --system --no-create-home --shell /usr/sbin/nologin qorpera-shared-vault`); the login helper
reinstalled from this build **first** (an older helper refuses a config with the new limit keys and a
vault token, and stops for every broker on the host); a host without a helper installs it as in
"Installing the helper" above, its own token included (`helper-token` refuses on a host without one).
Reinstalling node 1's helper restarts it: renewals in flight finish (its stop waits up to 40 s), but a
member in the middle of a sign-in has to start again, so pick a moment with none pending (no
`qorpera_native_provider_login_sessions` row with status `pending` and `expires_at` in the future).

Node 1:

1. Install the package, the unit at `/etc/systemd/system/qorpera-shared-vault.service` and the script at
   `/opt/qorpera-secret-broker/shared-vault-secrets.py` (root, 0500).
2. `python3 -I /opt/qorpera-secret-broker/shared-vault-secrets.py generate --key-id vault-root-1`. It prints
   the key id, `principalCapabilitySha256` (for the principal row; with the broker's database login it is
   the principal's proof, so keep it out of pages and PRs) and fingerprints; it never overwrites.
3. Copy the company brokers' files on the host, for example
   `install -m 0400 -o root -g root <a company broker's database-url> /etc/qorpera-shared-vault/database-url`,
   and the same for `runtime`, the connectors credential (as `connectors.json`) and the coding executor
   token (as `coding-executor`). Then `shared-vault-secrets.py fingerprint`: keep its `fingerprintsSha256`
   for node 2.
4. `shared-vault-secrets.py helper-token`. Only then (systemd refuses to start a unit whose credential
   file is missing, which would stop the helper for every broker on the host) the helper's drop-in
   `/etc/systemd/system/qorpera-model-login-helper.service.d/vault-token.conf`, `systemctl daemon-reload`,
   and a helper restart (like its reinstall, at a moment with no sign-in pending):

   ```ini
   [Service]
   LoadCredential=qorpera-model-login-helper-vault-token:/etc/qorpera-model-login-helper/vault-token
   ```
5. `config.json`: `{"schema": "qorpera.cloud-secret-broker-service/v3", "principalId": "<a new uuid>",
   "port": 18660, "memberOrigins": ["https://app.qorpera.com"]}` (any free loopback port; 18660 below).
6. nginx, before the vault starts: every map that picks a company's broker sends a company it has no line
   for to the vault. Every existing company keeps an explicit line; a company that rides on a map's
   fallback today (the acceptance company) gets its own line first.
   Regex keys hold `{}`, so each stays quoted (Step 7 doc); nginx tries exact keys first and regex keys in
   order.
   - `?company=` maps (`$qorpera_capture_broker` for captures and connector sign-in start and confirm;
     `$qorpera_email_draft_broker` for email drafts (node 1 routes them with a map of their own);
     `$qorpera_operations_broker` for `/v1/operations`, `/v1/repository-credentials`,
     `/v1/coding-environment`, `/v1/coding-mcp` and `/v1/coding-repository-fetch/{refs,upload-pack}`;
     `$qorpera_model_login_run_broker` for runs' `/v1/model-logins`):
     `"~(^|&)company=[0-9a-fA-F-]{36}(&|$)" 127.0.0.1:18660;`. Keep any `""` line that routes requests
     without `company=` where they go today.
   - `$qorpera_model_login_broker` (vault sign-in and account refresh, by path):
     `"~^/v1/model-logins/[0-9a-fA-F-]{36}/(login|account-refresh)$" 127.0.0.1:18660;`.
   - `$qorpera_oauth_broker` (the connector callback): it is keyed on the bare company id that
     `$qorpera_oauth_state_company` takes from the state, so `"~^[0-9a-f-]{36}$" 127.0.0.1:18660;`. Keep
     `default "";`: a state without a valid company prefix leaves the id empty, which matches no line and
     belongs to no broker.
   `nginx -t`, then reload. Check one request per map for a company without its own line (it reaches the
   vault) and one without a company (it goes where it went before).
7. Node 2's hand-over (below), so the keys never live on one host alone once anything is sealed under them.
8. The principal row (a database write, the coordinator's):
   `insert into public.qorpera_cloud_secret_broker_principals(id, service_origin, key_id, capability_sha256,
   registers_companies_created_after) values ('<principalId>', 'https://company41-node-01.tailbb15c7.ts.net:10000',
   'vault-root-1', '<principalCapabilitySha256>', statement_timestamp());`. Every company created after this
   moment is the vault's.
9. `systemctl daemon-reload`, `systemctl enable --now qorpera-shared-vault`. Within 10 s every company
   created after the start time has an authority row with this `principal_id` and a sign-in switch row.
   At start the unit logs its connectors line; after that, each `Shared vault:` line names a fact (a
   refused registration, a missing key, a failed pass).
10. Acceptance: a test company created after the start time; an owner connects a connector, a member signs
    in to Codex from the web client, usage shows, and one agent run uses the vault login. Nobody handles a
    login or a secret.

Node 2 baseline (before its standby steps). In September 2026 the company brokers and the login helper
run on node 1 only, so node 2 first gets the rest of a vault host, from the same release as node 1. Each
command runs as a plain argv (no shell needed):

1. Accounts: `qorpera-login-helper` and `qorpera-shared-vault` system users and groups (no home, no login
   shell).
2. Folders: `install -d -o root -g root -m 0755 /opt/qorpera-model-login-helper` (the helper's user must
   enter it) and `install -d -o root -g root -m 0700 /etc/qorpera-model-login-helper`.
3. Codex: copy node 1's `/opt/qorpera-model-login-helper/codex` host to host (no new download; the binary
   is public and its hash is the check, so any copy path will do), check its SHA-256 equals node 1's helper
   config `codexSha256`, and install it root-owned 0555 at the same path.
4. Isolation: root-owned `/usr/bin/bwrap` (0.8 or later) and `/usr/bin/node` (the version node 1 runs),
   and unprivileged user namespaces allowed for bubblewrap as on node 1. The helper checks bubblewrap,
   the namespaces, Codex, the isolation child, its config and its token at start; it does not check the
   Node version.
5. The helper from the release (`node scripts/package-model-login-helper.mjs --out <dir>`, its
   `manifest.json` lists each file's SHA-256): `qorpera-model-login-helper.mjs` and
   `qorpera-native-isolation-child.mjs` to `/opt/qorpera-model-login-helper/` (root, 0444), the unit to
   `/etc/systemd/system/`.
6. The helper's config: node 1's `config.json` as is (same paths, same `codexSha256`), and a token of its
   own for company brokers, made on the host, never shown and never over an existing file, although no
   company broker runs there (the helper requires one):
   `python3 -I -c 'import base64, os; fd = os.open("/etc/qorpera-model-login-helper/token", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400); os.write(fd, base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=") + b"\n"); os.close(fd)'`.
7. `systemctl daemon-reload`, `systemctl enable --now qorpera-model-login-helper` (enabled: after a
   reboot without it, node 2's vault copy would count every idle renewal it tries as failed, which delays
   those logins' renewals on both nodes). It logs `Model login helper: sandbox self-check ok (…)` or stops
   visibly. The self-check does not reach OpenAI: watch node 2's first renewal after its vault starts.
8. The broker package from the release: `install -d -o root -g root -m 0755 /opt/qorpera-secret-broker`
   and `install -d -o root -g root -m 0755 /etc/qorpera-secret-broker`, then
   `qorpera-cloud-secret-broker-service.mjs` to `/opt/qorpera-secret-broker/` (root, 0444),
   `shared-vault-secrets.py` beside it (root, 0500), and the CA to
   `/etc/qorpera-secret-broker/supabase-prod-ca-2021.crt` (root, 0444).

Node 2 (warm standby), between node 1's steps 6 and 8:

1. The prerequisites above, the package, the unit and the script as on node 1; then `helper-token`,
   node 1 step 4's drop-in, `systemctl daemon-reload` and a helper restart on node 2 (node 2's own helper
   and token; without the drop-in node 2's helper refuses the vault, and each refusal delays that login's
   renewals on both nodes).
2. The hand-over, host to host over the two nodes' Tailscale addresses:
   1. node 2: `shared-vault-secrets.py ticket`. It keeps a one-time ticket as a root-only file (replacing an
      unused one) and prints only `ticketSha256`.
   2. node 1: a one-shot transient unit bound to node 1's address that answers node 2's only:
      `systemd-run --unit=qorpera-shared-vault-handover --collect --property=RuntimeMaxSec=180
      --property=NoNewPrivileges=yes --property=ProtectSystem=strict --property=ProtectHome=yes
      --property=PrivateTmp=yes --property=LimitCORE=0 --property=IPAddressDeny=any
      --property=IPAddressAllow=100.80.160.64 -- /usr/bin/python3 -I
      /opt/qorpera-secret-broker/shared-vault-secrets.py serve --bind 100.75.4.70 --peer 100.80.160.64
      --port 39579 --ticket-sha256 <ticketSha256> --ttl 120`.
      It reads the files as root, then serves as nobody: it closes any other address before reading a
      byte, gives a connection 5 s to ask, answers once, and stops (or stops after 120 s). It writes two
      lines to the unit's journal: `shared-vault-secrets: serving once on 100.75.4.70:39579` once the port
      is bound (start step 3 after it; an earlier fetch finds nothing and uses up the ticket), then, when
      it stops, one that repeats `fingerprintsSha256`.
   3. node 2: `shared-vault-secrets.py fetch --source 100.75.4.70 --port 39579 --expect <node 1's
      fingerprintsSha256>`. The ticket is used up either way. It checks what arrived against node 1's
      digest before writing anything and answers `"match": "match"`; a mismatch or any failure leaves
      nothing written (start again from 1, after `systemctl stop qorpera-shared-vault-handover` on node 1
      if that unit still runs: it holds the port and the unit name for up to 120 s).
3. The same `config.json` as node 1's (same principal, same port). After node 1's step 9:
   `systemctl daemon-reload`, `systemctl enable --now qorpera-shared-vault` (enabled, so the standby comes
   back after a reboot). Check the unit is active and logs no `Shared vault:` failure line after its first
   pass.
   Both copies register new companies (the same row; the loser gets the same answer) and run the
   background work (every renewal takes the login's own lock); node 1's copy serves every request.
4. Failover. Requests reach the vault only through node 1's front. If node 1's copy stops, systemd
   restarts it and node 2's keeps renewals going. If node 1 is lost, node 2 still holds both secrets and
   keeps renewing; serving requests from node 2 needs a front there with the same maps, the run hosts'
   broker address and the authorities' service origin moved to it, and the web app allowed to reach the
   new origin (its content security policy names node 1's today): part of a node 1 recovery, not built
   here. To rebuild node 1, run the hand-over the other way (ticket on node 1, serve on node 2).
5. The two secrets live on node 1 and node 2 only. Losing both nodes loses them: every vault company's
   stored secrets, connector connections and model logins can then no longer be opened, and members sign
   in and reconnect again. By founder decision (29 September 2026) there is no third copy: "if the key is
   lost on both vaults, it's lost".

## ChatGPT plan logins (Sign in with ChatGPT, built switched off)

Founder decision 2026-10-01. A member's ChatGPT Plus or Pro plan pays for the work that member starts,
through OpenAI's "Sign in with ChatGPT" (SIWC). It stays off until OpenAI approves Qorpera's partner
application; today's Codex login keeps serving our own company until then. Design note:
https://claude.ai/artifact/UWehPVysVzAmWcwvkuU6on.

- **Deploy order.** This vault build reads every vault sign-in, Codex ones included, with
  `qorpera_describe_model_login_sign_in_v2` from migration `20260928329830`. That migration must be live
  before any vault (shared or one-company) runs this build; otherwise every vault Codex sign-in fails.
  The migration alone changes nothing a member sees: plans stay off.
- **Kind.** A plan login is a second kind of vault login (`qorpera_model_logins.login_kind =
  'chatgpt_plan'`, migration `20260928329830`). It holds OpenAI's OAuth tokens: a one-hour access token
  and a rotating 30-day refresh token. The envelope's one field is `chatgpt_plan_login`. The vault is
  the only renewer, under the same renewal lock as a Codex login, and renews with OpenAI's token
  endpoint itself (no helper, no Codex). A run gets the access token alone
  (`{schema, loginKind: "chatgpt_plan", version, accessExpiresAt, accessToken}`).
- **Runs (slice 4).** The run's host writes that token to `<run root>/chatgpt-plan/access-token` (mode
  0600 in a 0700 directory, the host's own user; never a refresh token) and rewrites it in one step
  whenever the vault hands it a newer one (the same once-a-minute check as for a Codex login). The run's
  Codex home stays empty. Codex uses a provider of its own, `qorpera_chatgpt_plan`: OpenAI's API
  (`https://api.openai.com/v1`, Responses) with the token as the bearer, read by Codex's token command
  (`/bin/cat` on the file, run again each minute and after a refused request), at standard speed (Fast
  mode is a Codex login's). The sandbox binds the token directory read-only, and the run reaches
  `api.openai.com` alone (not `chatgpt.com` or `auth.openai.com`: the vault renews). The agent's tools
  never reach the host's run root, and Codex's own shell is off. A 429 on a plan run is the plan's usage
  limit (OpenAI's only 429 for plan use), which stops the work; Codex 0.155.1 reports it as a 429 it gave
  up on. OpenAI takes the host id (`ext_agent_host_id`) at sign-in only, not on each request, so runs
  send none. Coding turns run the same way.
  - Fallback: the token in the run's Codex environment at start instead (OpenAI's documented path;
    through bwrap's own environment, readable by the host's user alone, never an argument). Each run
    then starts its own Codex (no warm spare for a plan run), so the next run picks up a renewed token;
    a run that outlives its token fails at OpenAI's refusal. The orchestrators do not pass a setting for
    it to the provider hosts they start, so the supported switch is `CHATGPT_PLAN_AUTH_DEFAULT` in
    `cloud-native-provider-service-main.ts` (`"command"` to `"environment"`) and a runtime release.
    `QORPERA_CHATGPT_PLAN_AUTH` (`command` or `environment`) serves a host started by hand.
- **Sign-in.** The web client begins a plan sign-in (`qorpera_begin_chatgpt_plan_sign_in`) and polls
  `/login` as for any vault sign-in. The vault answers with OpenAI's authorization address:
  Authorization Code with PKCE, the plan scopes, the resource `https://api.openai.com/v1`, the state
  `<company>.<43 random characters>`, and the identity's host id (`ext_agent_host_id`). OpenAI sends the
  browser to the callback Edge Function `chatgpt-plan-callback` (slice 3). That function forwards the
  state and code to `POST <vault>/v1/model-logins/<company>/chatgpt-plan/callback` and returns the browser
  with a one-time confirmation id in the page fragment. Nothing is exchanged then. The web client
  confirms with the sign-in's capability through the `native-provider-login` Edge Function, which
  forwards to `POST <vault>/v1/model-logins/<company>/chatgpt-plan/confirm`. Only then does the vault
  exchange the code, check the ID token against OpenAI's keys (signature, issuer, audience, expiry,
  nonce) and that plan use was granted, seal the login and complete the sign-in. A browser that did not
  start the sign-in never completes it.
- **Renewal.** A run renews a plan login past half its pass. Idle upkeep renews one only once its tokens
  are 7 days old, to keep the refresh token alive. Neither renews before OpenAI's `earliest_refresh_at`.
  A refused refresh (`invalid_grant`, `invalid_refresh_token`, `token_expired`, `refresh_token_expired`,
  `refresh_token_invalidated`, `refresh_token_reused`) marks the login for a new sign-in, and so does an
  answer after which the old refresh token is gone but the vault cannot keep the new one: plan use
  withdrawn (no `chatgpt.tokens.use.direct`), an ID token for another account or one that fails its
  checks, a 200 it cannot read, or a pass not later than the saved one. The vault then ends the new
  refresh token at OpenAI. A refresh answer without a new refresh token keeps the old one (RFC 6749 6
  allows it). A code exchange OpenAI answered but the vault refuses (no plan use, an ID token failing its
  checks) ends that answer's refresh token at OpenAI too; OpenAI's keys are loaded before the one-time
  code is spent.
  `invalid_client` never marks a login: that error is about our registration, not the member's login.
  Two cases stay `transient` and are retried with the capped backoff, logged with their reason, until
  someone acts: a login made under another client id (`client_changed`, after the registration changed:
  those logins need a new sign-in, marked by hand for now), and any refusal code OpenAI has not
  documented (`refresh_rejected`; add the code to the refused list once it is known).
- **Confirmation time budget.** Each hop waits longer than the one behind it, so the member never sees a
  failure for a login the vault saved: the vault's confirm route 30 s (the code exchange 15 s, the save
  8 s, a re-read after a lost save answer 4 s; ending an unsaved login at OpenAI waits for nobody), the
  `native-provider-login` Edge Function's `…/chatgpt-plan-confirm` 40 s (its gateway lookup, at most
  5 s, comes first), the web client 45 s, the front's read timeout 60 s.
- **Sign-ins in flight.** A plan sign-in between its first poll and its confirmation lives only in the
  memory of the vault copy that serves it (at most 32 per company). A restart or a failover drops them:
  the member's callback then answers `state_unknown` and the member starts again. Restart the vault at a
  moment with no plan sign-in pending, as for the helper.
- **Ending.** Once a plan login's capsule, every version that points at it, or their connections are
  revoked (the member disconnected or left), each upkeep pass ends it at OpenAI (token revocation)
  and marks it revoked. A disabled connection keeps its login.
- **Configuration (after approval only).** Qorpera's client registration is the private credential
  `qorpera-cloud-secret-chatgpt-plan`:
  `{"schema":"qorpera.chatgpt-plan-client/v1","clientId":"oaiapp_…","clientSecret":"…" or null,
  "redirectUri":"https://<project>.supabase.co/functions/v1/chatgpt-plan-callback"}`. The secret is
  sent only in the token request's Basic header (client id and secret form-encoded, RFC 6749 2.3.1).
  - Who installs it: the founder, who holds OpenAI's partner console, writes the file on each vault
    host directly (node 1 and node 2: node 2's copy renews too), for example by pasting it over SSH into
    `install -m 0400 -o root -g root /dev/stdin /etc/qorpera-shared-vault/chatgpt-plan.json`. It never
    passes through a chat, a session or the coordinator; the coordinator compares only the two hosts'
    `sha256sum` of the file.
  - Check the file before the drop-in: `jq -e '.schema == "qorpera.chatgpt-plan-client/v1" and
    (.clientId | startswith("oaiapp_")) and (.redirectUri | startswith("https://"))'` (prints nothing
    secret). A file the vault cannot parse does not stop it: it logs `Cloud secret broker: the ChatGPT
    plan credential is invalid; ChatGPT plan sign-ins stay off.` and serves on without plans. An empty,
    oversized or unsafe file (wrong owner or mode) still stops the unit, as for every credential.
  - Then the drop-in, `LoadCredential=qorpera-cloud-secret-chatgpt-plan:/etc/qorpera-shared-vault/chatgpt-plan.json`,
    `systemctl daemon-reload` and a vault restart. The unit stays as it is until then: a LoadCredential
    line for a missing file would stop the unit.
  - Without the credential the vault starts no plan sign-in and renews or ends no plan login, and logs
    nothing about plans. With it, it logs `Cloud secret broker serves ChatGPT plan sign-ins.` once.
  - A one-company broker serves plan sign-ins for its company only with the same file in its own unit
    (`/etc/qorpera-secret-broker/chatgpt-plan.json`, the same drop-in line pointing there) and with its
    company's line in the front map below. Switch such a company on only after both are in place.
- **Front routing.** The path map `$qorpera_model_login_broker` must also send the two plan routes to
  the vault:
  `"~^/v1/model-logins/[0-9a-fA-F-]{36}/(login|account-refresh|chatgpt-plan/callback|chatgpt-plan/confirm)$" 127.0.0.1:18660;`,
  with the same `location` widened to match. A company on a one-company broker needs the same widening
  on its own line. The vault host needs outbound HTTPS to `auth.openai.com` (discovery, signing keys,
  token and revocation endpoints). The vault requires `revocation_endpoint` in OpenAI's discovery
  document: without it, plan sign-ins and renewals stop (retried as `transient`), not only revocation.
- **Callback Edge Function (slice 3).** `supabase functions deploy chatgpt-plan-callback`
  (`verify_jwt = false`: OpenAI sends the browser without a JWT). The address OpenAI registers is
  `https://<project>.supabase.co/functions/v1/chatgpt-plan-callback`, the same as the credential's
  `redirectUri`. It asks `qorpera_chatgpt_plan_callback_target(state)` with the service role, forwards
  `{state, code, error, clientId}` to the company's vault, and returns the browser with
  `#?chatgpt_plan=confirm&confirmation=…` or `#?chatgpt_plan=failed&reason=…` after the return page.
  The return page is `QORPERA_CHATGPT_PLAN_RETURN_URL` (optional, and empty counts as unset: an HTTPS
  page of one of `QORPERA_WEB_ORIGINS`, else that list's first origin; no query, no credentials, no `?`
  in its fragment, or the function does not start). It forwards only to the vault route of the state's
  own company, gives the vault 20 s, reads at most 16 KB of its answer, and answers only GET. It never
  exchanges a code and never sees a token. The web client's confirmation goes through
  `native-provider-login` at `…/chatgpt-plan-confirm`, which the login chooser routes to the same vault
  and which waits 40 s for it (see the confirmation time budget above; redeploy that function too).
  Smoke check after deploy, which must show a 303 back to the return page with `reason=state_unknown`:
  `curl -s -o /dev/null -D - 'https://<project>.supabase.co/functions/v1/chatgpt-plan-callback?state=x' | grep -i '^location'`
  (a GET: the function answers anything else with 405).
- **Switches.** `update public.qorpera_chatgpt_plan_settings set enabled = true;` (platform) and
  `select public.qorpera_set_chatgpt_plan_company('<company>', true);` (service role; only for a company
  whose sign-ins go to its vault). Both start off.
- **Before the platform switch goes on:** the vault runs this slice, the credential and the routing
  above are in place, the callback Edge Function is deployed with OpenAI's registered address, every
  provider host runs slice 4, a usage limit stops the run instead of moving it to another login (#601,
  migration `20260928349910`, live), the plan rules (#614, slice 1b) are live, and company deletion ends plan
  logins at OpenAI (slice 1c, migration `20260928359960`; see RUNTIME-COMPANY-DELETE.md; it relies on #614,
  which keeps a plan sign-in from completing for a company being deleted).
- **First real sign-in (one company, the founder's own plan).** The fake OpenAI in the tests cannot prove
  what only OpenAI's endpoint answers. With one company switched on, sign in once and renew once, and
  check from the vault's journal and the login's row (never its envelope):
  - the code exchange succeeds: our Basic encoding and redirect address are accepted (a failure logs
    `ChatGPT plan sign-in: the code exchange failed (<reason>)`, where the reason is OpenAI's status and
    error code, or one of `token answer unreadable`, `token plan scope not granted`, `token answer
    unusable`, `ID token refused`, `signing key unknown`, `discovery unusable`, `OpenAI unreachable`);
  - discovery lists `revocation_endpoint`, and disconnecting a test login ends it at OpenAI;
  - a renewal succeeds and its answer keeps the plan scope, whether or not it repeats `scope` or sends
    an `id_token`; the renewed login keeps its owner (the access token's `sub` equals the ID token's);
  - `renew_not_before` on the row lies within the hour after the renewal (OpenAI's `earliest_refresh_at`
    read in the right unit; the vault drops a value outside the pass);
  - two members of one company never connect the same ChatGPT account unnoticed:
    `provider_account_reference` holds `openai-subject:<sha256 of OpenAI's subject>`;
  - one run on the plan completes: OpenAI accepts the token as the bearer on `/v1/responses` with no other
    header, and Codex's start (its model list) works with it;
  - a run that lasts past a renewal keeps working: the token the host renamed into the bound directory
    is the one Codex's next token command reads;
  - the usage limit: when the plan's limit is reached, the run's card says so. If it says the run was
    stopped by a provider step instead, Codex did not recognise OpenAI's code (a limit reached mid-answer
    arrives as `subscription_sharing_usage_limit_exceeded` in the stream, which Codex 0.155.1 retries
    and then reports as a lost stream): the follow-up is a pinned Codex that names it a usage limit.

## Failure cases

| Case | Result |
|---|---|
| Node dies mid-run | Nothing lost; the pass ends by itself; the run is retried elsewhere. |
| Helper dies before asking the provider | The lock expires after 5 minutes; the next caller renews. |
| Helper dies after the provider answered, before the commit | The stored renewal token is used up; the next renewal is refused and the login asks for a new sign-in. Passes already handed out work until they end. |
| Commit fails three times | Lock released as `renewal_unsaved`, permanent: the login asks for a new sign-in; this run keeps the new pass. |
| One broker copy down | A company broker: the other node's copy serves runs (the vault must run on both nodes before any login moves). The shared vault: systemd restarts node 1's copy; node 2's keeps renewing but serves no requests (see its failover). |
| Provider refuses a renewal | `needs_sign_in`; the vault refuses new runs on the login (they fail at the credential download) until the member signs in again (change 2B). Runs already going keep their pass until it ends. |
| Member signs out or leaves | The pointer capsule and lease checks refuse at once; running work is stopped by the existing checks. |

## Moving and retiring

- Each login moves by signing in again (test company first; company Qorpera after the "who pays"
  work and the founder's go), then the member's old node account is removed: the identity counts
  as in the vault only once no node login of it is active. The old path serves a login until then.
  The vault switches it off by itself (founder decision 2026-09-28, migration `20260928243500`),
  in its upkeep pass every 5 minutes:
  - The broker records the ChatGPT account of each vault login it keeps
    (`qorpera_model_logins_without_account`, `qorpera_record_model_login_account`: sha256 of
    `openai-account:` + `account_id`, the digest nodes and the vault record for usage).
  - While the company takes sign-ins in the vault, `qorpera_switch_off_replaced_node_logins` finds each
    active node Codex connection of the same member that is older than the member's vault connection
    and whose current login (the node capsule its latest version uses) was recorded as the same account;
    a record of an earlier login of the connection never counts (at most 4 per pass).
    Since `20260930059000` (the payer never changes without the member) it finds an older vault
    connection the same way: one whose current vault login (active, or needing a new sign-in) is of the
    same kind (Codex or ChatGPT plan) and was recorded as the same account. Every sign-in makes a new
    connection, so this is how a member who signs in to the vault again keeps their conversations,
    follow-up work and routines: their pins follow to the same account's new login. A ChatGPT plan
    login's account is recorded too: sha256 of `openai-subject:` + OpenAI's verified subject, a
    namespace of its own, so it pairs only with another plan login of the same person (the broker's
    `recordAccounts` reads it from the plan envelope; the secret broker needs that build). A login that
    needs a new sign-in before its account was read is still listed for it, so it can be paired.
  - It moves the member's pins to the vault connection first (`qorpera_move_member_login_pins`, #450:
    routines, coding sessions and agent work follow).
  - Once no queued or leased job, live lease, queued wake, queued turn or queued change review names
    the old login, it makes the same updates as the member's Disconnect (the connection, its native
    capsules and versions, its live leases). A refused move (busy, the vault login not usable or not
    consented), remaining work or a row held longer than 2 s waits for the next pass.
  - Another account, another member, a Claude login, a node login newer than the vault login and a
    company switched back to node sign-ins are never touched. Locks: rows only; the move and the old
    connection row are taken without waiting, the rows Disconnect updates wait at most 2 s.
  - A node login whose account no node has read yet is not matched; the member can still remove it in
    Settings.
- After every active login has run from the vault for a week, retire in separate changes: the home
  rule in placement and claim, exec-host identity devices and inventory `identityVolumes`, the login
  and refresh machines for Codex, login key backups and recovery, then the volumes (renamed
  `retired-identity-<uuid>`, deleted after 14 days).
