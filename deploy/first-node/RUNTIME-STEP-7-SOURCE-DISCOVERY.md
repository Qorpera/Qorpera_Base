# Runtime Step 7 continuation: prior-work source discovery

## Status and scope

This supplement extends the existing Step 7 cloud-connector component with bounded prior-work discovery and selected source reads. It does not replace or revise the historical handoff at `deploy/first-node/RUNTIME-STEP-7-CLOUD-CONNECTORS.md`.

Component status: **implemented, review-remediated, and verified with controlled fixtures; production wiring and live acceptance remain open**.

The continuation does not implement Co-Founder behavior, formation state, organizational schemas, context composition, Company File writes, a crawler, a scheduler, a new permission store, a credential store, browser sign-in, deployment, migration, or release work.

The supplied verification list ended with `changed provider`. This delivery treats that as changed provider resource identity and covers repository, revision, path, response URL, and duplicate stable-identity changes.

## Audited inputs and baseline

The implementation was based on the complete current ratified runtime contract, the complete existing Step 7 handoff, and the applicable repository instructions.

| Input | Captured evidence |
| --- | --- |
| Assigned worktree | `/Users/jonas/.codex/worktrees/90f2/Qorpera_Base-step2` at `a0b692947d5c867353591b36172afcc997f0521e` |
| Continuation request | SHA-256 `fbd5eca8ba7e60510c27ec816216071668f2c46e195641f1feb5e1b6e31d71e3`, 9,828 bytes |
| Ratified runtime contract | SHA-256 `a8a68b8605dc2a8ad01148ad6697e3a58b813b305b7b65286e8054d0895c8245` |
| Existing Step 7 handoff | SHA-256 `d6baf3d85830000a2a1fb334245c00d34196d42070221312c1ee38d8e2d888d2` |
| Existing Step 7 baseline | SHA-256 `9a201ad9a4515e4b4046c4c417468fc9fa5cdd8a6fedcdaf76546c19847fdf49` |
| Existing Step 7 hash manifest | SHA-256 `df866803d86f0b8b9eec2d92dcb239819bffb9d55846eead1fbd26cb92d4b1c2` |
| Pre-remediation source-discovery files | Temporary tar SHA-256 `3f08a1b70c85da91beca09370ae51bd218f8d6516855a785c7a1445e69d810a3`, 474,624 bytes; hash-list SHA-256 `498420fa29c8b09ef0d50230c0e796d8730ee38c0d6efa87b85f15b340881613`, 1,887 bytes |
| Pre-provenance/BOM remediation | 19 delivery files snapshotted at `2026-08-30T21:09:01.544Z`; snapshot manifest SHA-256 `f329d8ca40660e39357f5f55ee4f80d34b07cdde983d35f458a565c405e3b4de`. Original supplement baseline reconstructed and verified before editing. |

The pre-edit hashes for every existing file considered for modification, plus files absent at capture, are recorded in `RUNTIME-STEP-7-SOURCE-DISCOVERY-BASELINE.json`. Exact temporary copies were retained through patch review and are not delivery or runtime dependencies.

The three historical Step 7 evidence files above remain byte-for-byte unchanged.

## Delivered files

| File | Purpose |
| --- | --- |
| `packages/shell/src/cloud-connector-contract.ts` | Manifest v2, source capability/system/inventory types, host continuation contract, and source-aware adapter/invocation types. |
| `packages/shell/src/cloud-connector-source.ts` | Closed source-result validation, audience isolation, inventory projection, continuation scoping, and issued/resolved handle validation. |
| `packages/shell/src/cloud-connector-catalog.ts` | Closed manifest/capability validation, source-system projection, continuation-aware schemas, and integration fail-closed checks. |
| `packages/shell/src/cloud-connector-github.ts` | GitHub repository inventory, repository metadata, bounded directory listing, and exact commit/path text reads. |
| `packages/shell/src/cloud-connector-http.ts` | Source decode/inventory release, continuation issuance, secret-echo suppression, and preserved HTTP/authority fences. |
| `packages/shell/src/cloud-connector-tools.ts` | Source audience admission, total call deadline, host continuation resolution, exact native target binding, and source-system return. |
| `packages/shell/src/cloud-connector-authorization.ts` | Authorization v2 with distinct `connect` and `authorize` purposes and null pre-connection identity. |
| `packages/shell/test/fixtures/cloud-connector.ts` | Test-only host continuation port, ownership/authentication variants, lifecycle versions, and existing controlled loopback transport. |
| `packages/shell/test/cloud-connector-source-discovery.test.ts` | Focused source discovery, privacy, lifecycle, bounds, identity, hostile-content, and transport regressions. |
| `packages/shell/test/cloud-connector-execution.test.ts` | Existing execution regressions extended for distinct authorization outcomes and fully encoded credential echoes. |
| `packages/shell/test/cloud-connector-authorization.test.ts` | Connection-purpose, dismissal, and separation-of-authority regressions. |
| `packages/shell/test/cloud-connector-catalog.test.ts` | Existing operation assertions updated to coexist with compiled source operations. |
| `deploy/first-node/RUNTIME-STEP-7-SOURCE-DISCOVERY-BASELINE.json` | Pre-edit source continuation baseline. |
| `deploy/first-node/RUNTIME-STEP-7-SOURCE-DISCOVERY.patch` | Replayable implementation/test/baseline patch against the captured Step 7 state. |
| `deploy/first-node/RUNTIME-STEP-7-SOURCE-DISCOVERY-FILES.sha256` | Final delivery hashes. |

No dependency, lockfile, generated model, changelog, shared native runtime, browser, runner, gateway, scheduler, mouth, wake, context-composer, or Company File implementation changed.

## Versioned source contracts

The extension makes incompatible contract changes explicit:

- connector manifest schema: `qorpera.cloud-connector/v2`;
- native connector tool version: `qorpera.cloud-connector-tool/v4`;
- connector result schema: `qorpera.cloud-connector-result/v2`;
- connector authorization schema: `qorpera.connector-authorization/v2`;
- source capability schema: `qorpera.cloud-connector-source-capability/v1`;
- source system schema: `qorpera.cloud-connector-source-system/v2`;
- source inventory schema: `qorpera.cloud-connector-source-inventory/v1`; and
- host continuation schema: `qorpera.cloud-connector-continuation/v1`.

The GitHub manifest and compiled implementation are version `1.2.1`; `sources.file.read` is version `1.1.1`. Existing issue-operation inputs and effects remain unchanged; each operation carries an explicit `sourceCapability`, which is `null` for non-source operations.

Source capability objects are closed and compiled. They declare the capability kind, supported resource kinds, pagination mode, item/output/depth/request limits, and maximum continuation steps. Catalog admission rejects unknown capability fields, malformed bounds, source writes, nonzero effects, automatic write semantics, missing live-grant classification, and manifest or implementation drift. Descriptive capability metadata never grants authority.

`sourceSystems(signal)` is an asynchronous host-built projection. It requires a live `ConnectorSourceSystemAuthority`; construction fails closed when that shared integration is absent. Connection state and operation authorization are separate:

- connection state is `connected`, `authentication_required`, `revoked`, or `available_for_connection`;
- each enabled source operation is independently `authorization_required` or `live_check_required`; and
- disabled operations are `not_enabled`.

The status port revalidates the complete admitted identity, audience, installation, connection, current credential state, current grant state, and exact enabled operation set. Its closed output is bounded to 4 KiB and contains no handles or secrets. Malformed, stale, missing, or duplicate status results fail closed. The projection never includes credential handles, grant handles, bearer material, staff/sponsor identity, or continuation cursors. `live_check_required` remains descriptive: every source call still goes through the native receipt, authority, vault, dispatch, release, and context fences.

`authentication_required` now means the provider connection cannot authenticate. A connected account without the exact operation grant returns `authorization_required` with retry kind `authorize`, while expired or missing authentication returns retry kind `reauthorize`.

## Review remediation

The first post-delivery review identified four issues; all are corrected in this supplement revision:

1. Credential suppression now covers the exact bearer, mixed or fully percent-encoded bytes with either hex case, URL encoding, padded/unpadded base64, base64url, and hexadecimal forms. Object keys and values are scrubbed before provider projection or truncation. Source inventories still reject any post-decode credential mutation.
2. `sources.file.read` requires the expected Git blob SHA from the prior authorized directory inventory. The exact repository, commit, path, and blob tuple is part of the native target and must be accepted by the live authority. A Contents response that dereferences an in-repository symlink cannot substitute the target blob.
3. Decoded bytes are recomputed as a Git blob object (`SHA-1("blob " + byteLength + NUL + bytes)`) and must equal both the requested and returned blob SHA. Provider-supplied SHA labels can no longer authenticate different bytes.
4. Source-system connection state comes from the required live host status port. Grant state is per operation and no longer inferred as authentication from cached handle presence.

A subsequent reassessment reproduced two additional issues, corrected in the current revision:

1. A rejected credential-bearing path survived in failure provenance and stored receipt content. Result provenance now starts with compiled operation IDs, the logical-key digest, and a request digest when available. The raw logical key is `null`; selectors, URLs, account metadata, and other candidate fields are withheld until the existing one-use vault callback has checked the complete request and candidate provenance. Denial, cancellation, vault failure, lost receipt completion, pre-receipt failures, and denied replay cannot restore unchecked fields. Native receipt keys use a deterministic digest so a credential supplied as a logical key is not persisted before that check.
2. The UTF-8 decoder stripped valid BOM bytes while the file's byte count and hashes retained them. Decoding now preserves the BOM, keeping the returned text, byte count, SHA-256, and validated Git blob SHA consistent. Malformed UTF-8 and binary controls remain rejected.

## Typed source inventory

Successful source operations return a closed inventory containing:

- provider, connector, manifest implementation, and operation identity;
- exact company, connection/version, provider account, owner kind/ID, grant/version, and credential version attribution;
- requester and exact member/company audience;
- member-private or company-owned visibility;
- stable resource identity, type, label, locator, parent, revision, provider timestamps, accessibility, enabled follow-ups, bounded metadata, and optional validated text content;
- completeness, truncation reason, and an opaque host continuation handle; and
- `publication: requires_governed_company_file_operation` with `imported: false`.

The generic source boundary validates every resource again before release. It rejects unknown fields, duplicate stable identities, unsupported kinds, invalid parents, malformed Git hashes/timestamps, malformed content byte counts, and content SHA-256 mismatches. Follow-ups are filtered to enabled source operations.

Provider-controlled labels, descriptions, metadata, timestamps, paths, and file text remain untrusted data. Provider timestamps are never used as host ordering authority. Repository inventory and metadata explicitly report `revision.kind: unavailable`, `value: null`, and `stable: false`; exact directory and file operations retain the requested commit plus provider tree/blob hashes.

GitHub repository resources use the provider node ID. GitHub contents use a stable repository/path identity while the commit and tree/blob hashes remain separate revision data. Reading a source does not create a vision, dossier, project, department, template, memory, or Company File object.

## Deliberate bounds

Every source operation is one native tool call, one receipt, and at most one provider request. There is no recursive traversal and no default whole-account or whole-repository crawl.

| Operation | Items | Source output | Absolute path depth | Provider response | Continuation | Deadline |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `sources.repositories.list` | 10 per page | 2,048 bytes | 0 | 256 KiB | Host-only, at most 10 steps | 20 s maximum |
| `sources.repository.get` | 1 | 2,048 bytes | 0 | 256 KiB | None | 20 s maximum |
| `sources.directory.list` | 32 | 2,048 bytes | 7-segment target, 8-segment returned child | 256 KiB | None | 20 s maximum |
| `sources.file.read` | 1 | 2,048 bytes | 16 | 32 KiB; 1,024 decoded UTF-8 bytes | None | 20 s maximum |

The session timeout may shorten but cannot extend the compiled deadline. The existing 5 KiB native fenced-result budget remains unchanged. Byte pressure drops only a bounded tail and reports `complete: false`, `truncated: true`, `reason: byte_limit`. Empty account pages and directories return a valid complete empty inventory. Provider responses that violate the count/file limits are rejected rather than silently crawled.

GitHub pagination does not provide a collection snapshot. Each repository therefore retains an unavailable revision until a later exact commit is selected. Continuations bind to the exact run, requester, audience, installation, manifest/implementation, account, grant, credential version, operation, runtime bundle, and selector. Only `{id, version}` is model-visible; the provider page/step cursor remains in trusted host state. Missing continuation integration fails tool construction, and changed handles/scopes/cursors fail before credentials or HTTP.

## GitHub endpoint allowlist

The compiled adapter can prepare only these requests:

| Capability | Compiled request |
| --- | --- |
| Account repository page | `GET /user/repos` with fixed `affiliation`, `direction`, `sort`, `per_page=10`, and host-controlled numeric `page` |
| Exact repository metadata | `GET /repos/{normalized-owner}/{normalized-repository}` |
| Exact directory | `GET /repos/{normalized-owner}/{normalized-repository}/contents/{validated-path}?ref={40-hex-commit}` |
| Exact text file | The same Contents endpoint with a nonempty validated path and exact 40-hex commit |

Only `https://api.github.com` is accepted. The tool cannot supply a URL, origin, method, header, account, credential, provider cursor, or revision alias. Prepared and returned URLs reject credentials, fragments, unexpected query keys, duplicate pagination fields, changed repositories/paths/revisions, and encoded separators. Requests use manual redirect handling and never follow a redirect.

Paths are NFC-normalized, byte/depth bounded, relative, and segment encoded by trusted code. Empty segments, dot segments, leading/trailing separators, backslashes, `%`, query/fragment characters, controls, traversal, and returned subresource escapes are rejected. Directory symlinks/submodules are marked unsupported when the provider identifies them. File reads additionally require the exact prior-inventory `blobSha`. The response SHA must match that expected blob, and the decoded bytes must independently hash to the same Git blob object ID. This fails closed when the Contents endpoint dereferences an in-repository symlink or when a provider labels different bytes with the requested SHA. Strict canonical base64, declared-size agreement, fatal UTF-8 decode, and binary-control rejection still apply.

A leading UTF-8 BOM is preserved as part of the source text and included in the 1,024-byte limit and both hashes; it is not removed as a normalization step.

The endpoint design follows GitHub's official REST documentation for [authenticated-user repositories](https://docs.github.com/en/rest/repos/repos?apiVersion=2026-03-10), [repository contents](https://docs.github.com/en/rest/repos/contents?apiVersion=2026-03-10), and [REST pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api?apiVersion=2026-03-10). Documentation was read only; no live GitHub API was called.

There is no generic HTTP/URL tool, `gh` invocation, ambient login, browser cookie, browser fallback, local clone, filesystem source scan, or alternate-account path.

## Authority, ownership, and sharing

The native target binds the complete admitted identity, runtime bundle, installation object/version, manifest hash, implementation, account binding, operation/version/effect/permission/approval, destination, method, exact resource, request hash, source capability, continuation scope hash, opaque handle, and cursor hash.

Member-owned source operations add a hard component check:

- the account owner must equal the admitted requester;
- the audience must be the exact owner member audience;
- company audience relabeling is rejected;
- another member or company context cannot release a cached result; and
- source systems hide the member account outside its audience.

No automatic member-to-company promotion exists. A future explicit company-use grant must be represented by the shared authority system; until then, member-private content fails closed for company audiences.

Company-owned connections allow the exact company audience or the admitted requester's member audience, but every operation still requires the shared authority adapter to revalidate current company membership, run identity, installation, connection, grant, credential version, and target at admission, dispatch, release, and cached-context release. This component does not create a parallel membership or ACL store.

## Credentials and lifecycle

The existing one-use vault callback remains the only bearer consumer. It is bounded, can dispatch once, and is preceded by live authority. The exact bearer and mixed/fully percent-encoded, URL-encoded, padded/unpadded base64, base64url, and hexadecimal forms are redacted before provider projection or truncation. Keys and values are both inspected. A source inventory is rejected if post-decode inspection would change it, preventing an echoed credential from surviving with an invalid content hash. Provider error bodies are bounded, redacted, and never returned.

`executeCloudConnectorRpc` also receives trusted candidate `provenance` and an `onValidatedProvenance` callback. It checks both request and candidate metadata against the bearer before acknowledging that metadata or dispatching HTTP; no bearer or redactor leaves the vault callback. The tool wrapper uses only its minimal digest-based provenance until that acknowledgement. Receipt UUIDs and host timestamps can still be added. A failure before credential validation therefore has `logicalOperationKey: null` plus `logicalOperationKeySha256`, not unchecked raw selectors. Hosts must continue to exclude transient tool inputs and invocation objects from logs/traces; these checks do not authorize logging adversarial input.

No secret store, environment injection, global registry, desktop bridge, browser fallback, credential-bearing schema, or model-selected handle was added.

Authorization v2 distinguishes:

- `purpose: connect`, which requires `connectionId: null` and `connectionVersion: null`; and
- `purpose: authorize`, which requires the exact existing connection and version.

A connection request begins pending. Approval records only connector consent and still reports `authentication: out_of_band_required`. Decline and dismissal are terminal skip outcomes; they do not reopen or create consent. Approval does not create provider authentication, a broad read grant, an external-write grant, or publication authority. Expiry, revocation, authenticated-member proof, stale revision checks, duplicate suppression, and transactional rollback remain intact.

## Receipt, replay, cancellation, and revocation preservation

Source operations reuse the existing native operation/receipt port. No result cache, queue, scheduler, event store, reconciliation implementation, or crawler state was added.

- Stable logical-operation keys coalesce duplicate inventory and file reads without another provider request or vault call. Tool v4 maps the model key to `sha256:<connectorDigest(key)>`; the existing native port persists `run_connector:sha256:<digest>`. `connectorDigest` hashes the canonical JSON encoding of the key. This is deterministic, not an attempt ordinal, and the existing operation digest still binds all effective input and authority.
- Changed input under a completed key conflicts through the existing digest/receipt machinery.
- Caller cancellation cannot cancel another waiter or native run authority check.
- Cancelled/timed-out reads complete only a data-free no-effect result as in the prior Step 7 contract.
- Writes retain the prior uncertain-effect fence unchanged.
- Admission, dispatch, release, and `assertContext` revalidate authority; revocation withholds provider data and private cached results.
- Pre-receipt continuation and preparation failures cannot open a receipt or issue HTTP.

Full validated provenance retains the original logical key and its digest. Before validation, including an uncertain receipt begin, recovery uses the digest-derived native key and any known receipt UUID. Uncertain-write fencing does not depend on returning the unchecked model string.

Tool v4 changes the durable key representation. Admit it with the matching new runtime artifact; do not hot-swap it into a v3 run, relabel an old run's bundle, or replay v3 work under v4 keys. Existing uncertain operations must be resolved through their original receipts. This component has not been activated in production and supplies no compatibility migration or bypass.

## Verification

All tests use synthetic identities, a synthetic bearer, a test-only continuation map, the existing test-only receipt ledger, and a controlled loopback HTTP server that accepts only logical `https://api.github.com` requests. No real credentials, provider APIs, model calls, deployment, migration, commit, push, merge, or release were used.

From `packages/shell`:

```text
node ../../node_modules/vitest/dist/cli.js --run test/cloud-connector-catalog.test.ts test/cloud-connector-execution.test.ts test/cloud-connector-authorization.test.ts test/cloud-connector-source-discovery.test.ts test/github-company-connector.test.ts test/connector-execution-authorization.test.ts
```

Final result: **6 test files passed, 286 tests passed**.

The 70 source-discovery cases cover compiled/closed capabilities, live connection and per-operation authorization states, missing or malformed status/continuation integrations, closed inventory validation, empty pages, exact host pagination, continuation tampering and scope substitution, the ten-step limit, repository/commit/path/parent/blob binding, symlink dereference, provider SHA/byte mismatch, traversal and encoded separators, stale/revoked lifecycle versions, missing authentication versus authorization, member/company ownership, cross-member/company and private-cache denial, output/count/depth/file bounds, duplicate reads, changed identities, malformed/binary/hostile/prompt-injection content, raw/percent/base64/base64url/hex secret echoes, cancellation, stalls, redirects, and one-request behavior.

This remediation adds 18 regressions across the source and execution suites: BOM-only/text/limit cases with exact hashes and replay, malformed UTF-8 after a BOM, raw/encoded/opaque credential paths, completed and recovered failure replay, revoked replay, pre-vault denial/cancellation, vault and completion failures, cancellation during the vault wait, credential-bearing logical keys, pre-receipt audience/continuation failures, and uncertain receipt begin without exposing its unchecked key. Before the implementation fix, `node ../../node_modules/vitest/dist/cli.js --run test/cloud-connector-source-discovery.test.ts` reproduced **13 failures and 54 passes**; the later final command above passes all 286 cases.

From repository root:

```text
npm run check
```

Final result: exit 0, including Biome with warnings as errors, pinned dependencies, TypeScript import rules, cloud runtime boundaries, shrinkwrap/install-lock checks, `tsgo --noEmit`, and browser bundle smoke. The first remediation check formatted two edited files; the final check applied no fixes. Full command output was inspected.

`npm test`, the full Vitest suite, and `npm run build` were not run, per repository instructions.

The supplement patch was regenerated from the originally captured pre-continuation files, not from the remediated tree. `git apply --check` succeeded in a clean temporary reconstruction, applying the patch reproduced all 13 implementation, test, fixture, and baseline files byte for byte. The final SHA-256 manifest was then verified with `shasum -a 256 -c`.

## Explicit production gates

No permissive substitute exists for these remaining integrations:

- Supply the governed connector installation/account projection and the required live `ConnectorSourceSystemAuthority`; expose `sourceSystems(signal)` only inside the admitted audience/context fence. The authority must resolve current connection/authentication and exact per-operation grant state rather than trusting projected handle presence.
- Supply an existing trusted host `ConnectorContinuationPort` with bounded retention, exact scope-digest checks, cancellation, and no cursor/model/log exposure. The test map is not production storage.
- Supply the existing authenticated interaction transaction/mouth for `connect` and `authorize`, plus the real out-of-band provider connection flow. Approval alone must not create a connection or grant.
- Supply the existing native receipt, authority, and vault adapters. Verify current company membership and exact member/company ownership with real control-plane state. For `sources.file.read`, the authority must bind the requested repository, commit, path, and ordinary-file blob SHA to the prior authorized inventory/resource grant; model-supplied tuple fields are not authority.
- Keep selected-source publication in a separate governed Company File operation that retains provenance and live authority. This component grants no Company File path or write.
- Compose connector `assertContext` through every cached/resumed/compacted result release.
- Admit tool v4 and the GitHub `1.2.1` implementation as a matching runtime bundle; do not substitute v4 keys for operations from an older run or use a new key to bypass an unresolved receipt.
- Perform all-member-devices-offline acceptance with the deployed cloud runtime.
- Under fresh operational authorization, test GitHub API version behavior, pagination churn, rate limits, repository visibility, contents edge cases, vault expiry/revocation, dropped receipt acknowledgements, and secret containment with an authorized test account.
- Review packaging, rollout, migrations if any, rollback, and release separately.

Until those gates pass, this is a verified component extension, not deployed Step 7 acceptance.
