# Runtime Step 2: cloud secret-custody acceptance

**Status:** Passed for the isolated Step 2 broker/KMS canary; dedicated-login and live native-authority extension passed; signed real-GPT guest proof remains open

**Date:** 2026-08-29

**Normative contract:** [QORPERA-RUNTIME-CONTRACT.md](../../../QORPERA-RUNTIME-CONTRACT.md), sections 4, 11.4, and 11.5

## Acceptance boundary

The canary used only synthetic identities and one random canary credential. It made no model request, used no production connector or provider account, wrote no Company File revision, and published no agent message.

- Azure resource group: `rg-qorpera-step2-secrets`
- Azure region: Sweden Central
- Supabase preview project: `mxkduffilvonpgiakzfq`
- Supabase preview branch: `e6f258a0-2688-4c99-a39a-20ce11f092fc`
- Production Supabase parent: untouched by this acceptance lane

The preview and Azure resource group remain isolated for coordinated production-lane review. This record does not claim that the production database lane has applied or released these bytes.

## Frozen deployed bytes

| Artifact | SHA-256 |
| --- | --- |
| Content-addressed canary archive | `ab2eb79023a6f8fab1358195a9d791954bb4003fdf45447ab64c383cb216e10a` |
| Package manifest | `5f93d023ff59ee8d959c174d81b0cc29d69f7b651667bfe0b944f4c4b7530905` |
| Broker bundle | `4cb09102e1c8b25abdcb00ade3900e7647d0ca0e7eeae0dce7e9f89209361f53` |
| Secret-custody migration | `da086b7539eed0e9583f0be32a79e3f8c077e0e13fba8a085f31e1391caf90cf` |
| SQL acceptance test | `ecf010158f1772a6a36c7fe45bb42caaf3339edb1ce6cb9ae08d7b606d8f9463` |

The VM symlink resolved to the archive SHA above, its broker bundle matched the pinned bundle SHA, and all three canary services were active after the final bootstrap. The final bootstrap restarts already-active units, preventing a new immutable symlink from leaving old code resident.

## Dedicated broker-login and live authority extension

The later least-privilege extension replaced the broker's Supabase
`service_role` credential with a separately authenticated PostgreSQL login.
The broker unit receives a pinned Supabase database CA and bounded database
URL; the synthetic driver retains the service credential separately for test
run setup and recovery. The broker unit cannot read it.

| Extended artifact | SHA-256 |
| --- | --- |
| Content-addressed deployed canary archive | `ba59d83a8699e758f4549daa94d2e510f64526c41a0fab0ce97664cf6ca5b661` |
| Package manifest | `2223971f6994f4da946b71c0cdf80c28224e24a58ddd2734b867791c16db6b67` |
| Broker bundle | `b55d5d51bf13f2e0356e3b97f2a42ff566ebb1df84521f730240e798b80ce4cb` |
| Native cloud-tool authority migration | `1b3ef0fed7d48385422bab10ccf30b93e0e4cd99b60d5b3c98ba36bdda1c18be` |
| Secret-custody migration | `c5135f335bae7a48c5e8bee755ebd92088b07a5d391a85490bcf24dc20a9dd36` |
| Dedicated broker-role migration | `00d72da917d5567986f6f9b001cd6d89b139d1b1f6671661079d236336403a34` |
| SQL acceptance test | `16d674366d101eb3142fc09a4369044ec5975a723ee7be32055a8a72acdbe53a` |

Fresh packaging from the current source matched the deployed manifest and
broker bundle byte for byte. The live database proof connected as
`qorpera_secret_broker` and verified `NOINHERIT`, no elevated role attributes,
no direct secret-table privileges, no `service_role` membership, exactly three
fixed custody functions, and no remaining `service_role` execution of those
functions.

One admitted run then completed a safe effect and four reflection effects.
Raw, URL-encoded, base64, and base64url reflections all returned
`withheld_sensitive_response` while the receipts remained completed. A real
authenticated test administrator revoked the operation grant; the next call
was denied by the broker at effect time, and receipt
`8a28578b-d549-4678-84b3-902c8eae417c` was terminalized and reconciled as
`cancelled / confirmed_not_run`. The run ended failed, its assignment ended
failed, and its native lease is revoked. No unresolved receipt remains.

The revocation proof created two temporary Auth principals. Immutable foreign
keys retained their identities for audit, so physical deletion correctly
failed with SQLSTATE `23503`. Both principals have zero company memberships,
permanent bans, and rotated random passwords. They are audit identities only.

The current-host non-exposure scan derived 33 raw and encoded patterns from
seven encrypted credential classes and scanned 471 persistent files plus the
current system journal. It found zero persistent or journal matches, a
zero-byte reverse-proxy access log, and zero crash files.

An unsigned v53 guest candidate then passed a separate clean-boot negative
boundary preflight in a disposable KVM VM with UEFI Secure Boot enabled. It had
no bootstrap state, Compute Identity or Company File mount, active runner or
model process, Azure workload identity, broker bearer, broker CA, KMS
credential, or secret projection. An operator-only copy of the public canary CA
was introduced solely for the denial probe; the broker returned `404` for an
operation request without its bearer. Azure IMDS was unreachable. The marked
VM was stopped and deleted after the proof. The immutable record is
`unsigned-v53-secret-preflight-20260829T120857Z/evidence.json`, whose SHA-256 is
`338a6e28099015b42fc2f986b178002b7d6c482329ad65187512f9340f739d1e`.

That preflight is intentionally not the signed real-GPT guest proof. The
candidate still has `unsigned-candidate` provenance, and no model was invoked.
A temporary public IP and NSG rule expose TCP 8443 only to the LXD node's exact
egress address for the final signed test. They must be removed, and
private-only TLS restored, when the signed-guest acceptance ends.

## Infrastructure result

- Broker compute is a dedicated `Standard_F1as_v7` Azure VM, separate from model runners and the Company Computer.
- The VM uses Trusted Launch, Secure Boot, vTPM, and a system-assigned managed identity. The baseline ended with no public IP; the dedicated-login extension temporarily attached the restricted proof route described above.
- Key Vault has purge protection, RBAC, an approved private endpoint, default deny, zero IP rules, and public-network access disabled.
- Broker credentials are `LoadCredentialEncrypted` projections sealed with `host+tpm2`; there is no plaintext environment fallback.
- Storage has shared-key access disabled, default deny, zero IP rules, and one broker-subnet rule. Public-network mode remains enabled only because Azure service-endpoint rules use that mode.
- The operation broker and canary destination bind to `127.0.0.1`; the member-capture proxy was exercised over TLS and its temporary public IP and NSG rule were then deleted.
- Reverse-proxy access logging is disabled.

## Behavioral acceptance

| Gate | Result |
| --- | --- |
| Company-owned capture | Version 1 committed through the typed TLS capture route; the response was a closed descriptor. |
| Normal use | Exact admitted run, receipt, grant, pinned adapter, destination, and envelope produced one completed effect. |
| Response reflection | Raw, URL-encoded, base64, and base64url credential reflections were all replaced by `withheld_sensitive_response`; effects remained completed. |
| Lost response | The first downstream response was dropped; retry used the same idempotency identity and returned `reused: true`. |
| Broker restart | A post-restart effect completed without local or plaintext fallback. |
| Stalled destination | The request failed closed within the adapter deadline and was not published. |
| Encrypted recovery | A Key Vault backup restored into a separate vault and the restored value matched exactly. Backup SHA-256: `8018810782373068f7f78c382b102bd3303dfbfb579bd13cdc974c5ba7578519`. |
| Rotation | The authority moved to `company-kek-2`; immutable secret version 2 was captured and used successfully. |
| Old-key deletion | The live keyring contains only KEK-2. Two older Key Vault versions containing KEK-1 are disabled; an exact final-artifact effect still completed. |
| Grant revocation | The same live run was denied at effect time after its operation grant was revoked. |
| Agent archive | Archiving revoked all agent grants while the company secret remained active at version 2. |
| Member removal | Removing a synthetic member revoked that member's credential and left the company credential active at version 2. |
| Fixture closure | Final runner lease released, agent archived, active grant count zero, and unresolved canary receipt count zero. |

## Non-exposure evidence

The final VM scan generated raw, URL, base64, and base64url patterns from the protected provider token, service key, runtime bearer, broker capability, and active KEK inside root-only `/dev/shm`. It reported:

- persisted matches: `0`;
- journal matches: `0`;
- reverse-proxy access-log bytes: `0`; and
- crash files: `0`.

A full `public,auth` data-only dump of the isolated preview contained `0` raw or encoded secret matches across 150,455 bytes. Final control-plane inspection reported:

- model requests: `0`;
- public sends: `0`;
- Company File revisions: `0`;
- Company File proposals: `0`;
- completed canary receipts: `10`;
- unresolved canary receipts: `0`;
- effect-authorized audit events: `15`; and
- capture/rotation audit events: `3`.

The database stores ciphertext, hashes, closed results, and private audit provenance. It never received the plaintext canary.

## Verification commands

The final source passed:

- five focused Vitest files: 21 tests;
- three Node packaging/bootstrap tests;
- `bash -n` for bootstrap and credential refresh;
- `npm run test:cloud-secret-custody`: the SQL suite passed after all 90 migrations in disposable PostgreSQL;
- `npm run check`: no remaining diagnostics; and
- final source-to-package regeneration plus exact deployed bundle/hash comparison.

The extension additionally passed 22 focused broker/HTTP/adapter/destination/tool tests, 38 LXD provider/runtime tests, 19 guest-bootstrap tests, four packaging tests, custody SQL after all 91 migrations plus the upgrade fixture, and a new full `npm run check` with no diagnostics.

## Provisioning disclosures

- Azure Blob data-plane RBAC allowed listing but did not authorize the non-secret artifact upload during this canary. Each upload therefore used a bounded provisioning exception: the operator IP rule and shared-key access were enabled only for the upload and removed by a trap. Final state is shared-key disabled with zero IP rules.
- An earlier disposable Supabase preview was deleted immediately after its service key appeared in operator-tool output. That deleted project invalidated the key; all recorded acceptance used the replacement preview listed above.
- The temporary restore vault was deleted into its seven-day, purge-protected recovery state after the restore comparison. Disabled historical KEK versions remain recoverable only through explicit Key Vault operator authority, as required by the recovery contract.
- `systemd-creds` warned that its host credential secret file was not itself on encrypted media. Every projected credential was nevertheless encrypted with the combined host and TPM2 policy, decrypted successfully only on the Trusted Launch VM, and revalidated after Key Vault became private-endpoint-only.

Production connector adapters, OAuth/API-key UX, and connector-to-browser escalation remain Step 7. Production database application and release acceptance remain with the coordinated Step 2 production lane.
