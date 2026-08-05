# EVOLUTION.md — self-evolution and the signature rule

Converged design, 2026-08-05. **Status: RATIFIED 2026-08-05.** Extends
spec-v0 and the company-folder spine
(`packages/coding-agent/docs/company.md`). Supersedes the earlier draft of
this document (the `live`-ref / promotion-machinery design): that shape
collapsed into one authority rule once it was clear that slice 2's durable
per-content-hash approvals already are the promotion mechanism, per file.
Implementation may build against §9.

## 1. The change, in its simplest form

> The agent can do anything inside the company folder, anytime. But before
> anything it built may touch the outside world unattended, the founder
> signs that code once — and if the agent edits that code, the signature no
> longer covers it and it must ask again.

Outcome, per party:

- **The company** evolves at full speed, always — thinking, building, and
  rewriting itself are never blocked.
- **The world** only ever hears from code the founder signed, or actions
  the founder approved in the moment.
- **The founder's** whole job is: say what the company is for, and sign
  what may act on its behalf.

## 2. Why this shape

"Better company" is judged against intent that exists only in the founder's
head. Capability problems (bad edits, regressions, migrations) shrink as
models improve — building preventive machinery for them is building for the
weak-model present. Measurement problems grow as models improve — an
optimizer selected on "passes the gate" gets better at inhabiting the gap
between proxy and intent. So the platform enforces no gates on
self-modification content and exactly one thing at the world boundary:
intent, in the form of a founder signature. Human involvement is designed
to asymptote to stating intent, nothing else.

There is no versioning system. History is git (**[exists]** — the folder is
a repo). A "version" is a git tag the controller makes when its company
needs one. Promotion channels, evidence bundles, manifests, release
processes — all are patterns the controller may grow for itself in `app/`
(§6), never platform machinery.

## 3. The rule

**Codified behavior taking an outward effect unattended requires a standing
founder approval on that behavior's content hash.** Same mechanism as
extension-load gating (durable per-content-hash, `authority.md`): approval
covers that exact code; any edit is a new hash and a new request. Unsigned
behavior's outward effects gate to `inbox/` like anything else — gates
block effects, never the agent.

Decision matrix (rows = action source, columns = intent presence):

|  | Founder present | Unattended |
|---|---|---|
| **Inward effects** (thought, `work/`, `app/`, trail) | free | free |
| **Improvised outward** (model ad-libs an action) | inline gate, as today | inbox gate, as today |
| **Codified outward** (a routine/tool acts) | inline gate | **hash signed, else inbox gate** |

Everything executes at head — the working tree is the company, as today.
Nothing else changes: money/identity/irreversible/authority classes,
modes, and the gate lifecycle are untouched. The rule sits ON TOP of
authority classes, never instead — a signed routine still hits money
limits and identity gates.

Bulk signing: a gate request may name a commit and cover every behavior
file in that tree; one approval signs the set. "Releasing a version" is
this pattern plus a tag — convention, not machinery. Piecemeal signing can
produce incoherent combinations (routine signed, its edited helper not);
the tree-scoped pattern is the controller's own remedy, accepted as a
visible, recoverable failure mode rather than prevented.

Trail: every effect record stamps the acting behavior's content hash and
signature status (the check needs the hash anyway). Safe boot: the platform
bookmarks the last tree hash that started a session successfully — a trail
fact for recovery, not a governance object.

## 4. The three invariants

1. **History is append-only from the agent's side.** Largely **[exists]**:
   the destructive screen already gates `git push --force` and
   `git reset --hard`; extend the pattern list to cover remaining history
   rewrites. Append-only history is memory the intelligence needs, not an
   audit hedge — and it makes rollback a forward operation (§5).
2. **The agent cannot sign for itself.** **[exists]** as mechanism (agents
   cannot write `inbox/` approvals — authority class); this spec extends
   what requires a signature (§3). The signing policy is content: loosening
   it (scope exemptions, eventual delegated signing) is an edit to
   `authority.toml`, human-ratified — the trust dial is one sentence in one
   file, moved at the rate models earn it.
3. **Every agent-authored commit carries provenance** — trigger and
   rationale as trailers, hook-enforced. The agent explaining itself to its
   future self, not to a reviewer. **[delta]**

## 5. Charter and rollback

Charter = `company.md` + `authority.toml`: the objective, not config.
Ownership nuance: the agent *transcribes* `company.md` (conception
interview) — the founder speaks and ratifies; `authority.toml` and kernel
files are gate-protected **[exists]**. Only the founder supplies intent;
"better" is indexical and no capability level infers what the file is for.

Rollback is always forward: `git revert` scoped to behavior paths (`app/`,
`company.md`, kernel files). `trail/` and `work/` are state and never
reverted. Caveat, accepted: carried-forward state written by newer behavior
can be semantically stale for older behavior; schema checks can't catch
this, so rollbacks log loudly (trail + inbox note) and degradation gets
looked for.

## 6. Normalization: the platform as renderer

The platform is the browser for companies: company files are free-form;
the platform renders any of them installable, viewable, log-in-able. The
contract is the spine (identity `company.md` · charter surface
`authority.toml` · activity `trail/` · intent pipe `inbox/` + chat ·
controller `app/`). Trust-critical chrome — identity, charter editing, gate
approvals — is platform-rendered, never model-mediated. Surfaces are
model-built and shown at head (the founder sees the company as it is,
mid-molt); safe-mode falls back to the §3 bookmark.

Schema-creep guard: every UI feature will lobby for a required field; the
contract grows only when the intelligence *cannot* render from free-form
content. Default answer to "add a field" is no. Freezing the spine as a
public compatibility surface is deferred until the first external renderer
ships.

Version streams are three and independent: platform (Base releases),
company (its own history and tags), model (whatever the company pins for
itself). A founder updating the app must not touch their company; a company
evolving must not require an app update.

## 7. Deliberately not built

Patterns the controller may grow in `app/` when pain arrives — documented
so they don't get rebuilt into the platform by accident: release/version
conventions (tags + tree-signing), promotion channels and staged trust,
evidence attached to signing requests (evidence is a **tripwire, not a
proof** — §8.1), proposal/branch workflows, checkpoint-boundary swaps for
long-running work, journal squashing.

Minimalism trades prevention for recovery: mistakes land; append-only
history plus forward revert recovers. Right trade at small blast radius,
and the controller can grow prevention itself when blast radius grows.

## 8. Known flaws, held open

1. **Self-authored evidence Goodharts.** Anything the controller writes and
   is then judged by drifts toward what it already does; worsens with
   capability. Evidence on signing requests is a tripwire; the founder
   periodically audits the evidence-makers themselves.
2. **Laundering across the signature boundary.** Unsigned head code drafts
   content; a signed routine ships it. The gate sees the signer, not the
   payload's provenance. Taint-tracking is disproportionate; the
   institutional analogue (drafters draft, signers are accountable for what
   they ship) is partially reassuring. Unsolved; tripwire posture.
3. **The rule leans entirely on effect classification** — "outward"
   detection inherits every gap in the bash screen and the not-yet-built
   money/identity detections (`authority.md` known limits). Conservative
   screens, fail closed, sandbox underneath; the guarantee is only as good
   as the classifier.
4. **A signature ratifies a generator, not its outputs.** A signed routine
   is signed for whatever it generates within its authority classes.
   Bounded by those classes, not by the signature.
5. **Attributable, never reproducible.** Trail stamps and history make
   behavior attributable; models deprecate, sampling is nondeterministic,
   services drift. The compliance claim is attribution.
6. **Whether delegated signing stays benign as capability grows** is the
   open question of the field. This design doesn't settle it; it makes the
   dial one human-ratified sentence so the limit is approached at the rate
   models earn it.

## 9. Implementation deltas

1. Extend the durable hash-approval check from extension loading to
   codified behavior producing unattended outward effects (one new input in
   `authority.ts`); stamp behavior hash + signature status on effect trail
   entries. **Landed 2026-08-05** — `ToolCallContext` in `authority.ts`,
   wired at the agent-session mount; `qorpera_effect` trail entries; see
   `packages/coding-agent/docs/authority.md` §"The signature rule".
2. Provenance trailer hook on agent commits.
3. Add remaining history-rewrite patterns to the destructive screen.

## 10. Ratified decisions

Resolved at ratification (2026-08-05):

1. **Laundering posture (§8.2): tripwire accepted.** No payload provenance
   rule; signed routines are accountable for what they ship, and the
   founder periodically audits outward-shipping behavior. Revisit only if
   an incident shows the tripwire posture failing in practice.
2. **Extension loading: stays a separate per-edit load gate.** Extensions
   are ungated arbitrary code; the per-edit friction is the point. Revisit
   if it demonstrably throttles evolution.
3. **Surfaces render at head** (honesty over polish), safe-mode falls back
   to the last known-good tree (§6).
4. **Spine-as-public-contract freeze remains deferred** until the first
   external renderer ships (§6).
