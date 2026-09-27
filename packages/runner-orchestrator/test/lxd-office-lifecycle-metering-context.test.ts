import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	officeLifecycleMeteringFailure,
	readOfficeLifecycleMeteringContext,
} from "../../../scripts/acceptance/office-lifecycle-metering-context.ts";
import {
	PaidComputerGuard,
	PaidComputerGuardJournal,
	type PaidComputerHostClock,
	type PaidComputerPermit,
} from "../src/computer-paid-guard.ts";
import { LxdPaidComputerGuardPhysical } from "../src/computer-paid-guard-lxd.ts";
import {
	type PaidComputerUsageFrame,
	paidComputerUsageCursor,
	parsePaidComputerUsageEntry,
} from "../src/computer-paid-usage.ts";
import type { LxdInstanceRecord, LxdTrackedClient } from "../src/lxd-client.ts";
import { type LxdOfficeGuestBinding, lxdOfficeGuestPlan } from "../src/lxd-office-guest.ts";
import { publish } from "../src/lxd-office-journal-files.ts";
import { type RuntimeComputerContext, RuntimeComputerController } from "../src/runtime-computer-controller.ts";
import type { RuntimePaidComputerMachine } from "../src/runtime-paid-machine.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const signal = () => new AbortController().signal;

/** Unit composition: real controller, durable prestart/guard/usage/archive
 * journals and production LXD adapter; LXD and SQL endpoints are deterministic
 * fixture ports. This does not claim physical Linux or database acceptance. */
async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "office-context-")));
	roots.push(root);
	await chmod(root, 0o700);
	const journalRoot = await realpath(await mkdtemp(join(root, "provider-")));
	await chmod(journalRoot, 0o700);
	const binding: LxdOfficeGuestBinding = {
		schema: "qorpera.lxd-office-guest/v2",
		providerId: randomUUID(),
		providerPolicySha256: "a".repeat(64),
		companyId: randomUUID(),
		environmentId: randomUUID(),
		companyComputerId: randomUUID(),
		logicalComputerId: randomUUID(),
		computerGeneration: 1,
		allocationId: randomUUID(),
		project: "default",
		imageFingerprint: "b".repeat(64),
		bootstrapSha256: "c".repeat(64),
		storagePool: "default",
		rootDiskBytes: 32 * 1024 ** 3,
		workbenchSource: "/var/lib/office-workbench",
		network: "lxdbr0",
		cpus: 1,
		memoryBytes: 4 * 1024 ** 3,
	};
	const plan = lxdOfficeGuestPlan(binding);
	const context: RuntimeComputerContext = {
		allocationId: binding.allocationId,
		providerKind: "office",
		providerId: binding.providerId,
		policySha256: binding.providerPolicySha256,
		instanceSha256: plan.instanceSha256,
		bootstrapSha256: binding.bootstrapSha256,
		runId: null,
		runnerId: null,
		officeId: binding.companyComputerId,
		computerGeneration: binding.computerGeneration,
		officeIntent: { kind: "reset", plan: { transitionId: randomUUID() } },
	};
	const commandId = randomUUID();
	const paidStart = { schema: "qorpera.office-paid-start/v1", commandId, context };
	const paidPath = join(journalRoot, `paid-start-${binding.allocationId}-${commandId}.json`);
	await publish(
		journalRoot,
		`paid-start-${binding.allocationId}-${commandId}.json`,
		Buffer.from(`${JSON.stringify(paidStart)}\n`),
	);
	const clock: PaidComputerHostClock = {
		hostMachineIdSha256: "d".repeat(64),
		hostBootId: randomUUID(),
		uptimeMs: 100000,
	};
	const target: RuntimePaidComputerMachine["physicalTarget"] = {
		kind: "lxd",
		project: binding.project,
		instanceName: plan.request.name,
		profiles: plan.request.profiles,
		config: plan.request.config,
		devices: plan.request.devices,
	};
	const instance: LxdInstanceRecord = {
		name: target.instanceName,
		type: "virtual-machine",
		profiles: [...target.profiles],
		status: "Stopped",
		statusCode: 102,
		config: { ...target.config, "volatile.uuid": randomUUID() },
		expandedConfig: {},
		devices: structuredClone(target.devices),
		expandedDevices: structuredClone(target.devices),
	};
	instance.expandedConfig = { ...instance.config };
	const guestBootId = randomUUID();
	const client = {
		getInstance: vi.fn(async () => structuredClone(instance)),
		submitInstanceOperation: vi.fn(
			async (_project: string, request: Parameters<LxdTrackedClient["submitInstanceOperation"]>[1]) => {
				if (request.action !== "start" && request.action !== "stop") throw new Error("unexpected physical effect");
				instance.status = request.action === "start" ? "Running" : "Stopped";
				instance.statusCode = request.action === "start" ? 103 : 102;
				return { project: target.project, instanceName: target.instanceName, operationId: randomUUID() };
			},
		),
		inspectInstanceOperation: vi.fn(async () => "succeeded" as const),
		readInstanceClock: vi.fn(async () => ({ bootId: guestBootId, uptimeMs: 1000 })),
	};
	const hostClock = async () => ({ ...clock });
	const journal = new PaidComputerGuardJournal(root);
	const guard = new PaidComputerGuard(journal, new LxdPaidComputerGuardPhysical(client, hostClock), hostClock, {
		usageCapture: {
			capture: async () => ({
				host: await hostClock(),
				guestBootId,
				guestUptimeMs: 1000,
				evidenceSha256: "e".repeat(64),
				observedAt: "2026-09-27T12:00:00.000Z",
			}),
		},
	});
	await guard.initialize();
	let permit: PaidComputerPermit | null = null;
	let lastSample: Record<string, unknown> | null = null;
	const control = {
		call: vi.fn(async (method: string, args: Record<string, unknown>): Promise<unknown> => {
			const request = args.p_request as Record<string, unknown>;
			if (method === "qorpera_describe_runtime_computer_prestart")
				return { state: permit?.state ?? "absent", permit, lastSample };
			if (method === "qorpera_describe_runtime_computer_permit")
				return { mode: "paid", permit: permit?.state === "closed" ? null : permit, lastSample };
			if (method === "qorpera_prepare_runtime_computer_permit") {
				expect(permit).toBeNull();
				permit = {
					schema: "qorpera.computer-usage-permit/v2",
					prestart: request.prestart as PaidComputerPermit["prestart"],
					mode: "paid",
					permitId: commandId,
					allocationId: context.allocationId,
					instanceSha256: context.instanceSha256,
					nodeId: randomUUID(),
					epoch: randomUUID(),
					generation: 1,
					reservationId: randomUUID(),
					hostBootId: clock.hostBootId,
					guestBootId: null,
					physicalId: null,
					issuedAt: "2026-09-27T12:00:00.000Z",
					deadline: "2026-09-27T12:05:30.000Z",
					validForMs: 330000,
					windowMs: 300000,
					stopReserveMs: 30000,
					tariffVersion: 1,
					cpuMillis: 1000,
					memoryBytes: binding.memoryBytes,
					state: "prepared",
				};
				return permit;
			}
			if (!permit) throw new Error("fixture permit missing");
			if (method === "qorpera_record_computer_guard_samples") {
				const frames = request.entries as PaidComputerUsageFrame[];
				for (const frame of frames) {
					const sample = parsePaidComputerUsageEntry(JSON.parse(frame.entryText)).sample;
					if (sample.observationId === lastSample?.observationId) continue;
					expect(sample.previousObservationId).toBe(lastSample?.observationId ?? null);
					lastSample = structuredClone(sample) as unknown as Record<string, unknown>;
					if (sample.state === "running")
						permit = {
							...permit,
							state: "bound",
							physicalId: sample.physicalId,
							guestBootId: sample.guestBootId,
						};
				}
				return {
					schema: "qorpera.computer-guard-usage-receipt/v1",
					permit,
					cursor: paidComputerUsageCursor(frames.at(-1)!),
					sealed: lastSample?.state === "stopped",
					lastSample,
				};
			}
			if (method === "qorpera_finish_runtime_computer_permit") {
				expect(request.sample).toEqual(lastSample);
				expect(lastSample?.state).toBe("stopped");
				permit = { ...permit, state: "closed", validForMs: 0 };
				return permit;
			}
			throw new Error(`unexpected fixture method ${method}`);
		}),
	};
	const controller = () => new RuntimeComputerController({ control, guard, client, clock: hostClock });
	const initial = controller();
	await initial.ensure(context, commandId, signal());
	await initial.start(context.allocationId, target, signal());
	await guard.sweep();
	guard.tickUsage();
	await guard.settleUsage(commandId);
	await initial.observe(context.allocationId, signal());
	expect(permit).toMatchObject({ state: "bound" });
	return {
		binding,
		context,
		commandId,
		paidStart,
		paidPath,
		journalRoot,
		journal,
		guard,
		client,
		control,
		controller,
		instance,
		get permit() {
			return permit;
		},
		async seal() {
			guard.tickUsage();
			await guard.settleUsage(commandId);
		},
	};
}

describe("Office acceptance retained metering context", () => {
	it("settles the existing office intent after a controller restart", async () => {
		const f = await fixture();
		const before = await f.guard.latest(f.context.allocationId);
		const calls = f.control.call.mock.calls.length;
		const context = await readOfficeLifecycleMeteringContext({
			binding: f.binding,
			journalRoot: f.journalRoot,
			guard: f.guard,
			signal: signal(),
		});
		expect(context).toEqual(f.context);
		expect(context).not.toBe(f.context);
		expect(f.control.call).toHaveBeenCalledTimes(calls);
		expect(await f.guard.latest(f.context.allocationId)).toEqual(before);
		const controller = f.controller();
		await controller.recover(context, signal());
		await controller.stop(context.allocationId, signal());
		await f.seal();
		await controller.settleStopped(context.allocationId, signal());
		expect(f.permit?.state).toBe("closed");
		expect(await f.guard.list()).toEqual([]);
		expect(await f.guard.listPrestarts()).toEqual([]);
		expect(await f.journal.archiveNames()).toEqual(["0000000000000001.json"]);
		const page = await f.guard.readUsage(f.commandId);
		expect(page.state).toBe("sealed");
		expect(page.acknowledgedThrough).toEqual(page.head);
		expect(page.head.sequence).toBeGreaterThan(1);
		const archived = await f.journal.readArchive(1);
		expect(archived.value.prestart.intent.permitId).toBe(f.commandId);
		expect(archived.value.closure).toMatchObject({ permitId: f.commandId, state: "closed" });
		expect(
			f.control.call.mock.calls.filter(([method]) => method === "qorpera_finish_runtime_computer_permit"),
		).toHaveLength(1);
		expect(f.client.submitInstanceOperation.mock.calls.map(([, request]) => request.action)).toEqual([
			"start",
			"stop",
		]);
		f.control.call.mockClear();
		await f.controller().maintain(signal());
		expect(f.control.call).not.toHaveBeenCalled();
		expect(await f.journal.readArchive(1)).toEqual(archived);
	});
	it("preserves the production refusal for the previous bare acceptance context", async () => {
		const f = await fixture();
		const { officeIntent: _officeIntent, ...context } = f.context;
		const controller = f.controller();
		await controller.recover(context, signal());
		await controller.stop(context.allocationId, signal());
		await f.seal();
		f.control.call.mockClear();
		await expect(controller.settleStopped(context.allocationId, signal())).rejects.toThrow(
			"RUNTIME_COMPUTER_PRESTART_DIFFERS",
		);
		expect(f.instance.status).toBe("Stopped");
		expect(f.permit?.state).toBe("bound");
		expect(f.control.call).not.toHaveBeenCalled();
		expect(await f.journal.archiveNames()).toBeNull();
	});
	it.each([
		"schema",
		"command",
		"allocation",
		"provider",
		"policy",
		"instance",
		"bootstrap",
		"office",
		"generation",
		"missing intent",
		"changed intent",
		"extra context",
		"missing file",
		"unsafe custody",
		"missing prestart",
		"prestart digest",
		"guard incarnation",
		"changed guard",
		"changed retained bytes",
	])("refuses %s before any additional physical or accounting effect", async (mutation) => {
		const f = await fixture();
		const row = structuredClone(f.paidStart);
		if (mutation === "schema") row.schema = "unexpected";
		if (mutation === "command") row.commandId = randomUUID();
		if (mutation === "allocation") row.context.allocationId = randomUUID();
		if (mutation === "provider") row.context.providerId = randomUUID();
		if (mutation === "policy") row.context.policySha256 = "f".repeat(64);
		if (mutation === "instance") row.context.instanceSha256 = "f".repeat(64);
		if (mutation === "bootstrap") row.context.bootstrapSha256 = "f".repeat(64);
		if (mutation === "office") row.context.officeId = randomUUID();
		if (mutation === "generation") row.context.computerGeneration = 2;
		if (mutation === "missing intent") delete row.context.officeIntent;
		if (mutation === "changed intent")
			row.context.officeIntent = { kind: "reset", plan: { transitionId: randomUUID() } };
		if (mutation === "extra context") Object.assign(row.context, { extra: true });
		await writeFile(f.paidPath, `${JSON.stringify(row)}\n`);
		if (mutation === "missing file") await rm(f.paidPath);
		if (mutation === "unsafe custody") await chmod(f.paidPath, 0o644);
		if (mutation === "missing prestart") vi.spyOn(f.guard, "prestartStatus").mockResolvedValueOnce(null);
		if (mutation === "prestart digest" || mutation === "guard incarnation") {
			const prestart = structuredClone((await f.guard.prestartStatus(f.commandId))!);
			if (mutation === "prestart digest") prestart.intent.prepareSha256 = "f".repeat(64);
			else prestart.guardIncarnationId = randomUUID();
			vi.spyOn(f.guard, "prestartStatus").mockResolvedValueOnce(prestart);
		}
		if (mutation === "changed guard") {
			const before = await f.guard.latest(f.context.allocationId);
			vi.spyOn(f.guard, "latest")
				.mockResolvedValueOnce(before)
				.mockResolvedValueOnce({ ...before!, phase: "stopping" });
		}
		if (mutation === "changed retained bytes") {
			const original = f.guard.prestartStatus.bind(f.guard);
			vi.spyOn(f.guard, "prestartStatus").mockImplementationOnce(async (permitId) => {
				const result = await original(permitId);
				await writeFile(f.paidPath, `${(await readFile(f.paidPath, "utf8")).trim()} \n`);
				return result;
			});
		}
		f.control.call.mockClear();
		f.client.submitInstanceOperation.mockClear();
		await expect(
			readOfficeLifecycleMeteringContext({
				binding: f.binding,
				journalRoot: f.journalRoot,
				guard: f.guard,
				signal: signal(),
			}),
		).rejects.toThrow("OFFICE_ACCEPTANCE_METERING_CONTEXT_UNCONFIRMED");
		expect(f.control.call).not.toHaveBeenCalled();
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
		expect(f.instance.status).toBe("Running");
		expect(f.permit?.state).toBe("bound");
		expect(await f.journal.archiveNames()).toBeNull();
	});
	it("retains cancellation before reading or selecting paid context", async () => {
		const f = await fixture();
		const cancelled = new AbortController();
		const reason = new Error("test cancellation");
		cancelled.abort(reason);
		const latest = vi.spyOn(f.guard, "latest");
		f.control.call.mockClear();
		f.client.submitInstanceOperation.mockClear();
		await expect(
			readOfficeLifecycleMeteringContext({
				binding: f.binding,
				journalRoot: f.journalRoot,
				guard: f.guard,
				signal: cancelled.signal,
			}),
		).rejects.toBe(reason);
		expect(latest).not.toHaveBeenCalled();
		expect(f.control.call).not.toHaveBeenCalled();
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
	});
	it("exports only fixed metering stages and exact allowlisted codes", () => {
		expect(officeLifecycleMeteringFailure("workload-probe", new Error("RUNTIME_COMPUTER_PRESTART_DIFFERS"))).toEqual({
			schema: "qorpera.office-acceptance-metering-failure/v1",
			stage: "workload-probe",
			code: "RUNTIME_COMPUTER_PRESTART_DIFFERS",
		});
		for (const error of [
			new Error("RUNTIME_COMPUTER_PRESTART_DIFFERS secret=private"),
			new Error("/private/path"),
			new Error("password", { cause: new Error("RUNTIME_COMPUTER_PRESTART_DIFFERS") }),
			{ message: "secret" },
		]) {
			expect(officeLifecycleMeteringFailure("paid-context", error)).toEqual({
				schema: "qorpera.office-acceptance-metering-failure/v1",
				stage: "paid-context",
				code: "WITHHELD",
			});
		}
	});
});
