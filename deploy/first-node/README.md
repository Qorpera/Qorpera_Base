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
  --guest-package-manifest-sha256 REPLACE_GUEST_MANIFEST_SHA256
```

Install only the public material as root, readable by the provider account but
not writable by it:

```sh
sudo install -o root -g qorpera-provider -m 0640 \
  lxd-image-provenance.json /etc/qorpera/lxd-image-provenance.json
sudo install -o root -g qorpera-provider -m 0640 \
  lxd-image-provenance.pub /etc/qorpera/lxd-image-provenance.pub
```

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
