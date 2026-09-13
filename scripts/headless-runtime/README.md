# Install and call the headless runtime

`install.py` installs a reviewed local tarball closure into a new consumer and
calls the installed public runtime exports. It requires Python 3 and Node.js
22.19 or later with npm. Run runtime verification on an isolated allocation on
an actual Linux runtime-hosting node, as required by runtime-contract §24.

The installer uses offline npm with lifecycle scripts disabled, an empty
configuration and a fresh cache. It verifies every installed file against its
tarball before and after execution and rejects transitive checkout imports.
It does not build a release, obtain credentials, provision services or activate
a runtime bundle. Reserve CPU, memory and scratch storage before node execution;
give the process no live endpoint credentials or provider tokens.

## Inputs from the frozen release

Build the packages from the reviewed clean release commit and preserve its build
record. Collect npm tarballs for `@qorpera/runtime`, `@qorpera/contracts`,
`@qorpera/company`, `@qorpera/cloud-client` and the complete declared dependency
closure. Keep exact resolved versions and hashes; no workspace, registry or
checkout fallback is allowed. An absent peer is allowed only when its package
manifest explicitly marks it optional. Source-to-build provenance remains a
separate requirement; declaring a source commit in this input is not proof of it.

Create `release-input.json` with independently verified release pins and every
tarball's absolute path and SHA256:

```json
{
  "schema": "qorpera.external-runtime-input/v1",
  "sourceCommit": "<exact 40-character commit>",
  "runtimeBundleSha256": "<runtime bundle SHA256>",
  "modelPolicySha256": "<resolved model policy SHA256>",
  "nativeBinarySha256": "<native artifact SHA256>",
  "tarballs": [
    { "path": "/absolute/path/package.tgz", "sha256": "<tarball SHA256>" }
  ]
}
```

The example list is schematic; a complete closure is required. The installer
allows at most 100 packages, 200 MiB total expanded content, and requires at least
600 MiB free scratch space. Existing attempts are never overwritten.

```sh
python3 -B scripts/headless-runtime/install.py \
  --input /absolute/path/release-input.json \
  --out /absolute/path/new-consumer-attempt \
  --node "$(command -v node)" --npm "$(command -v npm)"
```

The result contains the standalone `consumer/` package tree, exact input,
installation/call logs, `RESULT.json` and `consumer/CALL-RESULT.json`. Keep failed
attempts and use a new output path after correcting their cause. The consumer's
installed packages are usable without the source checkout; no web or desktop
executor is started or required.

## Public interfaces and evidence scope

The runtime package root exports the executable bundle, model policy and native
artifact pins. Server implementations use its declared module subpaths. The
included `consumer.mjs` exercises these public imports:

| Import | Call checked |
| --- | --- |
| `@qorpera/runtime/cloud-runtime-bundle` | Exact bundle admission and mismatched-pin refusals |
| `@qorpera/runtime/cloud-runtime-policy` | Installed resolved model policy |
| `@qorpera/runtime/cloud-wake-bus` | All five wake-kind policies, silence and closed-schema refusals |
| `@qorpera/cloud-client/cloud-request` | Bounded binary response handling and oversized-response refusal |

These calls use synthetic inputs and perform no live RPC or model work. Fetch
and WebSocket are disabled in this consumer; this is not an operating-system
network sandbox. The result proves installed package callability for these
boundaries, not complete runtime operation or deployment acceptance.

Operating the runtime also requires its matching admitted SQL, protected native
provider and office services, runner orchestrator, storage, credentials and
network configuration. Existing service packagers use the runtime's headless
entrypoints. Follow the current Step 4 integration/deployment runbook for those
artifacts; the package installer does not replace their protected admission or
start them. The web client consumes the browser-safe cloud-client interfaces
and must not import runtime implementation or own its execution loop.

Final acceptance must independently exercise live headless calls and continued
cloud execution after all clients disconnect, plus the deployed web flows and
actual LXD/systemd/storage/restart boundaries required by Steps 0–4. Record the
installed release and node identities separately from these component receipts.

## Installer regression tests

```sh
QORPERA_TEST_NODE="$(command -v node)" QORPERA_TEST_NPM="$(command -v npm)" \
  python3 -B scripts/headless-runtime/test_install.py
```

The suite uses disposable synthetic packages. Its real offline-install case
requires Node/npm and fails if they are unavailable, rather than skipping the
checkout-isolation boundary. Explicit tool paths let an isolated node use a
task-local npm installation without changing the host installation.
