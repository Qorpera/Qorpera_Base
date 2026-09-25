# Qorpera Base

**Qorpera Base is the cloud control plane, runtime and web app for agent-operated companies.**

- Supabase is authoritative for companies, memberships, sessions, inputs, jobs, runs, leases, sponsor/provider bindings, provenance, and transcript order.
- The NAS object gateway stores immutable Company File objects, attachments, artifacts, encrypted Compute Identity capsules, and checkpoints.
- The standalone Runner Orchestrator claims durable jobs and controls isolated execution workers. Supabase notifications are wake hints, not scheduling authority.
- Provider-native workers run the official Codex or Claude harness under one explicit execution sponsor and provider connection. Subscription traffic never passes through a generic Qorpera model gateway.
- The web app observes and mutates durable cloud state. It holds no cloud authority and never executes agent turns.

The cloud control plane is implemented and tested, but autonomous all-devices-offline execution is not complete until the Step 2 runner infrastructure passes the acceptance gate in [deploy/first-node/STEP-2-ARCHITECTURE.md](deploy/first-node/STEP-2-ARCHITECTURE.md). The exact deployed checkpoint and continuation order are recorded in [deploy/first-node/STEP-2-HANDOFF.md](deploy/first-node/STEP-2-HANDOFF.md).

Packages:

- **[@qorpera/contracts](packages/contracts)**: provider-neutral cloud and execution contracts
- **[@qorpera/company](packages/company)**: provider-neutral Company File and company-domain primitives
- **[@qorpera/cloud-client](packages/cloud-client)**: cloud client APIs and wire contracts
- **[@qorpera/runtime](packages/runtime)**: headless cloud execution and shared office services
- **[@qorpera/runner-orchestrator](packages/runner-orchestrator)**: durable job reconciliation and provider boundary
- **[@qorpera/object-gateway](packages/object-gateway)**: immutable NAS/object-storage authority
- **[@qorpera/web](packages/web)**: the web app, a pure cloud client
- **[@qorpera/member-web](packages/member-web)**: independent browser client for governed Company Files and shared Company Computers

The repository began as a hard fork of the [PI coding agent](https://github.com/earendil-works/pi) by Mario Zechner (MIT). The PI packages and the desktop app built on them were removed on 2026-09-25; see [FORK.md](FORK.md).

## Development

See [AGENTS.md](AGENTS.md) for project rules (for both humans and agents).

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build         # Build the shared libraries and services (web apps build per workspace)
npm run check         # Lint, format, and type check
./test.sh             # Run tests in an isolated home without API keys
```

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `QORPERA_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps and native TypeScript import compatibility.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.

## License

MIT
