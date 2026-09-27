# Qorpera member web client

An independent static browser application for the governed Company File and shared Company Computer. It uses `@qorpera/cloud-client`; the headless runtime, cloud authority and object/view gateways own execution, grants, bytes and machine lifetime. This package contains no Electron bridge, native runner, provider credentials or service key.

The app supplies public-project sign-in with PKCE, company selection, bounded File browsing and text edits, explicit browser uploads/downloads, protected binary review, shared exports, read-only agent activity, computer start/status/cancel, agent grants, browser profile consent, private sign-in and account-level cleanup after membership removal. File mode is checked independently of computer access. Screens require explicitly configured WSS transport. Closing the app preserves durable office and privacy state.

Account events cancel old account/company operations synchronously. Token refresh for the same member preserves current work. Late responses cannot populate a new account or initiate its download. Sign-out clears only this app's session/PKCE namespace and reloads even if the Auth service is unavailable. No Auth SDK call is awaited inside an Auth state callback.

Browser uploads retain the selected bytes, destination, expected version and original operation key after an uncertain response. Downloads offer verified bytes through the browser's save interaction; the app cannot attest that the user saved them or acquire a member filesystem path. Native proposals use the same exact-plan review API as desktop.

## Unpublished local package

Create a public JSON configuration with exactly these fields:

```json
{
  "schema": "qorpera.member-web-config/v1",
  "supabaseUrl": "https://YOUR-PROJECT.supabase.co",
  "publishableKey": "sb_publishable_YOUR_PUBLIC_KEY",
  "objectGatewayUrl": "https://YOUR-MEMBER-GATEWAY.example",
  "officeViewerOrigin": "wss://YOUR-VIEWER.example"
}
```

Use `null` for `officeViewerOrigin` when screen viewing is unavailable. These are canonical origins without a trailing slash, path, credential, fragment or query. Remote origins require HTTPS/WSS; HTTP is accepted only for disposable `127.0.0.1` proofs. Service keys and member tokens are refused.

From the repository root, run `node scripts/package-member-web.mjs --out NEW_DIRECTORY --config PUBLIC_CONFIG_JSON`. This only writes a new local directory. It emits self-contained JS, styles, HTML, public config, the noVNC license, deployment headers and an asset hash manifest. It checks the vendored viewer against its recorded checksums and refuses runtime/desktop/Node adapters or external modules in the artifact. The HTML and header CSP limit requests to configured origins. The static server must apply `_headers` (or equivalent HTTP headers); `frame-ancestors` requires an HTTP header.

Before hosting, register the exact HTTPS app root as the Auth redirect destination, enable the chosen login providers, and configure member object/view gateways and Realtime for that origin. OAuth redirects and email delivery require hosted acceptance. Never infer these endpoints from desktop defaults. No hosting, login-provider setup, production activation or release is performed by the packager.

## Local evidence and remaining verification

The full repository check compiles this DOM-specific project separately and bundles its actual entry under the browser boundary gate. Run the named tests from this package: `node ../../node_modules/vitest/dist/cli.js --run test/account.test.ts test/config.test.ts test/files.test.ts`. Package boundary tests are `node --test scripts/package-member-web.test.mjs scripts/check-headless-packages.test.mjs` from the root.

`QORPERA_WEB_TEST_BROWSER=/path/to/chromium node scripts/test-member-web-browser.mjs` runs the actual static package, Auth SDK, HTTP, DOM, native browser chooser, Web Crypto and downloads against disposable fixture services. It verifies exact retry identity, binary review, start/grant recovery, independent File/computer access, corrupt-byte rejection, account cancellation and sign-out storage. `QORPERA_WEB_PROOF_OUTPUT` optionally retains inspected screenshots. Auth/control/object responses are fixtures; this proof does not claim actual SQL authorization or a physical office.

`QORPERA_WEB_SQL_TEST_BROWSER=/path/to/chromium node scripts/test-member-company-file-upload.mjs` applies all 192 migrations and connects the packaged web app to real disposable SQL, the member gateway, disk object store and replication journal. Native browser CORS is exercised across two loopback origins. It proves company discovery, exact recovery of a lost text edit with one revision, protected binary upload/pending download/approval, verified live downloads, viewer mutation denial, and member removal during object I/O preventing download. Office, account-cleanup and empty export discovery also use real SQL. Auth sessions, the HTTP-to-SQL adapter and initial empty snapshot storage are fixtures. `QORPERA_WEB_SQL_PROOF_OUTPUT` optionally retains a screenshot.

`QORPERA_WEB_OFFICE_TEST_BROWSER=/path/to/chromium node scripts/test-member-office-catalog.mjs` connects the actual static package and Auth SDK to real disposable SQL and the TLS viewer gateway. Native browser WebSockets and noVNC verify watch pixels, input blocking, control after drain acknowledgement, lost viewer/profile/privacy replies, account cancellation, ordinary-member private input, explicit reconnect/exit and separate consent. Two prepared profiles exercise independent account cleanup, refusal of changed consent, and both revocation and private exit after membership removal. `QORPERA_WEB_OFFICE_PROOF_OUTPUT` optionally retains screenshots. Only the disposable certificate's SPKI is trusted by the test browser; system trust is unchanged. Auth sessions, SQL HTTP transport, guest RFB pixels and physical drain/privacy acknowledgements remain fixtures. No Electron bridge is used.

`QORPERA_WEB_PRESENCE_TEST_BROWSER=/path/to/chromium node scripts/test-runtime-company-presence.mjs` connects the packaged app to two actual native presence publishers, native Ed25519 signatures, the existing Supabase/Phoenix v2 protocol and real SQL/member gateway. It verifies folder/exact-path activity, selection changes, private-path revocation and account cancellation. The member remains read-only and never publishes native activity. Auth sessions, the loopback Realtime server, SQL HTTP transport and initial empty snapshot storage are fixtures; selected absent-path metadata uses actual SQL. `QORPERA_WEB_PRESENCE_PROOF_OUTPUT` optionally retains a screenshot.

`QORPERA_WEB_EXPORT_TEST_BROWSER=/path/to/chromium node scripts/test-member-file-exports.mjs` follows a real native/SQL/Linux export through the disk object store and member gateway into the actual web export list and explicit download. It verifies binary bytes for a read-only member after the office connection closes and its grant is revoked. Membership removal during the next object read prevents another download. Both client and gateway reauthorize before and after reading. Auth sessions, SQL HTTP transport and office provisioning/mount admission remain fixtures. `QORPERA_WEB_EXPORT_PROOF_OUTPUT` optionally retains a screenshot. This command also reruns the existing export, import, live Company File publication and member-authority proofs.

`QORPERA_WEB_NATIVE_REVIEW_TEST_BROWSER=/path/to/chromium node scripts/test-member-file-exports.mjs` follows an actual native `company_write` of a completed Linux export into a protected proposal, then through the packaged web owner review. The native exact replay creates no duplicate proposal and leaves the live head unchanged. A viewer cannot approve, a changed digest is refused, and the owner downloads the exact pending bytes before approval. A lost response after the SQL commit recovers into the same single revision. The published bytes, original native receipt and immutable source provenance remain intact after the office connection closes and the producing native lease expires. Auth sessions, SQL HTTP, office provisioning/mount admission and the lease-expiry transition are fixtures. `QORPERA_WEB_NATIVE_REVIEW_PROOF_OUTPUT` optionally retains a screenshot.

The local web composition proofs now cover Files, native binary proposal review, office viewing/control/private consent, account cleanup, native activity and non-empty exports. Test hosted PKCE/proxy/TLS/Realtime integration separately. The enabled transfer-boundary audit passes; worker dispatch belongs to Order 5 and isolated coding VM lifecycle to Order 9, and current office transfer APIs refuse isolated-worker paths. Full Step 4 still needs node capacity/operational accounting, combined ordinary workloads, reset/rebuild preservation and final Steps 0–4 review. See [the acceptance ledger](../../deploy/first-node/RUNTIME-STEP-4-ACCEPTANCE.md). No release is authorized by these local checkpoints.
