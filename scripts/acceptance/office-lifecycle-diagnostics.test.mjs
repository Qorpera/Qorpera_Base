import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { buildSync } from "esbuild";
import { officeJournalDiagnostic, officeJournalDiagnostics, officePaidDiagnostic, officePaidSqlDiagnostics, officeSqlFailureHistory, officeProcessDiagnostic, officeServiceDiagnostics, officeStartupDiagnostics, officeStartupLogDiagnostic } from "./office-lifecycle-diagnostics.mjs";

const root = mkdtempSync(join(tmpdir(), "office-service-diagnostics-"));
after(() => rmSync(root, { recursive: true, force: true }));
const tools = join(root, "tools.mjs");
buildSync({ entryPoints: [new URL("./office-lifecycle-tools.ts", import.meta.url).pathname], outfile: tools, bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "silent",
	banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } });
const project = text => {
	const result = spawnSync(process.execPath, [tools, "service-diagnostics"], { input: text, encoding: "utf8", timeout: 10000, maxBuffer: 16384 });
	assert.equal(result.status, 0);
	return JSON.parse(result.stdout);
};

test("guest service failures are reprojected through the production closed code list", () => {
	const secret = "private-token";
	const record = { schema: "qorpera.office-service-failure/v1", stages: ["startup", secret], codes: ["OFFICE_STARTUP_METERING_TIMEOUT", secret], categories: ["filesystem-permission", secret] };
	const output = project([secret, JSON.stringify(record), JSON.stringify({ ...record, message: secret }), JSON.stringify({ ...record, codes: secret }), JSON.stringify({ ...record, schema: secret })].join("\n"));
	assert.deepEqual(output, [{ schema: record.schema, stages: ["startup"], codes: ["OFFICE_STARTUP_METERING_TIMEOUT"], categories: ["filesystem-permission"] }]);
	assert(!JSON.stringify(output).includes(secret));
	assert.equal(project(Array.from({ length: 20 }, () => JSON.stringify(record)).join("\n")).length, 8);
	assert.deepEqual(project(`${JSON.stringify(record)}\n${"untrusted\n".repeat(64)}`), []);
	assert.notEqual(spawnSync(process.execPath, [tools, "service-diagnostics"], { input: "x".repeat(65537), encoding: "utf8", timeout: 10000 }).status, 0);
});

test("owned current-boot service journal is bounded and checked against physical identity before export", () => {
	const f = fixture(), calls = [];
	const record = { schema: "qorpera.office-service-failure/v1", stages: ["configuration"], codes: ["INVALID_OFFICE_STARTUP_IDENTITY"], categories: ["unknown"] };
	const result = officeServiceDiagnostics({ ...f, project, command(args, maximum) {
		calls.push({ args, maximum });
		return { status: 0, stdout: args[0] === "exec" ? JSON.stringify(record) : JSON.stringify(f.instance) };
	} });
	assert.deepEqual(result, { available: true, complete: true, failures: [record] });
	assert.deepEqual(calls[1], { args: ["exec", f.machineName, "--project", "default", "--", "journalctl", "--boot=0", "--unit=qorpera-company-computer.service", "--lines=64", "--output=cat", "--no-pager"], maximum: 65536 });
	assert.equal(calls.length, 3);
});

test("foreign, changed, incomplete and unavailable service journals never reach the projector", () => {
	for (const fault of ["foreign", "changed", "truncated", "unavailable", "oversized"]) {
		const f = fixture(); let queried = 0, projected = false;
		if (fault === "foreign") f.policySha256 = "f".repeat(64);
		const result = officeServiceDiagnostics({ ...f, project() { projected = true; return []; }, command(args) {
			if (args[0] === "exec") return fault === "truncated" ? { status: null, error: { code: "ENOBUFS" }, stdout: "partial" } :
				fault === "unavailable" ? { status: 1, stdout: "" } : { status: 0, stdout: fault === "oversized" ? "x".repeat(65537) : "" };
			if (++queried === 2 && fault === "changed") f.instance.config["volatile.uuid"] = "10000000-0000-4000-8000-000000000099";
			return { status: 0, stdout: JSON.stringify(f.instance) };
		} });
		assert.equal(result.available, false);
		assert.equal(projected, false);
	}
});

test("office failure diagnostics export fixed states without journal credentials or arbitrary strings", () => {
	assert.deepEqual(officeJournalDiagnostic({ schema: "qorpera.lxd-office-operation-event/v2", state: "pending", action: "start", kind: "accepted", startSettled: false,
		secret: "private-token", operationId: "private-value", error: "private error", context: { token: "private-token" } }),
		{ schema: "qorpera.lxd-office-operation-event/v2", state: "pending", kind: "accepted", action: "start", startSettled: false });
	assert.deepEqual(officeJournalDiagnostic({ schema: "private-token", state: "private-token", kind: "private-token", startSettled: "private-token" }), {});
	assert.deepEqual(officeJournalDiagnostic(null), {});
});

test("known service inspection records retain only validated correlation identities", () => {
	const inspectionId = "10000000-0000-4000-8000-000000000001", commandId = "10000000-0000-4000-8000-000000000002",
		bootId = "10000000-0000-4000-8000-000000000003", operationId = "10000000-0000-4000-8000-000000000004";
	for (const purpose of ["service", "boot-service", "boot-service-restart", "reset-service", "reset-service-restart", "outage-service"]) {
		const dispatch = `qorpera.lxd-office-${purpose}-inspection-dispatch/v1`, accepted = `qorpera.lxd-office-${purpose}-inspection-accepted/v1`;
		assert.deepEqual(officeJournalDiagnostic({ schema: dispatch, inspectionId, command: { commandId, bootId, requestSha256: "private-token" },
			completion: { private: "private-token" }, request: "private-token", startedAt: "private-token" }),
			{ schema: dispatch, inspectionId, commandId, bootId });
		assert.deepEqual(officeJournalDiagnostic({ schema: accepted, inspectionId,
			reference: { operationId, project: "private-token", instanceName: "private-token" }, error: "private-token" }),
			{ schema: accepted, inspectionId, operationId });
	}
});

test("inspection identities never generalize to unknown schemas or arbitrary strings", () => {
	const id = "10000000-0000-4000-8000-000000000001";
	assert.deepEqual(officeJournalDiagnostic({ schema: { toString: "private-token" }, inspectionId: id }), {});
	for (const schema of ["qorpera.lxd-office-unknown-inspection-accepted/v1", "qorpera.lxd-office-boot-service-inspection-accepted/v2", "qorpera.unrelated/v1"])
		assert.deepEqual(officeJournalDiagnostic({ schema, inspectionId: id, command: { commandId: id, bootId: id }, reference: { operationId: id } }), { schema });
	for (const kind of ["accepted", "dispatch"]) {
		const schema = `qorpera.lxd-office-boot-service-inspection-${kind}/v1`;
		assert.deepEqual(officeJournalDiagnostic({ schema, inspectionId: "private-token", command: { commandId: "private-token", bootId: "private-token" }, reference: { operationId: "private-token" } }), { schema });
	}
});

test("bounded journal scan selects accepted nested inspection operations without exporting private records", async () => {
	const journal = mkdtempSync(join(root, "inspection-journal-")), guards = join(journal, "guards");
	mkdirSync(guards);
	const inspectionId = "10000000-0000-4000-8000-000000000001", operationId = "10000000-0000-4000-8000-000000000002",
		ignored = "10000000-0000-4000-8000-000000000003";
	writeFileSync(join(journal, "000-accepted.json"), JSON.stringify({ schema: "qorpera.lxd-office-boot-service-inspection-accepted/v1", inspectionId,
		reference: { operationId, token: "private-token" } }));
	writeFileSync(join(journal, "001-unknown.json"), JSON.stringify({ schema: "qorpera.unrelated/v1", reference: { operationId: ignored } }));
	for (let i = 2; i < 130; i++) writeFileSync(join(journal, `${String(i).padStart(3, "0")}.json`), JSON.stringify({ schema: "qorpera.unrelated/v1", private: "private-token" }));
	const result = await officeJournalDiagnostics(journal, guards);
	assert.equal(result.journal.length, 128);
	assert.deepEqual(result.operationIds, [operationId]);
	assert.deepEqual(result.journal[0], { schema: "qorpera.lxd-office-boot-service-inspection-accepted/v1", inspectionId, operationId });
	assert(!JSON.stringify(result).includes("private-token"));
	assert(!JSON.stringify(result).includes(ignored));
});

test("crowded package history cannot hide reset inspection or independent guard custody", async () => {
	const journal = mkdtempSync(join(root, "crowded-journal-")), guards = mkdtempSync(join(root, "crowded-guards-"));
	for (let i = 0; i < 300; i++) writeFileSync(join(journal, `code-package-${String(i).padStart(4, "0")}.json`),
		JSON.stringify({ schema: "qorpera.lxd-office-code-package-completed/v1", private: "private-token" }));
	const inspectionId = "10000000-0000-4000-8000-000000000001", operationId = "10000000-0000-4000-8000-000000000002";
	writeFileSync(join(journal, `reset-service-inspection-${inspectionId}-accepted.json`),
		JSON.stringify({ schema: "qorpera.lxd-office-reset-service-inspection-accepted/v1", inspectionId, reference: { operationId, private: "private-token" } }));
	writeFileSync(join(guards, "guard.json"), JSON.stringify({ schema: "qorpera.paid-computer-guard/v1", phase: "stopped", private: "private-token" }));
	const result = await officeJournalDiagnostics(journal, guards);
	assert.equal(result.journal.length, 128);
	assert(result.journal.some(record => record.schema === "qorpera.paid-computer-guard/v1" && record.guard.phase === "stopped"));
	assert(result.journal.some(record => record.inspectionId === inspectionId && record.operationId === operationId));
	assert.deepEqual(result.operationIds, [operationId]);
	assert.equal(result.journalLimited, true);
	assert(!JSON.stringify(result).includes("private-token"));
});

test("crowded guard archives preserve a bounded provider share and priority names do not authorize payloads", async () => {
	const journal = mkdtempSync(join(root, "guard-share-journal-")), guards = mkdtempSync(join(root, "guard-share-guards-"));
	for (let i = 0; i < 150; i++) writeFileSync(join(guards, `guard-${String(i).padStart(4, "0")}.json`),
		JSON.stringify({ schema: "qorpera.paid-computer-guard/v1", phase: "stopped", private: "private-token" }));
	for (let i = 0; i < 150; i++) writeFileSync(join(journal, `code-package-${String(i).padStart(4, "0")}.json`),
		JSON.stringify({ schema: "qorpera.lxd-office-code-package-completed/v1" }));
	const ignored = "10000000-0000-4000-8000-000000000001";
	writeFileSync(join(journal, "reset-service-inspection-private-token.json"), JSON.stringify({ schema: "qorpera.unrelated/v1",
		inspectionId: ignored, reference: { operationId: ignored }, private: "private-token" }));
	const result = await officeJournalDiagnostics(journal, guards);
	assert.equal(result.journal.length, 128);
	assert.equal(result.journal.filter(record => record.schema === "qorpera.paid-computer-guard/v1").length, 32);
	assert.deepEqual(result.journal[32], { schema: "qorpera.unrelated/v1" });
	assert.equal(result.guardLimited, true);
	assert.equal(result.journalLimited, true);
	assert.deepEqual(result.operationIds, []);
	assert(!JSON.stringify(result).includes("private-token"));
	assert(!JSON.stringify(result).includes(ignored));
});

test("startup logs expose bounded fingerprints and fixed error classes, never arbitrary log text", () => {
	const secret = "credential-not-for-artifacts";
	const value = `Error entering sandbox: ChdirNewRoot Permission denied (os error 13) token=${secret}`;
	const result = officeStartupLogDiagnostic(value);
	assert.equal(result.capturedSha256, createHash("sha256").update(value).digest("hex"));
	assert.deepEqual(result.signatures, ["sandbox_entry_failed", "shared_root_chdir_failed", "permission_denied"]);
	assert.deepEqual(result.errnos, [13]);
	assert(!JSON.stringify(result).includes(secret));
	assert.equal(result.complete, true);
	const large = officeStartupLogDiagnostic(`${"x".repeat(16384)}Permission denied`);
	assert.equal(large.capturedBytes, 16384);
	assert.equal(large.complete, false);
	assert.deepEqual(large.signatures, []);
	assert.equal(officeStartupLogDiagnostic("partial", false).complete, false);
});

function fixture() {
	const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
	const policySha256 = "a".repeat(64), allocationId = id(6);
	const guest = { providerId: id(1), companyId: id(2), environmentId: id(3), companyComputerId: id(4), logicalComputerId: id(5), computerGeneration: 1, project: "default", bootstrapSha256: "b".repeat(64) };
	const machineName = `qorpera-office-${allocationId.replaceAll("-", "")}`;
	const identity = { schema: "qorpera.lxd-office-guest/v2", providerId: guest.providerId, providerPolicySha256: policySha256,
		companyId: guest.companyId, environmentId: guest.environmentId, companyComputerId: guest.companyComputerId,
		logicalComputerId: guest.logicalComputerId, computerGeneration: 1, allocationId, project: "default", name: machineName };
	const instance = { name: machineName, type: "virtual-machine", config: { "volatile.uuid": id(7),
		"user.qorpera.schema": identity.schema, "user.qorpera.provider_id": guest.providerId,
		"user.qorpera.provider_policy_sha256": policySha256, "user.qorpera.company_id": guest.companyId,
		"user.qorpera.environment_id": guest.environmentId, "user.qorpera.office_id": guest.companyComputerId,
		"user.qorpera.logical_computer_id": guest.logicalComputerId, "user.qorpera.computer_generation": "1",
		"user.qorpera.allocation_id": allocationId, "user.qorpera.bootstrap_sha256": guest.bootstrapSha256,
		"user.qorpera.instance_sha256": createHash("sha256").update(JSON.stringify(identity)).digest("hex") } };
	return { instance, machineName, policy: { guest }, policySha256 };
}

test("only exact owned fixed startup logs are queried and identity is checked on both sides", () => {
	const f = fixture(), calls = [];
	const result = officeStartupDiagnostics({ ...f, command(args, maximum) {
		calls.push({ args, maximum });
		return { status: 0, stdout: args[1].includes("/logs/") ? "Error entering sandbox: Permission denied (os error 13)" : JSON.stringify(f.instance) };
	} });
	assert.equal(result.available, true);
	assert.equal(result.physicalId, f.instance.config["volatile.uuid"]);
	assert.deepEqual(calls.map(call => call.args), [
		["query", `/1.0/instances/${f.machineName}?project=default`],
		...["disk.workbench.log", "qemu.early.log", "qemu.log"].map(name => ["query", `/1.0/instances/${f.machineName}/logs/${name}?project=default`]),
		["query", `/1.0/instances/${f.machineName}?project=default`],
	]);
	assert(calls.slice(1, 4).every(call => call.maximum === 16384));
	assert(result.logs.every(log => log.errnos[0] === 13));
});

test("prefix names and missing or changed allocation authority cannot expose startup logs", () => {
	for (const mutation of [f => { f.policy = undefined; }, f => { f.policySha256 = "b".repeat(64); },
		f => { f.instance.config["user.qorpera.company_id"] = "foreign"; }, f => { f.machineName += "/logs/secret"; }]) {
		const f = fixture(), calls = []; mutation(f);
		assert.deepEqual(officeStartupDiagnostics({ ...f, command(args) { calls.push(args); return { status: 0, stdout: JSON.stringify(f.instance) }; } }), { available: false, logs: [] });
		assert(!calls.some(args => args[1].includes("/logs/")));
	}
	const f = fixture(); let inspections = 0;
	const result = officeStartupDiagnostics({ ...f, command(args) {
		if (args[1].includes("/logs/")) return { status: 0, stdout: "Permission denied" };
		if (++inspections === 2) f.instance.config["volatile.uuid"] = "10000000-0000-4000-8000-000000000099";
		return { status: 0, stdout: JSON.stringify(f.instance) };
	} });
	assert.deepEqual(result, { available: false, logs: [], identityChanged: true });
});

test("truncated and absent LXD logs remain explicitly incomplete without failing other diagnostics", () => {
	const f = fixture();
	const result = officeStartupDiagnostics({ ...f, command(args) {
		if (!args[1].includes("/logs/")) return { status: 0, stdout: JSON.stringify(f.instance) };
		if (args[1].includes("disk.workbench")) return { status: null, error: { code: "ENOBUFS" }, stdout: "Permission denied" };
		return { status: 1, stdout: "" };
	} });
	assert.equal(result.available, true);
	assert.equal(result.logs[0].available, true);
	assert.equal(result.logs[0].complete, false);
	assert.equal(result.logs[1].available, false);
	assert.equal(result.logs[1].complete, false);
});

test("owned process summaries accept only fixed comm, numeric identity and bounded kernel wait channel", () => {
	const status = "Name:\tqemu-system-x86\nState:\tS (sleeping)\nUid:\t0\t0\t0\t0\nGid:\t0\t0\t0\t0\nsecret=private-token";
	assert.deepEqual(officeProcessDiagnostic(123, status, "unix_stream_read_generic\n"), {
		pid: 123, name: "qemu-system-x86", state: "S", uid: 0, gid: 0, waitChannel: "unix_stream_read_generic" });
	assert.equal(officeProcessDiagnostic(123, status.replace("qemu-system-x86", "private-token"), "0"), null);
	assert.equal(officeProcessDiagnostic(0, status, "0"), null);
	assert.equal(officeProcessDiagnostic(123, "x".repeat(8193), "0"), null);
	assert.equal(officeProcessDiagnostic(123, status, "x".repeat(129)), null);
	assert.equal(officeProcessDiagnostic(123, status, "private-token\ncredential=value").waitChannel, "unavailable");
});


test("guard archives and durable usage anchors preserve stop clocks without credentials", () => {
	const permit = { permitId: "10000000-0000-4000-8000-000000000001", generation: 2, issuedAt: "2026-09-27T00:00:00Z", deadline: "2026-09-27T00:05:00Z", prestart: { prepareRequestText: "private-token" } };
	const stopReceipt = { state: "stopped", observedUptimeMs: 14000, closedAtUptimeMs: 14500, private: "private-token" };
	const sample = { state: "running", hostUptimeMs: 13000, guestUptimeMs: 2000, observedAt: "2026-09-27T00:00:13Z", private: "private-token" };
	const frame = { sequence: 3, sha256: "a".repeat(64), entryText: JSON.stringify({ schema: "qorpera.computer-guard-usage-entry/v1", permit, sample, stopReceipt: null, deadlineUptimeMs: 300000 }) };
	const archive = officeJournalDiagnostic({ schema: "qorpera.computer-guard-archive/v1", guard: { phase: "stopped", startDispatched: true, startSettled: true, startSucceeded: true, usageRequired: true, permit, stopReceipt, stopAtUptimeMs: 295000 }, closure: { ...permit, state: "closed" } });
	assert.equal(archive.guard.phase, "stopped"); assert.equal(archive.guard.stopAtUptimeMs, 295000);
	assert.equal(archive.stopReceipt.closedAtUptimeMs, 14500); assert.equal(archive.closure.state, "closed");
	const anchor = officeJournalDiagnostic({ schema: "qorpera.computer-guard-usage-anchor/v1", identity: permit, sealed: true, head: frame, lastRunning: frame, acknowledged: frame });
	assert.equal(anchor.head.sequence, 3); assert.equal(anchor.lastRunning.sample.guestUptimeMs, 2000);
	assert.equal(anchor.head.deadlineUptimeMs, 300000); assert.equal(anchor.sealed, true);
	assert(!JSON.stringify([anchor, archive]).includes("private-token"));
	assert(!JSON.stringify([anchor, archive]).includes("entryText"));
	assert.deepEqual(officePaidDiagnostic({ state: "private-token", deadline: "private-token", hostUptimeMs: -1, guestUptimeMs: Infinity }), {});
	assert.deepEqual(officeJournalDiagnostic({ schema: "qorpera.computer-guard-usage-anchor/v1", head: { ...frame, entryText: "x".repeat(8193) } }).head, { available: false });
});

test("SQL failure history keeps the first and recent predicates with exact RPC names and no raw errors", () => {
	const history = officeSqlFailureHistory(), method = "qorpera_record_computer_guard_samples";
	history.record("ERROR:  42501: Captured computer identity differs\nDETAIL: private-token", method);
	for (let i = 0; i < 40; i++) history.record("ERROR:  55000: private-token", "private-token");
	const snapshot = history.snapshot();
	assert.equal(snapshot.total, 41); assert.equal(snapshot.first.length, 16); assert.equal(snapshot.recent.length, 16); assert.equal(snapshot.omitted, 9);
	assert.equal(snapshot.first[0].method, method); assert.equal(snapshot.first[0].code, "CAPTURED_IDENTITY_DIFFERS");
	assert.equal(snapshot.first[0].sqlState, "42501");
	assert.equal(snapshot.recent[0].method, null); assert.equal(snapshot.recent[0].code, "MESSAGE_WITHHELD");
	assert(!JSON.stringify(snapshot).includes("private-token"));
	snapshot.first.length = 0; assert.equal(history.snapshot().first.length, 16);
});

test("paid SQL failure snapshots use bounded columns and reproject returned sample payloads", async () => {
	const summary = await officePaidSqlDiagnostics(async (sql, options) => {
		assert.match(sql, /limit 64/); assert.match(sql, /limit 16/);
		assert.equal(options.maxOutputBytes, 262144);
		return JSON.stringify([{ state: "closed", generation: 1, cursor: { sequence: 8, sealed: true, private: "secret" },
			samples: [{ sequence: 7, coverage: "gap", sample: { state: "gap", hostUptimeMs: 123, secret: "secret" } }] }]);
	});
	assert.deepEqual(summary, [{ state: "closed", generation: 1, cursor: { sequence: 8, sealed: true }, samples: [{ sequence: 7, coverage: "gap", sample: { state: "gap", hostUptimeMs: 123 } }] }]);
});


test("SQL timeouts, caller abort and output limits stay distinct from database rejection", () => {
	const history = officeSqlFailureHistory();
	for (const queryTermination of ["timeout", "caller_abort", "output_limit"])
		history.record("", "qorpera_record_computer_guard_samples", { queryTermination, elapsedMs: 2501, exitCode: null, signal: "SIGKILL", private: "secret" });
	const rejection = history.record("ERROR:  42501: Captured computer identity differs", "qorpera_record_computer_guard_samples", { queryTermination: "process_exit", elapsedMs: 33, exitCode: 3, signal: null });
	assert.equal(rejection.code, "CAPTURED_IDENTITY_DIFFERS"); assert.equal(rejection.exitCode, 3);
	assert.deepEqual(history.snapshot().first.slice(0, 3).map(row => [row.queryTermination, row.elapsedMs, row.exitCode, row.signal]),
		["timeout", "caller_abort", "output_limit"].map(reason => [reason, 2501, null, "SIGKILL"]));
	const hostile = history.record("", "private-token", { queryTermination: "private-token", elapsedMs: -1, exitCode: "private-token", signal: "private-token" });
	assert(!JSON.stringify(hostile).includes("private-token")); assert(!Object.hasOwn(hostile, "elapsedMs"));
});
