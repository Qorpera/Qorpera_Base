# Runtime room history and release identity

Room admission appends the canonical human transcript event in the same SQL transaction as the accepted input. This includes rooms with no eligible agents and wakes awaiting materialization. The input UUID is also the canonical event UUID, so replay and later materialization cannot add a second copy. The migration repairs previously accepted room inputs by appending missing events, including closed rooms; it does not rewrite existing event bodies, hashes, or sequence numbers.

The public `qorpera_read_session_events` RPC continues to enforce the established session audience: company members may read company-room history, while room membership gates posting. An explicit public agent send may include an optional `staff_speaker` object beside the event body:

```json
{"run_id":"UUID","staff_agent_id":"UUID","staff_version":1,"display_name":"Bob"}
```

The server derives the identity from the event's execution run and its exact session, company, and environment. It captures the display name only while the staff registry still has that run's staff version. Otherwise `display_name` is null. This projection is separate from the existing hash chain and cannot be updated through the public API. Staff renames do not relabel recorded replies. Older unresolvable speakers remain unknown; the web client never substitutes the human sponsor or current room membership for the speaker.

The web transcript still accepts only `qorpera.agent-send/v1` progress/final deliveries for public agent text. Speaker metadata does not authorize raw provider assistant output. The parser validates the closed metadata object and binds its run UUID to the event's execution UUID.

The native provider login proxy accepts browser requests only from the exact HTTPS origin `https://app.qorpera.com`. Its OPTIONS response permits POST with Authorization and Content-Type. Error responses for that origin carry the same CORS policy. Native callers without Origin retain capability authentication. Deploy the updated edge function along with a web build configured with the accepted public native-login URL; changing web configuration alone cannot enable browser access.

`web-deployment.json` records the measured Git `sourceCommit`, `sourceDirty`, canonical `runtimeBundleSha256`, and the runtime manifest file's `runtimeManifestSha256`. Release builds reject dirty source (excluding local AGENTS.md instructions) and a mismatch between the manifest and generated runtime identity. Freeze and verify the candidate runtime bundle before building the release; these fields identify the artifact and do not themselves prove live runtime acceptance.

## Verification

- `node --test supabase/functions/native-provider-login/native-provider-login.test.ts`
- `node --test packages/web/scripts/provenance.test.mjs`
- In `packages/web`: `npx vitest run test/room-speaker.test.ts test/transcript.test.ts`
- `node scripts/test-runtime-room-history.mjs` creates a disposable local PostgreSQL database with the complete migrations and real room/wake/native-send fixtures. It verifies zero-recipient persistence, replay, authorization, no materialization duplicate, immutable speaker projection, and migration repair of accepted historical messages. It never targets a configured hosted database.
