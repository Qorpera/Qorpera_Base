import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type CompanyComputerLifecycleRequest, parseCompanyComputerLifecycleRequest } from "@qorpera/contracts";
import type { LxdOfficeLifecycleResult } from "../../src/lxd-office-lifecycle.ts";

/** Repeated supervisor/worker/SQL composition with synthetic VM and root
 * effects. Every lost reply is recovered through a fresh provider instance. */
export async function runOfficeVmSqlCycles(input: {
	root: string;
	files: Map<string, { content: Buffer; mode: string }>;
	request: CompanyComputerLifecycleRequest;
	reconcile: () => Promise<LxdOfficeLifecycleResult>;
	setRecovery: (request: CompanyComputerLifecycleRequest) => void;
	setResume: (plan: unknown) => void;
	enable: () => Promise<void>;
	revoke: () => Promise<void>;
	restartDatabase: () => Promise<void>;
	counts: () => {
		powerOff: { posts: number; polls: number };
		resume: { starts: number; polls: number };
		configuration: { posts: number; polls: number; uploads: number };
		activation: { starts: number; inspections: number; uploads: number };
		stops: { stops: number; inspections: number; uploads: number };
	};
}) {
	const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
	const persistent = new Map(
		[...input.files]
			.filter(([path]) => !path.startsWith("/run/"))
			.map(([path, file]) => [path, Buffer.from(file.content)] as const),
	);
	let request = input.request;
	const historical: { request: CompanyComputerLifecycleRequest; plan: unknown }[] = [];
	let historicalReplaysRefused = 0;
	let preservedPersistentFiles = 0;
	const results = [],
		boots = new Set([request.startup.bootId]),
		invocations = new Set([request.startup.serviceInvocationId]);
	for (let cycle = 0; cycle < 2; cycle++) {
		input.setResume(undefined);
		const unknown = await input.reconcile();
		assert.equal(unknown.state, "unknown");
		assert.equal(unknown.phase, "power_off");
		await input.restartDatabase();
		const off = await input.reconcile();
		assert.equal(off.state, "powered_off");
		assert.equal(off.phase, "power_off");
		assert.deepEqual(await input.reconcile(), off);
		const suffix = `${request.startup.allocationId}-${request.transitionId}`;
		const seed = JSON.parse(await readFile(join(input.root, `power-off-request-${suffix}.json`), "utf8"));
		assert.equal(seed.schema, "qorpera.lxd-office-power-off-request/v3");
		const plan = {
			schema: "qorpera.lxd-office-resume-plan/v1",
			request: {
				schema: "qorpera.office-boot-intent-request/v1",
				bootIntentId: randomUUID(),
				activationId: randomUUID(),
				predecessor: request,
				stopHistorySha256: seed.stopHistorySha256,
				powerOffCompletionSha256: hash(await readFile(join(input.root, `power-off-completed-${suffix}.json`))),
			},
		};
		input.setResume(plan);
		assert.equal((await input.reconcile()).phase, "power_off"); // Retain the forward stage before dispatch.
		await input.enable();
		await assert.rejects(input.reconcile(), /OFFICE_LIFECYCLE_UNCONFIRMED/); // Committed intent reply lost.
		await input.restartDatabase();
		assert.equal((await input.reconcile()).state, "unknown"); // Accepted VM operation poll lost.
		await input.restartDatabase();
		const resumed = await input.reconcile();
		assert.equal(resumed.state, "progressed");
		assert.equal(resumed.phase, "resume");
		assert(![...input.files.keys()].some((path) => path.startsWith("/run/")));
		input.files.set("/run/qorpera-office-preparation/control.lock", { content: Buffer.alloc(0), mode: "0600" });
		assert.equal((await input.reconcile()).state, "unknown"); // Accepted root configuration poll lost.
		await input.restartDatabase();
		const configured = await input.reconcile();
		assert.equal(configured.state, "progressed");
		assert.equal(configured.phase, "boot_configuration");
		await assert.rejects(input.reconcile(), /OFFICE_LIFECYCLE_UNCONFIRMED/); // Committed successor preparation lost.
		await input.restartDatabase();
		await assert.rejects(input.reconcile(), /OFFICE_LIFECYCLE_UNCONFIRMED/); // Root start and committed activation lost.
		await input.restartDatabase();
		const active = await input.reconcile();
		assert.equal(active.state, "active");
		assert.equal(active.phase, "boot_activation");
		assert.equal(active.activationId, plan.request.activationId);
		assert.deepEqual(await input.reconcile(), active);
		if (historical.length) {
			const before = input.counts();
			input.setRecovery(historical[0].request);
			input.setResume(historical[0].plan);
			await assert.rejects(input.reconcile(), /OFFICE_LIFECYCLE_UNCONFIRMED/);
			assert.deepEqual(input.counts(), before);
			historicalReplaysRefused++;
			input.setRecovery(request);
			input.setResume(plan);
		}
		historical.push({ request, plan });
		const start = JSON.parse(
			input.files.get("/run/qorpera-office-preparation/boot-service-start-completion.json")!.content.toString(),
		);
		assert(!boots.has(start.command.bootId));
		boots.add(start.command.bootId);
		assert(!invocations.has(start.serviceInvocationId));
		invocations.add(start.serviceInvocationId);
		request = parseCompanyComputerLifecycleRequest({
			...request,
			action: "reboot",
			transitionId: randomUUID(),
			activationId: active.activationId,
			startup: {
				...request.startup,
				bootId: start.command.bootId,
				configurationSha256: start.configurationSha256,
				serviceInvocationId: start.serviceInvocationId,
			},
		});
		await input.revoke();
		input.setRecovery(request);
		input.setResume(undefined);
		await assert.rejects(input.reconcile(), /OFFICE_LIFECYCLE_UNCONFIRMED/); // Committed revocation lost.
		await input.restartDatabase();
		await assert.rejects(input.reconcile(), /OFFICE_LIFECYCLE_UNCONFIRMED/); // Committed stop acknowledgement lost.
		await input.restartDatabase();
		const stopped = await input.reconcile();
		assert.equal(stopped.state, "progressed");
		assert.equal(stopped.phase, "service_stop");
		assert.equal(stopped.transitionId, request.transitionId);
		assert(stopped.acknowledgedAtMs);
		for (const [path, bytes] of persistent)
			assert(bytes.equals(input.files.get(path)!.content), `prior bytes changed: ${path}`);
		preservedPersistentFiles = persistent.size;
		for (const [path, file] of input.files)
			if (!path.startsWith("/run/") && !persistent.has(path)) persistent.set(path, Buffer.from(file.content));
		const counts = input.counts();
		assert.equal(counts.powerOff.posts, cycle + 2);
		assert.equal(counts.powerOff.polls, (cycle + 2) * 2);
		assert.equal(counts.resume.starts, cycle + 2);
		assert.equal(counts.resume.polls, (cycle + 2) * 2);
		assert.equal(counts.configuration.posts, cycle + 2);
		assert.equal(counts.configuration.uploads, cycle + 2);
		assert.equal(counts.activation.starts, cycle + 2);
		assert.equal(counts.activation.uploads, cycle + 2);
		assert.equal(counts.stops.stops, cycle + 5);
		assert.equal(counts.stops.uploads, cycle + 5);
		results.push({ off, resumed, configured, active, stopped, bootId: start.command.bootId, counts });
		console.log(
			`OFFICE_SQL_VM_CYCLE=${JSON.stringify({ cycle: cycle + 1, bootId: start.command.bootId, activationId: active.activationId, counts })}`,
		);
	}
	return {
		results,
		...input.counts(),
		distinctBoots: boots.size,
		historicalReplaysRefused,
		preservedPersistentFiles,
		actualSqlAndUnixHttp: true,
		physicalVM: "synthetic",
		rootControls: "synthetic",
	};
}
