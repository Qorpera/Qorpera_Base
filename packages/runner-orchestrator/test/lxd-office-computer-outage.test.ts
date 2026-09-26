import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaidComputerGuard, PaidComputerGuardJournal, type PaidComputerPermit } from "../src/computer-paid-guard.ts";
import { LxdPaidComputerGuardPhysical } from "../src/computer-paid-guard-lxd.ts";
import type { LxdInstanceRecord, LxdTrackedClient } from "../src/lxd-client.ts";
import { OFFICE_COMPUTER_OUTAGE_RPC } from "../src/lxd-office-computer-outage.ts";
import { lxdOfficeGuestPlan } from "../src/lxd-office-guest.ts";
import { LxdOfficePaidComputer } from "../src/lxd-office-paid-computer.ts";
import { lxdOfficePhysicalPolicySha256 } from "../src/lxd-office-physical-policy.ts";
import { RuntimeComputerController } from "../src/runtime-computer-controller.ts";
import { officePhysicalFixture } from "./fixtures/office-physical-policy.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const signal = () => AbortSignal.timeout(10000);
async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "office-outage-")));
	roots.push(root);
	const { policy, binding } = officePhysicalFixture();
	policy.journal.path = root;
	policy.journal.mountPoint = root;
	binding.providerPolicySha256 = lxdOfficePhysicalPolicySha256(policy);
	const plan = lxdOfficeGuestPlan(binding),
		permitId = randomUUID(),
		guestBootId = randomUUID(),
		clock = { hostMachineIdSha256: policy.host.machineIdSha256, hostBootId: randomUUID(), uptimeMs: 100000 };
	const config = { ...plan.request.config, "volatile.uuid": randomUUID() };
	const vm: LxdInstanceRecord = {
		name: plan.request.name,
		type: "virtual-machine",
		profiles: [],
		status: "Stopped",
		statusCode: 102,
		config,
		expandedConfig: { ...config },
		devices: plan.request.devices,
		expandedDevices: plan.request.devices,
	};
	const client = {
		getInstance: vi.fn(async () => structuredClone(vm)),
		submitInstanceOperation: vi.fn(
			async (project: string, request: Parameters<LxdTrackedClient["submitInstanceOperation"]>[1]) => {
				if (request.action !== "start" && request.action !== "stop") throw new Error("unexpected physical effect");
				vm.status = request.action === "start" ? "Running" : "Stopped";
				vm.statusCode = request.action === "start" ? 103 : 102;
				return { project, instanceName: vm.name, operationId: randomUUID() };
			},
		),
		inspectInstanceOperation: vi.fn(async () => "succeeded" as const),
		readInstanceClock: vi.fn(async () => ({ bootId: guestBootId, uptimeMs: 1000 })),
		readInstanceFile: vi.fn(async (_project: string, _name: string, path: string) => ({
			content: Buffer.from(path === "/proc/uptime" ? "1.00 0.00\n" : `${guestBootId}\n`),
			uid: 0,
			gid: 0,
			mode: 0o444,
		})),
	};
	const guardRoot = join(root, "guard");
	await mkdir(guardRoot, { mode: 0o700 });
	const openGuard = () =>
		new PaidComputerGuard(
			new PaidComputerGuardJournal(guardRoot),
			new LxdPaidComputerGuardPhysical(client, async () => ({ ...clock })),
			async () => ({ ...clock }),
		);
	let guard = openGuard();
	await guard.initialize();
	let permit: PaidComputerPermit | null = null,
		lastSample: Record<string, unknown> | null = null,
		outage: Record<string, unknown> | undefined,
		loseOutageReply = false,
		orderly = false;
	const activation = {
		activationId: randomUUID(),
		providerId: binding.providerId,
		providerPolicySha256: binding.providerPolicySha256,
		startup: {
			scope: {
				companyId: binding.companyId,
				environmentId: binding.environmentId,
				companyComputerId: binding.companyComputerId,
				logicalComputerId: binding.logicalComputerId,
			},
			computerGeneration: binding.computerGeneration,
			allocationId: binding.allocationId,
			instanceSha256: plan.instanceSha256,
			imageSha256: binding.imageFingerprint,
			bootstrapSha256: binding.bootstrapSha256,
			bootId: guestBootId,
			configurationSha256: "a".repeat(64),
			serviceInvocationId: "b".repeat(32),
		},
	};
	const registry = {
		call: vi.fn(async () => ({
			schema: "qorpera.office-provider-activation/v1",
			officeState: outage || orderly ? "maintenance" : "active",
			activation: structuredClone(activation),
		})),
	};
	const control = {
		call: vi.fn(async (method: string, args: Record<string, unknown>): Promise<unknown> => {
			const request = args.p_request as Record<string, unknown>;
			if (method === OFFICE_COMPUTER_OUTAGE_RPC) {
				expect(JSON.parse(await readFile(requestPath, "utf8"))).toEqual(request);
				if (!outage) {
					expect(request.activation).toEqual(activation);
					expect(permit?.guestBootId).toBe(activation.startup.bootId);
					outage = {
						schema: "qorpera.office-computer-outage/v1",
						request: structuredClone(request),
						state: orderly ? "orderly" : "held",
						officeRevision: 3,
						registeredAtMs: Date.now(),
					};
				}
				expect(request).toEqual(outage.request);
				if (loseOutageReply) {
					loseOutageReply = false;
					throw new Error("lost committed outage reply");
				}
				return structuredClone(outage);
			}
			if (method === "qorpera_describe_runtime_computer_prestart")
				return { state: permit?.state ?? "absent", permit, lastSample };
			if (method === "qorpera_describe_runtime_computer_permit")
				return { mode: "paid", permit: permit?.state === "closed" ? null : permit, lastSample };
			if (method === "qorpera_prepare_runtime_computer_permit") {
				if (permit) throw new Error("duplicate reservation");
				permit = {
					schema: "qorpera.computer-usage-permit/v2",
					prestart: request.prestart as PaidComputerPermit["prestart"],
					mode: "paid",
					permitId,
					allocationId: binding.allocationId,
					instanceSha256: plan.instanceSha256,
					nodeId: randomUUID(),
					epoch: randomUUID(),
					generation: 1,
					reservationId: randomUUID(),
					hostBootId: clock.hostBootId,
					guestBootId: null,
					physicalId: null,
					issuedAt: "2026-09-25T12:00:00.000Z",
					deadline: "2026-09-25T12:05:30.000Z",
					state: "prepared",
					validForMs: 330000,
					windowMs: 300000,
					stopReserveMs: 30000,
					tariffVersion: 1,
					cpuMillis: binding.cpus * 1000,
					memoryBytes: binding.memoryBytes,
				};
				return permit;
			}
			if (!permit || request.generation !== permit.generation) throw new Error("SQL generation differs");
			const sample = request.sample as Record<string, unknown>;
			if (sample.previousObservationId !== (lastSample?.observationId ?? null))
				throw new Error("SQL predecessor differs");
			lastSample = structuredClone(sample);
			if (method === "qorpera_bind_runtime_computer_permit")
				permit = { ...permit, state: "bound", guestBootId, physicalId: config["volatile.uuid"] };
			else if (method === "qorpera_finish_runtime_computer_permit") permit = { ...permit, state: "closed" };
			else throw new Error("unexpected accounting effect");
			return permit;
		}),
	};
	const createController = () =>
		new RuntimeComputerController({ control, guard, client, clock: async () => ({ ...clock }) });
	let controller = createController(),
		adapter = new LxdOfficePaidComputer(policy, controller, control);
	const requestPath = join(root, `paid-outage-request-${binding.allocationId}-${permitId}.json`),
		receiptPath = join(root, `paid-outage-receipt-${binding.allocationId}-${permitId}.json`);
	await adapter.prepareStart(binding, permitId, { kind: "initial", intentId: randomUUID(), mappings: [] }, signal());
	await adapter.operations(binding).submitStart(permitId, signal());
	await guard.sweep();
	await controller.maintain(signal());
	return {
		root,
		policy,
		binding,
		client,
		control,
		registry,
		activation,
		permitId,
		requestPath,
		receiptPath,
		guard: () => guard,
		controller: () => controller,
		adapter: () => adapter,
		setOrderly: () => {
			orderly = true;
		},
		loseReply: () => {
			loseOutageReply = true;
		},
		stop: async () => {
			clock.uptimeMs += 300001;
			await guard.sweep();
		},
		restart: async () => {
			guard = openGuard();
			await guard.initialize();
			controller = createController();
			adapter = new LxdOfficePaidComputer(policy, controller, control);
		},
	};
}

describe("office paid guard outage registration", () => {
	it("reports first-window expiry with the original prepared guard, then recovers an archived proof after lost reply", async () => {
		const f = await fixture();
		expect((await f.guard().status(f.permitId)).permit).toMatchObject({ state: "prepared", guestBootId: null });
		await f.stop();
		const proof = await f.guard().status(f.permitId);
		f.loseReply();
		await expect(f.adapter().reconcileStopped(f.binding, f.registry, signal())).rejects.toThrow("lost committed");
		const request = await readFile(f.requestPath, "utf8");
		await f.controller().maintain(signal());
		expect(await f.guard().list()).toEqual([]);
		await f.restart();
		f.registry.call.mockRejectedValue(new Error("current activation unavailable"));
		await expect(f.adapter().reconcileStopped(f.binding, f.registry, signal())).resolves.toBe(true);
		expect(await readFile(f.requestPath, "utf8")).toBe(request);
		expect((await f.guard().status(f.permitId)).stopReceipt).toEqual(proof.stopReceipt);
		await expect(f.adapter().reconcileStopped(f.binding, f.registry, signal())).resolves.toBe(true);
		expect(f.registry.call).toHaveBeenCalledTimes(1);
		expect(f.control.call.mock.calls.filter(([method]) => method === OFFICE_COMPUTER_OUTAGE_RPC)).toHaveLength(2);
		expect(f.client.submitInstanceOperation.mock.calls.map(([, request]) => request.action)).toEqual([
			"start",
			"stop",
		]);
		expect(f.control.call.mock.calls.filter(([method]) => method.includes("finish"))).toHaveLength(1);
	});
	it("does not claim an outage for a running or unknown guard", async () => {
		const f = await fixture();
		await expect(f.adapter().reconcileStopped(f.binding, f.registry, signal())).resolves.toBe(false);
		expect(f.registry.call).not.toHaveBeenCalled();
		vi.spyOn(f.controller(), "guardRecord").mockResolvedValue(null);
		await expect(f.adapter().reconcileStopped(f.binding, f.registry, signal())).resolves.toBe(false);
		expect(f.control.call.mock.calls.some(([method]) => method === OFFICE_COMPUTER_OUTAGE_RPC)).toBe(false);
	});
	it("continues orderly recovery only after an explicit durable SQL acknowledgement outcome", async () => {
		const f = await fixture();
		await f.stop();
		f.setOrderly();
		await expect(f.adapter().reconcileStopped(f.binding, f.registry, signal())).resolves.toBe(false);
		expect(JSON.parse(await readFile(f.receiptPath, "utf8"))).toMatchObject({ state: "orderly" });
		await f.restart();
		await expect(f.adapter().reconcileStopped(f.binding, f.registry, signal())).resolves.toBe(false);
		expect(f.control.call.mock.calls.filter(([method]) => method === OFFICE_COMPUTER_OUTAGE_RPC)).toHaveLength(1);
	});
	it("rejects wrong activation scope before retaining or registering an outage", async () => {
		const f = await fixture();
		await f.stop();
		f.activation.startup.scope.companyId = randomUUID();
		await expect(f.adapter().reconcileStopped(f.binding, f.registry, signal())).rejects.toThrow("REQUEST_DIFFERS");
		expect(f.control.call.mock.calls.some(([method]) => method === OFFICE_COMPUTER_OUTAGE_RPC)).toBe(false);
		await expect(readFile(f.requestPath)).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("never treats unreadable retained evidence or a changed SQL receipt as absence", async () => {
		const f = await fixture();
		await f.stop();
		await writeFile(f.requestPath, "corrupt", { mode: 0o600 });
		await expect(f.adapter().reconcileStopped(f.binding, f.registry, signal())).rejects.toThrow();
		expect(f.registry.call).not.toHaveBeenCalled();
		expect(f.control.call.mock.calls.some(([method]) => method === OFFICE_COMPUTER_OUTAGE_RPC)).toBe(false);
	});
	it("fails closed if a receipt survives its lost request prefix", async () => {
		const f = await fixture();
		await f.stop();
		await f.adapter().reconcileStopped(f.binding, f.registry, signal());
		await rm(f.requestPath);
		await f.restart();
		await expect(f.adapter().reconcileStopped(f.binding, f.registry, signal())).rejects.toThrow("REQUEST_LOST");
		expect(f.control.call.mock.calls.filter(([method]) => method === OFFICE_COMPUTER_OUTAGE_RPC)).toHaveLength(1);
	});
	it("rejects a changed receipt without caching it or replacing the original request", async () => {
		const f = await fixture();
		await f.stop();
		f.control.call.mockResolvedValueOnce({
			schema: "qorpera.office-computer-outage/v1",
			request: {},
			state: "held",
			officeRevision: 3,
			registeredAtMs: Date.now(),
		});
		await expect(f.adapter().reconcileStopped(f.binding, f.registry, signal())).rejects.toThrow(
			"RECEIPT_UNCONFIRMED",
		);
		const request = await readFile(f.requestPath, "utf8");
		await expect(readFile(f.receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(f.adapter().reconcileStopped(f.binding, f.registry, signal())).resolves.toBe(true);
		expect(await readFile(f.requestPath, "utf8")).toBe(request);
	});
	it.each(["failed", "physical", "boot"])(
		"does not register a %s guard proof as current office execution",
		async (kind) => {
			const f = await fixture();
			await f.stop();
			const proof = await f.guard().status(f.permitId);
			if (kind === "failed") proof.startSucceeded = false;
			if (kind === "physical") proof.stopReceipt!.physicalInstanceId = randomUUID();
			if (kind === "boot") proof.permit.guestBootId = randomUUID();
			vi.spyOn(f.controller(), "guardRecord").mockResolvedValue(proof);
			if (kind === "failed")
				await expect(f.adapter().reconcileStopped(f.binding, f.registry, signal())).resolves.toBe(false);
			else await expect(f.adapter().reconcileStopped(f.binding, f.registry, signal())).rejects.toThrow();
			expect(f.control.call.mock.calls.some(([method]) => method === OFFICE_COMPUTER_OUTAGE_RPC)).toBe(false);
		},
	);
	it("keeps the same pinned request after SQL rejects a superseded first-window boot", async () => {
		const f = await fixture();
		await f.stop();
		f.activation.startup.bootId = randomUUID();
		f.control.call.mockRejectedValueOnce(new Error("SQL current activation differs"));
		await expect(f.adapter().reconcileStopped(f.binding, f.registry, signal())).rejects.toThrow("activation differs");
		const request = await readFile(f.requestPath, "utf8");
		await f.restart();
		f.registry.call.mockRejectedValue(new Error("must not discover a different activation"));
		f.control.call.mockRejectedValueOnce(new Error("SQL current activation differs"));
		await expect(f.adapter().reconcileStopped(f.binding, f.registry, signal())).rejects.toThrow("activation differs");
		expect(await readFile(f.requestPath, "utf8")).toBe(request);
		await expect(readFile(f.receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("does not apply an older held receipt to a newer running paid start", async () => {
		const f = await fixture();
		await f.stop();
		await expect(f.adapter().reconcileStopped(f.binding, f.registry, signal())).resolves.toBe(true);
		const successor = await f.guard().status(f.permitId);
		successor.permit.permitId = randomUUID();
		successor.phase = "running";
		successor.stopReceipt = null;
		successor.stopReference = null;
		vi.spyOn(f.controller(), "guardRecord").mockResolvedValue(successor);
		await expect(f.adapter().reconcileStopped(f.binding, f.registry, signal())).resolves.toBe(false);
		expect(f.control.call.mock.calls.filter(([method]) => method === OFFICE_COMPUTER_OUTAGE_RPC)).toHaveLength(1);
	});
});
