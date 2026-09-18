import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { type CompanyComputerLifecycleRequest, parseCompanyComputerLifecycleRequest } from "@qorpera/contracts";
import type { LxdOfficeLifecycleResult } from "../../src/lxd-office-lifecycle.ts";

/** Repeated provider recovery over real SQL/Unix HTTP. Root measurements and
 * workload readiness are explicitly synthetic in this probe. */
export async function runOfficeBootRestartCycles(input: {
	files: Map<string, { content: Buffer; mode: string }>;
	request: CompanyComputerLifecycleRequest;
	finalReboot?: boolean;
	reconcile: () => Promise<LxdOfficeLifecycleResult>;
	setRecovery: (request: CompanyComputerLifecycleRequest) => void;
	enable: () => Promise<void>;
	revoke: () => Promise<void>;
	restartDatabase: () => Promise<void>;
	counts: () => { starts: number; inspections: number; uploads: number };
}) {
	const retained = [...input.files].map(([path, file]) => [path, Buffer.from(file.content)] as const);
	await input.enable();
	let request = input.request;
	const results = [],
		invocations = [request.startup.serviceInvocationId];
	for (let cycle = 0; cycle < 2; cycle++) {
		// Lose each committed preparation and activation response independently.
		await assert.rejects(input.reconcile(), /OFFICE_LIFECYCLE_UNCONFIRMED/);
		await input.restartDatabase();
		await assert.rejects(input.reconcile(), /OFFICE_LIFECYCLE_UNCONFIRMED/);
		await input.restartDatabase();
		const active = await input.reconcile();
		assert.equal(active.state, "active");
		assert.equal(active.phase, "service_restart");
		assert(active.activationId);
		assert.deepEqual(await input.reconcile(), active);
		assert.equal(input.counts().starts, cycle + 1);
		assert.equal(input.counts().uploads, cycle + 1);
		const completion = JSON.parse(
			input.files
				.get(`/run/qorpera-office-preparation/boot-service-restart-completion-${active.activationId}.json`)!
				.content.toString(),
		);
		assert.equal(completion.activationId, active.activationId);
		assert(!invocations.includes(completion.serviceInvocationId));
		invocations.push(completion.serviceInvocationId);
		request = parseCompanyComputerLifecycleRequest({
			...request,
			action: cycle === 1 && input.finalReboot ? "reboot" : "service_restart",
			activationId: active.activationId,
			transitionId: randomUUID(),
			startup: { ...request.startup, serviceInvocationId: completion.serviceInvocationId },
		});
		if (cycle === 1) await input.revoke(); // Emergency stop remains possible after preparation is disabled.
		input.setRecovery(request);
		await assert.rejects(input.reconcile(), /OFFICE_LIFECYCLE_UNCONFIRMED/);
		await input.restartDatabase();
		await assert.rejects(input.reconcile(), /OFFICE_LIFECYCLE_UNCONFIRMED/);
		await input.restartDatabase();
		const stopped = await input.reconcile();
		assert.equal(stopped.state, "progressed");
		assert.equal(stopped.phase, "service_stop");
		assert.equal(stopped.transitionId, request.transitionId);
		assert(stopped.acknowledgedAtMs);
		results.push({ active, stopped });
	}
	for (const [path, bytes] of retained)
		assert(bytes.equals(input.files.get(path)!.content), `retained bytes changed: ${path}`);
	return {
		results,
		request,
		...input.counts(),
		distinctInvocations: invocations.length,
		preservedHistory: true,
		actualSqlAndUnixHttp: true,
		rootControls: "synthetic",
	};
}
