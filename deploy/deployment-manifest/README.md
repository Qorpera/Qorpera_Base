# Deployment manifest

One record of what is live now. For every live component it holds:

- the **exact identity** (digest, commit, version, policy sha);
- **when and in which cut** that identity went live, with the receipts that show it;
- the **acceptance evidence that was run against that identity**. When the identity changes, earlier evidence stops
  counting. The component then shows as *not accepted at this identity* until someone proves it again.

It answers two questions the bundle registry answers only in prose: "what exactly is running?" and "has this exact
thing been proven live?"

## Where the current manifest lives

**TO BE CONFIRMED WITH THE COORDINATOR.** Proposed: in the coordinator workspace next to the bundle registry.

```
<workspace>/outputs/deployment-manifest/
  current.json      the live manifest (only manifest.mjs apply writes it)
  CURRENT.md        the same, as a readable page (generated)
  history/          every earlier manifest: 0001-….json, 0002-….json, …
  changes/          the changes file each apply used (kept for review)
  evidence/         read-only query outputs used as evidence (observed state, run placements)
```

`<workspace>` is `/Users/jonas/Documents/Codex/2026-09-13/take-over-the-qorpera-runtime-work`. Receipt paths in the
manifest are relative to it. This repo folder holds only the format, the tool and this page.

## Reading it

Each component has an `acceptance.state`:

| State | Meaning |
|---|---|
| `accepted` | At least one piece of evidence was run against exactly this identity (same `identityDigest`). |
| `not-accepted-at-this-identity` | Live, but nothing proves this exact identity: never accepted, or it changed after the last acceptance (see `acceptance.superseded`). |
| `identity-unknown` | A live fact is not recorded anywhere (its value is `null`). Nothing can be accepted until it is recorded. |

`identityDigest` is the sha256 of the identity in canonical JSON (keys sorted). Evidence carries the digest it was run
against. `CURRENT.md` starts with the list of live components without proof at their live version.

A record says where a fact is written down:

- `{ "path", "sha256" }`: a receipt file, pinned by its bytes;
- `{ "path", "line", "quote" }`: one line of the bundle registry (append-only); the quote must be on that line;
- `{ "url" }`: a pull request or a check run.

`manifest.mjs check --manifest current.json --root <workspace>` re-reads every record. It fails when a receipt has
changed, a quote has moved, a digest is stale, or a state does not follow from its evidence.

## Components

| Id | What | Identity from |
|---|---|---|
| `database-migrations` | Last migration recorded in `schema_migrations` (the activation file) | cut lane `sql/` receipts |
| `runtime-bundle` | Active runtime bundle: version, sha, activation | `sql/receipts/activate-commit-*-result.json` |
| `runner-image` | LXD image of agent machines (both nodes + exec host) | `image/signing/image-provenance-*.json` |
| `codex-fence` | Codex binary with the result fence, inside the runner image | `guest/artifact.json` |
| `guest-provider-host` | `qorpera-native-provider-host.mjs` inside the runner image | `guest/` |
| `node-01-release`, `node-02-release` | Node agent release per node: provider (and node 1's orchestrator) program + env, and what the cut enrolled | `agent/release-N/`, `agent/receipts/`, `enroll/receipts/` |
| `node-agent` | The node agent program itself | explicit `set` |
| `exec-host` | Shared execution host VM on node 2 | `exec-host/receipts/` (package: explicit) |
| `office-service`, `office-image` | Company Computer provider and image | explicit `set` |
| `coding-image`, `coding-executor`, `coding-vm-policy` | Member coding machines on node 2 | explicit `set` |
| `secret-broker-qorpera`, `secret-broker-acceptance` | Secret brokers on node 1 and their authority rows | explicit `set` |
| `capture-proxy` | nginx route for captures on node 1 | explicit `set` |
| `object-gateway` | Object gateway on node 1 | explicit `set` |
| `web-client` | app.qorpera.com (Cloudflare Pages deploys every master commit) | `manifest.mjs web` |

Runtime connectors and tools are part of `runtime-bundle`.

## In the cut routine

After resume and acceptance, and before `agent gc`:

```bash
M=deploy/deployment-manifest/manifest.mjs
W=/Users/jonas/Documents/Codex/2026-09-13/take-over-the-qorpera-runtime-work
D=$W/outputs/deployment-manifest

# 1. What the lane changed (SQL, bundle, runner image, Codex binary, guest host, node releases, exec host)
node $M lane --lane $W/work/cut-v107-a1 --root $W --cut "cut v107 (work/cut-v107-a1)" > $D/changes/0007-cut-v107.json
#    Add set operations by hand for parts the lane does not record in JSON (coding switch, broker roll, office).
#    Fill every null you can confirm from a receipt; leave the rest null.
node $M apply --dir $D --changes $D/changes/0007-cut-v107.json --root $W

# 2. The acceptance runs, against what is live now
node $M apply --dir $D --changes $D/changes/0008-cut-v107-accepted.json --root $W
node $M check --manifest $D/current.json --root $W
```

An accept operation names the components a run actually exercised, e.g. a run placed on node 1 accepts
`node-01-release`, but not `node-02-release`:

```json
{
	"schema": "qorpera.deployment-manifest-changes/v1",
	"reason": "cut v107 accepted",
	"writtenBy": "Fable, coordinator",
	"operations": [
		{
			"op": "accept",
			"ids": ["runtime-bundle", "database-migrations", "runner-image", "guest-provider-host", "node-01-release"],
			"at": "2026-09-25T06:10:00Z",
			"summary": "run 1234abcd (acceptance company, node 1) completed; routine last run fired",
			"records": [{ "path": "outputs/BUNDLE-REGISTRY.md", "line": 1200, "quote": "v107 ACCEPTED live" }]
		}
	]
}
```

Changes outside a cut use the same `set` and `accept` operations: a coding machine size change, a broker roll, an
office image. For a web deploy, run:

```bash
gh api repos/Qorpera/Qorpera_Base/commits/<sha>/check-runs > /tmp/checks.json
node $M web --commit <sha> --check-runs /tmp/checks.json > $D/changes/NNNN-web.json
```

Every apply writes a new `history/` file. It also replaces `current.json` and `CURRENT.md`, and chains `previous` to the
sha256 of the file it replaced. Never edit `current.json` by hand: `check` rejects hand edits.

## Drift check (no SSH)

`observed-state.sql` is one read-only SELECT. It returns what the backend itself reports:

- active bundle and last migration;
- the newest enrolled policy per node provider;
- node inventory policies;
- coding VM policy;
- active Company Computer images;
- secret broker authorities;
- which bundle the runs since the activation carried.

Run it read-only (the Management API query endpoint with `read_only: true`) and save the `observed` object:

```bash
node $M drift --manifest $D/current.json --observed observed.json
```

The output says `match` or `DRIFT` per field. It says `not observable from the backend` for what only a node knows:
node agent release numbers, program digests, the runner image fingerprint, broker and gateway programs, the proxy
config. The nodes do not report those to the backend today. This check never uses SSH.

## Rules

- Record only what a receipt, the registry or a read-only query shows. Unknown stays `null`.
- Evidence counts only for what the run exercised. A run's node comes from its placement: `observed-state.sql`
  does not show that, so use `qorpera_runtime_node_demands` via the run's machine allocation.
- A health check (service active, healthz 200) shows a component started. It is not acceptance.
