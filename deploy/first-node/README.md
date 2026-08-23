# Company41 first-node Step 2 runbook

This directory provisions the first Ubuntu compute node as a fail-closed LXD
full-VM host. It does not make the node an authority for Company File objects,
Compute Identity recovery, checkpoints, or publication. Those authorities stay
outside the provider. The production target is NAS-primary with Supabase
Storage backup; the NAS-disconnected acceptance profile explicitly makes
Supabase Storage active instead of silently failing over at runtime.

## Current non-authorizing checkpoint

The first node has passed the host, KVM, UEFI Secure Boot, private bridge,
locked guest-package, and credential-free clean-boot checks. The accepted local
candidate is still deliberately unsigned:

- node: `company41-node-01`
- image fingerprint: `ad36141eb7956a5be17a82946dc901ace7a2576bfe20b64efb4151e3dfb8a947`
- base fingerprint: `7ef31bed9834094a06517d63b93434588049efcbe2ab5d67419a6167988b7d4f`
- guest-package manifest: `0425306167392328ff7d31573621973869a6a8b26d7b168d3b75855829fefb44`
- clean-boot evidence: `4a42d6c70729df169642e2e219e72b6485fcdcc8bf5513238cf6c5b31f2c1e24`

That candidate was produced during an uncommitted implementation checkout. It
is useful evidence that the boundary works, but it must not receive production
provenance. Rebuild and re-run acceptance from a reviewed clean commit before
signing; the fingerprints and manifest digest will change.

The provider service must remain disabled and `/etc/qorpera/lxd-provider.env`
must remain absent at this checkpoint.

## Signed image provenance

`npm run pack:lxd-provider` emits both the provider and
`qorpera-lxd-image-provenance.mjs`. The latter creates, signs, and verifies a
strict Ed25519 envelope. The signed statement binds:

- the exact LXD image server, image fingerprint, base fingerprint, and locked
  guest-package manifest;
- the immutable nested OCI runner image plus the exact private archive and
  keyless Cosign bundle digests;
- the reviewed HTTPS repository, clean source commit, and clean-tree claim;
- the SHA-256 digest of the retained clean-boot evidence; and
- KVM, UEFI Secure Boot, absent credentials, absent identity volume, and
  fail-closed services.

The provider verifies the envelope against its configured fingerprint and
guest-package manifest before opening the LXD socket. LXD aliases and mutable
image properties are never authorization.

Choose and approve the signing-key custody policy before generating the key.
The private Ed25519 key must not be created, copied, or used on the compute
node. Only its public key and the signed envelope belong under `/etc/qorpera`.

From a reviewed clean checkout, create and inspect a statement with the values
from the newly rebuilt image and retained acceptance evidence:

```sh
test -z "$(git status --porcelain=v1 --untracked-files=all)"
npm run pack:lxd-provider

node .artifacts/lxd-provider/qorpera-lxd-image-provenance.mjs create \
  --image-server local \
  --image-fingerprint REPLACE_IMAGE_FINGERPRINT \
  --base-image-fingerprint REPLACE_BASE_FINGERPRINT \
  --guest-package-manifest-sha256 REPLACE_GUEST_MANIFEST_SHA256 \
  --runner-image REPLACE_IMAGE_REFERENCE@sha256:REPLACE_IMAGE_DIGEST \
  --runner-image-archive-sha256 REPLACE_OCI_ARCHIVE_SHA256 \
  --runner-image-cosign-bundle-sha256 REPLACE_COSIGN_BUNDLE_SHA256 \
  --source-repository https://github.com/Qorpera/Qorpera_Base.git \
  --source-commit "$(git rev-parse HEAD)" \
  --source-tree clean \
  --tested-at REPLACE_CANONICAL_UTC_TIMESTAMP \
  --acceptance-evidence-sha256 REPLACE_ACCEPTANCE_EVIDENCE_SHA256 \
  --output lxd-image-statement.json
```

After independent review, sign with the approved encrypted off-node private key
and verify with its public key. On macOS the passphrase is piped directly from
Keychain to standard input; it is never placed in an argument, environment
variable, repository file, or terminal output:

```sh
security find-generic-password -w \
  -s com.qorpera.company41.lxd-image-provenance \
  -a "$USER" | node .artifacts/lxd-provider/qorpera-lxd-image-provenance.mjs sign \
  --statement lxd-image-statement.json \
  --private-key REPLACE_OFF_NODE_PRIVATE_KEY.pem \
  --private-key-passphrase-stdin true \
  --output lxd-image-provenance.json

node .artifacts/lxd-provider/qorpera-lxd-image-provenance.mjs verify \
  --provenance lxd-image-provenance.json \
  --public-key lxd-image-provenance.pub \
  --image-server local \
  --image-fingerprint REPLACE_IMAGE_FINGERPRINT \
  --guest-package-manifest-sha256 REPLACE_GUEST_MANIFEST_SHA256 \
  --runner-image REPLACE_IMAGE_REFERENCE@sha256:REPLACE_IMAGE_DIGEST \
  --runner-image-archive-sha256 REPLACE_OCI_ARCHIVE_SHA256 \
  --runner-image-cosign-bundle-sha256 REPLACE_COSIGN_BUNDLE_SHA256
```

Install only the public material as root, readable by the provider account but
not writable by it:

```sh
sudo install -o root -g qorpera-provider -m 0640 \
  lxd-image-provenance.json /etc/qorpera/lxd-image-provenance.json
sudo install -o root -g qorpera-provider -m 0640 \
  lxd-image-provenance.pub /etc/qorpera/lxd-image-provenance.pub
```

## Management VM service boundary

`npm run pack:runner-orchestrator` emits one checksum-manifested service
artifact. `install-runner-orchestrator-guest.sh` installs that artifact only
inside the dedicated `company41-orchestrator-01` full VM and leaves it disabled
while `/etc/qorpera/runner-orchestrator.env` is absent. Its rotated control
capability state is private to the `qorpera-orchestrator` account under
`/var/lib/qorpera-orchestrator`.

The provider listens on the host bridge address over TLS and accepts every
endpoint only from the management VM's anti-spoofed static address. For the
first node those addresses are `10.41.0.1` and `10.41.0.2`. The bridge profile
must retain LXD MAC and IPv4 filtering. Install the private CA certificate in
the management VM and configure `NODE_EXTRA_CA_CERTS`; install only the
server certificate and private key on the host. A bearer capability remains
required in addition to both network controls. Job and login VMs must receive
`403` from the provider even if they learn its URL.

The management VM has no LXD socket, `lxd` group membership, Supabase service
role secret, native-provider credential, capsule key, or object-storage
authority. It receives only its orchestrator control capability, the
orchestrator-to-provider capability, the Supabase publishable key, and the
provider CA certificate.

## Common activation gate

Do not create the real environment file or enable the provider until all of
these checks are independently complete:

1. The exact production image was rebuilt and clean-boot accepted from the
   reviewed clean source commit.
2. The signed provenance envelope verifies under the approved off-node trust
   root and matches the environment fingerprint and guest manifest.
3. Real Supabase and orchestrator capabilities are installed without
   placeholders and their network path is restricted as designed.

## Acceptance activation gate

The provider can be enabled for the NAS-disconnected Step 2 acceptance run
after all common checks pass and every object consumer explicitly uses
`QORPERA_OBJECT_STORAGE_PRIMARY=supabase`. The client and
`company-file-verifier` both honor that value; catalog entries and cleanup must
remain `supabase-storage`. Do not configure a fake gateway and do not relabel
this as a NAS topology test.

When an already-published Company File is NAS-backed, run the explicit
promotion workflow before acceptance. The preflight hashes the local checkout
and requires an exact match with the current verified snapshot and reachability
graph. `--apply` then uploads every immutable object to Supabase Storage,
downloads and re-hashes the complete closure, and only afterward invokes the
service-only, GC-fenced catalog promotion RPC:

```sh
export QORPERA_SUPABASE_SECRET_KEY="$(security find-generic-password -w \
  -s com.qorpera.company41.supabase-project-secret -a "$USER")"

node_modules/.bin/tsx scripts/promote-company-file-snapshot-to-supabase.ts \
  --supabase-url https://REPLACE_PROJECT.supabase.co \
  --profile-id REPLACE_PROFILE_UUID \
  --company-root REPLACE_COMPANY_FILE_ROOT \
  --snapshot-id REPLACE_CURRENT_HEAD_UUID \
  --graph-id REPLACE_VERIFIED_GRAPH_UUID

node_modules/.bin/tsx scripts/promote-company-file-snapshot-to-supabase.ts \
  --supabase-url https://REPLACE_PROJECT.supabase.co \
  --profile-id REPLACE_PROFILE_UUID \
  --company-root REPLACE_COMPANY_FILE_ROOT \
  --snapshot-id REPLACE_CURRENT_HEAD_UUID \
  --graph-id REPLACE_VERIFIED_GRAPH_UUID \
  --apply

unset QORPERA_SUPABASE_SECRET_KEY
```

This is an explicit authority change, never a runtime fallback. It leaves the
NAS bytes untouched. When the NAS returns, the existing
`qorpera-object-gateway migrate` path re-hashes the Supabase objects, writes
them to the NAS, and moves catalog authority back only after durable
confirmation.

## Production activation gate

Production additionally requires:

1. `QORPERA_OBJECT_STORAGE_PRIMARY=nas` is selected, the NAS object gateway is
   online, and it rejects unsigned, stale, wrong-company,
   and wrong-Compute-Identity recovery material.
2. Supabase backup replication and restore are proven without permitting an
   implicit authority change when the NAS is unavailable.
3. A replacement-node drill restores a Compute Identity master key inside a
   login VM, proves existing capsules remain decryptable, and records a durable
   recovery receipt.

## Recovery boundary

Today the capsule master key exists only on the persistent per-identity LXD
volume. The provider cannot read it, but loss of that volume loses access to the
identity's encrypted capsules. No local fallback key may be synthesized.

The acceptance recovery path may retrieve the same company-signed,
identity-bound sealed key object from Supabase Storage. The production path
retrieves it from the NAS primary and must prove restoration from the Supabase
backup. Both paths verify company, identity, policy, revision, and signature
before unsealing and reject rollback or replay. The job VM may use the recovered
identity volume only after that flow succeeds. Until the NAS-primary and backup
restore paths have positive and negative tests, this node is not replaceable
and the production storage topology is not complete.
