# Runtime release train

Every runtime PR used to declare its own runtime bundle version. It edited the
version lines in `scripts/generate-cloud-runtime-bundle.mjs`, added an
activation migration, regenerated the compiled bundle and its manifest, and
re-pinned the guest package from CI's Linux packaging. Those derived files
conflicted between every pair of runtime PRs, so each merge forced the next PR
to be cut again.

Since 2026-09-26 the derived files belong to release branches only. Feature PRs
change source. One release branch per live cut declares the version and
regenerates everything once.

## Derived files (release branches only)

- `scripts/generate-cloud-runtime-bundle.mjs`: the `activation`,
  `activationVersion`, `previousActivationVersion` and
  `previousActivationSha256` lines (CI enforces these), and the activation
  prerequisite guards in its activation template (release-owned by review; CI
  does not enforce them).
- `supabase/migrations/<timestamp>_runtime_bundle_activation_vNNN.sql`.
- `packages/runtime/src/cloud-runtime-bundle.generated.ts`.
- `deploy/first-node/native-codex/runtime-bundle-manifest.json`.
- `deploy/first-node/native-codex/guest-package-manifest.json` (pinned from
  CI's Linux x64 packaging).
- `scripts/test-runtime-bundle-activation.mjs`, when the release moves the
  activation transition it exercises.

## Feature PRs

- Change source only. Do not declare a bundle version, do not run
  `npm run generate:runtime-bundle`, and do not re-pin the guest package.
  Between cuts master's derived files describe the last release, not master's
  source. That is expected.
- CI enforces this. The "Runtime release train" workflow fails any pull request
  whose head branch does not start with `release/runtime-` when it changes a
  derived file: the generated bundle, its manifest, the guest pin, an
  activation migration, or the `activation`, `activationVersion`,
  `previousActivationVersion` and `previousActivationSha256` lines of
  `scripts/generate-cloud-runtime-bundle.mjs`. Other generator changes are
  allowed. The check compares the pull request merge commit with its base
  (`scripts/check-release-train-derived-files.mjs`). An open PR that still
  carries these files fails until they are dropped.
- CI skips only the freshness comparisons listed below. Every other assertion in
  those tests still runs. Packaging tests package against the committed bundle
  identity, which is exactly what the packaged host embeds.
- `npm run check` and the web `build:release` report a stale bundle instead of
  failing. They still fail on any other generator error.
  `npm run check:runtime-bundle` stays strict. On a stale master it fails, and
  that is not a reason to regenerate.
- If the change needs an activation prerequisite (a guard such as "Activation
  requires migration X"), say so in the PR body. The release branch adds the
  guard.
- SQL migrations use unique plain timestamps later than master's newest
  migration. Never use the `_runtime_bundle_activation_vNNN` name or a
  timestamp the coordinator reserved for an activation.
- A migration that patches an existing function or constraint by exact text
  (for example `pg_temp.*_patch(regprocedure, old, new)`) must carry master's
  current text at merge time. `create or replace` and `drop ... add` also
  overwrite whatever master holds at that name. After merging master into the
  branch, compare each such definition with the newest master migration that
  defines the same name, and run `npm run test:hosted-db` before merging.

## Release branches

The coordinator session owns release branches, bundle numbers, merge order and
live cuts.

1. Branch `release/runtime-vNNN` from the master commit to cut. `NNN` is the
   bundle version it declares.
2. Set the version lines and prerequisite guards in the generator (the previous
   version and SHA-256 are the currently active bundle's), run
   `npm run generate:runtime-bundle`, and re-pin
   `guest-package-manifest.json` from the Linux x64 packaging. The Step 2 LXD
   job's "Test deterministic packaging" step fails with the expected manifest
   when the pin is wrong.
3. Open the PR to master. CI enforces full freshness on it.
4. If master moves while the release PR is open, merge master into the release
   branch, regenerate and re-pin, and let CI run again. A pull request run
   tests the merge with master, so an old green run proves nothing about a
   newer master.
5. Merge, then cut live from the merged master commit.

## How CI tells a release branch apart

Each workflow sets `QORPERA_ENFORCE_RUNTIME_BUNDLE` to `1` only when

```
(github.event_name == 'pull_request' && startsWith(github.head_ref, 'release/runtime-'))
|| (github.event_name == 'push' && startsWith(github.ref_name, 'release/runtime-'))
```

and to `0` otherwise. Manual `workflow_dispatch` runs are not enforced, with one
exception: the signed ephemeral runner export always enforces, because it
publishes a signed image.

Which workflows run:

- "Runtime release train" (`runtime-release-train.yml`) has no path filter. It
  runs on every pull request, on pushes to master and `release/runtime-*`, and
  by hand. It runs the derived-files guard on feature PRs, then
  `npm run check:runtime-bundle:release-train`, the generator test, the
  ephemeral runner packaging test and the guard's own test. A runtime-only
  feature PR matches no other workflow's paths, so this job is the one that
  packages its runtime.
- The same workflow's "Unit tests" job runs every unit test file of
  `packages/runtime`, `packages/shell` and `packages/cloud-client`, sharded
  across runners, on the same triggers. A runtime- or shell-only feature PR is
  therefore tested even when it matches no other workflow's paths. The workflow
  file names each excluded test and why.
- Step 2 LXD, hosted database and ephemeral runner run on every push to
  `release/runtime-*`. The web client workflow also lists `release/runtime-*`
  in its push branches, but keeps its path filter there, so a release push runs
  it only when the push touches one of its paths. The derived files are among
  them.
- A release PR always changes the generated bundle, its manifest and an
  activation migration, so every bundle-related job runs on it. The pull request
  path filters of Step 2 LXD (`deploy/first-node/**`), web client and ephemeral
  runner include the generated bundle or its manifest. Hosted database includes
  none of those; it runs on a release PR because its `supabase/migrations/**`
  filter matches the new activation migration.

Locally, `QORPERA_ENFORCE_RUNTIME_BUNDLE=1` reproduces release enforcement:

```
QORPERA_ENFORCE_RUNTIME_BUNDLE=1 npm run check
QORPERA_ENFORCE_RUNTIME_BUNDLE=1 node --test scripts/generate-cloud-runtime-bundle.test.mjs scripts/package-lxd-runner-guest.test.mjs
```

## Assertions gated by the switch

Enforced only when `QORPERA_ENFORCE_RUNTIME_BUNDLE=1`:

- `scripts/generate-cloud-runtime-bundle.test.mjs`, "the packaged native host
  embeds the same executable and policy pins as its manifest": the generator
  check of the repository and the packager's own freshness gate. Without
  enforcement the test compares the package with the committed bundle identity
  instead.
- `scripts/package-lxd-runner-guest.test.mjs`, "packages the complete pinned LXD
  runner guest contract": the packager's freshness gate; the current guest pin's
  native binary, source commit and patch against `linux-x64-artifact.json`; and,
  on Linux x64, the whole current guest pin against a fresh packaging.
- `scripts/package-ephemeral-runner.test.mjs` and
  `scripts/native-company-artifact.test.mjs`: the packager's freshness gate only.
- `scripts/test-ephemeral-runner-linux.sh`: the packager's freshness gate for
  the image the containment test builds. Without enforcement that package goes
  to `.artifacts/ephemeral-runner-committed-bundle-test`, never to the install
  folder `.artifacts/ephemeral-runner`.
- `npm run check`: the generator check. `check:runtime-bundle` itself is
  unchanged.
- Web `build:release` (the Cloudflare Pages command): it now runs
  `check:runtime-bundle:release-train` instead of `check:runtime-bundle`, then
  `build:release-artifact`. The web client workflow also runs the strict
  `check:runtime-bundle` as its own step, only when enforced.

Nothing else changed. The generator, `check:runtime-bundle`, every production
packager, the rollout gates (`scripts/test-runtime-context-parity.mjs`,
`scripts/test-runtime-provenance.mjs`) and the activation SQL guards still
refuse a stale bundle.

## Cloudflare Pages

The Pages build command stays `npm run build:release --workspace packages/web`.
Pages does not set `QORPERA_ENFORCE_RUNTIME_BUNDLE`, so a Pages build of master
between cuts deploys and does not fail on a stale bundle. `web-deployment.json`
then records the committed bundle identity. That is the last release, which is
what the nodes run.
