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
- **Part B, sign-in and usage** (next): sign-in (`codex login --device-auth`, the same prompt
  scraping as today) answering the node login gateway's `/login` protocol so the web client is
  unchanged, and usage reads (the existing `wham/usage` call with the pass, from the vault, no
  machine).

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
6. Before rollout, prove one real renewal on the vault host (a test login): the unit's system-call
   filter and the sandbox are only proven there. A renewal that cannot start Codex records
   `codex_launch_failed`, and a binary changed since start records `codex_changed` and restarts the
   helper.

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
  (binding = its lease, run, job, runner, assignment, capsule and identity) instead of opening a
  capsule, refuses a copy that carries a renewal token, writes the copy as `codex/auth.json` in the
  run's private root (staged beside the Codex home, which must hold `auth.json` alone, then renamed
  into it), asks again every minute with the version it holds, and swaps the file whenever the vault
  answers with a copy. It never uploads a login; the lease is still validated at the start, every
  15 s and at the end. A warm root keeps its vault version and asks for the current one at the next
  run. The account usage list accepts vault logins and the host skips them (the vault reads usage,
  change 2B).
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
- Deploy order: free. A database without the check answers 404, and the orchestrator, exec host and
  LXD provider then keep the node path, as before.
- Activation: move no login into the vault until every node's orchestrator, exec host and guest
  image carry this change. Before that, `qorpera_compute_identity_login_in_vault` is false for every
  identity and nothing changes.

## Failure cases

| Case | Result |
|---|---|
| Node dies mid-run | Nothing lost; the pass ends by itself; the run is retried elsewhere. |
| Helper dies before asking the provider | The lock expires after 5 minutes; the next caller renews. |
| Helper dies after the provider answered, before the commit | The stored renewal token is used up; the next renewal is refused and the login asks for a new sign-in. Passes already handed out work until they end. |
| Commit fails three times | Lock released as `renewal_unsaved`, permanent: the login asks for a new sign-in; this run keeps the new pass. |
| One broker copy down | The other node's copy serves runs (the vault must run on both nodes before any login moves). |
| Provider refuses a renewal | `needs_sign_in`; the vault refuses new runs on the login (they fail at the credential download) until the member signs in again (change 2B). Runs already going keep their pass until it ends. |
| Member signs out or leaves | The pointer capsule and lease checks refuse at once; running work is stopped by the existing checks. |

## Moving and retiring

- Each login moves by signing in again (test company first; company Qorpera after the "who pays"
  work and the founder's go). The old path serves a login until then.
- After every active login has run from the vault for a week, retire in separate changes: the home
  rule in placement and claim, exec-host identity devices and inventory `identityVolumes`, the login
  and refresh machines for Codex, login key backups and recovery, then the volumes (renamed
  `retired-identity-<uuid>`, deleted after 14 days).
