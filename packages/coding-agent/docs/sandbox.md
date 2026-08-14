# Host access and runtime boundaries

**Status:** Company controllers and product workers launched by Qorpera Base
run directly as the signed-in desktop user. They are not placed in the Codex
offline sandbox.

## Agent process capabilities

The desktop kernel starts the RPC child with Electron's bundled Node runtime,
the role's company or product-worktree directory as its working directory, and
a copy of the complete host environment. The child therefore has everything
an ordinary process launched from the user's terminal has:

- filesystem access granted to the signed-in user, including paths outside
  the company folder;
- direct network access;
- installed applications, shells, and CLIs on `PATH`;
- the user's home, application-data directories, Git configuration,
  credential helpers, keychains, cloud profiles, and environment credentials;
- normal OS browser handoffs, including CLI login flows such as
  `gh auth login --web`.

This grants the agent the user's capabilities, not automatic administrator or
root privileges. It can invoke the operating system's normal elevation flow
when a command supports one, and the user remains responsible for approving
that OS prompt.

The desktop retains a separate Qorpera agent-data directory for the RPC
session's internal model configuration. Paid model requests still use opaque
broker handles so request construction, usage accounting, and trail records
remain kernel-owned. This internal directory does not replace `HOME`,
`USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, temporary directories, Git config,
or `CODEX_HOME` for host tools.

Local stdio MCP servers inherit the same host environment and permissions.
`run_company_tool` intentionally removes ambient credential variables and
kernel tokens so identified unattended programs do not receive secrets merely
by being launched; that clean environment is not an OS security boundary.
When direct host access or inherited credentials are needed, the controller
can run the command through its ordinary shell tool.

## Policy and observability

Full host access does not remove Qorpera's higher-level controls:

- `authority.toml` still classifies tool effects and can allow, notify, or
  gate them;
- attended prompts and autonomous wakes still receive signed causal intents;
- model and brokered HTTP operations remain kernel-observed;
- session events still append to the company trail;
- kernel-owned checkpointing still preserves founder and agent work.

These controls govern Qorpera's built-in tool paths. They are not an OS
sandbox and must not be described as one: a host-capable process, a child
program, or a sufficiently indirect command can exercise whatever access the
signed-in user has.

The `http_request` tool remains available as an auditable lane for bound HTTPS
destinations and `secret://` references. It is optional rather than the only
way for a controller to reach the network.

## Renderer boundary

The company controller process and the company renderer are separate trust
domains. Granting host access to the controller does not grant it to mutable
company HTML or JavaScript. Electron renderer sessions remain sandboxed with
Node integration disabled, external network requests denied, and only their
exact loopback backend origin allowed. External links still cross a native
review before the OS opens them.

## Security posture

A company controller can now do the same damage as any other local process
running under the user's account. Treat company prompts, files, MCP servers,
and tool code as trusted. For untrusted companies or unattended work that
needs containment, run Qorpera Base under a dedicated OS account, VM, or
container with only the required files and credentials.

The legacy sandbox-profile and provisioning helpers remain in
`packages/shell/src/agent-runtime.ts` for compatibility and integration
coverage, but the desktop launch path in `packages/shell/src/main.ts` does not
invoke them.
