# Isolation — what is enforced, by what, on which platform

**Status:** Reference for Build 2 (manifesto §7.2: isolation strength is
stated honestly, per platform, or scoped down until it can be). The
enforcement code is the authority: `packages/shell/src/agent-runtime.ts`
(`writeSandboxProfile`, `provisionSandbox`, `protectedCompanyAgentPaths`,
`brokeredChildEnvironment`), `packages/shell/src/main.ts` (child spawn,
credential brokering), `packages/coding-agent/src/core/tools/company-tool.ts`
(company-program execution).

## The layers

Company agent runs execute only under the desktop host (the CLI refuses them
otherwise). The host spawns each agent as a child process inside the
bundled Codex sandbox (`codex sandbox --permission-profile qorpera-agent`),
with a generated filesystem permission map:

- company root: **write** for a company agent, **read** for product-workers
- `.git/`, `trail/`, an optional `authority.toml`,
  `.qorpera/`, `inbox/`, and every product repository/worktree root: **read**
- `inbox/messages/`: **write** for the company agent — the one sanctioned
  agent-writable inbox lane (which files inside are legitimate stays
  enforced at the tool boundary: `msg-*.md` direct children only)
- a product-worker's single assigned worktree: **write** (its `.git`: read)
- network: **disabled** (`network_proxy = false`, `[network] enabled = false`)

Independent of the OS sandbox, on every platform:

- **Credential denial** — the child environment is a strict allowlist
  (`SAFE_CHILD_ENV` in `agent-runtime.ts`: PATH shape, locale, TLS trust,
  and the Windows `ProgramFiles` roots the bash tool's shell discovery
  needs); no provider keys reach it. Model credentials are opaque broker handles;
  request construction, authentication, and network stay in the host
  process, gated by host-signed intents with per-intent budgets.
- **Git ownership isolation** — the Windows sandbox account receives
  command-scope `safe.directory` entries only for the exact company and
  assigned product worktree it can already access. System/global Git config
  and terminal credential prompts stay disabled, so agents can inspect
  their repository without trusting arbitrary machine paths.
- **Trail integrity** — the child cannot write the trail file; it submits
  entries the host validates, stamps into a hash chain, and appends.
- **Tool-boundary authority** — `authority.toml` gates classified effects
  before execution, inside the child, in core-owned hooks.

Company-authored programs run through `run_company_tool` as subprocesses of
the agent child: they inherit its OS confinement, and additionally get
a from-scratch clean environment (no QORPERA_* state, no broker handles),
the company root as working directory, bounded output, and a hard timeout.
Their content-hash identity is stamped into the trail on every run. A
program may make its own outbound requests by printing
`qorpera_program_http_request` frames on stdout and reading responses from
stdin: the runner evaluates each as UNATTENDED codified behavior (so the
signature rule applies at outward classes, with the program file as the
acting behavior) and forwards it through the host lane with the
program's identity attached — a founder-signed program acting outward
with nobody present, end to end.

## Verification — fail closed

Before any agent starts, the host proves the sandbox is real
(`provisionSandbox`):

- **Windows**: runs `whoami.exe` inside the sandbox and requires the Codex
  offline sandbox identity, then attempts direct HTTPS from inside the
  sandbox and refuses to start the agent if any request succeeds.
- **macOS / Linux**: attempts the same direct HTTPS probe inside the
  sandbox and refuses to start if it succeeds. There is no identity check
  on these platforms; the probe is the proof that the profile is enforced
  at all. If the bundled sandbox no-ops, the probe succeeds and the host
  refuses to start — an unenforced profile never silently degrades to
  "hope".

Outbound HTTP (Build 3) travels the same trusted pipe: the child submits
`qorpera_http_request` frames carrying opaque `secret://<name>` references;
the host checks the destination against founder-bound network
capabilities, dereferences references at the boundary (with host-mediated
OAuth2 refresh), executes with a per-turn request budget and no
auto-followed redirects, and records the unresolved request identity in the
  trail (`qorpera_kernel_http_request`, the version-5 wire name for a
  host-observed HTTP request).

## Stated gaps (current, honest)

- macOS/Linux verification proves network isolation only; filesystem
  confinement on those platforms rests on the Codex sandbox's own
  enforcement without an independent probe.
- The network probe tests direct HTTPS; a sandbox that blocked HTTPS but
  leaked other protocols would pass it.
- Secret values at rest live in a machine-local protected vault outside the
  company folder and every sandbox path grant. The vault is keyed by durable
  company identity and protected by the OS account; explicit portability uses
  a company-bound, passphrase-encrypted rewrapping bundle.
- `bash` inside an agent can run company code without behavior
  identity; such runs are confined identically but carry no signable
  content hash, so they can never take unattended outward effects — that
  is the designed degradation, not a gap.
- Agents can install company connector recipes and drive public provider setup
  in managed Chrome. The host alone binds destinations and stores generated
  secrets or OAuth grants; the child receives only opaque references.
- (Closed) The HTTP lane now rides the same host-signed causal intents
  as the model lane: every outbound request must echo an intent the
  host registered for the run, byte-identical and unexpired, with a
  per-intent request budget; turn end revokes it.
