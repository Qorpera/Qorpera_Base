# Step 10: constitution and hire overlays

Source baseline: `f44e5300a` (`origin/master`, 2026-09-19).
Package: `@qorpera/runtime` 0.83.0. Candidate activation: v37 (master shipped v32 to v36 first).

The existing cloud loop now compiles a shared, 644-word constitution, native
context/turn protocol, admitted identity/bundle binding, and one thin behavioral
overlay. `cloud-runtime-constitution.ts` holds the shared law;
`cloud-runtime-hire-overlays.ts` holds Co-Founder and employee defaults.
Tool schemas, authority, wake policy, model effort and execution remain the
existing kernel's responsibility.

Context v2 adds `agentKind`, selected by the database's canonical company
Co-Founder mapping. Editable names, role descriptions, template labels and
charters cannot select it. The existing charter remains a hash-bound, pageable
source at the admitted staff revision. It supplies mission, responsibilities,
voice and escalation preferences without a second platform prompt or a new
company-state schema. It also supplies `initialAcknowledgementSatisfied` from
canonical progress receipts for the current run and session. The composer
derives `delivery.beforeWork` from that fact, the admitted wake policy and any
continuation, so resumed attempts do not repeat a confirmed acknowledgement.
Transcript text cannot satisfy that gate.

The final JSON context block is `hireOverlay`: identity, name, role, charter
source and the current first-run assignment. Mutable text remains escaped data,
never interpolated into developer instructions. Startup assignments are issued
only on fresh first-run wakes; resumed first runs, ordinary wakes and office continuations retain their
existing continuation rules. No template artifacts or new wakes are created.

The Codex adapter writes one host-owned, read-only `AGENTS.md` in its private
scratch workspace and supplies those exact bytes through `developerInstructions`.
Project-document discovery stays disabled, provider skills stay disabled, and
restored identity homes remain auth-only. This meets the native bootstrap
requirement without allowing a company file or ambient configuration to become
another instruction source. The unsupported Claude lane remains unavailable.

The constitution and overlays describe only advertised capabilities. Workers,
the memory notebook, connector breadth, schedules and coding VMs from Orders 5–9 are
not implemented or certified by this change. Co-Founder formation and employee
responsibility behavior use the same tools, admission, audience and mouth as
other runs.

## Verification

Focused tests cover both roles through the native RPC fixture and direct/HTTP
authority adapters, hostile hire text, exact bootstrap bytes, source pagination,
first-run selection, all five wake policies and bundle drift. These use a
scripted native process and faux authority/provider boundaries, not real model
behavior. SQL context parity uses real PostgreSQL and all migrations, including
canonical versus spoofed Co-Founder identity, legacy private/company audiences,
forged transcript acknowledgements, and a real sponsor handoff with a fresh
assignment and no duplicate greeting. Current product threads and greetings
are shared, following the September 17–18 contract amendments.

[The prompt audit](RUNTIME-STEP-10-PROMPT-AUDIT.md) maps the current contract to
instructions and enforcement, records resolved conflicts, and separates
deterministic regression evidence from outstanding native-model behavior checks.

[Live behavior screening](RUNTIME-STEP-10-BEHAVIOR-SCREEN.md) subsequently exercised
18 synthetic scenarios in 57 real-model trials. It found and corrected pagination
recovery and evidence-reporting weaknesses. The final checks preserve truthful
proposal, continuation, silence and blocker behavior. These screens use official
Codex 0.152 with production prompt/parser components, not the pinned patched
Linux adapter, and do not replace installed-release acceptance.

[The third pass](RUNTIME-STEP-10-BEHAVIOR-PASS-3.md) screened Co-Founder and employee
role behavior and writing quality, composes instructions per wake, and records
why staff agents share one prompt while workers need their own protocol layer.

The task's verification record documents exact hosts, commands, results and
environment differences. It is component evidence, not deployed acceptance.
The current guest-package manifest pins the host bundle rebuilt on Linux x64;
the historical signed v56 package and image recipes remain unchanged.

## Activation boundary

Migration `20260919234000_runtime_hire_overlay_context.sql` and the v37 package
must be rolled out together through the existing drain/package/activation
procedure. Old v1 parsers reject v2 context; do not apply the context migration
to a running old host. Historical v31 activation remains unchanged. If another
runtime activation lands first, allocate the next unused version and regenerate
the manifest/compiled pin before integration; never relabel an existing bundle.

No production migration, package publication or live activation is performed by
this source change. Installed-release verification and live human/first-run,
silent routine, employee and Co-Founder behavior remain rollout acceptance work.
Steps 5–9 and the full launch gates remain independently required.
