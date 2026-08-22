# Step 1.5 acceptance

**Purpose:** remove architecture that lets cloud execution depend on the inherited Pi/local-runtime lane before publishing the Step 1 cloud release.

## Required boundaries

1. `@qorpera/contracts`, `@qorpera/company`, the object gateway, the Runner Orchestrator, and every `cloud-*` shell module are provider-neutral and import no `@qorpera/pi-*` package.
2. Company File, staff, artifact, room, connector, execution-identity, capability, and operation-kind contracts are owned by Qorpera packages rather than the inherited coding-agent package.
3. A cloud session turn requires one explicit sponsor/provider connection and is created through the durable native-subscription runner request. The desktop does not append, claim, or execute an unsponsored cloud turn.
4. The desktop cloud-session pump observes queue state only. It never claims work for the local model runtime.
5. Cloud wakes remain durable control-plane work and wait for the Runner Orchestrator. They never fall back to a desktop child.
6. The inherited model broker is named and documented as `legacy-local`; both attended prompts and hidden staff directives fail closed for cloud profiles. The desktop cannot append a separate unsponsored introduction input.
7. CI rejects new Pi imports in provider-neutral packages and rejects reintroduction of a desktop cloud-turn fallback.

The current desktop may still start an explicitly named legacy Pi RPC attachment to project a cached transcript into the existing renderer. That attachment is not cloud authority or cloud compute: it cannot receive a cloud prompt, claim a cloud job, or handle personal subscription traffic. Replacing this read/projection adapter is a desktop modularity cleanup, not a prerequisite for Step 2 native workers.

## Release proof

Before publishing the shell release:

- run `npm run check`;
- run `npm run build:offline`;
- run the affected company, cloud, runner, native-provider, and shell wiring tests;
- run `./test.sh` from the repository root;
- run `npm run test:hosted-db`;
- rerun the hosted cloud smoke and desktop UI verification;
- rebuild the installer from the reviewed merge commit.

## Explicitly not claimed

Step 1.5 does not deploy autonomous execution. Personal Codex/Claude subscription execution is complete only after Step 2 deploys the Runner Orchestrator, isolated login/job workers, official native harnesses, capsule handling, revocation, and the two-member all-devices-offline acceptance test described in [deploy/first-node/STEP-2-ARCHITECTURE.md](deploy/first-node/STEP-2-ARCHITECTURE.md).
