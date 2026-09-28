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
    without locks (exact binding; job leased and unexpired; assignment accepted and unexpired; lease
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
  - `qorpera_release_model_login_renewal(…, token, permanent, reason)`: gives the lock back and
    records the failure time; a permanent failure sets `needs_sign_in` (a revoked login stays
    revoked).
- Locks: the login row only, for one short statement. No company row, fence or authority row is
  locked for update (a saved version's foreign key takes a key-share lock on its authority); the
  run's host keeps validating its lease with the company fence every 15 s, as today.

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

- A separate unit beside each broker (the broker unit's `RestrictNamespaces=yes`, `MemoryMax=256M`,
  `TasksMax=32` cannot host Codex). It runs the pinned official Codex release binary (unmodified,
  single static binary, SHA-256 pinned) per operation in a private tmpfs `CODEX_HOME`, with the
  existing bubblewrap launcher and an egress relay limited to `auth.openai.com` and `chatgpt.com`.
- Operations: sign-in (`codex login --device-auth`, the same prompt scraping as today), renewal
  (`app-server` + `account/read {refreshToken: true}`, success = `auth.json` changed), usage (the
  existing `wham/usage` read with the pass, from the vault, no machine).
- Sign-in keeps the web client unchanged: the vault answers the node login gateway's `/login`
  protocol, and the gateway chooser returns the vault for companies switched to the vault.

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
  work and the founder's go). The old path serves a login until then.
- After every active login has run from the vault for a week, retire in separate changes: the home
  rule in placement and claim, exec-host identity devices and inventory `identityVolumes`, the login
  and refresh machines for Codex, login key backups and recovery, then the volumes (renamed
  `retired-identity-<uuid>`, deleted after 14 days).
