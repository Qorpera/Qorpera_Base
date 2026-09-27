# Joined founding and native execution acceptance

This is a disposable-host test, not a deployment command. The CLI joins the
actual two-member browser founding flow to the same materialized run, actual
bootstrap object publication, production orchestrator/provider, governed native
Codex process, independent paid guard and the isolated allowance ledger.

**Physical joined acceptance is not yet recorded.** The retained local browser
tests prove Auth, member operations, real bootstrap publication and exact normal
orchestrator claim. TLS/DNS/capsule tests prove the local protocol boundaries.
They do not prove guest boot, native inference transport or physical settlement.

By default, the computer plans in this CLI use disclosed canonical test-invoice
funding fixtures. The optional hosted-payment mode below instead purchases both
plans through the real member UI and Stripe test Checkout, then carries those
same members, funded balances, company, bootstrap store and materialized run
through physical execution and debit. Its physical result is still pending;
the separately retained hosted scenario proves purchase through founding only. External model OAuth is
synthetic: each member still creates its own identity/login/sponsor through real
member-authenticated RPCs, then the test completes that login with a synthetic
credential. The fresh identity volume receives its matching marker/key before
the real bootstrap. The capsule uses the actual production encryption format.
There are no real model credentials, model charges, production companies or
production database migrations.

## Host and immutable inputs

Use an empty disposable Linux x86-64 machine with actual KVM, systemd, LXD,
`nft`, OpenSSL, Python3, Node ≥22.19 and at least **6 observed CPUs and 12 GiB
observed RAM** (a 16 GiB machine avoids nominal-versus-usable RAM differences).
The current 2-CPU/8-GiB host cannot run this test. The preflight refuses it
before creating a VM.

Install PostgreSQL17 and the hash-pinned Auth/PostgREST/browser dependencies
using the existing founding acceptance installation instructions. The isolated
unprivileged account must have access to the LXD Unix socket and the tools.
LXD must have an empty `dir` pool and a working image-builder network. No
existing VM, guard journal or guard service may share this test host.

Provide these actual immutable artifacts, without changing release pins:

- A Linux guest package built from the current checkout, containing the pinned
  native Codex0.155.1 artifact and exact signed runner OCI archive. For isolated
  feature-branch acceptance, use the test packaging command below. Production
  packaging and release freshness enforcement remain separate and unchanged.
- The SHA256 of that package's `manifest.json`, with package files root-owned
  and not group/world writable.
- A locally imported Ubuntu26.04 VM image's full fingerprint. The preparation
  CLI will not replace a missing fingerprint with a moving image alias.

The existing production image installer runs inside that image. Only an
ephemeral acceptance CA is added to the resulting test image; no production
certificate or authentication key is imported. The private CA key never enters
the guest, package, public evidence directory or upload artifact.

The retained inputs were checked again on 2026-09-27. Native artifact
`a7531592e69dbbeeda6c11f279547e5d48328eb54beec98ac6511f67f18194df`
matches the pinned source and patch. Cosign 3.1.3 independently verified the
retained runner archive `c9370c825bdbd589bf0c1391e567b8f5ea8ba36161cc554b32fcfb235f046239`
against the exact committed certificate identity, issuer, workflow source,
repository, ref and trigger, with transparency verification enabled. This
verifies the existing inputs; it does not build a current guest image or prove
joined execution. Physical acceptance still requires the host described above.

## Build an isolated test package

On Linux x64, with a new output directory and the verified native/signed image
artifacts already available:

```sh
node scripts/acceptance/founding-native-package.mjs \
  --out /opt/founding-package-test \
  --native-company-artifact /opt/verified-native-codex \
  --signed-runner-image /opt/verified-signed-runner
```

The wrapper uses the existing `runtimeBundlePackagingEnvironment` test hook.
It bundles current sources while preserving the committed runtime identity
embedded by the native host; it does not regenerate or relabel release files.
The production packager still verifies exact native source/binary pins and signed
image archive/bundle digests. All packaged files must exist and match their
manifest; a contract-only package is refused. Existing output is never replaced.

`/opt/founding-package-test/evidence.json` records `testOnly: true`, the current
source manifest/digest, the committed identity, and the resulting guest manifest
digest. Source identity is checked again after packaging. Use its `package`
directory and `manifestSha256` in the preparation configuration, after ensuring
the files are root-owned and not group/world writable. Retain this evidence with
the acceptance report; it is not a verified release, deployment authorization,
or physical execution result.

With `QORPERA_ENFORCE_RUNTIME_BUNDLE=1`, the wrapper invokes the real strict check
and does not install the test hook; stale release files still fail before output
creation. Inherited `NODE_OPTIONS` hooks are refused in either mode.

## Run

Write a root-owned mode0600 JSON configuration, with real paths and digests:

```json
{
  "schema": "qorpera.founding-native-preparation/v1",
  "disposableHost": true,
  "account": "acceptance",
  "uid": 1001,
  "gid": 1001,
  "workRoot": "/opt/qorpera-founding-one",
  "out": "/tmp/founding-native-evidence",
  "binDirectory": "/usr/lib/postgresql/17/bin",
  "tools": "/opt/founding-tools",
  "guestPackage": "/opt/current-guest-package",
  "guestPackageSha256": "REPLACE_WITH_64_HEX_SHA256",
  "ubuntuImageFingerprint": "REPLACE_WITH_64_HEX_FINGERPRINT",
  "storagePool": "default"
}
```

```sh
sudo node scripts/acceptance/founding-native-prepare.mjs --config /root/founding-preparation.json
sudo -u acceptance env NODE_EXTRA_CA_CERTS=/opt/qorpera-founding-one/ca.pem \
  node scripts/acceptance/founding-native-joined.mjs \
  --host /opt/qorpera-founding-one/host.json
```

For one continuous hosted purchase → founding → native execution → paid debit,
add both explicit payment arguments to the second command:

```sh
sudo -u acceptance env NODE_EXTRA_CA_CERTS=/opt/qorpera-founding-one/ca.pem \
  node scripts/acceptance/founding-native-joined.mjs \
  --host /opt/qorpera-founding-one/host.json \
  --stripe-cli /opt/private/stripe \
  --stripe-key /home/acceptance/private/stripe-test-key
```

Use the protected Stripe CLI 1.52.0 and current-user-owned mode0600 `sk_test_…`
key described in [hosted acceptance](founding-hosted-acceptance.md). Live keys,
an incomplete argument pair, unsafe executables and wrong versions are refused.
Host/CA/resource preflight runs before payment setup. No payment is made by the
preparation command or by fixture mode. Hosted mode reuses the production
Checkout/webhook handler and never falls back to invoice fixtures on failure.
Native closure and settlement precede owned subscription cancellation and
listener shutdown; failed payment cleanup also retains the accounting database.
Private keys, raw webhook bodies and signatures never enter public evidence.

Preparation first verifies the actual `/usr/bin/node` used by the guard and
captures the protected host mount-namespace record as root; the observer gets
no extra capabilities. It retains a private `host.json` before creating physical resources, installs
the actual image contract, publishes an image with no inherited profiles,
creates a separate empty profile/bridge and starts the production native guard
as an independent supervised service. The fixed model/platform listeners bind
only to that private bridge. The firewall redirects only the two allowlisted
model hosts' synthetic destination to local TLS and drops all routed guest
IPv4/IPv6 traffic. It never flushes unrelated firewall tables.

Before installing the synthetic identity, the actual guest must demonstrate
external IPv4/IPv6 refusal, synthetic DNS and trusted TLS, and refusal of an
uncredentialed financial request. A failed proof aborts bootstrap. The guest
receives an opaque execution gateway key, not the host's service JWT or paid
executor secret. The gateway permits only fixed execution RPCs and this guest's
exact encrypted capsule; billing/enrollment/permit endpoints stay inaccessible.

The model fixture requires the exact immutable founding receipt in the real
Responses request and emits a scripted governed `send_message` final call.
The CLI requires actual job completion, physical deletion, observed guard
samples and exact ledger reconciliation before reporting success. A model
request or assignment alone is insufficient.

## Evidence and failure cleanup

Upload only the configured evidence directory. Never upload `workRoot`, private
PostgreSQL/Auth logs, the CA key, guest provider logs, capsules or browser
storage. The public report contains identifiers/digests, network assertions,
model-boundary observations and measured allowance reconciliation.

On a failed physical closure or later cleanup step, the test chooses database
retention before attempting diagnostic writes. Even failed marker writes cannot
permit the outer harness to delete that accounting database. It retains private evidence and reports
cleanup failure. Keep the independent guard running. Do not delete its durable
journal, release allowances manually, assume an absent VM proves cancellation,
or reuse the failed host for another acceptance run. Inspect the exact retained
allocation and physical custody before teardown. After successful acceptance,
destroy the disposable host; all resources and the acceptance CA are local to
it. A production rollout still requires its own approved release/enrollment.
