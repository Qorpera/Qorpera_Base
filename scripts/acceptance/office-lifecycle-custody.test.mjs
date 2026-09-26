import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { closeOfficeLifecycleCustody, officeCustodyMachines } from "./office-lifecycle-custody.mjs";

function fixture() {
	const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
	const policySha256 = "a".repeat(64), allocationId = id(6);
	const guest = { providerId: id(1), companyId: id(2), environmentId: id(3), companyComputerId: id(4), logicalComputerId: id(5), computerGeneration: 1, project: "default", bootstrapSha256: "b".repeat(64) };
	const name = `qorpera-office-${allocationId.replaceAll("-", "")}`;
	const identity = { schema: "qorpera.lxd-office-guest/v2", providerId: guest.providerId, providerPolicySha256: policySha256,
		companyId: guest.companyId, environmentId: guest.environmentId, companyComputerId: guest.companyComputerId,
		logicalComputerId: guest.logicalComputerId, computerGeneration: 1, allocationId, project: "default", name };
	const instance = { name, type: "virtual-machine", project: "default", config: { "volatile.uuid": id(7),
		"user.qorpera.schema": identity.schema, "user.qorpera.provider_id": guest.providerId,
		"user.qorpera.provider_policy_sha256": policySha256, "user.qorpera.company_id": guest.companyId,
		"user.qorpera.environment_id": guest.environmentId, "user.qorpera.office_id": guest.companyComputerId,
		"user.qorpera.logical_computer_id": guest.logicalComputerId, "user.qorpera.computer_generation": "1",
		"user.qorpera.allocation_id": allocationId, "user.qorpera.bootstrap_sha256": guest.bootstrapSha256,
		"user.qorpera.instance_sha256": createHash("sha256").update(JSON.stringify(identity)).digest("hex") } };
	return { instance, policy: { guest }, policySha256 };
}

test("early admission discovery requires exact policy ownership without a review marker or cached name", () => {
	const f = fixture();
	assert.deepEqual(officeCustodyMachines([f.instance], f.policy, f.policySha256), [{ name: f.instance.name, project: "default", physicalId: f.instance.config["volatile.uuid"] }]);
	for (const key of Object.keys(f.instance.config)) {
		assert.throws(() => officeCustodyMachines([{ ...f.instance, config: { ...f.instance.config, [key]: "foreign" } }], f.policy, f.policySha256));
	}
	assert.throws(() => officeCustodyMachines([{ ...f.instance, name: "unrelated" }], f.policy, f.policySha256));
	assert.throws(() => officeCustodyMachines([{ ...f.instance, project: "other" }], f.policy, f.policySha256));
	assert.throws(() => officeCustodyMachines([f.instance], undefined, undefined));
	assert.deepEqual(officeCustodyMachines([], undefined, undefined), []);
});

function closure(failed = new Set(), passed = true, settled = true) {
	const order = [];
	const call = (name, result) => async () => { order.push(name); if (failed.has(name)) throw new Error(name); return result; };
	const f = fixture(), machines = officeCustodyMachines([f.instance], f.policy, f.policySha256);
	return { order, ports: { passed, stopProducers: [call("provider"), call("metering"), call("observer")], discover: call("discover", machines),
		stopAndVerify: call("physical-stop"), accountingSettled: call("accounting", settled), deleteStopped: call("delete"),
		confirmEmpty: call("empty"), stopGuard: call("guard"), closeRpc: call("rpc"), stopDatabaseRetainingFiles: call("pg-retain"),
		removeStorage: call("storage-delete"), removeDatabase: call("pg-delete"), retainDiagnostic: call("diagnostic") } };
}

test("success stops and proves physical/financial closure before guard, database or custody removal", async () => {
	const f = closure();
	assert.equal((await closeOfficeLifecycleCustody(f.ports)).cleanup, true);
	assert.deepEqual(f.order, ["provider", "metering", "observer", "discover", "physical-stop", "accounting", "delete", "empty", "guard", "rpc", "pg-retain", "storage-delete", "pg-delete"]);
});

test("a failed lifecycle retains stopped VM, guard, accounting and journals even when its name was never cached", async () => {
	const f = closure(new Set(), false);
	assert.deepEqual(await closeOfficeLifecycleCustody(f.ports), { cleanup: false, custodyRetained: true, physicalMachinesObserved: 1, errors: 0 });
	assert.deepEqual(f.order, ["provider", "metering", "observer", "discover", "physical-stop", "rpc", "pg-retain", "diagnostic"]);
});

for (const failure of ["provider", "discover", "physical-stop", "accounting", "delete", "empty"]) {
	test(`uncertain ${failure} cannot disable the guard or destroy financial custody`, async () => {
		const f = closure(new Set([failure, "diagnostic"]));
		const result = await closeOfficeLifecycleCustody(f.ports);
		assert.equal(result.cleanup, false);
		assert(!f.order.includes("guard")); assert(!f.order.includes("storage-delete")); assert(!f.order.includes("pg-delete"));
		assert(f.order.indexOf("pg-retain") < f.order.indexOf("diagnostic"));
	});
}

test("unsettled holds do not become settled merely because a VM is stopped", async () => {
	const f = closure(new Set(), true, false);
	assert.equal((await closeOfficeLifecycleCustody(f.ports)).cleanup, false);
	assert(!f.order.includes("delete")); assert(!f.order.includes("guard")); assert(!f.order.includes("storage-delete"));
});

test("failed server close and failed retention diagnostic still stop the database retaining files", async () => {
	const f = closure(new Set(["rpc", "diagnostic"]));
	assert.equal((await closeOfficeLifecycleCustody(f.ports)).cleanup, false);
	assert(f.order.includes("pg-retain")); assert(!f.order.includes("storage-delete")); assert(!f.order.includes("pg-delete"));
});
