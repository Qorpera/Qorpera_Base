# Cloud hardening backlog

This backlog tracks the non-blocking findings from the PR #27 architecture review. The blocker, retention, recovery, and sandbox/operations passes are not repeated here. Each item needs a focused regression before it is closed.

## Identity, invitations, and collaboration

- [ ] `COLLAB-1` Authenticate and lock the profile/session before event-append and promotion idempotency lookups so replay cannot become an existence oracle or race its authority check. Gate: broader hosted beta.
- [ ] `COLLAB-2` Define invitation behavior for an existing member: apply an authorized role change or reject without consuming the invitation. Gate: broader hosted beta.
- [ ] `COLLAB-3` Add the leave-profile RPC referenced by current error copy, or remove that product promise. Gate: broader hosted beta.
- [ ] `COLLAB-4` Replace free-text sync retry classification with structured hosted error codes. Gate: broader hosted beta.
- [ ] `MAIL-1` Compare invitation and cleanup worker secrets in constant time. Gate: public worker endpoints.
- [ ] `MAIL-2` Rate-limit invitations and constrain sender identity text to reduce outbound spam and impersonation. Gate: public invitations.
- [ ] `MAIL-3` Make manual resend respect an active delivery lease and expose an accurate result instead of resetting in-flight work. Gate: support tooling.

## Object storage, retention, and portability

- [ ] `OBJECT-1` Stream-limit Edge request bodies without relying on `content-length`, and cap runner-broker object responses while reading rather than after buffering. Gate: arbitrary runner payloads.
- [ ] `OBJECT-2` Add a service repair path for content-addressed objects whose stored bytes do not match their hash path. Gate: durable customer objects.
- [ ] `OBJECT-3` Remove successful and abandoned `cloud-company-previews/<uuid>` directories under bounded lifecycle rules. Gate: broader hosted beta.
- [ ] `OBJECT-4` Retire completed-artifact reachability roots when they no longer protect a retained reference, without weakening GC safety. Gate: automatic retention cleanup.
- [ ] `OBJECT-5` Enforce one lowercase profile-prefix representation across Storage RLS, server lookup, and upload paths. Gate: automatic retention cleanup.
- [ ] `OBJECT-6` Canonicalize both destination and target ancestors on macOS before containment comparison so `/tmp` and `/private/tmp` do not false-reject valid materialization. Gate: packaged macOS app.

## Runner and provider operations

- [ ] `RUNNER-1` Align the sandbox socket deadline with the 120-second gateway deadline so one logical idempotent request cannot trigger a duplicate provider call. Gate: any paid provider call.
- [ ] `RUNNER-2` Bound output directory depth and total entries, not only regular-file count and bytes. Gate: arbitrary execution images.
- [ ] `RUNNER-3` Verify the configured image digest against the expected Cosign identity and issuer at runner startup, not only during image build. Gate: first real runner.
- [ ] `RUNNER-4` Prove absent one-time credentials across the supported systemd versions or switch to the documented tolerant credential mechanism. Gate: Linux acceptance.
- [ ] `RUNNER-5` Derive lease-expiry decisions from server time or include an explicit skew allowance instead of trusting the worker clock. Gate: multi-host runner pool.
- [ ] `RUNNER-6` Select named service credentials deterministically from `SUPABASE_SECRET_KEYS`; never choose an arbitrary long entry. Gate: key rotation.

## Desktop privacy and message fidelity

- [ ] `DESKTOP-1` Replace the ±30-second exact-text attended-message heuristic with a durable message identity so legitimate repeated prompts are not dropped. Gate: broader hosted beta.
- [ ] `DESKTOP-2` Delete account-bound hosted profile rosters and emails on sign-out, with an explicit offline-data retention choice if needed. Gate: shared-device support.
- [ ] `DESKTOP-3` Expire the cached offline account projection instead of reporting an authenticated identity indefinitely. Gate: shared-device support.
