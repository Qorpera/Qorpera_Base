import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { assertCodingFixtureParents, assertCodingExecutorCleanup, assertCodingExecutorEvidence, codingImageAddress, codingFixtureRemote, localCodingFixtureGit, waitForCodingChild } from "./coding-executor-fixture.mjs";

const execute = promisify(execFile);
function input(scratchRoot, args) {
  return { scratchRoot, cwd: scratchRoot, network: true, args,
    env: { PATH: process.env.PATH, HOME: scratchRoot, XDG_CONFIG_HOME: scratchRoot, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `http.${codingFixtureRemote}.extraHeader`, GIT_CONFIG_VALUE_0: "Authorization: Basic Zml4dHVyZQ==" },
    signal: AbortSignal.timeout(10000) };
}
test("fixture URL substitution performs real local Git reads, strips credentials and disables network", async () => {
  const root = await mkdtemp(join(tmpdir(), "coding-executor-fixture-"));
  try {
    const repo = join(root, "source"), bare = join(root, "bare.git");
    await execute("git", ["init", "--initial-branch=master", repo]);
    await writeFile(join(repo, "value.txt"), "initial\n");
    await execute("git", ["-C", repo, "add", "value.txt"]);
    await execute("git", ["-C", repo, "-c", "user.name=Acceptance", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"]);
    const head = (await execute("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
    await execute("git", ["clone", "--bare", "--no-hardlinks", repo, bare]);
    const observed = [];
    const adapter = localCodingFixtureGit({ bareRepository: bare, runGit: async (command) => {
      assert.equal(command.network, false); assert.equal(command.env.GIT_ALLOW_PROTOCOL, "file");
      assert.equal(command.env.GIT_CONFIG_COUNT, undefined); assert.equal(command.env.GIT_CONFIG_VALUE_0, undefined);
      assert(!command.args.includes(codingFixtureRemote)); observed.push(command.args);
      return (await execute("git", command.args, { cwd: command.cwd, env: command.env })).stdout;
    } });
    const lookup = join(root, "lookup"); await mkdir(lookup);
    assert.equal(await adapter(input(lookup, ["ls-remote", "--refs", "--heads", codingFixtureRemote, "refs/heads/master"])), `${head}\trefs/heads/master\n`);
    const fetched = join(root, "fetch"); await mkdir(fetched); await execute("git", ["init", "--bare", fetched]);
    await adapter(input(fetched, ["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", codingFixtureRemote, "refs/heads/master:refs/heads/master"]));
    assert.equal((await execute("git", ["-C", fetched, "rev-parse", "master"])).stdout.trim(), head);
    assert.equal(observed.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("fixture refuses alternate endpoints, push, branches and credential scope before execution", async () => {
  let calls = 0;
  const adapter = localCodingFixtureGit({ bareRepository: "/never/read", runGit: async () => { calls++; } });
  for (const args of [
    ["ls-remote", "--refs", "--heads", "https://github.com/other/repo.git", "refs/heads/master"],
    ["push", codingFixtureRemote, "HEAD:refs/heads/master"],
    ["ls-remote", "--refs", "--heads", codingFixtureRemote, "refs/heads/other"],
    ["fetch", codingFixtureRemote, "refs/heads/master"],
  ]) await assert.rejects(adapter(input("/tmp/unused", args)));
  const wrong = input("/tmp/unused", ["ls-remote", "--refs", "--heads", codingFixtureRemote, "refs/heads/master"]);
  wrong.env.GIT_CONFIG_KEY_0 = "http.https://elsewhere.invalid.extraHeader";
  await assert.rejects(adapter(wrong)); assert.equal(calls, 0);
});
test("real executor evidence cannot pass without two-user isolation, preserved reuse and closed paid settlement", () => {
  const proof = () => ({ schema: "qorpera.coding-executor-physical/v1",
    sessions: [200000, 200001].map((uid) => ({ uid, vmId: "same", editTestCommit: true, crossSessionDenied: true, custodyWriteDenied: true })),
    reuse: { sameVm: true, sameStorageMarker: true, sameCommit: true, reseeded: false },
    detach: { otherSessionContinued: true, oldTransportRefused: true },
    balanceBefore: { issuedUs: "10000", debitedUs: "0", reservedUs: "0" }, balanceAfter: { issuedUs: "10000", debitedUs: "1000", reservedUs: "0" },
    accounting: { permit: { state: "closed" } }, reconciliation: { debitedUs: "1000" }, reservedUsAfter: "0" });
  assert.doesNotThrow(() => assertCodingExecutorEvidence(proof()));
  for (const mutate of [
    (p) => { p.sessions[1].uid = p.sessions[0].uid; }, (p) => { p.sessions[0].crossSessionDenied = false; },
    (p) => { p.sessions[0].custodyWriteDenied = false; }, (p) => { p.reuse.reseeded = true; },
    (p) => { p.detach.otherSessionContinued = false; }, (p) => { p.accounting.permit.state = "bound"; },
    (p) => { p.reservedUsAfter = "1"; }, (p) => { p.reconciliation.debitedUs = "0"; },
  ]) { const value = proof(); mutate(value); assert.throws(() => assertCodingExecutorEvidence(value)); }
});

test("failed prepare retains empty-VM custody until both guard and SQL close", () => {
  const sql = { openReservations: 0, openPermits: 0, closedPermitIds: [], closedAttemptIds: [] };
  const intent = { state: "registered", intent: { permitId: "one" } };
  assert.throws(() => assertCodingExecutorCleanup(sql, [intent], []));
  assert.throws(() => assertCodingExecutorCleanup({ ...sql, openReservations: 1 }, [], []));
  assert.throws(() => assertCodingExecutorCleanup({ ...sql, openPermits: 1 }, [], []));
  intent.state = "abandoned";
  assert.throws(() => assertCodingExecutorCleanup(sql, [intent], []));
  assert.doesNotThrow(() => assertCodingExecutorCleanup({ ...sql, closedAttemptIds: ["one"] }, [intent], []));
  const record = { phase: "running", permit: { permitId: "one" }, stopReceipt: null };
  const closed = { ...sql, closedPermitIds: ["one"] };
  assert.throws(() => assertCodingExecutorCleanup(closed, [], [record]));
  assert.doesNotThrow(() => assertCodingExecutorCleanup(closed, [], [{ ...record, phase: "stopped", stopReceipt: {} }]));
});

test("timed out child escalates without treating its later exit as successful cleanup", async () => {
  const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000)'], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((resolve) => child.stdout.once("data", resolve));
  const signals = [];
  await assert.rejects(waitForCodingChild(child, { timeoutMs: 20, graceMs: 30, kill: (signal) => { signals.push(signal); child.kill(signal); } }), /custody retained/);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("image address follows the guest default-route device and remains inside the managed bridge", () => {
  const link = (name, ip) => ({ ifname: name, addr_info: [{ family: "inet", scope: "global", local: ip }] });
  const route = (name) => ({ dst: "default", dev: name });
  assert.equal(codingImageAddress([link("enp5s0", "10.22.1.2")], [], "10.22.1.1/24"), null);
  for (const name of ["eth0", "enp5s0"]) assert.deepEqual(codingImageAddress([link("lo", "127.0.0.1"), link(name, "10.22.1.2")], [route(name)], "10.22.1.1/24"), { device: name, address: "10.22.1.2" });
  assert.equal(codingImageAddress([link("eth0", "10.22.1.2")], [route("enp5s0")], "10.22.1.1/24"), null);
  assert.throws(() => codingImageAddress([link("enp5s0", "10.23.1.2")], [route("enp5s0")], "10.22.1.1/24"), /outside/);
  assert.throws(() => codingImageAddress([link("enp5s0", "10.22.1.2")], [route("eth0"), route("enp5s0")], "10.22.1.1/24"), /Ambiguous/);
});

test("fixture preflight rejects writable, foreign-owned and symlinked system ancestry", () => {
  const parents = () => ["/", "/var", "/var/lib"].map((path) => ({ path, canonical: path, directory: true, symlink: false, uid: 0, gid: 0, mode: 0o755 }));
  assert.doesNotThrow(() => assertCodingFixtureParents(parents()));
  for (const mutation of [{ mode: 0o777 }, { mode: 0o775 }, { uid: 1001 }, { symlink: true }, { canonical: "/elsewhere" }]) {
    const value = parents(); Object.assign(value[2], mutation);
    assert.throws(() => assertCodingFixtureParents(value));
  }
});
