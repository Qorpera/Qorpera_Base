# Interaction card release

The web changes correct historical unsupported form/sign-in card copy. They work
with the current v126 runtime. The agent's question-selection guidance and new
form/sign-in refusals require the separate v128 runtime rollout.

## Canonical activation sequence

Master's account-name release owns v127, bundle
`805ab4b63afe7b359a3ea8895531a2342cafbea8fbadad33e7c2e8535d33be0e`,
in `20260926000100_runtime_bundle_activation_v127.sql`. Preserve it unchanged.
The conflicting fleet v127 activation was never applied or published to master
and has been retired. Fleet implementation is included in the combined v128.

v128 is bundle
`172c21af11c3a074f872f93ce5a2967451361c03113d45d6bef338df4e20c10d`.
Its activation requires the exact canonical v127 predecessor under a row lock.
Older, newer, repeated and competing activations are exercised by
`node scripts/test-runtime-bundle-activation.mjs` in disposable PostgreSQL.
The Linux host package pin must match the generated v128 artifact.

## Source merge and runtime rollout

Merging publishes the web changes through the configured Cloudflare production
branch. Repository CI does not apply production SQL or install runtime hosts.
The runtime rollout must be coordinated separately; do not apply all pending
migrations or treat a green preview as proof of live agent behavior.

At the fleet owner's 26 September 2026 14:43 UTC readback, production was still
v126 and neither v127 activation was applied. Both nodes were enabled and
eligible. Fleet SQL and host preparation had already been deployed separately.
Re-read this state before any runtime cut. Account-name SQL is also already
applied; follow its rollout document when reconciling the migration journal.

Remaining fleet acceptance requires a legitimate fresh office scope with current
image metadata and a successful authorized cross-node coding command. Host-admin
access must be restored before that acceptance can continue. Keep these gates
with the fleet rollout owner; source merge does not certify pooled provisioning.

After that acceptance, build and deploy the signed combined runtime through the
governed release process, reconciling canonical v127 and v128 in the coordinated
activation sequence. Verify both node artifact identities, then test natural
requests in the app: an open-ended question stays in chat, a needed bounded
decision creates a question card, and an email draft opens its own review card
without an extra question card. Record deployment and behavior evidence before
claiming the new guidance is live.
