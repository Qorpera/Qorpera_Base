# Qorpera member web client

An independent static browser application for the shared Company Computer. It uses `@qorpera/cloud-client`; the headless runtime, cloud authority and view gateway own execution, grants and machine lifetime. This package contains no Electron bridge, native runner, provider credentials or service key.

The app supplies public-project sign-in with PKCE, company selection, computer start/status/cancel, agent grants, browser profile consent, private sign-in and account-level cleanup after membership removal. Opening a company opens its Company Computer. Screens require explicitly configured WSS transport. Closing the app preserves durable office and privacy state.

The governed Company File panel (snapshot-v1: browsing, text edits, uploads, exports, binary review and presence) is gone with snapshot-v1; a folder-v2 company's files are in the web app (`packages/web`). `src/files.ts` keeps only the browser download helper the web app's folder view uses.

Account events cancel old account/company operations synchronously. Token refresh for the same member preserves current work. Late responses cannot populate a new account. Sign-out clears only this app's session/PKCE namespace and reloads even if the Auth service is unavailable. No Auth SDK call is awaited inside an Auth state callback.

## Unpublished local package

Create a public JSON configuration with exactly these fields:

```json
{
  "schema": "qorpera.member-web-config/v1",
  "supabaseUrl": "https://YOUR-PROJECT.supabase.co",
  "publishableKey": "sb_publishable_YOUR_PUBLIC_KEY",
  "officeViewerOrigin": "wss://YOUR-VIEWER.example"
}
```

Use `null` for `officeViewerOrigin` when screen viewing is unavailable. These are canonical origins without a trailing slash, path, credential, fragment or query. Remote origins require HTTPS/WSS; HTTP is accepted only for disposable `127.0.0.1` proofs. Service keys and member tokens are refused.

From the repository root, run `node scripts/package-member-web.mjs --out NEW_DIRECTORY --config PUBLIC_CONFIG_JSON`. This only writes a new local directory. It emits self-contained JS, styles, HTML, public config, the noVNC license, deployment headers and an asset hash manifest. It checks the vendored viewer against its recorded checksums and refuses runtime/desktop/Node adapters or external modules in the artifact. The HTML and header CSP limit requests to configured origins. The static server must apply `_headers` (or equivalent HTTP headers); `frame-ancestors` requires an HTTP header.

Before hosting, register the exact HTTPS app root as the Auth redirect destination, enable the chosen login providers, and configure the view gateway for that origin. OAuth redirects and email delivery require hosted acceptance. Never infer these endpoints from desktop defaults. No hosting, login-provider setup, production activation or release is performed by the packager.

## Local evidence and remaining verification

The full repository check compiles this DOM-specific project separately and bundles its actual entry under the browser boundary gate. Run the named tests from this package: `node ../../node_modules/vitest/dist/cli.js --run test/account.test.ts test/config.test.ts`. Package boundary tests are `node --test scripts/package-member-web.test.mjs scripts/check-headless-packages.test.mjs` from the root.

`QORPERA_WEB_TEST_BROWSER=/path/to/chromium node scripts/test-member-web-browser.mjs` runs the actual static package, Auth SDK, HTTP and DOM against disposable fixture services. It verifies that a company opens its computer with no Files panel, start/grant recovery, browser profile consent, cleanup, account cancellation of a pending computer read and sign-out storage. `QORPERA_WEB_PROOF_OUTPUT` optionally retains an inspected screenshot. Auth/control responses are fixtures; this proof does not claim actual SQL authorization or a physical office.

`scripts/test-member-company-file-upload.mjs` (`QORPERA_WEB_SQL_TEST_BROWSER`), which ran this package against real SQL through the old Company File path gateway, was deleted with snapshot-v1 in the legacy sweep (B2b).

`QORPERA_WEB_OFFICE_TEST_BROWSER=/path/to/chromium node scripts/test-member-office-catalog.mjs` (deleted in the legacy sweep) connects the actual static package and Auth SDK to real disposable SQL and the TLS viewer gateway. Native browser WebSockets and noVNC verify watch pixels, input blocking, control after drain acknowledgement, lost viewer/profile/privacy replies, account cancellation, ordinary-member private input, explicit reconnect/exit and separate consent. Two prepared profiles exercise independent account cleanup, refusal of changed consent, and both revocation and private exit after membership removal. `QORPERA_WEB_OFFICE_PROOF_OUTPUT` optionally retains screenshots. Only the disposable certificate's SPKI is trusted by the test browser; system trust is unchanged. Auth sessions, SQL HTTP transport, guest RFB pixels and physical drain/privacy acknowledgements remain fixtures. No Electron bridge is used.

`scripts/test-runtime-company-presence.mjs` (`QORPERA_WEB_PRESENCE_TEST_BROWSER`) and `scripts/test-member-file-exports.mjs` (`QORPERA_WEB_EXPORT_TEST_BROWSER`, `QORPERA_WEB_NATIVE_REVIEW_TEST_BROWSER`) proved the Company File panel's presence, exports and native proposal review against real SQL; they were deleted in the legacy sweep, and the panel with step C (C2).

The local web composition proof covers office control, private consent and account cleanup. Test hosted PKCE/proxy/TLS integration separately. The enabled transfer-boundary audit passes; worker dispatch belongs to Order 5 and isolated coding VM lifecycle to Order 9, and current office transfer APIs refuse isolated-worker paths. Full Step 4 still needs node capacity/operational accounting, combined ordinary workloads, reset/rebuild preservation and final Steps 0–4 review. See [the acceptance ledger](../../deploy/first-node/RUNTIME-STEP-4-ACCEPTANCE.md). No release is authorized by these local checkpoints.
