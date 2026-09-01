# Runtime Step 7 — Cloud connector execution

Date: 2026-08-28. Independent component handoff. **Components are implemented and locally verified; deployed Step 7 acceptance is not established.**

Worktree: `/Users/jonas/.codex/worktrees/90f2/Qorpera_Base-step2`.
The new components are not registered in the application or native host. The existing cloud authority, vault, governed installation reader and interaction transaction adapters must be supplied before enabling them. Missing adapters fail closed.

No other session was contacted or created. No agents, automations, browser, real account linking, provider API calls, paid tokens, production access, migrations, deployments, credential operations, commits, pushes or merges were used. Reference worktrees were read only. Public GitHub documentation was consulted; HTTP execution tests used synthetic credentials and controlled loopback endpoints. No skills were loaded.

## Baseline and reference integrity

`deploy/first-node/RUNTIME-STEP-7-BASELINE.json` records revisions, original working-tree status and 113 relevant file hashes, captured before implementation at `2026-08-28T16:32:42.528705+00:00`. Working-file hashes matter because the contract and Step 4 deliverables include uncommitted files.

| Reference | Starting HEAD | Path |
| --- | --- | --- |
| Assigned worktree, initially clean | `a0b692947d5c867353591b36172afcc997f0521e` | `/Users/jonas/.codex/worktrees/90f2/Qorpera_Base-step2` |
| Runtime contract | `18181de7f2698c9f44347a7ee141eebead84bc35` | `/Users/jonas/.codex/worktrees/27d4/Qorpera_Base-step2` |
| Main runtime, initially clean | `a20dd1ef0dbdcce31166789053b2d7bb5ab2a929` | `/private/tmp/qorpera-step2-resume.rN3rbf/source` |
| Step 4 handoff | `a0b692947d5c867353591b36172afcc997f0521e` | `/Users/jonas/.codex/worktrees/5ced/Qorpera_Base-step2` |

At the `2026-08-28T17:18:00.563Z` reference audit, the main reference had advanced independently to `c86ad187009181a2b54066dc0bf78f163f2430da`; **all 113 recorded file hashes still matched**, including the native interfaces used by the compatibility probe. The other three HEADs matched their baselines. This worktree's existing tracked files are unchanged.

Baseline working-file SHA-256 values:

| Reference file | SHA-256 |
| --- | --- |
| Runtime contract `QORPERA-RUNTIME-CONTRACT.md` | `f6c9836df26c313bab133b6d77465749ecb14b023e6b71f44fb850a25d919ede` |
| Step 4 `deploy/first-node/RUNTIME-STEP-4-COMPUTERS-SCREENS.md` | `520c57372f2a66ac89a1695a0acb8034e42cbb260f5ec7f80b1abae70f902da0` |
| Main `cloud-native-tool-authority.ts` | `05a5a7b8f58b4f2808903bd2f01e3c04b806fd06682d4ea1ff6f199158b03185` |
| Main `cloud-native-tool-operations.ts` | `a8878a3f5e85433ac8666045c74ab8157efc44e1a119b317437ae93278cbe4ac` |
| Main `cloud-native-tool-boundary.ts` | `d2286a2444ea56b2afb782a0ffc3064eeaaf9ea7ef8633510cc0d845da81f5cb` |
| Main `cloud-native-run-tool-session.ts` | `e0c28f67deb4b3fb635f86d1a40089e0c1b259921d2c5cc8b5cd39dd6c3e8302` |

The four main TypeScript files above are under `packages/shell/src`. Recheck their interfaces when integrating; a baseline revision is not permission to overwrite later runtime work.

The reassessment-fix audit at `2026-08-28T18:24:23.919Z` matched **112 of 113** original file hashes. The Step 4 handoff had changed independently to SHA-256 `db1bb63039384142dd8c113edb74254872da80753602fb05f8b99083ccfb3a17`; its current contents were reread. All recorded native interfaces and other reference files still match. Reference HEADs are unchanged from the earlier audit, and this worktree's existing tracked files remain unchanged. The original baseline is preserved.

The cancelled-read fix audit at `2026-08-28T18:54:03.699Z` again matched **112 of 113** hashes, with only that same Step 4 handoff difference. The main reference had independently advanced to `b2b7215a660807dfbcde628cdfeca6b4d2423489`; all recorded native interfaces remain unchanged. Other reference HEADs and this worktree's existing tracked files are unchanged. A temporary snapshot of this follow-up's eight edited delivery files was taken before edits at `2026-08-28T18:44:57.970Z`; the original baseline was not rewritten.

The managed-user owner fix audit at `2026-08-28T19:13:15.274Z` also matched **112 of 113** original hashes, with only the previously recorded Step 4 handoff difference. Reference HEADs and all 113 working-file hashes are unchanged since this follow-up began. Its six edited delivery files were snapshotted before edits at `2026-08-28T19:10:12.106Z`. Existing tracked files and the original baseline remain unchanged.

## Audit, reuse and obsolete assumptions

| Audited area | Existing behavior | Step 7 disposition |
| --- | --- | --- |
| `packages/company/src/company-connectors.ts` and coding-agent re-exports | `qorpera.connector/v1`, local playbook/company-tool implementations, host and secret-name declarations, maintainer `ownerAgentId`. | Unchanged here; not accepted as a cloud installation, credential-owner grant or executable cloud adapter. New manifests are versioned, matched exactly to compiled implementations and read through governed Company File state. |
| `packages/coding-agent/src/core/tools/run-connector.ts` and `connector-runtime-contract.ts` | Local company-tool subprocess dispatch and stdout HTTP broker frames. | Not reused as an execution path. The new `run_connector` is a native cloud RPC tool; no subprocess, desktop or unrestricted HTTP fallback. Do not register both implementations under the same tool name. |
| `connector-execution-authorization.ts` | Local installed-file hash, destination/secret declarations and a completed connection request used as execution grant. | Retain the useful principle of exact code/destination checks. Replace the local authorization assumption with required live run, owner, grant, resource, audience and receipt checks. |
| `github-company-connector.ts`, `github-connection.ts` | Generic `api.get`; local materialization; API/upload/raw hosts; desktop `gh auth` and the active local account. | Two compiled REST operations on `https://api.github.com` only. No `gh`, ambient account discovery, anonymous fallback, upload/raw hosts, login flow or account substitution. |
| `connection-requests.ts`, `company-connections.ts`, `request-connection.ts`, `company-connection-storage.ts` | Local user-data records, physical company root/inode binding, transcript reconstruction, statuses such as connecting/connected/failed/cancelled. | These are not multiplayer cloud approval evidence. The connector lifecycle uses the existing authenticated cloud transaction/journal through an explicit adapter; no transcript reconstruction or local state store. |
| `company-secret-vault.ts`, `local-company-secret-store.ts` | Local secret resolution and a process-wide store registration; company/name addressing and OAuth refresh mechanisms. | Do not reuse their local/global ownership assumptions. A required vault bridge resolves one opaque, versioned, run-bound credential handle for the named member/company account. No new vault implementation or secret persistence. |
| `http-request-broker.ts` | Generic requests and file transfer, buffered response handling, optional receipts and an idempotency header. | Do not expose it to the cloud model. The new RPC streams bounded responses, rejects redirects, redacts failures and uses the existing durable operation ledger. A header does not establish provider idempotency. |
| Main native authority/operations/boundary/session and native-authority SQL | Admitted full identity, live authority checks, durable begin/complete adapters, logical operation keys, replay fencing and untrusted result envelopes. | Reuse these exact interfaces; no new production ledger, runner or native-provider implementation. Tests include the current main classes through a temporary compatibility probe. |
| Step 4 computer/sign-in handoff | Explicit browser-profile grants and a private sign-in handoff that drains automation/viewing before secret entry. | Connector failure grants no browser authority. Any later sign-in interaction must use that existing handoff and its privacy barrier, without returning credentials to this connector's model interface. |

A skill remains a procedure, a connector is authenticated RPC, and a plugin is an installed capability bundle. This implementation does not load skills as connectors, execute plugin code from Company File, or provide a marketplace.

## Changed-file manifest

All 13 files below are new. No existing source, changelog, shared native-provider/mouth/context/sandbox/runner/gateway/vault/authority implementation, package metadata or lockfile was modified.

| File | Purpose |
| --- | --- |
| `packages/shell/src/cloud-connector-contract.ts` | Structural native interfaces; versioned connector, installation, account, credential, authority and typed outcome contracts; bounded JSON and result-size accounting. |
| `packages/shell/src/cloud-connector-catalog.ts` | Governed installation validation, immutable account/manifest snapshots, compiled adapter registry, closed model schemas and destination checks. |
| `packages/shell/src/cloud-connector-github.ts` | Exercised issue read/comment adapter, actual module-byte pin, request preparation, selective response projection and provider status classification. |
| `packages/shell/src/cloud-connector-http.ts` | Bounded cancellable RPC, one-use credential callback, final dispatch/release checks, streaming limits and credential redaction. |
| `packages/shell/src/cloud-connector-tools.ts` | Run-bound `run_connector`, existing receipt integration, uncertain-effect fence, provenance and cached-result read-set checks. |
| `packages/shell/src/cloud-connector-authorization.ts` | Connector-specific request/result lifecycle and safe typed interaction projection over required authenticated transaction hooks. |
| `packages/shell/test/fixtures/cloud-connector.ts` | Synthetic account/authority/vault, test-only receipt ledger with native run cancellation semantics, realistic GitHub payloads and actual loopback HTTP server. |
| `packages/shell/test/cloud-connector-catalog.test.ts` | Manifest/hash/schema drift, ownership, destination escapes, closed arguments and JSON bounds. |
| `packages/shell/test/cloud-connector-execution.test.ts` | RPC, cancellation, stalls, redaction, revocation, duplicate/recovered receipts, uncertain writes and result budgets. |
| `packages/shell/test/cloud-connector-authorization.test.ts` | Authenticated lifecycle, stale/wrong-member/duplicate responses, corruption, expiry and transactional rollback. |
| `deploy/first-node/RUNTIME-STEP-7-BASELINE.json` | Initial reference revisions, working-file hashes and status. |
| `deploy/first-node/RUNTIME-STEP-7-CLOUD-CONNECTORS.md` | This handoff. |
| `deploy/first-node/RUNTIME-STEP-7-FILES.sha256` | Final hashes for the other 12 files, including this handoff; excludes itself. |

Verify the delivered hashes from the worktree root with `shasum -a 256 -c deploy/first-node/RUNTIME-STEP-7-FILES.sha256`.

## Connector and credential contracts

### Governed definition and pinned account

`CloudConnectorCatalog` accepts host-resolved `{ installation, account }` registrations and explicitly supplied compiled adapters. It does not scan a local directory, install anything, or import Company File code. There is at most one pinned account per connector in a run and at most 16 connectors/16 operations per adapter.

An installation contains its company, governed object identity (`companyFileId`, `objectId`, `objectVersion`, `logicalPath`, `ownerPrincipalId`, `policyClass`), exact manifest and enabled operation subset. The logical path is `connectors/<connectorId>/manifest.json`; it is not a local executable path. The Company File adapter must establish that this is the current authorized object, not merely a structurally valid object.

Manifest schema is `qorpera.cloud-connector/v1`, with connector/operation/implementation versions, implementation SHA-256, HTTPS origins, authentication surface, read/write/effect classification, permission, approval class, receipt policy, retry/reconciliation policy and response/time limits. The installed manifest must equal the compiled adapter's manifest. Changed destinations, schemas, classifications, versions or hashes are refused.

The GitHub adapter hashes the bytes of its executing module. The deployment owner must generate the governed installation manifest from that same shipped artifact. A source `.ts` hash cannot be reused for different bundled/compiled bytes. The separately admitted `runtimeBundleVersion` must pin the surrounding RPC/catalog/authority code; the adapter hash alone does not do that. This task did not build a release artifact.

`ConnectorAccountBinding` carries `companyId`, connection UUID/version, provider account identity, explicit `{ kind: "member" | "company", id }` owner, nullable opaque credential `{ id, version }`, and nullable grant `{ id, version, approverUserId }`. Company ownership must name the same company. Member delegation is decided by live authority; UUID syntax and an owner label are not grants. No account/owner/handle/grant selector is model-facing.

`ConnectorCredentialVault.withBearer(invocation, receipt, consume, signal)` is an adapter to the existing cloud vault boundary, not a vault implementation. It must authenticate the full run and exact handle/version, account, company/member owner and grant. Only the trusted RPC module receives the ephemeral bearer. The callback is one-use, awaited and invalid after abort/settlement. The implementation does not refresh, relink, substitute an account or persist the bearer. Provider-subscription capsules are not GitHub connector credentials.

### Model operations and concrete GitHub adapter

The model's closed input is:

```json
{
  "connectorId": "qorpera.github",
  "operationId": "issues.get",
  "logicalOperationKey": "review-issue-42",
  "input": {
    "repositoryOwner": "acme",
    "repository": "roadmap",
    "issueNumber": 42
  }
}
```

`issues.create_comment` uses the same target plus a nonempty `body`, limited to 4,096 UTF-8 bytes. The schema hints are revalidated by a closed parser on every call. No principal, credential, host, URL, method, header, arbitrary path or file selector is accepted. Repository names normalize to lowercase; path/URL escapes, secret references and recognizable GitHub tokens in write content are refused. The bound bearer and its common encodings are also checked against the prepared request before dispatch.

Repository validation accepts leading dots and hyphens, including `.github`, `.github-private` and `-tools`, with the same pattern in both operation schemas and the runtime parser. It retains the 1–100 character bound and rejects exact `.`/`..` path segments, slashes, backslashes, percent escapes, queries, fragments and trailing newlines. GitHub documents the `.github` and `.github-private` repositories for organization profiles. [GitHub organization profiles](https://docs.github.com/en/organizations/collaborating-with-groups-in-organizations/customizing-your-organizations-profile).

Owner validation accepts underscores used by GitHub.com Enterprise Managed Users, including `mona-cat_octo`, while retaining the 1–39 character bound, alphanumeric first character, lowercase normalization and path/URL escape rejection. The same pattern supplies both operation schemas and the parser. This validates URL-segment syntax, not account existence or authority; the pinned account, exact resource and live grants still control access. GitHub documents the [managed-user name format](https://docs.github.com/en/enterprise-cloud@latest/admin/managing-iam/iam-configuration-reference/username-considerations-for-external-authentication) and [repositories owned by managed users](https://docs.github.com/en/enterprise-cloud@latest/admin/managing-accounts-and-repositories/managing-repositories-in-your-enterprise/accessing-user-owned-repositories-in-your-enterprise).

| Operation | Provider request | Declared authority/effect | Success |
| --- | --- | --- | --- |
| `issues.get` | `GET /repos/{owner}/{repo}/issues/{issueNumber}` | `issues:read`, live grant, read/no external mutation | HTTP 200 with matching issue identity |
| `issues.create_comment` | `POST /repos/{owner}/{repo}/issues/{issueNumber}/comments` | `issues:write`, separate action grant, externally visible write | HTTP 201 with matching `issue_url` and comment ID |

Requests pin `X-GitHub-Api-Version: 2026-03-10`. Repository casing is not an identity change. GitHub issue endpoints also cover pull-request issue conversations; this adapter does not create review comments or restrict numbers to non-PR issues. Grant policy must account for that provider resource meaning. [GitHub issue API](https://docs.github.com/en/rest/issues/issues#get-an-issue).

Creating a comment can send notifications. Provider token permissions do not replace company grants or action approval. GitHub documents Issues write or Pull requests write access for the comment endpoint; the host must validate the selected account's actual permissions against the approved operation. No general provider idempotency/reconciliation support is assumed, and no `Idempotency-Key` header is sent. [GitHub comment API](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment).

### Bounds, outcomes and receipts

- RPC and the caller's tool wait each have a maximum 20-second deadline; the host may shorten it. Abort covers initial admission/vault waits, response headers and streamed body, including late callbacks and transports that ignore cancellation. Already-admitted native receipt work retains the native port's separate bounds and may settle after the caller stops waiting. Aborting a dispatched write cannot undo it.
- Requests use exact pinned HTTPS origins, manual redirects, no ambient cookies and no referrer. Returned redirects, changed response URLs, wrong-resource responses and credential/header overrides are refused. The injected `fetchImpl` is trusted host/test code only. Production still needs its existing TLS/egress/containment boundary.
- Response headers are limited to 16 KiB; declared and streamed response bodies to 256 KiB. UTF-8 and JSON parsing are bounded. Provider errors/headers/cookies are not returned. Known bearer values and encodings are redacted before projection/truncation; recognizable GitHub tokens are additionally scrubbed. This is not a universal DLP claim.
- Optional JSON error detail has a stricter 16 KiB/one-second inspection limit within the overall deadline. Credentials are redacted before adapter classification. Malformed, non-JSON, oversized or stalled detail keeps the definitive HTTP rejection; caller cancellation still takes precedence. Authentication and rate limits already classified from HTTP status or headers do not wait for error bodies.
- Only selected issue/comment fields become data. Body/title excerpts have 2,048/512-byte budgets measured after native escaping, with truncation flags. The complete connector content has a 5 KiB fenced-content budget. Oversized host provenance is rejected before an effect; if necessary provider data is omitted with `dataOmitted: "result_budget"`, preserving status and receipt metadata inside Step 2's 8 KiB envelope.

Outcomes use `qorpera.cloud-connector-result/v1` and separate `status`, `effect` (`none`, `applied`, `uncertain`) and `retry` (`never`, `reauthorize`, bounded `after`, `reconcile`). They are data for the existing runtime, not scheduling instructions executed here.

| Situation | Outcome policy |
| --- | --- |
| Missing credential/grant or HTTP 401 | `authentication_required` / `authentication_expired`; named-account reauthorization only. No alternate account, public request or browser fallback. |
| Authority rejection/revocation | Deny before dispatch; withhold data if revoked in flight. A dispatched write without confirmed receipt completion remains uncertain if final authority fails. |
| Denied, cancelled or timed-out replay after confirmed receipt completion | Preserve the typed denial/cancellation with `effect: "none"`; withhold cached data. The failed replay does not undo the original effect or make its completed receipt uncertain. |
| HTTP 403/429 with rate-limit evidence | `rate_limited`; bounded numeric delay when valid, otherwise `never`. No raw header text or automatic retry. |
| Definitive provider rejection | `provider_rejected`, no applied effect; no automatic retry. |
| Read transport/5xx failure | Typed unavailable/failure result; a retry hint is not current authorization or a scheduler. |
| Cancellation before execution, while queued, or before first admission completes | `cancelled` (or `timed_out` for the deadline), `effect: "none"`; no new uncertain-write fence. |
| Cancellation/deadline after a read is admitted, while native authority remains valid | Complete a failure receipt with `cancelled` / `timed_out`, `effect: "none"`, and no provider data. A confirmed failure does not block later authorized work. |
| Dispatched write timeout/cancellation, dropped/malformed response, unexpected status, or unconfirmed receipt begin/completion | `uncertain`/`receipt_unconfirmed`/timeout/cancellation with `effect: "uncertain"` and `retry: "reconcile"`. |

Rate-limit hints never shorten a provider's specified delay. Delays beyond 24 hours or malformed hints produce no retry suggestion. If both valid retry/reset hints exist, the later limit wins. [GitHub rate-limit guidance](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#handle-rate-limit-errors-appropriately).

GitHub HTTP 403 with a JSON `message` identifying a secondary rate limit is also `rate_limited`, even with a positive primary quota and no `Retry-After`. With no retry header or applicable primary reset, the suggested delay is 60 seconds. The provider message never enters the result or receipt. `CloudConnectorAdapter.classifyFailure` now receives a final `body: JsonValue | null` argument: null for initial HTTP/header classification, or bounded, redacted JSON when refining a rejection. [GitHub secondary-limit errors](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#rate-limit-errors).

Every attempt uses the existing `CloudNativeToolOperations.execute` with normalized arguments and a target containing installation/version/hash, implementation identity, account/grant, operation permission/effect, exact URL/method/resource/request hash, runtime version and audience. `requiresCompanyRevision` is false because the mutation is external; installation changes themselves remain governed Company File mutations.

The model supplies a stable `logicalOperationKey` through the closed schema; the host binds it to the admitted operation's effective input digest. The runtime must retain that key across replay, never substitute an attempt ordinal. Completed receipts can be replayed only after live authorization. An uncertain RPC throws inside `perform`, deliberately leaving the durable receipt unfinished. The local session also fences subsequent and already-queued calls; the existing durable ledger must retain the run-wide unfinished-effect gate across restart and different keys. No exactly-once external execution is claimed.

Failure results retain the logical key and receipt UUID when this process obtained one. If a prior/existing receipt cannot be confirmed, `receiptId` may be null: use the run/logical key in the existing ledger, not a new key to retry. GitHub has no reconciliation implementation in this adapter. Reconciliation or human review belongs to the existing authorized recovery path; an ordinary user/model retry cannot clear the fence.

The session tracks attempt ownership, first admission, dispatch, confirmed completion and known receipt ID for at most 128 logical keys. This is progress tracking, not a replacement ledger or result cache. Only a successful return from the existing native operation port establishes completion; a provider response alone does not. A later denied replay preserves its typed authorization failure and cannot turn that confirmed receipt into an uncertain effect. Live authorization still runs on every replay, and cached provider data is withheld on denial.

Caller cancellation and deadlines apply to the bounded result wait, initial admission and the RPC. The signal passed to `CloudNativeToolOperations.execute` is the connector session lifetime; the native instance also retains its own run cancellation. This separation is required because `CloudNativeToolRun.assertActive` closes the shared run on an aborted check. Passing an individual waiter's signal there would cancel other calls. A cancelled duplicate or queued waiter leaves the owning call and native run usable, while actual run cancellation and native authority loss still stop execution.

Cancelling a duplicate waiter retains its known receipt in the waiter's outcome; that waiter cannot create a session-wide fence on the owner's behalf. Cancelling work before first admission creates no fence. Once admission permits receipt creation, an unconfirmed begin still fences the owning write even if HTTP was never dispatched. Already-admitted native receipt RPCs retain the native port's bounds and may settle after a caller stops waiting; that is not permission for a late provider dispatch or an automatic retry.

An owning read with declared `effect: "none"` that passed initial admission may finish its live authorization check before `perform` using native/session cancellation rather than caller cancellation. This permits an already-opened receipt to reach the existing completion path; it does not bypass authority. The RPC still receives the cancelled caller signal and cannot dispatch late. When the cancelled read returns a known no-effect result, the wrapper removes all provider data and records only its typed failure and provenance. A separate timeout flag preserves `cancelled` versus `timed_out` even after cleanup aborts the deadline controller. Same-key replay returns the receipted failure after authorization, including after recovery; it does not repeat the HTTP request. Subsequent authorized logical work can proceed. Revoked authority before `perform`, stopped native/session lifetime, unknown begin or failed completion still leaves the existing durable gate intact. Writes do not use this completion exception.

## Connector authorization interaction lifecycle

`CloudConnectorAuthorizations` is a transition service over a **required** `ConnectorAuthorizationStore.transact` adapter. There is no production in-memory store, file store, event queue, universal approval UI, OAuth implementation or scheduler here.

The host constructs `ConnectorAuthorizationSpec` from the admitted full identity, runtime/audience, governed installation/hash, operation/permission, destination/resource, pinned connection/version, credential owner and intended member. Uniqueness is `(companyId, runId, logicalOperationKey)` with an exact scope digest. A matching request is reused; changed scope under the same key is denied; terminal states never reopen.

| Transition | Required checks |
| --- | --- |
| New request → `pending` | `assertRequestAllowed` checks live run, installation, scope, member and routing inside the existing transaction. |
| `pending` → `approved` | Authenticated member endpoint supplies the session separately; `assertMember` and `approve` validate membership, recipient, scope, policy and current approval authority. Evidence must match the exact request/company/member/scope. |
| `pending` → `declined` / `dismissed` | Same authenticated member and current request/revision; these are distinct terminal states. |
| `pending` → `expired` | Ten-minute server-time response deadline. Late responses are not accepted; expiry can be recorded through the existing authorized transaction. |
| `pending` / `approved` → `revoked` | Authenticated revocation policy and atomic fencing of any exact linked connector grant through `revoke`; not a vault deletion. |

The response body accepts only `{ requestId, expectedRevision, decision: "approve" | "decline" | "dismiss" }`. It cannot supply member/company identity, a token, credential handle or approval proof. Wrong member/company/session, stale revision/ID, duplicate response, corrupted row/proof, expired request and missing adapter methods are rejected.

All transaction methods are mandatory. The adapter must lock the existing row, use fresh authoritative time, validate live policy and atomically persist transition, consent/revocation and the existing interaction journal. Throw/abort must roll back, including provisional consent; recheck at commit. Tests cover expiry after approval returns and delayed results after cancellation. The service bounds a transaction to five seconds, but cannot make a nontransactional store safe.

`approved` records connector consent only. It neither proves provider authentication nor grants the comment action. The ten-minute request deadline is not a credential/grant lifetime; those are independently enforced by the live authority/vault bridge. Link authenticated evidence to the actual connector grant through the existing control plane.

`projectConnectorAuthorization` supplies a safe `connector_authorization` interaction with request/revision/status, operation, permission, destination/resource, audience, scope digest, owner, expiry and `approvalScope: "connector_access_only"`. `authentication: "out_of_band_required"` remains explicit. The existing mouth must authenticate the recipient and render fields as data; do not accept a model's claimed projection as authorization. No secret, session ID, OAuth state or vault URL is projected.

## Precise Step 2 and Step 4 integration hooks

### Step 2 native session

The **current main** `runCloudNativeRunToolSession.options.tools` signature is `(identity, operations) => ({ tools, assertContext })`. The Step 4 handoff describes an older three-argument `(identity, operations, run)` hook; do not assume that third argument exists.

1. Read authorized installation snapshots and resolve the pinned account through the existing cloud boundaries. Construct `CloudConnectorCatalog` with those snapshots and `createGitHubCloudConnectorAdapter()` from the trusted runtime artifact.
2. Inside the existing two-argument native tool factory, call `createCloudConnectorTools<CloudNativeToolIdentity>` with the **entire admitted identity**, the existing `CloudNativeToolOperations`, admitted runtime version/audience and mandatory connector authority/vault adapters. `ConnectorRunIdentity` is only a structural minimum, not a reconstructed authority grant.
3. Register its `tools` in the existing tool list. Compose its `assertContext(signal)` with the existing Company File/context read-set checks. This is required for same-native-call-ID cache hits and native result/compaction replay, which may bypass `execute`. Do not wire only the per-operation checks.
4. Keep `CloudNativeToolBoundary` and the patched native result fence on every model result path. Its envelope owns provenance and untrusted-data handling. JSON issue text, forged roles and purported approvals never become instructions. Host code must use trusted bindings/evidence, not model-returned copies of an envelope.
5. Arrange `connectorSession.close()` in the owning host's `finally`; the current factory has no cleanup callback. Keep the existing run-bound native operation instance: it owns run cancellation. Initial admission and RPC combine caller and native signals; an admitted read may settle a failure receipt under live native authority after its caller stops waiting, as described above. Supply only the connector session lifetime to the native port. Do not substitute an individual waiter's signal as the native operation lifetime. No shared session implementation was edited here.

`ConnectorAuthority.assertAuthorized(invocation, phase, receipt, signal)` must check the full admitted company/environment/run/job/runner/assignment/lease/compute/staff/version/session/requester/sponsor/provider identity, exact installation currentness, connector account/grant/owner, target request, audience and action approval. `admission` also runs on completed-result replay and the released read set. Dispatch and release must resolve the supplied receipt and downstream key to this **exact unfinished operation**, not merely accept their UUID/hash syntax.

The cloud effect adapter must bind authority and the ledger under its existing atomic checks, including grant consumption/replay semantics. The RPC checks again after the vault wait immediately before dispatch, and before releasing a response. Those checks do not make GitHub and the control-plane database one transaction: a revocation or lost response after dispatch can still leave an external effect. Preserve the unfinished receipt and recovery policy.

The existing native authority RPC/ledger wrappers in `supabase/migrations/20260828004000_native_cloud_tool_authority.sql` authenticate native runs; they are not a connector-specific target/credential grant implementation. Do not grant access solely because `describeToolAuthority` succeeds or because a model names a receipt UUID.

### Step 4 authentication boundary

An authentication outcome may cause the existing host to create the connector-specific request above using trusted catalog/run bindings. It does not itself start sign-in or open a computer. After authenticated consent, use the existing out-of-band linking flow to create/update the named cloud account and opaque handle; a new admitted binding/version is required before subsequent use. Do not mutate a run's pinned account or search for another active account.

If that existing flow uses a browser, Step 4 owns `CompanyComputerBrowserAccess.assertGranted`, the profile owner/version/lease and the typed sign-in privacy handoff. Before password/OTP entry it must suspend and acknowledge agent control, screenshots/recording and unauthorized viewers. Credential fields/cookies/profile bytes must not appear in connector input, output, Company File, transcripts or model-visible paths. Masking alone is not the barrier. Connector, browser-profile and model-provider grants remain distinct.

No Step 4 code or UI is modified. No screen lease is needed to execute these RPCs; a connected account must remain usable in the cloud with all member apps closed. Step 8 consumes typed auth/rate-limit/retry outcomes through the existing interaction/wake mechanism and owns suspension/scheduling; this component schedules nothing.

## Verification commands and results

Environment: Node `v24.18.0`, npm `11.12.1`, Vitest `4.1.9`.

Setup used `npm ci --ignore-scripts`: exit 0, 602 packages added, zero reported vulnerabilities; existing transitive deprecation notices only. No dependency/lockfile change or lifecycle scripts. The checkout lacked ignored AI model JSON, which initially made unrelated model types collapse to `never`.

To avoid provider/catalog network calls, `node /tmp/qorpera-step7-hydrate-local.mjs` copied only the ignored `packages/ai/src/providers/data` cache from the read-only Step 4 worktree. It first verified that the generated aggregator and all provider shards matched, validated source hashes/structure, refused overwrite, then validated the destination. Result: 38 provider JSON files; manifest SHA-256 `8040950564e86df4a367cde1b7e267633e789dbb784fbda58cf35f168b8ccced`. No generated TypeScript was edited. The temporary setup script was removed after use.

Final focused command, from `packages/shell`:

```sh
node ../../node_modules/vitest/dist/cli.js --run test/cloud-connector-catalog.test.ts test/cloud-connector-execution.test.ts test/cloud-connector-authorization.test.ts test/github-company-connector.test.ts test/connector-execution-authorization.test.ts
```

Result after the latest fixes: **5 files, 213 tests passed**, exit 0 (206 new connector tests and 7 existing connector regressions). The new suite uses actual loopback HTTP requests and realistic issue/comment payloads, synthetic credentials, live-state test authority, and a test-only transactional receipt/journal stand-in. Existing regressions exercise temporary local legacy fixtures, not a fallback path or a real provider.

The first review follow-up added 23 regressions for cancellation before admission, duplicate/queued waiters, lost begin acknowledgements, secondary rate limits without headers, error-body bounds/redaction, and cancellation/revocation during error inspection. Before those fixes, `node ../../node_modules/vitest/dist/cli.js --run test/cloud-connector-execution.test.ts` from `packages/shell` reproduced both findings: 6 failures and 74 passes. That follow-up ended with 84 passing execution tests. One added read-revocation assertion was corrected: provider data is withheld, but the typed no-effect failure may complete the read receipt; an uncertain write remains unfinished.

The native compatibility probe in the table below is historical evidence from the initial implementation. The first follow-up did not rerun it and missed the shared native run's cancellation behavior. The reassessment fixes were checked with a new probe against the actual native classes, described below; the reference interfaces still match their recorded hashes.

| Additional exact command, from root unless stated | Result |
| --- | --- |
| `npm run check` | Exit 0: Biome, pinned dependencies, relative imports, cloud boundaries, shrinkwrap/install-lock, TypeScript and repository browser bundle smoke. Full output inspected. |
| `node_modules/.bin/tsgo --noEmit -p /tmp/qorpera-step7-native-probe.tsconfig.json` | Exit 0: connector factory/authority/vault types compose with the actual main native classes and full identity. Temporary config used the main TS paths and disabled import rewriting for absolute probe imports; no source type was weakened. |
| `QORPERA_STEP7_REQUIRE_FULL_RESULT=1 node /tmp/qorpera-step7-native-probe.ts` | Exit 0: real main `CloudNativeToolRun`, `CloudNativeToolOperations`, `CloudNativeToolBoundary`, this connector and loopback HTTP composed successfully with controlled authority/ledger/vault adapters. |
| `node /tmp/qorpera-step7-audit.mjs` | Revisions checked; all 113 original relevant file hashes matched. Main HEAD advancement recorded above. |
| `node /tmp/qorpera-step7-fixes.OskfEo/audit.mjs` | Review-fix audit at `2026-08-28T17:50:23.611Z`: all 113 recorded hashes still match; reference HEADs unchanged since the earlier audit. Existing tracked files unchanged. |
| `git diff --check` | Exit 0; existing tracked files unchanged. New files additionally covered by repository lint/type checks. |
| `shasum -a 256 -c deploy/first-node/RUNTIME-STEP-7-FILES.sha256` | All 12 listed files match. |

The native probe verified same-call cached result revocation, native-result replay denial, completed receipt replay after changing runner/assignment/lease, and an uncertain write remaining unfinished across recovery/new keys. The run-wide durable gate was supplied by the controlled ledger port, **not** a deployed database. Long Unicode/control/HTML-sensitive issue text originally truncated the native envelope; the final probe returned a complete 5,725-byte envelope with `truncated: false` and intact typed outcome/receipt.

Temporary probe SHA-256: `a71cf3f221a503d5af426bc403a517f5e93930f0acf51bf64eaf19e8a04888f8`; config SHA-256: `aec88d65921b328d831463e6a35c86830a8d95b44423eb44ac4d6f334fd713d3`. These temporary probe/config files were removed after verification, not added as reference-path-dependent production tests. The permanent focused suite above is self-contained in this worktree.

Intermediate test/lint failures were corrected: test assertions for absent fields and reused work keys, a fixture's inferred `AbortSignal` return type, transport-level oversized-header classification, and native envelope truncation. Final checks pass. No `npm test`, full Vitest suite, `npm run build`, real GitHub/API/model request or live cloud acceptance was run. The repository browser smoke checks bundling only and did not launch a browser.

The first follow-up audit script and temporary copies used for diff review were removed after verification. No additional permanent files were introduced by either review follow-up.

### Reassessment fixes and native compatibility

Reassessment found two remaining defects: cancelling a duplicate/queued waiter could close the actual shared native run, and a denied replay could report an already-completed write as uncertain. The earlier receipt fixture lacked the native run's serialized authority checks and close-on-abort behavior. That behavior is now part of the permanent test fixture.

The follow-up added nine execution regressions and strengthened the existing cancellation cases. Before changing the implementation, the execution command above produced **10 failures and 83 passes**. After the fixes it passes **all 93 execution tests**. Coverage includes duplicate/queued deadlines, actual run cancellation, completed write/rejection replay denial, typed authentication expiry, and cancellation/deadlines during replay. A declaration-inference error on the fixture's exported signal was fixed with an explicit `AbortSignal` annotation.

Only `cloud-connector-tools.ts`, the signal contract documentation, the execution tests and their fixture changed in this follow-up, plus this handoff and delivery hashes. Shared runtime implementations remain untouched. The connector retains native receipt coalescing, live authority and durable fencing; it adds no queue, scheduler or result cache.

| Exact command, from root | Result after reassessment fixes |
| --- | --- |
| `npm run check` | Exit 0 twice. The first run formatted two files; the second applied no fixes. Full output inspected, including TypeScript and repository boundary/install-lock/browser bundle checks. |
| `node_modules/.bin/tsgo --noEmit -p /tmp/qorpera-step7-findings.gp75cn/native-probe.tsconfig.json` | Exit 0: corrected connector and fixture types compose with the actual native operation/authority classes and complete admitted identity. |
| `node /tmp/qorpera-step7-findings.gp75cn/native-probe.ts` | **13 passed, 0 failed**, repeated after repository formatting. Uses actual main `CloudNativeToolRun` and `CloudNativeToolOperations`, controlled authority/ledger/vault adapters and loopback HTTP only. |
| `node /tmp/qorpera-step7-findings.gp75cn/audit.mjs` | 112/113 baseline hashes match; the sole external Step 4 handoff change is recorded above. Native interfaces and existing tracked files unchanged. |

The 13 native cases cover successful duplicate coalescing; duplicate/queued cancellation and deadlines; denied replay of completed writes, definitive rejections and recovered receipts; cancelled replay; caller versus run cancellation during a write; lost receipt completion with recovery fencing; and native authority loss closing the run. The controlled ledger is not evidence of deployed database behavior.

New probe SHA-256: `f0feedb40f07d9fb18fbd9190af86baa6919c200c57cee49730e90c0b8988f1e`; config SHA-256: `c5aa812d212ce86654229a7f675ff33c4509aa42ba055f10a5b8a41715dbe2c2`. Temporary probe/config/audit files are not deliverables or production dependencies. The permanent tests have no reference-worktree path dependency.

### Cancelled-read receipts and GitHub repository names

The next reassessment reproduced two further defects: a cancelled/timed-out read left its receipt executing, blocking subsequent work and making an undispatched write appear uncertain; both GitHub operations rejected valid names beginning with a dot or hyphen. The cancellation and schema changes above address these findings without changing shared native code, the receipt ledger or write fencing.

This follow-up adds 35 regressions (14 execution and 21 catalog cases) and strengthens three existing cancellation tests. The catalog/execution command `node ../../node_modules/vitest/dist/cli.js --run test/cloud-connector-catalog.test.ts test/cloud-connector-execution.test.ts`, from `packages/shell`, reproduced **15 failures and 142 passes** before the implementation changes. One new native-run guard test's context was corrected to use the native run signal before that reproduction. The initial implementation passed all 157 cases; two more revocation/duplicate safeguards were then added. Final totals are **107 execution tests, 52 catalog tests and 191 tests across the five-file command above**, all passing.

Coverage includes cancellation/deadlines at response headers/body and after receipt begin but before HTTP; matching stored failure status with no provider data; same-key/recovered replay without another HTTP request; live revocation; later authorized reads/writes; late transport/vault callbacks; stopped native/session lifetime; failed completion; and safe repository names in schemas, parsing, prepared destinations and actual loopback read/comment requests. Traversal, encoded separators, fragments, newlines and length violations remain rejected.

| Exact command, from root | Result after these fixes |
| --- | --- |
| `npm run check` | Exit 0 twice. First run formatted three edited files; second applied no fixes. Full output inspected, including repository boundaries, lock checks, TypeScript and browser bundle smoke. |
| `node_modules/.bin/tsgo --noEmit -p /tmp/qorpera-step7-fix3.6ikxVf/native-probe.tsconfig.json` | Exit 0: full native identity/operation interfaces remain structurally compatible. |
| `node /tmp/qorpera-step7-fix3.6ikxVf/native-probe.ts` | **20 passed, 0 failed**, using actual main native classes with controlled authority/ledger/vault adapters and loopback HTTP only. |
| `node /tmp/qorpera-step7-fix3.6ikxVf/audit.mjs` | 112/113 baseline hashes match; only the previously recorded external Step 4 handoff differs. Current reference revision is recorded above. |

The 20 native checks exercise cancellation and deadlines at headers, body, delayed receipt begin and the second admission check; same-key/recovered failure replay and subsequent work; native cancellation/authority loss; revoked target authority; failed receipt completion; uncertain writes; duplicate waiter isolation; completed-write replay denial; an uncancelled duplicate of a cancelled read; and read/comment operations for `.github`, `.github-private` and `-tools`. The controlled ledger reflects the existing SQL unresolved-operation gate, but no live database was exercised.

Probe SHA-256: `cd7d1aeca25354a2f58065faec649448a7de98f9a91dbed7b6fffe21c7a55ac7`; config SHA-256: `b6b67aac8b45dc8bad204f4f002bfaf1c5cb0f87d59926a4d050ee821448815c`. Changes are limited to the tool/GitHub components, signal-contract documentation, catalog/execution tests and their fixture, this handoff and delivery hashes. Temporary probes/snapshots are removed after verification; no permanent file was added by this follow-up. Deployed acceptance remains open.

### GitHub managed-user repository owners

The next reassessment found that both operation schemas and parsers rejected valid owners such as `mona-cat_octo` because the owner character class omitted underscores. The production fix adds `_` to that shared pattern; destination origins, account selection, authority, RPC, receipt and cancellation code are unchanged. The test fixture can now bind its exact authorized repository owner instead of assuming `acme`; it still rejects other owners.

This follow-up adds **22 regressions**: four valid-owner and 16 invalid-owner catalog cases, plus two loopback execution cases covering both read/comment operations. They check maximum length, case normalization, prepared destinations, path separators/escapes, query/fragment/user-info syntax, line terminators, receipt replay, wrong-owner denial and revocation without extra HTTP or vault access. Before the implementation fix, `node ../../node_modules/vitest/dist/cli.js --run test/cloud-connector-catalog.test.ts test/cloud-connector-execution.test.ts` from `packages/shell` produced **6 failures and 175 passes**. The five-file focused command above then passed **all 213 tests**, including **72 catalog and 109 execution tests**, both before and after repository formatting.

| Exact command, from root | Result after the owner fix |
| --- | --- |
| `npm run check` | Exit 0. Formatted the execution test file; all repository checks, TypeScript and browser bundle smoke passed. Full output inspected. |
| `node /tmp/qorpera-step7-ownerfix.mzhG61/snapshot.mjs` | Captured the six edited delivery files and current reference revisions/hashes before edits; original baseline preserved. |
| `node /tmp/qorpera-step7-ownerfix.mzhG61/audit.mjs` | 112/113 original baseline hashes match; no reference file changed during this follow-up. Existing tracked files unchanged. |

Changes are limited to the GitHub adapter, catalog/execution tests and their fixture, this handoff and delivery hashes. No permanent file was added. The native compatibility probes documented above were not rerun for this owner-validation change. Temporary snapshots/audit scripts are removed after verification; production installation/authentication wiring and deployed acceptance remain open.

## Remaining wiring and live acceptance gates

Before activation, the integration owner must supply the governed installation projection/mutation workflow, trusted artifact registry, exact cloud account/handle bridge, connector target/effect authority, authenticated interaction transaction/journal and existing mouth/linking flow. None has a permissive production substitute here. The local test ledger is explicitly test-only.

- [ ] With **all member devices offline**, an admitted cloud run reads the authorized issue and creates one approved comment through the real native tool session. Verify actual provider state, durable receipts and fenced results, not a model report or fixture response.
- [ ] Load/install/update/remove connector intent through governed Company File state. Verify version/hash/operation-subset changes and revocation during a run; source/bundle hashes must match the shipped artifact. No local directory or unrestricted Company File execution route may activate a connector.
- [ ] Verify real member-owned, explicitly delegated and company-owned accounts, memberships/sponsors, run and connection/grant/credential versions. Cross-company, wrong-member, wrong-target, expired/revoked and missing-authority cases must refuse before credentials/HTTP and suppress unauthorized replay.
- [ ] Exercise atomic target authorization and receipt admission with the actual cloud database. Test dropped begin/completion replies, concurrency, host restart, changed assignment, same/different logical keys and provider-success/receipt-loss ambiguity. Never retry an unfinished write without authorized reconciliation; this adapter has no provider reconciliation implementation.
- [ ] Exercise vault expiry, revocation, outage and delayed responses. Confirm no bearer/header/cookie/callback code reaches logs, traces, exceptions, prompts, transcripts, Company File, native process environment or model-visible paths. Verify containment/egress against the real cloud transport, not only URL validation.
- [ ] Verify auth interactions through real authenticated member sessions, company routing, request/revision uniqueness, consent evidence, expiry, cancellation/rollback, revocation and existing wake delivery. Consent and typed status must not replace live provider authentication or separate write approval.
- [ ] If existing linking uses Step 4 browser sign-in, verify acknowledged private entry and independent profile grants before credentials appear. A failed connector call must not open a browser, choose another account or resume computer control.
- [ ] Test real rate-limit/rejection semantics, malformed/oversized/stalled streams, disconnect/cancellation, result budgets and secret echoes using an authorized test account/service under fresh operational permission. Do not infer live provider behavior from the controlled fixture alone.
- [ ] Compose connector `assertContext` into every existing context/result fence, including same-call cache, resumed run and compaction paths. Revoked provider data must not survive as an authorized result merely because it was previously returned.
- [ ] Review packaging, migrations if needed, rollout and rollback separately under fresh authorization. This handoff grants no deployment or release permission.

Component completion is ready for review. Deployed Step 7 acceptance remains open until these integration and cloud gates are satisfied. This handoff was delivered only in the assigned worktree and this session.
