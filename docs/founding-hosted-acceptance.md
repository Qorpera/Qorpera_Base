# Hosted payment and multiplayer acceptance

`scripts/acceptance/founding-stripe-hosted.mjs` creates a disposable PostgreSQL cluster, real Supabase Auth/PostgREST processes, private SMTP capture, and a private build of the production web client. Two independent browser contexts sign in through real email OTP. Each buys a computer plan through the production Plan & usage page and Stripe's hosted test-card form. Genuine signed Stripe CLI deliveries pass through the production billing handler and its separately enrolled bridge credential into that same database.

The same two members then create a company, invite and join, explicitly contribute their 74 + 286 funded hours, co-sign a revised vision, and launch from the noncreator's session. Lost launch replies and concurrent founder replay must produce one materialized turn with the frozen roster/vision and the launcher's own model sponsorship. A solo company reuses the first member's global balance without duplicating or debiting it before physical execution.

Both the hosted composition and the default offline founding harness use the production CompanyBootstrapProvisioner, object store, durable journal and replication staging path. They verify real filesystem bytes and SHA-256 digests against the published snapshot and complete closure. The actual object HTTP handler reauthorizes reads with each real member session; the second founder is denied before joining and remains denied from the separate solo company. The default offline harness retains explicitly labeled invoice and model-account fixtures.

## Run on a disposable Linux host

Use an unprivileged Linux x86-64 account with native PostgreSQL 17, Node 24, OpenSSL and Chromium dependencies. `scripts/acceptance/founding-install.sh <new-absolute-tools-directory>` installs checksum-pinned Auth v2.197.0 and PostgREST 16.4 plus the repository-pinned Playwright Chromium. Supply a separately reviewed Stripe CLI 1.52.0 binary; the runner checks its exact version and refuses symlinked or group/world-writable binaries. It does not download or install Stripe automatically.

Create a private, current-user-owned regular file containing only a dedicated `sk_test_…` key, with mode 0600. Never pass the key on the command line. The runner rejects live keys, public files and symlink aliases. Do not provide production credentials, a remote database or an existing company: there are no arguments for them.

```sh
node scripts/acceptance/founding-stripe-hosted.mjs \
  --bin /usr/lib/postgresql/17/bin \
  --tools /absolute/private/founding-tools \
  --out /absolute/new/evidence-directory \
  --stripe-cli /absolute/private/stripe \
  --stripe-key /absolute/private/stripe-test-key
```

The output directory must be new. The runner creates only tagged, owned test-mode products/prices, customers, Checkout sessions and subscriptions. Cleanup expires open sessions, cancels subscriptions and deactivates prices/products. Customers and their canceled financial history remain as test evidence. No email is sent externally: Auth mail is captured by the local SMTP service. Ordinary founding navigation is restricted to the private origin; external HTTPS browser requests are enabled only during the one hosted-payment phase and disabled even if that phase fails.

`evidence.json` and `checkout-details.json` contain bounded test identifiers, checks and cleanup results. Private OTPs, sessions, webhook bodies/signatures and credentials are not artifact outputs. A failed external cleanup retains private reconciliation state and marks the run failed; do not delete that state before resolving owned objects. A concurrent subscription webhook may receive the expected reconciliation-busy 503; the harness retries its exact original signed bytes within signature validity, requires convergence, then repeats the paid invoice to prove one bucket. It never fabricates a replacement Stripe signature.

## Evidence boundary

The retained local macOS-adapter run `checkout-retained-dd2f63b0-9bd3-456c-876d-20209bb054a5` passed at merged source commit `2434c8ad6` with all 461 migrations, native PostgreSQL 17.11, Auth v2.197.0 and PostgREST 16.4. Both actual hosted test-card purchases funded one bucket each, concurrent subscription reconciliation retried its original signed delivery successfully, and multiplayer/solo creation and immutable bootstrap publication passed. Eight member-authorized file reads and the before-joining/solo nonmember refusals passed. Both subscriptions were canceled through genuine deletion deliveries; owned payment cleanup passed. The checkout was clean and all 3,062 retained source-file hashes match that commit exactly. This is actual payment/client/database evidence with an explicit macOS process adapter; it is not the joined Linux physical run below.

This proves hosted **test-mode** purchase, invoice authority, local object publication, real member reads and multiplayer/solo startup materialization together. Model-login completion remains an explicit, separate fixture for each member. It does not spend model tokens or prove external ChatGPT OAuth, model inference, physical computer dispatch, physical NFS, remote Storage replication, hosted Realtime, deployed webhook endpoints or production rollout. The pending object replica journal is not reported as healthy remote durability. The joined Linux runtime acceptance must consume the exact resulting company/run and a controlled faux-model boundary before claiming physical startup continuity.

Run the focused harness safeguards without external payments:

```sh
node --test scripts/acceptance/founding-bootstrap.test.mjs \
  scripts/acceptance/founding-stripe-hosted.test.mjs \
  scripts/acceptance/founding-payment-scope.test.mjs \
  scripts/acceptance/founding-services.test.mjs
```
