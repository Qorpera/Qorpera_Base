import assert from "node:assert/strict";
import { cp, lstat, mkdtemp } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

export const codingFixtureRepository = Object.freeze({ host: "github.com", owner: "Qorpera", name: "Qorpera_Base", baseBranch: "master" });
export const codingFixtureRemote = "https://github.com/Qorpera/Qorpera_Base.git";

/** The only substitute: the fixture's two read-only remote Git operations.
 * The real broker still executes every Git operation in its Linux sandbox.
 * It receives no network namespace and no HTTP credential for these reads. */
export function localCodingFixtureGit({ bareRepository, runGit, record = () => {} }) {
  assert(isAbsolute(bareRepository) && typeof runGit === "function");
  return async (input) => {
    if (!input.network) return runGit(input);
    const remoteIndex = input.args.indexOf(codingFixtureRemote);
    assert(remoteIndex >= 0 && input.args.lastIndexOf(codingFixtureRemote) === remoteIndex, "Only the exact local fixture remote is supported");
    const lookup = input.args.slice(-5).join("\0") === ["ls-remote", "--refs", "--heads", codingFixtureRemote, "refs/heads/master"].join("\0");
    const fetch = input.args.slice(-6).join("\0") === ["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", codingFixtureRemote, "refs/heads/master:refs/heads/master"].join("\0");
    assert(lookup || fetch, "Fixture transport cannot push, change refs or access arbitrary URLs");
    assert(input.args.filter((arg) => /^https?:|^file:|^ssh:/.test(arg)).length === 1);
    assert.equal(input.env.GIT_CONFIG_COUNT, "1");
    assert.equal(input.env.GIT_CONFIG_KEY_0, `http.${codingFixtureRemote}.extraHeader`);
    assert(/^Authorization: Basic [A-Za-z0-9+/=]+$/.test(input.env.GIT_CONFIG_VALUE_0));
    assert(isAbsolute(input.scratchRoot) && isAbsolute(input.cwd));
    const child = relative(input.scratchRoot, input.cwd);
    assert(child !== ".." && !child.startsWith("../") && !isAbsolute(child));
    const copied = join(await mkdtemp(join(input.scratchRoot, ".acceptance-remote-")), "repository.git");
    const source = await lstat(bareRepository);
    assert(source.isDirectory() && !source.isSymbolicLink());
    await cp(bareRepository, copied, { recursive: true, errorOnExist: true, force: false });
    const env = { ...input.env, GIT_ALLOW_PROTOCOL: "file" };
    delete env.GIT_CONFIG_COUNT; delete env.GIT_CONFIG_KEY_0; delete env.GIT_CONFIG_VALUE_0;
    const args = input.args.map((arg) => arg === codingFixtureRemote ? copied : arg);
    args.unshift("-c", "protocol.file.allow=always");
    record({ operation: lookup ? "ls-remote" : "fetch", remote: codingFixtureRemote, network: false });
    return runGit({ ...input, network: false, args, env });
  };
}

export function assertCodingExecutorEvidence(value) {
  assert.equal(value.schema, "qorpera.coding-executor-physical/v1");
  assert.equal(value.sessions.length, 2);
  assert.equal(new Set(value.sessions.map((s) => s.uid)).size, 2);
  assert(value.sessions.every((s) => Number.isInteger(s.uid) && s.uid >= 200000 && s.editTestCommit && s.crossSessionDenied && s.custodyWriteDenied));
  assert.equal(new Set(value.sessions.map((s) => s.vmId)).size, 1);
  assert.equal(value.reuse.sameVm, true); assert.equal(value.reuse.sameStorageMarker, true);
  assert.equal(value.reuse.sameCommit, true); assert.equal(value.reuse.reseeded, false);
  assert.equal(value.detach.otherSessionContinued, true); assert.equal(value.detach.oldTransportRefused, true);
  assert.equal(value.accounting.permit.state, "closed");
  assert(value.reconciliation && BigInt(value.reconciliation.debitedUs) > 0n);
  assert.equal(value.reservedUsAfter, "0");
  assert.equal(value.balanceBefore.issuedUs, value.balanceAfter.issuedUs);
  assert.equal(value.balanceBefore.reservedUs, "0"); assert.equal(value.balanceAfter.reservedUs, "0");
  assert.equal(BigInt(value.balanceAfter.debitedUs) - BigInt(value.balanceBefore.debitedUs), BigInt(value.reconciliation.debitedUs));
}

/** Absence of a VM is not proof that an admitted start cannot arrive later. */
export function assertCodingExecutorCleanup(sql, intents, records) {
  assert.equal(sql.openReservations, 0, "Unsettled allowance custody must be retained");
  assert.equal(sql.openPermits, 0, "Open permit custody must be retained");
  const closed = new Set([...sql.closedPermitIds, ...sql.closedAttemptIds]);
  for (const intent of intents) {
    assert.notEqual(intent.state, "registered", "Undispatched intent requires durable cancellation before cleanup");
    assert(closed.has(intent.intent.permitId), "Guard intent has no confirmed SQL closure");
  }
  for (const record of records) {
    assert.equal(record.phase, "stopped", "Physical custody has not stopped");
    assert(record.stopReceipt && closed.has(record.permit.permitId), "Physical stop requires matching SQL closure");
  }
}

/** Stop only this harness process group. Independent systemd custody survives. */
export function waitForCodingChild(child, { timeoutMs, graceMs = 10000, kill = (signal) => child.kill(signal) }) {
  return new Promise((resolve, reject) => {
    let expired = false, escalation, final;
    const finish = (error, code) => {
      clearTimeout(timer); clearTimeout(escalation); clearTimeout(final);
      child.removeListener("error", onError); child.removeListener("close", onClose);
      if (error) reject(error); else resolve(code);
    };
    const onError = (error) => finish(error);
    const onClose = (code) => finish(expired ? new Error("Coding executor timed out; custody retained") : null, code);
    const timer = setTimeout(() => {
      expired = true;
      try { kill("SIGTERM"); } catch (error) { finish(error); return; }
      escalation = setTimeout(() => {
        try { kill("SIGKILL"); } catch (error) { finish(error); return; }
        final = setTimeout(() => { child.unref(); finish(new Error("Coding executor exit unconfirmed; custody retained")); }, graceMs);
      }, graceMs);
    }, timeoutMs);
    child.once("error", onError); child.once("close", onClose);
  });
}

/** VM device names are selected by the guest; do not assume container eth0. */
export function codingImageAddress(addresses, routes, bridgeCidr) {
  const defaults = routes.filter((route) => route.dst === "default");
  if (defaults.length === 0) return null;
  assert.equal(defaults.length, 1, "Ambiguous guest default route");
  const device = defaults[0].dev;
  assert(typeof device === "string" && /^[a-zA-Z0-9_.:-]{1,32}$/.test(device));
  const candidates = addresses.filter((link) => link.ifname === device).flatMap((link) => link.addr_info ?? [])
    .filter((entry) => entry.family === "inet" && entry.scope === "global");
  if (candidates.length === 0) return null;
  assert.equal(candidates.length, 1, "Ambiguous guest IPv4 address");
  const numeric = (ip) => {
    assert(typeof ip === "string" && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip));
    const bytes = ip.split(".").map(Number); assert(bytes.every((b) => b >= 0 && b <= 255));
    return bytes.reduce((sum, byte) => sum * 256 + byte, 0);
  };
  const [bridge, prefix] = bridgeCidr.split("/");
  assert(/^\d+$/.test(prefix) && Number(prefix) >= 8 && Number(prefix) <= 30);
  assert.equal(Math.floor(numeric(candidates[0].local) / 2 ** (32 - Number(prefix))),
    Math.floor(numeric(bridge) / 2 ** (32 - Number(prefix))), "Guest address is outside the managed bridge");
  return { device, address: candidates[0].local };
}
