# Qorpera Base

**Qorpera Base is the cloud-first control plane and client for agent-operated companies.**

- Supabase is authoritative for companies, memberships, sessions, inputs, jobs, runs, leases, sponsor/provider bindings, provenance, and transcript order.
- The NAS object gateway stores immutable Company File objects, attachments, artifacts, encrypted Compute Identity capsules, and checkpoints.
- The standalone Runner Orchestrator claims durable jobs and controls isolated execution workers. Supabase notifications are wake hints, not scheduling authority.
- Provider-native workers run the official Codex or Claude harness under one explicit execution sponsor and provider connection. Subscription traffic never passes through Pi or a generic Qorpera model gateway.
- Desktops observe and mutate durable cloud state. They are not required for cloud authority and cannot execute cloud turns through the legacy local model runtime.

The cloud control plane is implemented and tested, but autonomous all-devices-offline execution is not complete until the Step 2 runner infrastructure passes the acceptance gate in [deploy/first-node/STEP-2-ARCHITECTURE.md](deploy/first-node/STEP-2-ARCHITECTURE.md). The exact deployed checkpoint and continuation order are recorded in [deploy/first-node/STEP-2-HANDOFF.md](deploy/first-node/STEP-2-HANDOFF.md).

Primary packages:

- **[@qorpera/contracts](packages/contracts)**: provider-neutral cloud and execution contracts
- **[@qorpera/company](packages/company)**: provider-neutral Company File and company-domain primitives
- **[@qorpera/runner-orchestrator](packages/runner-orchestrator)**: durable job reconciliation and provider boundary
- **[@qorpera/object-gateway](packages/object-gateway)**: immutable NAS/object-storage authority
- **[@qorpera/shell](packages/shell)**: desktop client, cloud synchronization, and explicit legacy-local execution boundary

Qorpera Base retains a hard-forked [PI coding agent](https://github.com/earendil-works/pi) harness by Mario Zechner (MIT), forked 2026-08-04 at v0.83.0, for local-company compatibility. It is not the cloud execution architecture and does not handle personal native-subscription traffic.

---

## Legacy local PI harness

These packages remain for the explicit local-company compatibility lane:

| Package | Description |
|---------|-------------|
| **[@qorpera/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@qorpera/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@qorpera/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@qorpera/pi-tui](packages/tui)** | Terminal UI library with differential rendering |

## Permissions & Containerization

The legacy local PI harness does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it.

If you need stronger boundaries, containerize or sandbox Pi. See [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) for three patterns:

- **Gondolin extension**: keep `pi` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `pi` process in a local container for simple isolation.
- **OpenShell**: run the whole `pi` process in a policy-controlled sandbox.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).  Longer term plans for Pi can also be found in [RFCs](https://rfc.earendil.com/keyword/pi/).

## Development

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build         # Refresh model data, then build all packages
npm run build:offline # Rebuild using existing model data without network access
npm run check         # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run pi from sources (can be run from any directory)
```

## Building standalone binaries from release source

GitHub releases include a versioned source archive covered by the release's `SHA256SUMS` file. Extract it and run the same build script used for the official standalone binaries:

```bash
VERSION="<release-version>"
tar -xzf "pi-${VERSION}-source.tar.gz"
cd "pi-${VERSION}"
./scripts/build-binaries.sh --offline-model-data --platform linux-x64 --out "$PWD/out"
```

The source archive includes the generated provider model data used for the release. `--offline-model-data` builds with that snapshot instead of refreshing it from live provider catalogs. The script still installs dependencies, builds the monorepo, compiles the Bun executable, and stages its runtime assets. Package maintainers who provide dependencies separately can pass `--skip-install --skip-deps`.

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `QORPERA_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent shrinkwrap.
- The published CLI package includes `packages/coding-agent/npm-shrinkwrap.json`, generated from the root lockfile, to pin transitive deps for npm users.
- Release smoke tests use `npm run release:local` to build, pack, and create isolated npm and Bun installs outside the repo before tagging a release.
- Local release installs, documented npm installs, and `pi update --self` use `--ignore-scripts` where supported.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Shrinkwrap generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## Share your OSS coding agent sessions

If you use Pi or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## License

MIT

<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>
