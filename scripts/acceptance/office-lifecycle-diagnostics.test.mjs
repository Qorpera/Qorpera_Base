import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { officeJournalDiagnostic, officeProcessDiagnostic, officeStartupDiagnostics, officeStartupLogDiagnostic } from "./office-lifecycle-diagnostics.mjs";

test("office failure diagnostics export fixed states without journal credentials or arbitrary strings", () => {
	assert.deepEqual(officeJournalDiagnostic({ schema: "qorpera.lxd-office-operation-event/v2", state: "pending", action: "start", kind: "accepted", startSettled: false,
		secret: "private-token", operationId: "private-value", error: "private error", context: { token: "private-token" } }),
		{ schema: "qorpera.lxd-office-operation-event/v2", state: "pending", kind: "accepted", action: "start", startSettled: false });
	assert.deepEqual(officeJournalDiagnostic({ schema: "private-token", state: "private-token", kind: "private-token", startSettled: "private-token" }), {});
	assert.deepEqual(officeJournalDiagnostic(null), {});
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
