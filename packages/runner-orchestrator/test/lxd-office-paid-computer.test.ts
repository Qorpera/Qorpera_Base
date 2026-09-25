import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaidComputerGuard, PaidComputerGuardJournal, type PaidComputerPermit } from "../src/computer-paid-guard.ts";
import { LxdPaidComputerGuardPhysical } from "../src/computer-paid-guard-lxd.ts";
import type { LxdInstanceRecord, LxdOperationReference, LxdTrackedClient } from "../src/lxd-client.ts";
import { LxdOfficeBootWorker } from "../src/lxd-office-boot-worker.ts";
import { lxdOfficeGuestPlan } from "../src/lxd-office-guest.ts";
import { LxdOfficeLifecycle } from "../src/lxd-office-lifecycle.ts";
import { observeLxdOfficeOperationJournals } from "../src/lxd-office-operation-observer.ts";
import { LxdOfficeOperationJournal } from "../src/lxd-office-operations.ts";
import type { LxdOfficePaidComputerPort } from "../src/lxd-office-paid-computer.ts";
import { LxdOfficePaidComputer } from "../src/lxd-office-paid-computer.ts";
import { lxdOfficePhysicalPolicySha256 } from "../src/lxd-office-physical-policy.ts";
import { RuntimeComputerController } from "../src/runtime-computer-controller.ts";
import { officeBootWorkerFixture } from "./fixtures/office-boot-worker.ts";
import { officePhysicalFixture } from "./fixtures/office-physical-policy.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const signal = () => new AbortController().signal;
async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "office-paid-")));
	roots.push(root);
	const { policy, binding } = officePhysicalFixture();
	policy.journal.path = root;
	policy.journal.mountPoint = root;
	binding.providerPolicySha256 = lxdOfficePhysicalPolicySha256(policy);
	await mkdir(join(root, binding.allocationId), { mode: 0o700 });
	const controller = {
		ensure: vi.fn<RuntimeComputerController["ensure"]>().mockResolvedValue({ mode: "shadow" }),
		recover: vi.fn<RuntimeComputerController["recover"]>().mockResolvedValue("shadow"),
		start: vi.fn<RuntimeComputerController["start"]>(),
		guardRecord: vi.fn<RuntimeComputerController["guardRecord"]>().mockResolvedValue(null),
		manages: vi.fn().mockReturnValue(false),
		settleStopped: vi.fn<RuntimeComputerController["settleStopped"]>(),
		maintain: vi.fn<RuntimeComputerController["maintain"]>(),
		assertRunning: vi.fn<RuntimeComputerController["assertRunning"]>(),
	};
	const control = { call: vi.fn(async () => ({ mode: "shadow" })) };
	const adapter = new LxdOfficePaidComputer(policy, controller, control);
	return { root, policy, binding, controller, control, adapter };
}
describe("paid company computer lifecycle adapter", () => {
	it("holds the real first-boot worker on funding failure, then recovers a guarded start without public node admission", async () => {
		const f = await officeBootWorkerFixture(roots);
		let reference: LxdOperationReference | null = null,
			expectedCommand: string | undefined;
		const prepareStart = vi
			.fn<LxdOfficePaidComputerPort["prepareStart"]>()
			.mockRejectedValueOnce(new Error("pool empty"));
		prepareStart.mockImplementation(async (binding, commandId, intent) => {
			expect(binding).toEqual(f.binding);
			expect(intent).toMatchObject({ kind: "initial", intentId: f.request.intentId, mappings: [] });
			expectedCommand = commandId;
			return true;
		});
		const submitStart = vi.fn(async (commandId: string, checked: AbortSignal) => {
			expect(commandId).toBe(expectedCommand);
			reference = await f.client.submitInstanceOperation(
				f.binding.project,
				{ action: "start", name: f.instance.name },
				checked,
			);
			throw new Error("guard reply lost");
		});
		const paid: LxdOfficePaidComputerPort = {
			prepareStart,
			creationRegistry: (_binding, _intent, registry) => registry,
			operations: () => ({
				submitStart,
				recoverStart: async (commandId) => {
					expect(commandId).toBe(expectedCommand);
					return reference;
				},
			}),
			recover: async () => {},
			settleStopped: async () => {},
			assertActive: async () => {},
			maintain: async () => {},
		};
		const create = () =>
			new LxdOfficeBootWorker(
				{ policy: f.policy, check: f.check },
				{ call: f.call },
				{ client: f.client, kernelLock: f.kernelLock, readProtected: f.readProtected, paidComputer: paid },
			);
		await expect(create().reconcile(f.request, signal())).rejects.toThrow("pool empty");
		expect(f.submit).not.toHaveBeenCalled();
		await expect(create().reconcile(f.request, signal())).resolves.toMatchObject({ state: "unknown" });
		await expect(create().reconcile(f.request, signal())).resolves.toMatchObject({
			state: "awaiting_preparation",
			startCommandId: expectedCommand,
		});
		expect(f.submit).toHaveBeenCalledOnce();
		expect(submitStart).toHaveBeenCalledOnce();
		expect(f.call.mock.calls.some(([method]) => method === "qorpera_reserve_runtime_node_machine")).toBe(false);
	});
	it("integrates real durable guard and office journals across a lost paid start reply", async () => {
		const f = await fixture(),
			plan = lxdOfficeGuestPlan(f.binding),
			commandId = randomUUID(),
			intentId = randomUUID();
		const clock = { hostMachineIdSha256: f.policy.host.machineIdSha256, hostBootId: randomUUID(), uptimeMs: 100000 };
		const config = {
			...plan.request.config,
			"volatile.uuid": randomUUID(),
			"volatile.base_image": f.binding.imageFingerprint,
		};
		const vm: LxdInstanceRecord = {
			name: plan.request.name,
			type: "virtual-machine",
			status: "Stopped",
			statusCode: 102,
			profiles: [],
			config,
			expandedConfig: { ...config },
			devices: plan.request.devices,
			expandedDevices: plan.request.devices,
		};
		const client = {
			getInstance: vi.fn(async () => structuredClone(vm)),
			submitInstanceOperation: vi.fn(
				async (project: string, action: Parameters<LxdTrackedClient["submitInstanceOperation"]>[1]) => {
					if (action.action === "start") {
						vm.status = "Running";
						vm.statusCode = 103;
					}
					return { project, instanceName: vm.name, operationId: randomUUID() };
				},
			),
			inspectInstanceOperation: vi.fn(async () => "succeeded" as const),
			readInstanceFile: vi.fn(),
		};
		const guardRoot = join(f.root, "guard");
		await mkdir(guardRoot, { mode: 0o700 });
		const guard = new PaidComputerGuard(
			new PaidComputerGuardJournal(guardRoot),
			new LxdPaidComputerGuardPhysical(client, async () => clock),
			async () => clock,
		);
		await guard.initialize();
		let permit: PaidComputerPermit | null = null;
		const control = {
			call: vi.fn(async (method: string, args: Record<string, unknown>) => {
				if (method.includes("describe")) return { mode: "paid", permit, lastSample: null };
				if (!method.includes("prepare") || permit) throw new Error("unexpected accounting effect");
				const request = args.p_request as Record<string, unknown>;
				permit = {
					schema: "qorpera.computer-usage-permit/v1",
					mode: "paid",
					permitId: String(request.requestId),
					allocationId: f.binding.allocationId,
					instanceSha256: plan.instanceSha256,
					nodeId: randomUUID(),
					epoch: randomUUID(),
					generation: 1,
					reservationId: commandId,
					hostBootId: clock.hostBootId,
					physicalId: null,
					guestBootId: null,
					issuedAt: "2026-09-25T12:00:00.000Z",
					deadline: "2026-09-25T12:05:30.000Z",
					validForMs: 330000,
					windowMs: 300000,
					stopReserveMs: 30000,
					tariffVersion: 1,
					cpuMillis: f.binding.cpus * 1000,
					memoryBytes: f.binding.memoryBytes,
					state: "prepared",
				};
				return permit;
			}),
		};
		const controller = new RuntimeComputerController({ control, guard, client, clock: async () => clock });
		const adapter = new LxdOfficePaidComputer(f.policy, controller, control);
		const journal = await LxdOfficeOperationJournal.open(
			f.root,
			intentId,
			f.binding,
			client,
			false,
			undefined,
			adapter.operations(f.binding),
		);
		await journal.reconcile(randomUUID(), "create", signal());
		await adapter.prepareStart(f.binding, commandId, { kind: "initial", intentId, mappings: [] }, signal());
		const start = controller.start.bind(controller);
		vi.spyOn(controller, "start").mockImplementationOnce(async (...args) => {
			await start(...args);
			throw new Error("guard reply lost");
		});
		await expect(journal.reconcile(commandId, "start", signal())).resolves.toEqual({ state: "unknown" });
		await guard.sweep();
		client.inspectInstanceOperation.mockRejectedValue(new Error("LXD five-second operation retention elapsed"));
		const resumed = await LxdOfficeOperationJournal.open(
			f.root,
			intentId,
			f.binding,
			client,
			true,
			undefined,
			adapter.operations(f.binding),
		);
		await expect(resumed.observe(commandId, "start", signal())).resolves.toMatchObject({ state: "succeeded" });
		await observeLxdOfficeOperationJournals(f.root, client, signal());
		expect(client.submitInstanceOperation.mock.calls.map((call) => call[1].action)).toEqual(["create", "start"]);
		expect(control.call.mock.calls.filter((call) => call[0].includes("prepare"))).toHaveLength(1);
		expect((await journal.history()).events).toHaveLength(6);
	});
	it("retains exact authority before funding and refuses rebinding even when the first response was lost", async () => {
		const f = await fixture(),
			commandId = randomUUID(),
			intent = { kind: "resume", request: { bootIntentId: randomUUID() } };
		f.controller.ensure.mockImplementationOnce(async () => {
			expect(
				JSON.parse(await readFile(join(f.root, `paid-start-${f.binding.allocationId}-${commandId}.json`), "utf8")),
			).toMatchObject({ commandId, context: { officeIntent: intent } });
			throw new Error("funding response lost");
		});
		await expect(f.adapter.prepareStart(f.binding, commandId, intent, signal())).rejects.toThrow("response lost");
		await expect(
			f.adapter.prepareStart(f.binding, commandId, { ...intent, request: { bootIntentId: randomUUID() } }, signal()),
		).rejects.toThrow("IDENTITY_CHANGED");
		expect(f.controller.ensure).toHaveBeenCalledOnce();
		expect(f.controller.start).not.toHaveBeenCalled();
	});
	it("does not mint or start during exact journal recovery and never borrows another command's latest reference", async () => {
		const f = await fixture(),
			commandId = randomUUID();
		await f.adapter.prepareStart(f.binding, commandId, { kind: "initial" }, signal());
		f.controller.ensure.mockClear();
		await expect(f.adapter.operations(f.binding).recoverStart(commandId, signal())).resolves.toBeNull();
		expect(f.controller.recover).toHaveBeenCalledOnce();
		expect(f.controller.ensure).not.toHaveBeenCalled();
		expect(f.controller.start).not.toHaveBeenCalled();
		await expect(f.adapter.operations(f.binding).recoverStart(randomUUID(), signal())).rejects.toThrow();
	});
	it("requires confirmed shadow mode before using the existing unmetered admission", async () => {
		const f = await fixture(),
			fallback = { call: vi.fn(async () => ({ state: "reserved" })) };
		const registry = f.adapter.creationRegistry(f.binding, randomUUID(), fallback);
		await expect(registry.call("qorpera_reserve_runtime_node_machine", {}, signal())).resolves.toEqual({
			state: "reserved",
		});
		expect(fallback.call).toHaveBeenCalledOnce();
		f.control.call.mockRejectedValue(new Error("mode unavailable"));
		await expect(registry.call("qorpera_reserve_runtime_node_machine", {}, signal())).rejects.toThrow(
			"mode unavailable",
		);
		expect(fallback.call).toHaveBeenCalledOnce();
	});
	it("holds an apparently active office after paid custody expires without inventing a resume", async () => {
		const f = await fixture(),
			g = f.policy.guest,
			intentId = randomUUID();
		f.controller.recover.mockResolvedValue("paid");
		f.controller.assertRunning.mockRejectedValue(new Error("RUNTIME_COMPUTER_PERMIT_REQUIRED"));
		const registry = {
			call: vi.fn(async () => ({
				schema: "qorpera.office-provider-status/v1",
				scope: {
					companyId: g.companyId,
					environmentId: g.environmentId,
					companyComputerId: g.companyComputerId,
					logicalComputerId: g.logicalComputerId,
				},
				computerGeneration: g.computerGeneration,
				providerId: g.providerId,
				providerPolicySha256: f.binding.providerPolicySha256,
				providerVersion: 1,
				preparationEnabled: true,
				officeState: "active",
				imageSha256: g.imageFingerprint,
				bootstrapSha256: g.bootstrapSha256,
				intent: {
					schema: "qorpera.office-start-intent/v1",
					intentId,
					companyComputerId: g.companyComputerId,
					computerGeneration: 1,
					state: "reserved",
				},
				reservation: {
					allocationId: f.binding.allocationId,
					instanceSha256: "a".repeat(64),
					providerBindingSha256: "b".repeat(64),
				},
			})),
		};
		const lifecycle = new LxdOfficeLifecycle(
			{ policy: f.policy, inspect: vi.fn(), check: vi.fn() },
			registry,
			{
				paidComputer: f.adapter,
				planPath: "/protected/lifecycle.json",
				inventoryLimits: {
					maxEntries: 100,
					maxDepth: 4,
					maxFileBytes: 1024,
					maxTotalBytes: 4096,
					maxManifestBytes: 65536,
				},
			},
			{ kernelLock: vi.fn(async () => {}) },
		);
		await expect(lifecycle.reconcile(signal())).resolves.toEqual({
			state: "held",
			intentId,
			reason: "OFFICE_PAID_RECOVERY_REQUIRED",
		});
		expect(f.controller.start).not.toHaveBeenCalled();
		expect(f.controller.ensure).not.toHaveBeenCalled();
	});
});
