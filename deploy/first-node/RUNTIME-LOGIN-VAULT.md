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
- `POST /v1/model-logins?company=<profile>` under the runtime token, body
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
    at most 6 run at once, 2 per company. The binding is a consistency check: the brokers on one
    host share the helper's token (one broker per host today; give each its own token before a
    helper serves several companies). Codex stops after 10 minutes at the latest;
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
    after three refused lookups in a row (`42501` or `22023`: the company was switched back or its
    broker authority changed meanwhile; an outage or a timeout is no refusal). An ended
    sign-in is never started again by a late poll. The recovery
    pin still fences a recovering identity, but asks no node key backup of a sign-in that created a
    vault login. A repeat after a lost answer finds its own login.
  - Deploy: the broker's public front must route `POST /v1/model-logins/<company>/login` to that
    company's broker by path (the edge function adds no query). The helper must run beside the
    broker (without it the route answers 404). A helper restart ends sign-ins in flight; the member
    signs in again.
- **Part C, usage** (next): usage reads for vault logins in the vault (the existing `wham/usage`
  call with the pass, no machine), and the account refresh chooser sending those identities to the
  vault. Until then (with change 3) a node's usage check lists vault logins and skips them; switch
  no company before Part C lands.

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

## Runs (change 3, migration `20260928161000`)

- The native host asks `/v1/model-logins` at run start instead of opening a capsule, writes the copy
  as `codex/auth.json` in the run's private root, asks again every minute once the pass is past half
  its life, and replaces the file atomically (temporary file and rename in the same directory) when a
  newer version arrives. It never uploads. Warm roots keep the copy and re-ask at the next run.
- The shared execution service and one-run guests skip the identity volume, master key and epoch
  credential for vault logins.
- Placement and claim skip the identity home rule for a run whose capsule is a vault pointer.

## Failure cases

| Case | Result |
|---|---|
| Node dies mid-run | Nothing lost; the pass ends by itself; the run is retried elsewhere. |
| Helper dies before asking the provider | The lock expires after 5 minutes; the next caller renews. |
| Helper dies after the provider answered, before the commit | The stored renewal token is used up; the next renewal is refused and the login asks for a new sign-in. Passes already handed out work until they end. |
| Commit fails three times | Lock released as `renewal_unsaved`, permanent: the login asks for a new sign-in; this run keeps the new pass. |
| One broker copy down | The other node's copy serves runs (the vault runs on both nodes from change 3). |
| Provider refuses a renewal | `needs_sign_in`; new runs on the login stop. Today every refusal of the route is the same 403; change 3 lets the host tell "sign in again" from an outage. |
| Member signs out or leaves | The pointer capsule and lease checks refuse at once; running work is stopped by the existing checks. |

## Moving and retiring

- Each login moves by signing in again (test company first; company Qorpera after the "who pays"
  work and the founder's go), then the member's old node account is removed: the identity counts
  as in the vault only once no node login of it is active. The old path serves a login until then.
- After every active login has run from the vault for a week, retire in separate changes: the home
  rule in placement and claim, exec-host identity devices and inventory `identityVolumes`, the login
  and refresh machines for Codex, login key backups and recovery, then the volumes (renamed
  `retired-identity-<uuid>`, deleted after 14 days).
