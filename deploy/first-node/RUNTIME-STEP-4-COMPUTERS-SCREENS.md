# Runtime Step 4 — Company Computer and agent screens

Date: 2026-08-28; updated 2026-08-30. Independent implementation handoff; **not a deployment or live acceptance record**.

## Status and provenance

The independently owned components and all findings recorded below are
implemented and tested in `/Users/jonas/.codex/worktrees/5ced/Qorpera_Base-step2`.
The two recovery gaps identified on 2026-08-30 are corrected, with focused
regressions and a subsequent re-review. This is component completion, not
runtime integration or live cloud acceptance.
The components are intentionally not registered in the current application,
native host, runner or provider. The main runtime owner must supply the
adapters below before enabling them. Missing adapters have no permissive
implementations or local execution fallback.

- Starting and final HEAD: `a0b692947d5c867353591b36172afcc997f0521e`, detached worktree. No commits were created.
- Selectively reused source: read-only `/Users/jonas/.codex/worktrees/step3-remaining-ops`, branch `codex/step3-remaining-ops`, HEAD `2d72b74eadc6f1e81ccce65512b210bd9fd9fb7b`.
- Relevant older changes: `ecac1c78e603c5c0b524c71bc80ff4f2de47a939` (assigned-screen bridge), `422cc847e146a613aeb85a5ccf525f5106825e36` (on-demand screens), `7ae33c823c94c7a14ac76b2424bead63adf23b3d` (screen/VM power), `234209e9f3f38a4da3e915dcee8de0e10a8cd06e` (viewer lifecycle), `39258429432507ae5a38c5628aa8b7db82e45473` (NAS guest alignment; its raw authority assumptions are superseded).
- Appearance restoration reuses `companyComputerScreenCreature`, the explicit read/write wallpaper publication and XFCE setup from that same `2d72b74e...` reference. It also honors the starting worktree renderer's persisted `appearance.creature` override; shared renderer/staff files remain unchanged.
- Governing contract: `/Users/jonas/.codex/worktrees/27d4/Qorpera_Base-step2/QORPERA-RUNTIME-CONTRACT.md`, worktree HEAD `18181de7f2698c9f44347a7ee141eebead84bc35`. Initial working-tree snapshot SHA-256: `f6c9836df26c313bab133b6d77465749ecb14b023e6b71f44fb850a25d919ede`. Current reviewed snapshot, rechecked for these corrections on 2026-08-30: `a8a68b8605dc2a8ad01148ad6697e3a58b813b305b7b65286e8054d0895c8245`.
- Step 2 interface reference: read-only `/tmp/qorpera-step1-client-release.JLmEex/source`, HEAD `a0b692947d5c867353591b36172afcc997f0521e`, including its uncommitted `cloud-native-tool-authority.ts`, `cloud-native-tool-operations.ts`, `cloud-native-tool-boundary.ts` and `cloud-native-run-tool-session.ts`. Those files were inspected, not copied or changed. Their eventual integrated versions remain authoritative.

No other sessions were contacted or created. No reference worktree was changed.
No production calls, migrations, NAS configuration, credential operations,
service restarts, image activation, releases, commits, pushes or merges occurred.
No skills or sub-agents were used.

## Audit: implementation, historical evidence and gaps

The older infrastructure's “Step 3” is this contract's **Step 4**, not the wake bus.
The four requested infrastructure documents and the corresponding provider,
guest, screen, viewer, browser wrapper and registry implementations were inspected.

| Area | Existing implementation/evidence | Current-contract disposition |
| --- | --- | --- |
| Shared persistent VM | LXD company provider, durable journal, NAS-backed storage, image replacement retaining persistent volumes, idle stop/restart. | Reuse the provider lifecycle selectively. Do not import its old single `activeAssignment` / `max_assignments: 1` runner admission into the new runtime; power must account for all resource leases. Provider remains unchanged here. |
| Agent desktops | XFCE/TigerVNC, ordinal/display/port conventions, agent attachment, ensure/open, idle closure, agent wallpapers, desktop settings and Chrome. | Preserve one shared company computer and parallel work surfaces. Add exact company/environment/logical/physical-generation/screen-generation bindings and fail closed on absent state. Restore the agent wallpaper and XFCE defaults; screens are not separate company-data security silos. |
| Occupancy | Registry leases and a runner DISPLAY bridge. Older renewal tolerated failures, and the guest broker trusted run/staff identifiers without sufficient live authority. | Never retain control after failed renewal or degrade a refused computer action to another machine. New handles abort on failure; current Step 2 authority must admit every claim and effect. |
| Viewer | Private TCP gateway, one-use capability, local WebSocket bridge and vendored noVNC. | Old redemption-only checks and ambient VNC input are insufficient. New watch/control modes are enforced in the server byte stream, grants expire, open viewers recheck access, and control requires acknowledged takeover. |
| Browser state | Persistent per-display Chrome profiles, shared storage, guest launchers. | Old `screen-<ordinal>` directories need explicit adoption into UUID-keyed state, not a fresh directory or symlink fallback. The non-executing plan and procedure below preserve identity and require explicit profile disposition. The broker checks current UUID/version grants and retains adopted bytes across close/recovery. Provider credentials never move through this path. |
| Company File | Older documents and guest wrappers directly open `/srv/qorpera/dataset/live` and describe NAS as canonical authority. | Superseded by runtime contract §§12–12.2. Workbench is noncanonical. Company File access needs the governed mount/projection/gateway; no unrestricted NAS alias may survive inside computer execution. |
| Screenshots | Older periodic recording and capture infrastructure. | New model screenshots publish through an injected immutable asset/audience boundary. Ambient periodic recording is not wired; any recording integration must apply current privacy/read authorization, especially during sign-in. |
| Agent computer use | The older DISPLAY plumbing and local automation components existed. | Historical live evidence did **not** establish agent control. New model/guest adapters have component tests only; native cloud acceptance remains open. |

### Historical proof is not current authorization

`STEP-3-FIRST-MACHINE.md` expressly limits its proof to viewing/lifecycle,
**without agents controlling the computer**. It records source
`e21a78e504396e823ff70cb6825baa2068465a65`, later corrected source
`6854fb643551dc23e564cf606da342a7f11f46dd`, and v2 image fingerprint
`614dce363812ca0f32f39cb7eb7e6d2d4439a4c5b3fca633d2a2afa8f4a15ec2`.
It describes real XFCE/Chrome/Files viewing, approximately 15-minute screen idle
closure, 5-minute machine idle stop, and reopening. The first background-only
frame was not the complete desktop proof. The runner reached a dormant-lane
401; that is not successful agent execution.

The same document records a clean-boot v3 candidate with fingerprint
`ec5821bef522ef95e820be7692833ac359b6d18b990a4310a214ca1087417c11`, signed
provenance staged but not live activation. These are historical documentary
claims, not observations made during this task. No historical activation or
maintenance command was rerun. In particular, prior approval of direct NAS
authority does not override the current runtime contract.

## Implemented components

- **Registry transition module:** ensure/open, stable agent assignment, bounded capacity, close/detach/retire, reusable physical slots with fresh generations, exact claim/renew/release, viewer presence, idle sweep and recovery generation. It is a pure projection/transition module, not a new database or authorization service. Stale cleanup cannot release a replacement or refresh its activity.
- **Occupancy handle and action interlock:** bounded 30-second leases, monotonic local deadlines, live checks, renewal failure cancellation, exact cleanup, one in-flight action per physical screen, and takeover that waits for actual drain. An explicit screen open can retry a confirmed refusal before lease admission; uncertain admissions and failed/revoked established leases cannot retry this way. Browser cancellation remains armed through final authorization and asynchronous shutdown. A timeout or failed browser shutdown does not free the screen. Generation replacement needs a supervisor proof; uncertain shutdown remains quarantined.
- **Model tools:** version `qorpera.company-computer-tools/v2`: `computer_screen` (`open`/`release`), `computer_browser`, `computer_desktop`, `computer_shell`, `computer_screenshot`. Browser `list_tabs`/`select_tab` recover an existing multi-tab context through opaque, lease-scoped handles and bounded previews. Closed argument parsers expose no host, company, agent, display, profile path or credential selector. Each operation carries the existing logical key, version, exact target and resource identities through Step 2 operations. There is no executor, queue or provider integration in this module.
- **Guest receiver:** validates operation/lease/receipt targeting, invokes the existing effect-check adapter before dispatch and result release, shares the screen gate, and drains the browser channel on cancellation/failure. Screen release occurs after the existing operation's final check; it releases occupancy, not persistent desktop state. Authorized member controls or idle reconciliation close power.
- **Established automation:** installed Chrome through `playwright-core` persistent contexts, explicit tab discovery/selection, role/name page actions and accessibility snapshots before pixels, password-field fill refusal, screenshot masking as defense in depth, X11 input through `xdotool`, and shell/capture through the existing contained command runner adapter. Typed pre-input ambiguity, unavailable tab IDs and already-closed targets preserve the browser only after a fresh authority check; terminal failures never silently reopen or retry. Shell is bounded to 15 seconds, output to 16 KiB; browser tab closure never silently switches the target. Screenshot receipts validate dimensions, digest, asset identity and size.
- **Guest lifecycle:** generation-aware XFCE/TigerVNC reconciler, readiness checks, failed-start retry, failed-stop quarantine, exact live VNC resolution and restore from durable cloud state. The reused wrapper now takes a screen UUID, checks display/port/path consistency, separates desktop state from workbench, sanitizes child environments, waits for X/window-manager readiness and cleans child process groups. Whole-service/cgroup proof remains the supervisor's responsibility.
- **Existing-state adoption plan:** pure mapping of verified legacy screen/agent identities and explicit browser-profile dispositions to the new UUID directories. Rejects ambiguous or substituted mappings; ungranted profiles remain quarantined. It is not a migration executor or authorization grant. The current boundary must require the existing journal's completed adoption or explicitly empty inventory before startup.
- **Desktop appearance:** restored image-owned agent wallpaper publication by explicit read/write and atomic rename, including current persisted creature overrides. The wrapper requires that screen's wallpaper and runs the reused XFCE settings inside its clean D-Bus environment before the desktop starts. Unrelated desktop configuration is preserved; ambient Chrome and raw Company File launchers remain excluded.
- **Viewer:** reused noVNC overlay/CSS and private TCP/loopback WebSocket topology; watch is the default. Takeover/release use fresh cloud connections. Reconnection never silently retargets or resumes control. The gateway drops watch input, clipboard transfer in both directions and client desktop-resize requests. Server framing streams image payloads unchanged while removing legacy and extended ServerCutText, including coalesced handshake bytes. Native renderer origin and one-use URL allowlisting are required. Errors do not echo service diagnostics or capabilities.

The RFB framing follows [RFC 6143](https://www.rfc-editor.org/rfc/rfc6143), plus
the bounded noVNC/TigerVNC extensions already used by the vendored client.
The vendored noVNC bundle and license notice are unchanged from the reference:

- `novnc-rfb.js`: SHA-256 `ea8c20928abd8b8a71c4f75a12504a6c46dccc9f4e172dd443c47cc416711c36`.
- `NOVNC_LICENSE.txt`: SHA-256 `3ccd2242d7f5b6c5ae831a486f63cce1f18d8cd11c511f6a7a7251673763b2d1`.

## Review corrections and re-review

The first four reported findings were corrected in this worktree:

| Finding | Correction and regression evidence |
| --- | --- |
| P1: guest clipboard reached watch/control clients | Added a bounded streaming server RFB parser; all guest bytes, including transport remainder, pass through it. Both legacy and extended ServerCutText are discarded. Corrected the ExtendedClipboard pseudo-encoding to `0xc0a1e5ce`; `-309` is XVP. Loopback watch/control tests cover both transport paths, malformed output, and pixels containing clipboard-shaped bytes. |
| P2: final authorization could acknowledge a fence before browser shutdown | Moved cancellation/failure drain ownership into the action gate. The listener remains installed through final authorization; fence acknowledgement waits for both the actual operation and successful browser drain. Rejection, cancellation during stalled final checks, delayed shutdown and failed shutdown have regressions. |
| P2: ordinary targeting errors permanently closed the browser | Added a narrow trusted `CompanyComputerActionNotStartedError` for target/tab ambiguity before input. These failures preserve the existing browser only after final reauthorization. Composed endpoint/gate/guest tests prove a subsequent snapshot works without relaunching. Authority rejection and cancellation still shut down; error strings alone do not authorize recovery. |
| P2: retired rows exhausted all 32 ordinals | `ensure` reuses inactive physical slots with increasing generations while respecting active capacity. A 100-retirement regression proves capacity remains available. A registry/gate regression requires acknowledged generation replacement and rejects the old binding. Retirement history remains in the existing event journal. |

The second review checked dispatch/result authorization, failure cleanup,
takeover drain, slot reuse, both viewer directions and framing against the
unchanged vendored decoders. It also corrected zero-area ZRLE framing and
rejects empty Tight palette rectangles whose retained noVNC state would make
subsequent framing ambiguous. That component review did not cover two reuse
gaps subsequently found by the instruction-compliance review:

| Instruction-compliance finding | Correction and regression evidence |
| --- | --- |
| P2: no explicit adoption of old `screen-<ordinal>` state | Added `planCompanyComputerStateAdoption`, the procedure below and mandatory boundary/adoption disposition hooks. Pure tests reject wrong identities, ambiguous mappings and implicit grants. A local synthetic fixture demonstrates desktop/profile byte preservation across the explicit path change and fake-browser restart, with startup denied for pending adoption or revoked grants. No actual migration ran. |
| P3: agent wallpapers and XFCE defaults omitted without disposition | Reused the old creature mapping, wallpaper publication and XFCE properties in computer-specific helpers. Tests cover explicit appearance overrides, persistent settings, changed binding/abort/alias failures, and the actual Bash helper with fake X11/XFCE commands. Image packaging, live rendering and governed dock launcher integration remain explicit hooks. |

These checks do not verify the missing runtime adapters, real Chrome/VNC
rendering, cookie decryption or live cloud actions.

The follow-up re-review checked the non-executing plan, binding/ambiguity/grant
dispositions, adoption refusal before profile creation, retained source and
desktop bytes, and the actual XFCE helper's argument and failure paths. Both
instruction-compliance findings are addressed at component/handoff level; no
additional actionable issue was found in those changes. The adoption-completion
adapter, real copier, image packaging and cloud acceptance remain prerequisites.

### 2026-08-30 reassessment and recovery corrections

This reassessment supersedes the earlier blanket conclusion that no further
instruction mismatch remained. Original work items 2, 3 and 5 require usable
recovery and browser interaction with focused regression coverage, not only
safe rejection. Two gaps were found inside this track's ownership and are now
corrected without replacing the shared runtime, executor or authorization framework:

| Finding | Correction and regression evidence |
| --- | --- |
| P2: a refused screen acquisition permanently poisons the tool session | Added `CompanyComputerScreenAdmissionRefusedError`, emitted only by the authenticated registry adapter after a definitive occupancy/capacity refusal with no lease admitted. `createCompanyComputerTools` permits a later explicit `computer_screen.open` under fresh run authority; other actions do not replay or trigger reacquisition. Factory regressions cover both refusal reasons, concurrent retries sharing admission, string-only/uncertain failures, post-claim failure, revoked established leases, fresh run checks and cleanup racing recovery. |
| P2: an existing multi-tab browser has no page-level recovery path | Added closed `list_tabs`/`select_tab` actions and Playwright page selection inside the authorized context. IDs are scoped to the automation instance/profile and admitted lease ID/epoch/run; renewal retains them, replacement invalidates them. Lists contain at most 10 bounded previews with a continuation cursor. The composed profile/endpoint/gate/guest regression now selects between two distinct existing pages through the model action contract, without altering the page list. Additional tests cover selected-page input/screenshots, reorder/renewal, foreign/stale IDs, pre-input closure recovery, cancellation/drain, revocation and output bounds. |

Before correction, the existing suite passed 185 tests; temporary probes of the
actual tool/guest components confirmed both failures using authority/browser
doubles. Those probes were removed. The corrections add 32 regressions and
strengthen the former ambiguity/closed-target tests. **Final focused suite:
11 files, 217 tests passed** on 2026-08-30 (23:17:32, 2.14 seconds). The two edited
test files account for 70 tests. `npm run check` passed after correcting two
test-fixture typing errors; its final run reported no formatting fixes or diagnostics.

The subsequent re-review checked admission provenance, explicit retry only,
terminal established leases, cancellation/cleanup races, tab-handle scope and
invalidation, preview bounds, pre-input recovery versus uncertain in-flight
failures, and dispatch/result authorization. No additional actionable issue was
found in these corrections. No real browser, live cloud or native Step 2
integration was exercised; the required adapters and acceptance gates remain open.

The governing reference was read again at the same HEAD, with current contract
SHA-256 `a8a68b8605dc2a8ad01148ad6697e3a58b813b305b7b65286e8054d0895c8245`.
It now includes the organizational operating model ratified on 2026-08-29.
The initial implementation provenance above remains the original snapshot;
this reassessment applies the current shared-computer and authority requirements.
No reference worktree, protected shared implementation or operational system
was changed, and no other session was contacted or created.

## Changed-file manifest

The 34 files below are new/untracked except the appended shell changelog entries.
No shared runtime, runner, sandbox, mouth, Company File authority, package
metadata, lockfile, migration, release or deployment script was modified.

| File | Purpose |
| --- | --- |
| `packages/shell/src/cloud-company-computer-contract.ts` | Binding/lease invariants, v2 tool version and structural Step 2 adapter contracts. |
| `packages/shell/src/cloud-company-computer-state.ts` | Pure registry transitions and provider power intent. |
| `packages/shell/src/cloud-company-computer-leases.ts` | Confirmed admission-refusal contract, expiring lease handle, per-screen interlock, takeover/replacement fencing. |
| `packages/shell/src/cloud-company-computer-tools.ts` | Model-facing closed parsers, explicit admission recovery, tab schemas and existing-ledger dispatch. |
| `packages/shell/src/cloud-company-computer-endpoint.ts` | Guest dispatch/effect-check adapter composition. |
| `packages/shell/src/cloud-company-computer-guest.ts` | Persistent profile broker, lease-scoped tab discovery/selection and Playwright/X11/shell/screenshot adapters. |
| `packages/shell/src/cloud-company-computer-adoption.ts` | Pure legacy-state path/identity mapping with explicit profile dispositions; no migration execution. |
| `packages/shell/src/cloud-company-computer-desktop.ts` | Reused creature selection and bound wallpaper publication. |
| `packages/shell/src/cloud-company-computer-screens.ts` | Guest desktop lifecycle/recovery and readiness. |
| `packages/shell/src/cloud-company-computer-rfb.ts` | Bounded RFB/WebSocket framing and input classification. |
| `packages/shell/src/cloud-company-computer-rfb-server.ts` | Streaming guest-output framing and clipboard egress filter. |
| `packages/shell/src/cloud-company-computer-viewer-gateway.ts` | Private, expiring watch/control gateway. |
| `packages/shell/src/cloud-company-computer-view.ts` | Bound member connection and one-use renderer bridge. |
| `packages/shell/userland/screen-viewer.js` | Viewer state machine with explicit takeover and fresh reconnect. |
| `packages/shell/userland/screens.css` | Reused screen/viewer styling with control states. |
| `packages/shell/userland/vendor/novnc-rfb.js` | Unchanged existing noVNC bundle. |
| `packages/shell/userland/vendor/NOVNC_LICENSE.txt` | Unchanged existing license notice. |
| `packages/shell/test/fixtures/company-computer.ts` | Test-only identities, registry fixtures and deferred promises. |
| `packages/shell/test/cloud-company-computer-state.test.ts` | Binding, assignments, occupancy, takeover, expiry, idle and recovery. |
| `packages/shell/test/cloud-company-computer-leases.test.ts` | Renewal/revocation, cancellation, actual drain and generation fencing. |
| `packages/shell/test/cloud-company-computer-tools.test.ts` | Admission recovery/refusal, runtime adapter dispatch, receipts, tab targeting and failed-drain quarantine. |
| `packages/shell/test/cloud-company-computer-guest.test.ts` | Profile filesystem persistence, scoped tab recovery, cancellation and automation adapter behavior. |
| `packages/shell/test/cloud-company-computer-adoption.test.ts` | Legacy/new path mapping, binding, ambiguity, explicit disposition and unsafe-root regressions. |
| `packages/shell/test/cloud-company-computer-desktop.test.ts` | Wallpaper byte/state preservation and real Bash XFCE helper with fake commands. |
| `packages/shell/test/cloud-company-computer-screens.test.ts` | Guest reconcile failures/recovery and loopback readiness. |
| `packages/shell/test/cloud-company-computer-rfb.test.ts` | Framing, extensions, clipboard/input separation and bounds. |
| `packages/shell/test/cloud-company-computer-rfb-server.test.ts` | Fragmented/mixed server encodings, clipboard egress, malformed output and size bounds. |
| `packages/shell/test/cloud-company-computer-view.test.ts` | Loopback gateway/client/bridge, expiry, revocation and reconnect constraints. |
| `packages/shell/test/cloud-company-computer-viewer-ui.test.ts` | Actual UI state machine with fake DOM/noVNC. |
| `deploy/lxd-company-computer-guest/qorpera-screen-session` | Selectively adapted, inactive computer desktop wrapper. |
| `deploy/lxd-company-computer-guest/qorpera-screen-xfce` | Reused XFCE appearance setup, invoked inside the wrapper's clean per-screen D-Bus session. |
| `deploy/lxd-company-computer-guest/README.md` | Guest adapter, containment and activation prerequisites. |
| `deploy/first-node/RUNTIME-STEP-4-COMPUTERS-SCREENS.md` | This handoff. |
| `packages/shell/CHANGELOG.md` | Unreleased entry, explicitly describing inactive components. |

## Verification

Local environment: Node `v24.18.0`, npm `11.12.1`, Vitest `4.1.9`.

Dependency setup used `npm ci --ignore-scripts`. The fresh checkout initially
lacked ignored provider model JSON; `npm run hydrate:model-data` generated that
data without changing tracked AI/model code. No lifecycle scripts or new
dependencies were introduced. Initial lint/type failures were corrected.

Final focused suite (2026-08-30): **11 files, 217 tests passed**. From `packages/shell`:

```sh
node ../../node_modules/vitest/dist/cli.js --run \
  test/cloud-company-computer-state.test.ts \
  test/cloud-company-computer-leases.test.ts \
  test/cloud-company-computer-tools.test.ts \
  test/cloud-company-computer-guest.test.ts \
  test/cloud-company-computer-adoption.test.ts \
  test/cloud-company-computer-desktop.test.ts \
  test/cloud-company-computer-screens.test.ts \
  test/cloud-company-computer-rfb.test.ts \
  test/cloud-company-computer-rfb-server.test.ts \
  test/cloud-company-computer-view.test.ts \
  test/cloud-company-computer-viewer-ui.test.ts
```

Additional checks from repository root:

| Check | Result |
| --- | --- |
| `npm run check` | Passed on 2026-08-30 after these corrections: Biome, pinned dependencies, TS imports, cloud boundaries, shrinkwrap/install-lock, TypeScript, repository browser bundle smoke. |
| `node --check packages/shell/userland/screen-viewer.js` | Passed. |
| `node --check packages/shell/userland/vendor/novnc-rfb.js` | Passed. |
| `bash -n deploy/lxd-company-computer-guest/qorpera-screen-session` | Passed; syntax only, not Linux desktop startup. |
| `bash -n deploy/lxd-company-computer-guest/qorpera-screen-xfce` | Passed; helper behavior is additionally tested against fake commands. |
| `git diff --check` | Passed for tracked changes. |
| Handoff manifest against Git status | All 34 changed files accounted for; no missing, extra or duplicate entries. Only the shell changelog is a tracked modification. |
| Vendor hashes against reference | Identical for bundle and notice. |

Tests use authority/ledger/supervisor/browser/command/asset test doubles, real
temporary profile directories and real **loopback-only** TCP/WebSocket
connections. The synthetic screenshot header is not a captured desktop; RFB
fixtures verify wire framing, not rendering or successful JPEG/H264 decoding.
Adoption tests copy synthetic temporary files only; they do not migrate an
existing machine, transfer real cookies or validate Chrome/keyring compatibility.
Wallpaper tests use synthetic image bytes. XFCE tests execute the actual helper
against fake `xrandr`, `xfconf-query` and `xfce4-session`, not a running desktop.
The repository browser smoke is a bundle check, not a rendered viewer test.
No full Vitest suite, `npm test`, `npm run build`, live model/provider request,
Electron visual acceptance or real cloud computer action was run.
Admission-retry tests inject the required registry refusal classification; they
do not prove a real registry transaction's outcome. Tab tests use separate fake
Playwright pages and synthetic metadata, not a running Chrome tab strip.

## Required runtime integration hooks

### 1. Existing Step 2 native-tool session and effect ledger

Register the returned `createCompanyComputerTools(...).tools` in the existing
`runCloudNativeRunToolSession` **`options.tools(identity, operations, run)`**
factory. Pass the existing `CloudNativeToolRun` and `CloudNativeToolOperations`;
do not construct another principal or ledger. Compose with the existing context
read-set check. Arrange `await computerSession.close()` in the owning host's
`finally`; the inspected factory currently returns tools/assertContext, not a
resource-cleanup callback. Abort on native/run shutdown as well.

Pin the registered computer tool bundle to **`qorpera.company-computer-tools/v2`**
on both native and guest sides. Its closed browser schema includes `list_tabs`
and `select_tab`; do not register the older schema or bypass exact version checks.

`CompanyComputerRunIdentity` is only a structural projection. It is **not**
sufficient authority: retain Step 2's full admitted identity, including job,
runner, assignment, lease, compute identity, staff/sponsor/provider versions,
session and authorizing member. Never cast this subset into an authority grant.

`CompanyComputerGuestEffectCheck.assertAuthorized` must revalidate that full
identity, exact operation target, live screen lease, resource/profile grants,
privacy handoff and destinations. In `perform`, the receipt UUID and downstream
idempotency digest must resolve to the existing admitted unfinished effect;
checking their syntax alone is insufficient. Preserve the existing ledger's
uncertain-result reconciliation. A failed/ambiguous browser click or shell
action must not be replayed under a new operation key.

Keep every browser/shell/error/asset result inside `CloudNativeToolBoundary`.
Its inspected envelope limit is 8 KiB and it owns truncation/provenance and
untrusted-data fencing. Do not bypass it to display a larger snapshot. The
inspected native adapter has text/JSON results only: **authorized immutable
screenshot asset references still need its image-context reader**. Do not send
raw images or storage URLs through an unfenced parallel channel.

### 2. Existing authenticated registry and resource leases

Implement `CompanyComputerScreenLeaseControl` with the existing control plane.
`acquire` must atomically ensure/open the admitted agent's screen and claim it,
under the company registry/screen lock. `check`, `renew` and `release` must use
the exact lease ID, driver, epoch and all binding fields. Server time must bound
the returned remaining milliseconds by the minimum of run, member, screen,
resource and profile authority, never more than 30 seconds.

For a definitive `SCREEN_OCCUPIED` or `SCREEN_CAPACITY_EXHAUSTED` refusal, the
adapter may throw **`CompanyComputerScreenAdmissionRefusedError(reason)`** only
after the authenticated control plane confirms that no lease was admitted.
Do not classify by an error string or HTTP status alone, and never map an
uncertain transport outcome, timeout, authority denial or post-claim failure to
this type. After that marker, only a fresh explicit `computer_screen.open`
retries acquisition under current run authority. Concurrent opens share the
pending acquisition; no browser/shell operation has been admitted or replayed.
All other acquisition failures stay terminal for this tool session and require
the existing admission reconciliation. Successful release, expiry, revocation
and cleanup do not enable reacquisition through the same handle.

Apply `transitionCompanyComputerScreens` only after live authorization inside
the existing transaction. Persist projection, events and applicable receipt
atomically. The caller supplies `now` from the server, generated IDs and the
current generation; none comes from a model-supplied registry. Store no company
authority in a desktop-local state file. Replace legacy long-lived leases at
integration, rather than interpreting them as current grants.

Screen rows identify reusable physical slots. Use the binding returned by the
transition, not the proposed `newScreenId`: an available retired/detached slot
keeps its screen UUID/ordinal and increases its generation. Preserve retirement
events in the existing journal. Before opening the reused slot to a new driver,
apply `replaceBinding` with its previous binding, fresh binding and supervisor
proof; neither a recycled ordinal nor a new staff assignment erases old fences.

Takeover sequence:

1. Authorize the member and `begin_takeover`; invalidate the old driver and bump epoch.
2. Publish that exact fence through the existing control channel. Call the shared guest gate's `fence(binding, epoch, signal)` and stop/drain all older control work.
3. Confirm input cleanup, including held keys/buttons and existing viewer/control channels. Do not treat an HTTP response timeout or wrapper PID exit as a drain acknowledgement.
4. With fresh member/profile checks and matching computer/screen generations, `complete_takeover` using the acknowledged epoch; then mint a **new** control viewer session/capability.

An expired pending takeover remains fenced until explicit authorized
revocation/recovery. Never auto-grant a new driver while old effects may still
run. Watcher cleanup is exact-session scoped. Member input must share the same
physical-screen interlock as agent actions, through the `forwardInput` adapter.

### 3. Existing guest supervisor, provider and containment

Implement `CompanyComputerScreenLauncher` using the existing guest supervisor
and the included wrapper. `ready` needs authenticated registry binding plus
Xvnc/XFCE readiness. `stop` and `exited` must prove the **whole service/cgroup**
and control channels are reaped, including detached descendants. `launch`
must honor cancellation; a hung/uncertain supervisor must not start a second
process for the slot. The wrapper's readiness line alone is not authentication.

Before launch, under the existing serialized guest reconcile, resolve the
current template and persisted creature from the same authorized staff-agent
record as `binding`. Call
`prepareCompanyComputerScreenWallpaper({ binding, layout, boundary, templateId,
creature }, signal)` and whitelist its `wallpaper` result as
`QORPERA_SCREEN_WALLPAPER` alongside the four directory variables. Repeat on
authenticated appearance changes; do not accept an asset path from model input.
The helper preserves the old explicit read/write publication because direct
`copyFile` failed across image/VirtioFS. Keep the existing image's seven
`/usr/share/backgrounds/qorpera-screen-<creature>.png` assets and package the
included executable at `/usr/local/bin/qorpera-screen-xfce` when separately
authorized. Missing/mismatched wallpaper or helper prevents wrapper startup.
Run preparation with the verified desktop state's writer identity/UID mapping:
new state directories are mode `0700`, the published wallpaper is `0600`, and
the desktop wrapper must be able to traverse/read them. Verify this through the
existing supervisor/boundary; do not relax provider/profile isolation or chown
existing NAS paths as an implicit workaround. No such ownership change ran here.

The XFCE helper restores the wallpaper, image-style 5, hidden desktop icons,
enabled native desktop menu and disabled dock shadow. The image-owned dock
remains an integration prerequisite: preserve its presentation, but route
Chrome through the explicit profile broker and Files/Terminal through governed
Company File access and the noncanonical workbench. Do not copy old launcher
commands into the image or adopted desktop settings without reviewing them.

One `CompanyComputerScreenActionGate` must be shared by all endpoints and member
input on that physical guest. On generation change use `replaceBinding` only
with the supervisor's actual replacement proof. Failed-drain quarantine must
not be erased by making a second gate: if shutdown cannot be proven, recover
the guest/service under the existing provider's verified stop/restart contract
before constructing fresh in-memory gates. Reset stale control leases and bump
`computerGeneration`; mark the registry active only after readiness.

Feed `companyComputerPowerIntent` **all** active resource leases, not one runner
assignment. Recheck the registry revision and leases atomically before physical
power changes. Preserve maintenance stops and existing rollback infrastructure.
This file does not change LXD provisioning, images, volumes or journal formats.

`CompanyComputerGuestBoundary.assertReady` is mandatory and must verify actual
instance/generation, mount/alias absence, protected control/credential paths,
profile access, network policy and assigned display channels. A Linux platform
check, clean environment or safe-looking path is not containment. In particular,
arbitrary shell must not reach another display/raw RFB/CDP socket, provider
process environment or the profile broker's storage. Shared company work
remains shared; private work still belongs in isolated workers.
For an existing computer it must also require the completed adoption disposition
below. Unresolved legacy state must not be treated as a fresh empty computer.

### 4. Browser grants, typed sign-in, commands and governed file/asset access

Supply `CompanyComputerBrowserAccess.assertGranted` from the existing grant
authority, including owner, company/audience, profile lease/version and privacy
handoff. Share the persistent profile manager within the guest. Its directories
are broker-owned and cannot be read directly by arbitrary shell/file-manager
paths. Grant revocation must revoke access and close automation channels;
renewing provider access does not grant browser-profile access.

For existing tabs, use `computer_browser` actions `{ kind: "browser", action:
"list_tabs" }` and `{ kind: "browser", action: "select_tab", tabId }`. Listing
returns `tabs: [{ tabId, titlePreview, urlPreview }]`, `selectedTabId` and
`nextAfterTabId`. Supply a non-null cursor as `afterTabId` on the next `list_tabs`
call. Each page contains at most 10 rows; title and URL previews are capped at
128 and 256 JSON-encoded UTF-8 bytes respectively, leaving space in the native
8 KiB envelope. The previews are untrusted data. A closed cursor requires a
fresh listing, not index-based retargeting.

The opaque UUID handles refer only to pages in the already-granted browser
context, exact screen and automation instance. They confer no authority. A
changed lease ID/epoch/run or a new guest automation instance invalidates IDs
and selection; ordinary renewal and tab reordering do not. Do not persist IDs
across restart or translate arbitrary CDP/page indexes into these handles.
Selection uses Playwright `bringToFront` through the existing effect path and
pins subsequent page actions/screenshots to that page. Listing does not select,
open, close or navigate tabs. A closed selected page requires explicit selection
of another listed page; pending work never silently switches to a surviving tab.

Typed pre-input target/tab ambiguity, unavailable IDs and already-closed targets
preserve the browser only after the guest gate rechecks authority. A failure
or closure during dispatched automation remains uncertain and terminal, as do
cancellation and revocation. Attach a new browser/automation endpoint only after
actual drain and fresh run/screen/profile checks. Do not reopen silently or
replay uncertain effects.
Pass `drainOnFailure` when using the screen gate with a persistent control
channel; the supplied guest endpoint already wires it to `stopBrowser`.

Before password/OTP entry, the existing typed sign-in handoff must suspend
agent control, screenshots/recording and unauthorized viewers and wait for
acknowledgement. Periodic viewer rechecks are bounded (at most 5 seconds), not
an instantaneous privacy barrier. Password masking/fill refusal is secondary
protection, not the sign-in mechanism. Replace the old ambient Chrome dock
launcher with the authorized browser/profile hook before enabling the image.

Implement `CompanyComputerGuestCommands.run` with the existing contained
runner, including exact environment, workbench cwd, process-tree cancellation,
output bounds and resource provenance. Supply `capturePng` using the existing
scrot capturer with a private temporary file, bounded read and cleanup. Do not
substitute the member's computer broker, browser, filesystem or DISPLAY.

Expose Company File access only through Step 2's governed live
mount/projection/mutation gateway. The workbench contains tools/caches and
unadmitted working bytes. Browser downloads are disabled in this adapter;
typed imports/exports need explicit authorized realm transfer with immutable
asset identity. `CompanyComputerScreenshotPublisher.publish` must use the
existing asset/audience/receipt path; no new storage credential system is added.

### 5. Viewer gateway and app composition

Implement `CompanyComputerViewerAuthority` with existing member auth and the
single-use capability ledger: fresh membership/privacy checks at redemption,
expiry/revocation/generation checks for open viewers, audited effect-time input,
and exact-session release. Each control connection needs its own acknowledged
member lease/session. `forwardInput` receives sequence/hash/bytes but must not
log raw keystrokes or sign-in secrets; its forward callback is one-use and
invalid after settlement. `check` must never change mode or silently substitute
a principal/lease. A new capability alone must not resurrect a revoked grant.

Implement `CompanyComputerViewerGuestTransport.connect` by resolving the exact
registry/journal binding, authenticating the guest leg, checking readiness and
returning a paused socket plus any coalesced bytes. RFB 3.8/None is confined
behind that boundary; raw loopback access from model processes is forbidden.
The retained TCP topology requires the existing authenticated encrypted private
network/tunnel; the code's private-address check is not transport authentication.
Do not publish this gateway directly to the internet.

The viewer pins the wrapper's 1920×1200, 32-bit/24-depth true-color format in
both RFB directions. Retain the server parser on every output path, including
coalesced guest-handshake bytes. It bounds buffered chunks to 256 KiB, clipboard
messages to 64 KiB, rectangle bodies to 16 MiB, updates to 64 MiB and 4,096
rectangles. Unknown encodings, unsafe format changes and malformed framing
disconnect rather than bypass the filter. Clipboard transfer requires a
separate governed typed interaction; it is not restored by enabling control.
Check actual image/decoder compatibility in cloud acceptance before activation.

In the app, wire the existing trusted-renderer IPC/allowlist to:

- `connectCompanyComputerScreenView({ host, port, capability, binding, mode, signal })`, with endpoint/capability resolved by the authenticated cloud adapter, never model input.
- `startLocalScreenViewWebSocketBridge(view, { origin, registerRendererUrl })`, using the exact trusted renderer origin and existing one-use URL allowlist.
- `window.qorperaScreenViewer.open({ binding, title, requestConnection, releaseConnection, onClosed })`, loading `screen-viewer.js` as a module and `screens.css` through the normal userland packaging.

`requestConnection({ binding, mode, signal })` must validate the trusted IPC
sender and current member/company, perform the required cloud open/takeover,
mint a fresh capability, and return only `{ connectionId, url, binding, mode }`.
`releaseConnection({ connectionId })` closes exactly that native bridge/cloud
session even when the UI's admission signal was cancelled. Never pass cloud
capabilities, profile paths or service credentials into the DOM. Bound IPC
timeouts and release late/cancelled admissions. The app is a viewer/controller
of cloud services and does not execute agent work.

## Existing-state adoption procedure

**Prepared procedure only. No approval, migration, credential transfer or live
filesystem inspection was performed in this worktree.** The historical layout
is not automatically compatible with the new one:

| State | Verified historical source | New destination |
| --- | --- | --- |
| Desktop config/cache/data | `<legacy QORPERA_SCREEN_STATE_ROOT>/screen-<old ordinal>`; old default `/srv/qorpera/dataset/.qorpera-computer/screens/screen-<old ordinal>` | `<layout.screenStateRoot>/<same screen UUID>` |
| Chrome profile | `<legacy QORPERA_CHROME_PROFILES>/screen-<old ordinal>`; old default `/srv/qorpera/dataset/profiles/chrome/screen-<old ordinal>` | `<layout.browserProfilesRoot>/<explicitly granted profile UUID>` |
| Agent wallpaper | Old image asset plus `wallpapers/screen-<old ordinal>.png` | Regenerate from the same agent's current appearance into `<layout.screenStateRoot>/<screen UUID>/wallpaper.png`; do not overwrite unrelated desktop settings. |

The old ordinal identifies source bytes, **not their owner or a profile grant**.
`planCompanyComputerStateAdoption({ scope, legacyRoots, layout, mappings })`
accepts mappings of `{ legacy, binding, browserProfile }`. `legacy` supplies the
verified old company/environment/computer/logical IDs, screen UUID, ordinal and
staff-agent UUID; `binding` supplies the current exact binding. The screen and
agent UUIDs must match. An explicitly remapped ordinal is allowed; duplicate
source/target ordinals, screens, agents or profile IDs are rejected.
`browserProfile` is the existing authority's `{ profileId, grantId, version }`,
or **explicit `null`** to leave that old profile quarantined. Omission is an
error. The returned frozen plan is deterministic, has no filesystem side effects,
and is **not** an authorization, inventory validator or completed migration.

The integration owner must perform the following only after fresh operational
authorization, using the existing migration, authority and audit machinery:

1. Inventory the actual configured roots and immutable old registry identities
   from the same company environment. Account for every old desktop/profile,
   including inactive/detached rows, unregistered directories and `screen-0`.
   Missing, ambiguous or orphaned state must receive an explicit quarantine or
   recovery disposition, never an inferred owner from directory order. Preserve
   original screen UUIDs when projecting the old registry into the current store.
2. Confirm each desired profile's owner, audience and live explicit grant. Have
   the authorized owner approve the source-profile-to-profile-UUID mapping;
   neither a provider subscription nor an attached agent implies consent to old
   browser sessions. Null/unapproved profiles stay in protected quarantine, outside
   the guest's accessible workbench, and receive no runtime profile attachment.
   Retain the plan and source inventory/digests in the existing audit record.
3. Fence agents, member control, recording and viewers. Prove all old/new Chrome,
   XFCE/Xvnc and related services are stopped and reaped before reading a consistent
   source snapshot. Preserve original bytes and rollback data. Mount any old
   source only in the separately authorized migration context; it must not become
   an alternate NAS/Company File/profile route inside the new guest.
4. Validate physical paths and destination absence. Refuse aliases, symlinks,
   unexpected mount crossings, path conflicts and unreviewed executable state;
   never recursively merge into an existing UUID directory. On retry, an existing
   destination is reusable only if the existing completed adoption receipt and
   verified digests match this exact plan; otherwise stop for reconciliation.
5. Review desktop config/cache/data before staging. Preserve compatible settings,
   but do not activate saved autostart/session entries or dock launchers that
   restore raw `dataset/live`, old ambient `qorpera-chrome`, provider paths or
   unrestricted local control channels. Keep rejected originals in quarantine;
   require approved replacements through the governed browser/File interfaces.
   Do not copy the old shared HOME or service environments wholesale.
6. Check Chrome version/UID compatibility and the source profile's OS keyring
   requirements. Do not copy a general keyring, provider capsule or provider
   credential as a shortcut. If an old browser session needs additional protected
   material, require its own authorized browser-profile transfer or retain the
   bytes in quarantine and use typed sign-in. A Preferences-file fixture does not
   prove cookie decryption or continuity of a real authenticated session.
7. Stage the approved snapshot bytes into fresh protected destinations with the
   existing migration machinery, verify file inventories/digests and ownership,
   and publish atomically. The live copier must support the NAS/VirtioFS boundary;
   the local fixture's `fs.cp` is not a production copy implementation. Preserve
   originals until separately authorized retirement; do not add symlink aliases
   from `screen-N` into UUID directories or grant access by moving a directory.
8. Recheck authority, grants and exact registry generations at publication, then
   record completion in the existing journal/transaction and invalidate old
   capabilities. **`CompanyComputerGuestBoundary.assertReady` must reject unresolved
   adoption; `CompanyComputerBrowserAccess.assertGranted` must check the corresponding
   profile disposition as well as current authority.** A fresh computer instead
   needs a verified empty inventory. Do not call normal open/prepare helpers to
   manufacture fresh state when an expected legacy adoption is still pending.
9. Prepare the current agent wallpaper and the reviewed launcher configuration,
   then validate real browser session state and desktop settings through the
   authorized viewer. Test close/reopen, service/VM recovery and rollback with old
   generations fenced. Record only authorized evidence, not cookies, passwords or
   provider secrets. Live acceptance below remains required before rollout.

## Obsolete paths that must not be reintroduced

- Raw `QORPERA_LIVE_COMPANY_ROOT`, `/srv/qorpera/dataset/live`, direct company NAS exports, or aliases accessible from computer shell/Chrome/Files as a Company File bypass.
- Provider credential/capsule placement on shared workbench/profile storage, or a shared desktop UID that can read service/provider environments.
- Identity-only guest lease brokers that trust `run_id`/staff ID without Step 2 admission and exact live effect checks.
- The old best-effort DISPLAY bridge that keeps working after renewal failure, or any fallback into the member's local `computer-broker`.
- V1 redemption-only viewer authority, watch sessions that forward keyboard/mouse, unfiltered guest-output pipes or clipboard messages, reusable renderer URLs, or automatic control resumption on reconnect.
- Treating the old per-display Chrome directory as an explicit profile grant, or ambient screenshot recording during private sign-in.
- Silent fresh UUID directories for unresolved legacy state; `screen-N` symlink aliases; blind directory merges; old desktop autostart/dock commands that reintroduce ambient browser or direct NAS authority.
- Whole-branch imports of older native-provider/runner/sandbox/mouth/Company File/deployment machinery, old single-assignment scheduling, or retired desktop sync/capture as canonical company authority.
- Historical maintenance commands, image candidates or signed-provenance notes treated as current permission to activate a machine.

## Proposed integration order

The two component recovery findings from the 2026-08-30 reassessment are fixed
and regression-tested; they are not deferred to the shared runtime owner.

1. Finish and verify Step 2 authority, effect fencing, governed Company File and containment. Reconcile the structural adapters with the final interfaces.
2. Integrate authorized registry transitions/leases and schema projection into the existing store, including definitive no-admission refusal classification. Add real transaction/concurrency tests; invalidate legacy occupancy/view capabilities.
3. Integrate the provider/supervisor hooks and verified guest layout. Apply the explicit adoption procedure above only under new authorization, with identity mapping, profile dispositions and journal completion. Prepare the retained agent wallpaper/XFCE behavior and reviewed dock hooks; preserve original/rollback bytes without exposing old raw authority routes.
4. Connect the profile broker, typed sign-in privacy barrier, contained commands and immutable assets. Verify actual stop/reap and generation recovery before exposing input.
5. Register the v2 computer tools in the existing native tool factory and close resource sessions in its owner. Verify explicit admission retry and scoped tab recovery against real authority/ledger adapters. Add fenced image-context consumption. Run native cloud computer-use acceptance with all member devices offline.
6. Connect the private viewer gateway and native renderer IPC/module wiring. Exercise watch, takeover, release, revocation and reconnect against real VNC and the shipping app.
7. Only the main runtime/deployment owner should decide image packaging, migration, rollout and release after acceptance. Nothing in this handoff grants operational approval.

## Outstanding live cloud acceptance

- [ ] With **every member device offline**, an admitted native cloud agent starts/reuses the Company Computer, opens its assigned screen, uses an authorized connector/browser, clicks/types, captures a usable image and executes a contained shell command. Verify actual effects and fenced results, not a model's claim or mocked response.
- [ ] Two agents work on different desktops on the **same** VM and shared workbench; same-screen conflicts fail. Shell/service resource leases and their provenance do not incorrectly serialize or power off unrelated work.
- [ ] After a confirmed occupancy/capacity refusal, a still-authorized run explicitly opens again once capacity is available. Verify the registry's no-admission classification, one fresh claim, no automatic work replay, and no retry after an uncertain admission or revoked/expired established lease.
- [ ] A real persistent browser with several existing tabs supports paginated discovery, explicit selection, page input and browser screenshots on the chosen tab. Closing the selected tab permits explicit recovery without closing unrelated tabs; renewal retains IDs while run/lease changes and guest restart invalidate them. Revocation/cancellation during selection prevents success output and drains control before takeover.
- [ ] Member takeover during in-flight browser/shell/input cancels and drains the predecessor before member input. Hung or failed shutdown stays quarantined. Release clears held keys/buttons; no queued input leaks into the next driver.
- [ ] Revoking member, sponsor, run, screen or profile authority stops new effects and prevents result/pixel release as required. Test control-plane loss, expired tokens, delayed replies, duplicate frames, reused capabilities and fresh reconnect after recovery.
- [ ] Typed password/OTP sign-in pauses agent access and unauthorized watchers/recording before secrets appear. Browser-profile grants remain distinct from provider subscriptions; revocation and regrant/version change work with persistent cookies without exposing credentials to the model.
- [ ] The real app renders XFCE/Chrome through the vendored noVNC client, in watch mode by default; real keyboard/mouse work only after takeover. Verify scaling, focus, disconnect, renderer close and handshake extensions against the intended image.
- [ ] Guest and member clipboard contents never cross the viewer transport in watch or control mode. Verify the intended TigerVNC encodings and fragmented/coalesced frames against real noVNC without display corruption or disconnects during normal use.
- [ ] Close/reopen, guest-service crash, VM stop/start and verified root-image replacement preserve browser/desktop working state but invalidate old generation capabilities. Confirm service/cgroup reaping and durable journal recovery, not only wrapper PID exit.
- [ ] On an authorized existing-machine upgrade, map real `screen-N` state into the intended screen/profile UUIDs without a fresh-profile surprise, owner substitution or data loss. Verify actual cookie/keyring compatibility, reviewed XFCE settings, correct agent wallpaper/dock presentation, quarantine of ungranted/orphaned state, retry conflicts and rollback. Unresolved adoption must prevent admission.
- [ ] Repeated retirement/reassignment beyond 32 historical screens reuses capacity while old bindings remain fenced. Exercise final-check revocation and cancellation during takeover; no predecessor browser channel remains after acknowledgement.
- [ ] Screen/VM idle policy respects viewers, all resource leases and maintenance stops. A cloud run can reopen the computer without an app running.
- [ ] Resetting the VM leaves canonical company state intact. Company File reads/writes use the governed boundary, including protected-path proposals; raw NAS aliases, provider environments, profile directories and unapproved cross-realm transfers are inaccessible.
- [ ] Screenshots are real, correctly bound and immutable; authorized image-context consumption works through the final native boundary. Recording, if enabled, observes the same privacy/audience checks.
- [ ] Separately validate image provenance, packaging, rollback and deployment under fresh operational authorization. The historical viewer proof is insufficient for this gate.

The main runtime owner can inspect and selectively integrate this worktree.
This handoff was not sent to another session.
