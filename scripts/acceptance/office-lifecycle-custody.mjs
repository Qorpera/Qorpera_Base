import assert from "node:assert/strict";
import { createHash } from "node:crypto";

/** Discover before the first review marker exists. A name prefix is never
 * ownership: every VM must match the protected fixture policy and its exact
 * allocation digest. Unknown instances prevent destructive cleanup. */
export function officeCustodyMachines(instances, policy, policySha256) {
	assert(Array.isArray(instances), "Office instance inventory unavailable");
	return instances.map((instance) => {
		assert(policy && /^[0-9a-f]{64}$/.test(policySha256), "Office cleanup authority missing");
		const guest = policy.guest, config = instance.config;
		assert(instance.type === "virtual-machine" && instance.project === guest.project && config, "Unowned office instance");
		const allocationId = config["user.qorpera.allocation_id"], physicalId = config["volatile.uuid"];
		const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
		assert(uuid.test(allocationId) && uuid.test(physicalId), "Office physical identity missing");
		const name = `qorpera-office-${allocationId.replaceAll("-", "")}`;
		const identity = { schema: "qorpera.lxd-office-guest/v2", providerId: guest.providerId, providerPolicySha256: policySha256,
			companyId: guest.companyId, environmentId: guest.environmentId, companyComputerId: guest.companyComputerId,
			logicalComputerId: guest.logicalComputerId, computerGeneration: guest.computerGeneration, allocationId,
			project: guest.project, name };
		const expected = { "user.qorpera.schema": identity.schema, "user.qorpera.provider_id": guest.providerId,
			"user.qorpera.provider_policy_sha256": policySha256, "user.qorpera.company_id": guest.companyId,
			"user.qorpera.environment_id": guest.environmentId, "user.qorpera.office_id": guest.companyComputerId,
			"user.qorpera.logical_computer_id": guest.logicalComputerId, "user.qorpera.computer_generation": String(guest.computerGeneration),
			"user.qorpera.bootstrap_sha256": guest.bootstrapSha256,
			"user.qorpera.instance_sha256": createHash("sha256").update(JSON.stringify(identity)).digest("hex") };
		assert.equal(instance.name, name, "Office allocation name changed");
		for (const [key, value] of Object.entries(expected)) assert.equal(config[key], value, "Office ownership changed");
		return { name, project: guest.project, physicalId };
	});
}

/** Keep the independent guard and all durable custody through uncertain
 * closure. Even a failed diagnostic cannot bypass database retention, which
 * the caller selects before launching its private PostgreSQL process. */
export async function closeOfficeLifecycleCustody(ports) {
	const errors = [];
	const attempt = async (operation) => { try { return await operation(); } catch (error) { errors.push(error); return undefined; } };
	for (const stop of ports.stopProducers) await attempt(stop);
	const machines = await attempt(ports.discover);
	if (machines) for (const machine of machines) await attempt(() => ports.stopAndVerify(machine));
	let released = false;
	if (ports.passed && !errors.length && machines && await attempt(ports.accountingSettled)) {
		for (const machine of machines) {
			if (errors.length) break;
			await attempt(() => ports.deleteStopped(machine));
		}
		if (!errors.length) await attempt(ports.confirmEmpty);
		// No physical custody remains before stopping the watchdog.
		if (!errors.length) await attempt(ports.stopGuard);
		released = errors.length === 0;
	}
	await attempt(ports.closeRpc);
	// This always stops with keepFiles=true, including success. Destruction is
	// a separate action after every physical/accounting/transport check passed.
	await attempt(ports.stopDatabaseRetainingFiles);
	if (released && !errors.length) await attempt(ports.removeStorage);
	if (released && !errors.length) await attempt(ports.removeDatabase);
	const cleanup = released && errors.length === 0;
	if (!cleanup) await attempt(() => ports.retainDiagnostic({ machines: machines ?? null, errors: errors.length }));
	return { cleanup, custodyRetained: !cleanup, physicalMachinesObserved: machines?.length ?? null, errors: errors.length };
}
