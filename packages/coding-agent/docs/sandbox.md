# Isolation — what is enforced, by what, on which platform

**Status:** Reference for Build 2 (manifesto §7.2: isolation strength is
stated honestly, per platform, or scoped down until it can be). The
enforcement code is the authority: `packages/shell/src/agent-runtime.ts`
(`writeSandboxProfile`, `provisionSandbox`, `protectedControllerPaths`),
`packages/shell/src/main.ts` (child spawn, environment allowlist,
credential brokering), `packages/coding-agent/src/core/tools/company-tool.ts`
(company-program execution).

## The layers

Company sessions run only under the desktop kernel (the CLI refuses them
otherwise). The kernel spawns the controller as a child process inside the
bundled Codex sandbox (`codex sandbox --permission-profile qorpera-agent`),
with a generated filesystem permission map:

- company root: **write** for the controller, **read** for product-workers
- `.git/`, `trail/`, `authority.toml`, `AGENTS.md`, `CLAUDE.md`,
  `.qorpera/`, `inbox/`, and every product repository/worktree root: **read**
- `inbox/messages/`: **write** for the controller — the one sanctioned
  agent-writable inbox lane (which files inside are legitimate stays
  enforced at the tool boundary: `msg-*.md` direct children only)
- a product-worker's single assigned worktree: **write** (its `.git`: read)
- network: **disabled** (`network_proxy = false`, `[network] enabled = false`)

Independent of the OS sandbox, on every platform:

- **Credential denial** — the child environment is a 12-variable allowlist;
  no provider keys reach it. Model credentials are opaque broker handles;
  request construction, authentication, and network stay in the kernel
  process, gated by kernel-signed intents with per-intent budgets.
- **Trail integrity** — the child cannot write the trail file; it submits
  entries the kernel validates, stamps into a hash chain, and appends.
- **Tool-boundary authority** — `authority.toml` gates classified effects
  before execution, inside the child, in core-owned hooks.

Company-authored programs run through `run_company_tool` as subprocesses of
the controller child: they inherit its OS confinement, and additionally get
a from-scratch clean environment (no QORPERA_* state, no broker handles),
the company root as working directory, bounded output, and a hard timeout.
Their content-hash identity is stamped into the trail on every run.

## Verification — fail closed

Before any agent starts, the kernel proves the sandbox is real
(`provisionSandbox`):

- **Windows**: runs `whoami.exe` inside the sandbox and requires the Codex
  offline sandbox identity, then attempts direct HTTPS from inside the
  sandbox and refuses to start the controller if any request succeeds.
- **macOS / Linux**: attempts the same direct HTTPS probe inside the
  sandbox and refuses to start if it succeeds. There is no identity check
  on these platforms; the probe is the proof that the profile is enforced
  at all. If the bundled sandbox no-ops, the probe succeeds and the kernel
  refuses to start — an unenforced profile never silently degrades to
  "hope".

## Stated gaps (current, honest)

- macOS/Linux verification proves network isolation only; filesystem
  confinement on those platforms rests on the Codex sandbox's own
  enforcement without an independent probe.
- The network probe tests direct HTTPS; a sandbox that blocked HTTPS but
  leaked other protocols would pass it.
- Secret values at rest are a plaintext mode-0600 file in the machine-local
  agent directory, outside the company folder and outside every sandbox
  path grant — but not OS-keychain-protected. Hardening is Build 3.
- `bash` inside the controller can run company code without behavior
  identity; such runs are confined identically but carry no signable
  content hash, so they can never take unattended outward effects — that
  is the designed degradation, not a gap.
