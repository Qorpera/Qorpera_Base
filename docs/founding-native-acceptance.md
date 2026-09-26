# Joined founding and native execution acceptance

This is a disposable-host test, not a deployment command. The CLI joins the
actual two-member browser founding flow to the same materialized run, actual
bootstrap object publication, production orchestrator/provider, governed native
Codex process, independent paid guard and the isolated allowance ledger.

**Physical joined acceptance is not yet recorded.** The retained local browser
tests prove Auth, member operations, real bootstrap publication and exact normal
orchestrator claim. TLS/DNS/capsule tests prove the local protocol boundaries.
They do not prove guest boot, native inference transport or physical settlement.

The computer plans in this CLI use the disclosed canonical test-invoice funding
fixtures from the browser scenario. Real hosted Stripe checkout and genuine
webhook acceptance are a separate retained scenario. External model OAuth is
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

- A current Linux governed runner guest package containing the patched native
  Codex0.155.1 artifact and the signed runner OCI archive. Use the existing
  `scripts/package-lxd-runner-guest.mjs` procedure with
  `--native-company-artifact` and `--signed-runner-image`. Its normal release
  provenance checks remain mandatory; a stale package is not current proof.
- The SHA256 of that package's `manifest.json`, with package files root-owned
  and not group/world writable.
- A locally imported Ubuntu26.04 VM image's full fingerprint. The preparation
  CLI will not replace a missing fingerprint with a moving image alias.

The existing production image installer runs inside that image. Only an
ephemeral acceptance CA is added to the resulting test image; no production
certificate or authentication key is imported. The private CA key never enters
the guest, package, public evidence directory or upload artifact.

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
