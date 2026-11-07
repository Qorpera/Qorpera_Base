# Standalone node observer installation

This unreleased installer is independent of Electron, the web client and the office guest. It installs a host service that reads protected host identity and complete LXD inventory, then publishes through the service-only SQL registry. Installation leaves the observer disabled and inactive. It neither enrolls a node nor creates, adopts, stops or deletes computers.

## Reviewed inputs

Build with `node scripts/package-runtime-node-observer.mjs --out <new-directory>`. Review and retain the exact manifest SHA-256 independently of the package. Its five required artifacts are the observer, fixed namespace helper, installer, observer unit template and namespace helper unit. The manifest is an integrity contract, not a release signature. Existing release/provenance approval is still required for deployment.

On the target Linux host, stage the package, spec and documents in canonical root-owned local directories without writable ancestors or symlinks. The source credential requires root:root mode 0400. Public inputs must be root-owned and not group/world writable. Use a dedicated unused positive UID and private primary GID; the observer also receives the reviewed LXD socket group. The socket must be canonical, root-owned and mode 0660. Node at `/usr/bin/node` must be at least 22.19.

The installation spec has exactly these fields:

```json
{
  "schema": "qorpera.node-observer-installation/v1",
  "packageRoot": "/root/reviewed-node-observer/package",
  "packageManifestSha256": "<SHA-256 of exact manifest bytes>",
  "policySha256": "<canonical public policy SHA-256>",
  "uid": 2301,
  "gid": 2301,
  "documents": {
    "service": {"path": "/root/reviewed-node-observer/service.json", "bytes": 1, "sha256": "<exact byte SHA-256>"},
    "key": {"path": "/root/reviewed-node-observer/service.key", "bytes": 1, "sha256": "<exact byte SHA-256>"},
    "ca": {"path": "/root/reviewed-node-observer/registry-ca.pem", "bytes": 1, "sha256": "<exact byte SHA-256>"}
  }
}
```

Replace every placeholder and byte length with the reviewed values; the example cannot be installed unchanged. `service.json` has exactly `registryUrl` (canonical HTTPS origin) and `policy` (the complete enrolled `qorpera.runtime-node-inventory-policy/v1` policy). The key is the separately scoped service registry credential. The CA document must contain a currently valid CA certificate; its complete bytes are pinned in the spec and installed as `/etc/qorpera/node-observer-ca.pem`. The unit supplies that fixed file through `NODE_EXTRA_CA_CERTS`; standard hostname/certificate verification remains enabled.

The spec's `policySha256` uses the existing `officeDigest` convention: recursively sort object keys, preserve array order, encode compact JSON as UTF-8 and hash those bytes. This local review digest is distinct from the database's digest of PostgreSQL `jsonb::text`; do not substitute one for the other. Startup compares the complete parsed local policy with the SQL context, rather than equating these differently encoded hashes.

## Check and apply

Run the packaged installer as root with the protected spec:

```sh
/usr/bin/node --jitless --disable-proto=throw --disallow-code-generation-from-strings /root/reviewed-node-observer/package/qorpera-node-observer-install.cjs --check --spec /root/reviewed-node-observer/spec.json
/usr/bin/node --jitless --disable-proto=throw --disallow-code-generation-from-strings /root/reviewed-node-observer/package/qorpera-node-observer-install.cjs --apply --spec /root/reviewed-node-observer/spec.json
```

`--check` verifies inputs, executing installer bytes, actual host identity/architecture, socket custody, local Node version, stopped units, dedicated identity, installed bytes and systemd overrides. It creates no account, lock or files and makes no registry/LXD requests. Its output lists the fixed target paths and digest of the reviewed spec.

`--apply` repeats validation under an inherited kernel flock at `/run/qorpera-node-observer-install/install.lock`. It creates the dedicated locked, non-login account if absent, publishes exact files with fsync and atomic rename, verifies the units, reloads systemd and confirms the observer remains disabled/inactive. The internal `--commit` stage refuses invocation without the actual inherited flock; a lock pathname alone grants no authority.

Executables and the receipt live under `/opt/qorpera/node-observer`. Configuration and CA are root-owned mode 0444; the installed key is root-owned mode 0440 for the private primary service group. The receipt records exact file hashes, lengths, modes and GIDs, manifest digest, reviewed policy digest and dedicated identity. Keep the protected input package/spec for exact checks and recovery. The receipt includes a credential digest, never its plaintext.

An exact stopped reinstall preserves file inodes and the service identity. Running processes, changed bytes/modes/groups, symlinks, loaded or unloaded systemd overrides and a receipt with missing installed files are refused. An interrupted first installation without a final receipt can resume only when every existing target exactly matches the reviewed plan. No in-place package, credential, CA or identity rotation is implemented. Do not delete receipts or relax checks to force an upgrade; retain the evidence and use a separately reviewed recovery/migration procedure.

## Enrollment and reconciliation

Before enabling the service, an authorized operator must review the whole physical host, configure its CPU/RAM/headroom policy, enroll exact native/login/office provider placements and enroll the matching inventory policy using the service-only RPCs documented in `RUNTIME-NODE-CAPACITY.md`. Every infrastructure instance needs its exact project/name/physical UUID/configuration digest and cost within reserved headroom. Operating headroom is additional. Pre-existing unregistered machines require explicit reconciliation or verified retirement; adding public tags does not establish missing allocation or physical history.

The current inventory policy is immutable. A daemon certificate/version change, infrastructure replacement or changed physical allocation cannot be silently adopted by editing local configuration. Disable new admission, preserve reservations and physical evidence, and prepare a reviewed migration before changing that authority. Stopping the observer or allowing its observation to expire does not release resources. A versioned node budget change invalidates prior receipts until a fresh scan is accepted.

After deployment approval, start the observer through systemd and independently verify a fresh matching inventory receipt and node capacity query before enabling dispatch. The namespace helper executes with its limited root capability; the ordinary observer has zero capabilities and stays in the host mount namespace. It can access the privileged LXD socket, so its account and code remain part of the trusted host boundary despite having no Linux capabilities. Only fixed read requests are implemented. Closing every desktop/web client has no effect on polling or machine reservations.

## Journal lines

Each look writes one JSON line to the observer's journal (`journalctl -u <the observer's unit> -o cat`): `{"event","state"}`, where `event` is `node_inventory`, `node_health` or `node_agent_exit`. A ready inventory, a whole health sample and a healthy exit write that line alone, as before. Any other look adds why: `check`, the step it stopped at or found the problem in, and `code`, a closed code. An unavailable inventory also has `entries`, the kinds of entry that kept it so. For example:

```json
{"event":"node_inventory","state":"unavailable","check":"reconcile","code":"NODE_INVENTORY_ENTRY_UNAVAILABLE","entries":["unmanaged:UNREGISTERED_INSTANCE"]}
```

The steps:
- `node_inventory`: `host` (the first read of the socket, boot and hardware), `context` (the database's inventory context), `policy` (it equals the installed policy), `inventory` (the VM manager's instances), `host-again` (the same read after the scan), `releases` (the node's signed releases), `reconcile`, then `publish` and `receipt`; `look` for a look that started while the last one was still running (`NODE_OBSERVER_BUSY`). A failed scan step is published `unavailable` with its step and code; a failure at `host`, `publish` or `receipt`, or a look past its 15 seconds, is `unconfirmed` with the step it was in. `reconcile` is `NODE_INVENTORY_ENTRY_UNAVAILABLE`, or `NODE_INVENTORY_HEADROOM_EXCEEDED` when the enrolled reservations no longer fit the node's headroom (its `entries` may be empty). Each entry is `category:REASON` (`unmanaged:UNREGISTERED_INSTANCE`, `build:BUILD_SPACE_EXCEEDED` and the like), once per kind, never an instance.
- `node_health`: `collect` (the probe; a failed probe's sample is still published, so the line says `reported` with the probe's code, `RUNTIME-NODE-HEALTH.md`), `sample` (`NODE_HEALTH_SAMPLE_INCOMPLETE`, with `entries` the metrics' own failure codes) and `publish`.
- `node_agent_exit`: `exit-health` (`NODE_AGENT_EXIT_PROBLEMS`, `NODE_AGENT_EXIT_UNHEALTHY` by the exit's own word, `NODE_AGENT_EXIT_HEALTH_MALFORMED`, or the read's own code for a missing or unprotected file, such as `ENOENT` or `OFFICE_HOST_FILE_UNPROTECTED`) and `publish`.

A database call that fails gives the call's code: `NODE_OBSERVER_RPC_HTTP_<status>`, `NODE_OBSERVER_RPC_CONTENT_TYPE`, `NODE_OBSERVER_RPC_RESPONSE_INVALID`, `NODE_OBSERVER_RPC_RESPONSE_INCOMPLETE`, `NODE_OBSERVER_RPC_RESPONSE_TOO_LARGE`, `NODE_OBSERVER_RPC_REQUEST_TOO_LARGE`, a system or TLS code (`ECONNREFUSED`, `ECONNRESET` and the like), `NODE_OBSERVER_RPC_TIMEOUT` when the call's own five seconds ran out, or `TIMED_OUT` when the look's did. A code is a fixed name only: an error's text, a path, a name, a version, a digest or an id is never logged, and an error with no such code is `UNCODED`. The reports to the database are unchanged.

## Local evidence and limits

`QORPERA_OFFICE_SYSTEMD_TEST_IMAGE=<prepared-local-image-digest> node scripts/test-node-observer-installation-systemd.mjs` uses a prepared digest-pinned Linux image (`scripts/fixtures/systemd-test-image.Dockerfile`), private systemd/cgroups, no external network and no host cgroup bind. Twenty-one checks exercise actual installation/account/file custody, inherited and competing kernel locks, zero observer capabilities, host namespace, trusted HTTPS publication, restart/crash recovery, daemon failure/recovery, cancellation, identical reinstall, partial retained state and loaded/unloaded overrides. The TLS registry and LXD daemon are explicit fixtures; real PostgreSQL integration is separately covered by `scripts/test-runtime-node-inventory.mjs` (deleted in the legacy sweep).

This evidence does not prove live enrollment, real LXD/KVM inventory, NAS durability, deployment or production service credentials. Production remains unreleased pending the complete Step 4 acceptance gates.
