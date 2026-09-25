import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	PaidComputerGuard,
	PaidComputerGuardJournal,
	type PaidComputerHostClock,
	type PaidComputerPermit,
} from "../src/computer-paid-guard.ts";
import { LxdPaidComputerGuardPhysical } from "../src/computer-paid-guard-lxd.ts";
import type { LxdInstanceRecord, LxdOperationReference, LxdTrackedClient } from "../src/lxd-client.ts";
import { type RuntimeComputerContext, RuntimeComputerController } from "../src/runtime-computer-controller.ts";
import type { RuntimePaidComputerMachine } from "../src/runtime-paid-machine.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "runtime-permit-")));
	roots.push(root);
	await chmod(root, 0o700);
	const clock: PaidComputerHostClock = {
		hostMachineIdSha256: "a".repeat(64),
		hostBootId: randomUUID(),
		uptimeMs: 100000,
	};
	const context: RuntimeComputerContext = {
		allocationId: randomUUID(),
		providerKind: "native",
		providerId: "native",
		policySha256: "b".repeat(64),
		instanceSha256: "c".repeat(64),
		bootstrapSha256: "d".repeat(64),
		runId: randomUUID(),
		runnerId: randomUUID(),
		officeId: null,
		computerGeneration: null,
	};
	const target: RuntimePaidComputerMachine["physicalTarget"] = {
		kind: "lxd",
		project: "native",
		instanceName: `qorpera-${context.allocationId.replaceAll("-", "")}`,
		profiles: ["native-v1"],
		config: { "limits.cpu": "4", "limits.memory": "8GiB", "user.qorpera.instance_sha256": context.instanceSha256 },
		devices: { root: { type: "disk", path: "/", pool: "native", size: "64GiB" } },
	};
	let instance: LxdInstanceRecord | undefined = {
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
	let guestUptime = 1;
	const operation = (): LxdOperationReference => ({
		project: target.project,
		instanceName: target.instanceName,
		operationId: randomUUID(),
	});
	const client = {
		getInstance: vi.fn(async () => (instance ? structuredClone(instance) : undefined)),
		submitInstanceOperation: vi.fn(
			async (_project: string, request: Parameters<LxdTrackedClient["submitInstanceOperation"]>[1]) => {
				if (!instance || (request.action !== "start" && request.action !== "stop"))
					throw new Error("unexpected physical effect");
				instance.status = request.action === "start" ? "Running" : "Stopped";
				instance.statusCode = request.action === "start" ? 103 : 102;
				return operation();
			},
		),
		inspectInstanceOperation: vi.fn(async () => "succeeded" as const),
		readInstanceFile: vi.fn(async (_project: string, _name: string, path: string) => ({
			content: Buffer.from(path === "/proc/uptime" ? `${guestUptime}.00 0.00\n` : `${guestBootId}\n`),
			uid: 0,
			gid: 0,
			mode: 0o444,
		})),
	};
	const journal = new PaidComputerGuardJournal(root),
		hostClock = async () => ({ ...clock });
	let guard = new PaidComputerGuard(journal, new LxdPaidComputerGuardPhysical(client, hostClock), hostClock);
	await guard.initialize();
	let permit: PaidComputerPermit | null = null,
		lastSample: Record<string, unknown> | null = null,
		mode: "paid" | "shadow" = "paid";
	let losePrepare = false,
		loseRenew = false,
		loseFinish = false,
		sourceUnavailable = false;
	const samples: Record<string, unknown>[] = [];
	const control = {
		call: vi.fn(async (method: string, args: Record<string, unknown>): Promise<unknown> => {
			const request = args.p_request as Record<string, unknown>;
			if (method === "qorpera_describe_runtime_computer_prestart")
				return { state: permit?.state ?? "absent", permit, lastSample };
			if (method.includes("describe")) {
				if (sourceUnavailable) throw new Error("native run no longer exists");
				return { mode, permit: permit?.state === "closed" ? null : permit, lastSample };
			}
			if (method.includes("prepare")) {
				if (permit) throw new Error("duplicate reservation");
				permit = {
					schema: "qorpera.computer-usage-permit/v2",
					prestart: request.prestart as PaidComputerPermit["prestart"],
					mode: "paid",
					permitId: String(request.requestId),
					allocationId: context.allocationId,
					instanceSha256: context.instanceSha256,
					nodeId: randomUUID(),
					epoch: randomUUID(),
					generation: 1,
					reservationId: randomUUID(),
					hostBootId: clock.hostBootId,
					guestBootId: null,
					physicalId: null,
					issuedAt: "2026-09-25T12:00:00.000Z",
					deadline: "2026-09-25T12:05:30.000Z",
					validForMs: 330000,
					windowMs: 300000,
					stopReserveMs: 30000,
					tariffVersion: 1,
					cpuMillis: 4000,
					memoryBytes: 8 * 1024 ** 3,
					state: "prepared",
				};
				if (losePrepare) {
					losePrepare = false;
					throw new Error("prepare reply lost");
				}
				return permit;
			}
			if (method.includes("abandon")) {
				const reservationReleased = permit !== null;
				if (permit) permit = { ...permit, state: "closed" };
				return {
					schema: "qorpera.computer-abandonment-receipt/v1",
					permitId: request.permitId,
					state: "abandoned_before_dispatch",
					abandonment: request.abandonment,
					reservationReleased,
					debitedUs: "0",
					releasedUs: reservationReleased ? "330000000" : "0",
				};
			}
			if (!permit) throw new Error("permit missing");
			const sample = request.sample as Record<string, unknown>;
			samples.push(structuredClone(sample));
			lastSample = structuredClone(sample);
			if (method.includes("bind"))
				permit = {
					...permit,
					state: "bound",
					physicalId: String(sample.physicalId),
					guestBootId: String(sample.guestBootId),
				};
			if (method.includes("renew")) {
				permit = {
					...permit,
					generation: permit.generation + 1,
					reservationId: randomUUID(),
					issuedAt: "2026-09-25T12:04:10.000Z",
					deadline: "2026-09-25T12:09:40.000Z",
					validForMs: 330000,
				};
				if (loseRenew) {
					loseRenew = false;
					throw new Error("renew reply lost");
				}
			}
			if (method.includes("finish")) {
				permit = { ...permit, state: "closed" };
				if (loseFinish) {
					loseFinish = false;
					throw new Error("finish reply lost");
				}
			}
			return permit;
		}),
	};
	const options = () => ({
		control,
		guard,
		client,
		clock: hostClock,
		now: () => Date.parse("2026-09-25T12:00:00Z") + clock.uptimeMs,
	});
	let controller = new RuntimeComputerController(options());
	return {
		context,
		target,
		clock,
		client,
		control,
		samples,
		get controller() {
			return controller;
		},
		get guard() {
			return guard;
		},
		get permit() {
			return permit;
		},
		get instance() {
			return instance;
		},
		setMode(value: typeof mode) {
			mode = value;
		},
		setGuestUptime(value: number) {
			guestUptime = value;
		},
		losePrepare() {
			losePrepare = true;
		},
		loseRenew() {
			loseRenew = true;
		},
		loseFinish() {
			loseFinish = true;
		},
		moveSource() {
			sourceUnavailable = true;
		},
		async restart() {
			guard = new PaidComputerGuard(journal, new LxdPaidComputerGuardPhysical(client, hostClock), hostClock);
			await guard.initialize();
			controller = new RuntimeComputerController(options());
		},
		removeInstance() {
			instance = undefined;
		},
		async start() {
			await controller.ensure(context, context.allocationId, new AbortController().signal);
			await controller.start(context.allocationId, target, new AbortController().signal);
			await guard.sweep();
			await controller.observe(context.allocationId, new AbortController().signal);
		},
	};
}
const signal = () => new AbortController().signal;
describe("funded runtime physical custody", () => {
	it.each([false, true])(
		"checks the exact durable abandonment closure after a lost reply (altered: %s)",
		async (altered) => {
			const f = await fixture();
			await f.controller.ensure(f.context, f.context.allocationId, signal());
			const original = f.control.call.getMockImplementation()!;
			let closure: Record<string, unknown> | null = null;
			f.control.call.mockImplementation(async (method, args) => {
				if (method === "qorpera_abandon_runtime_computer_permit") {
					closure = (await original(method, args)) as Record<string, unknown>;
					throw new Error("abandonment reply lost");
				}
				if (method === "qorpera_describe_runtime_computer_prestart")
					return {
						state: "abandoned",
						permit: f.permit,
						closure: altered ? { ...closure, permitId: randomUUID() } : closure,
					};
				return original(method, args);
			});
			await expect(f.controller.abandonUndispatched(f.context, f.context.allocationId, signal())).rejects.toThrow(
				"reply lost",
			);
			f.moveSource();
			if (altered) {
				await expect(f.controller.maintain(signal())).rejects.toThrow("RECOVERY_UNCONFIRMED");
				expect(f.controller.manages(f.context.allocationId)).toBe(true);
			} else {
				await f.controller.maintain(signal());
				expect(f.controller.manages(f.context.allocationId)).toBe(false);
			}
			expect((await f.guard.listPrestarts())[0].state).toBe("abandoned");
			expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
		},
	);
	it("clears a lost finish reply from exact history after source removal without queued live-source reads", async () => {
		const f = await fixture();
		await f.start();
		await f.controller.stop(f.context.allocationId, signal());
		f.loseFinish();
		await expect(f.controller.observe(f.context.allocationId, signal())).rejects.toThrow("finish reply lost");
		expect(f.controller.manages(f.context.allocationId)).toBe(true);
		const stopped = await f.guard.latest(f.context.allocationId);
		f.moveSource();
		f.control.call.mockClear();
		await Promise.all([
			f.controller.maintain(signal()),
			f.controller.maintain(signal()),
			f.controller.stop(f.context.allocationId, signal()),
		]);
		expect(f.controller.manages(f.context.allocationId)).toBe(false);
		expect(
			f.control.call.mock.calls.filter(([method]) => method === "qorpera_describe_runtime_computer_permit"),
		).toHaveLength(0);
		expect(f.control.call.mock.calls.filter(([method]) => method.includes("finish"))).toHaveLength(0);
		expect(await f.guard.latest(f.context.allocationId)).toEqual(stopped);
		await f.restart();
		await f.controller.maintain(signal());
		expect(f.controller.manages(f.context.allocationId)).toBe(false);
	});
	it.each(["permitId", "hostBootId", "prestart"])(
		"retains managed custody when terminal history has different %s",
		async (field) => {
			const f = await fixture();
			await f.start();
			const original = f.control.call.getMockImplementation()!;
			f.control.call.mockImplementation(async (method, args) => {
				if (method !== "qorpera_describe_runtime_computer_prestart") return original(method, args);
				return {
					state: "closed",
					permit: {
						...f.permit,
						state: "closed",
						[field]:
							field === "prestart"
								? { guardIncarnationId: randomUUID(), prepareSha256: "a".repeat(64) }
								: randomUUID(),
					},
				};
			});
			await expect(f.controller.maintain(signal())).rejects.toThrow("RECOVERY_UNCONFIRMED");
			expect(f.controller.manages(f.context.allocationId)).toBe(true);
			expect((await f.guard.latest(f.context.allocationId))?.phase).toBe("running");
		},
	);
	it("recovers an expired prepare-only hold after restart without looking for a VM or renewing its clock", async () => {
		const f = await fixture();
		f.losePrepare();
		await expect(f.controller.ensure(f.context, f.context.allocationId, signal())).rejects.toThrow("reply lost");
		f.removeInstance();
		f.clock.uptimeMs += 300001;
		await f.restart();
		await f.controller.maintain(signal());
		expect(f.permit?.state).toBe("closed");
		expect((await f.guard.prestartStatus(f.context.allocationId))?.state).toBe("abandoned");
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
		await expect(f.controller.ensure(f.context, f.context.allocationId, signal())).rejects.toThrow("START_ABANDONED");
		expect(f.control.call.mock.calls.filter(([method]) => method.includes("prepare"))).toHaveLength(1);
	});
	it("persists cancellation before SQL and recovers a lost closure reply after another restart", async () => {
		const f = await fixture();
		await f.controller.ensure(f.context, f.context.allocationId, signal());
		const original = f.control.call.getMockImplementation()!;
		f.control.call.mockImplementationOnce(async (method, args) => {
			await original(method, args);
			throw new Error("closure reply lost");
		});
		await expect(f.controller.abandonUndispatched(f.context, f.context.allocationId, signal())).rejects.toThrow(
			"closure reply lost",
		);
		expect((await f.guard.prestartStatus(f.context.allocationId))?.state).toBe("abandoned");
		await f.restart();
		await f.controller.maintain(signal());
		expect(f.permit?.state).toBe("closed");
		await expect(f.controller.ensure(f.context, f.context.allocationId, signal())).rejects.toThrow("START_ABANDONED");
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
	});
	it("never refunds an uncertain dispatched start even after reboot and physical disappearance", async () => {
		const f = await fixture();
		await f.controller.ensure(f.context, f.context.allocationId, signal());
		f.client.submitInstanceOperation.mockRejectedValueOnce(new Error("lost start"));
		await expect(f.controller.start(f.context.allocationId, f.target, signal())).rejects.toThrow("lost start");
		f.removeInstance();
		await expect(f.controller.abandonUndispatched(f.context, f.context.allocationId, signal())).rejects.toThrow();
		expect(f.control.call.mock.calls.filter(([method]) => method.includes("abandon"))).toHaveLength(0);
		expect(f.permit?.state).toBe("prepared");
	});
	it("keeps cancellation final even if company mode later reports shadow", async () => {
		const f = await fixture();
		await f.controller.ensure(f.context, f.context.allocationId, signal());
		await f.controller.abandonUndispatched(f.context, f.context.allocationId, signal());
		f.setMode("shadow");
		await f.restart();
		await expect(f.controller.ensure(f.context, f.context.allocationId, signal())).rejects.toThrow("START_ABANDONED");
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
	});
	it("keeps known in-process sample continuity across active-state reads and refuses settlement of a running VM", async () => {
		const f = await fixture();
		await f.start();
		const calls = f.client.submitInstanceOperation.mock.calls.length;
		await expect(f.controller.settleStopped(f.context.allocationId, signal())).rejects.toThrow("STOPPED_REQUIRED");
		expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(calls);
		expect(await f.controller.recover(f.context, signal())).toBe("paid");
		f.clock.uptimeMs += 5000;
		f.setGuestUptime(6);
		await f.controller.observe(f.context.allocationId, signal());
		expect(f.samples.at(-1)?.state).toBe("running");
		f.instance!.status = "Stopped";
		f.instance!.statusCode = 102;
		await f.controller.settleStopped(f.context.allocationId, signal());
		expect(f.permit?.state).toBe("closed");
		expect(await f.controller.recover(f.context, signal())).toBe("paid");
		await expect(f.controller.assertRunning(f.context.allocationId, signal())).rejects.toThrow("PERMIT_REQUIRED");
	});
	it("reserves before physical start, binds protected boot observation, and settles only confirmed physical stop", async () => {
		const f = await fixture();
		await f.controller.ensure(f.context, f.context.allocationId, signal());
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
		await f.controller.start(f.context.allocationId, f.target, signal());
		await f.guard.sweep();
		await expect(f.controller.assertRunning(f.context.allocationId, signal())).rejects.toThrow("RUNNING_PERMIT");
		await f.controller.observe(f.context.allocationId, signal());
		await f.controller.assertRunning(f.context.allocationId, signal());
		expect(f.samples[0]).toMatchObject({ state: "running", previousObservationId: null, guestUptimeMs: 1000 });
		const stopped = await f.controller.stop(f.context.allocationId, signal());
		expect(stopped.phase).toBe("stopped");
		await f.controller.observe(f.context.allocationId, signal());
		expect(f.permit?.state).toBe("closed");
		expect(f.controller.manages(f.context.allocationId)).toBe(false);
		expect(f.client.submitInstanceOperation.mock.calls.map((call) => call[1].action)).toEqual(["start", "stop"]);
	});
	it("recovers a lost prepare reply without another reservation or a physical start", async () => {
		const f = await fixture();
		f.losePrepare();
		await expect(f.controller.ensure(f.context, f.context.allocationId, signal())).rejects.toThrow(
			"prepare reply lost",
		);
		await f.restart();
		await f.controller.ensure(f.context, f.context.allocationId, signal());
		expect(f.control.call.mock.calls.filter((call) => call[0].includes("prepare"))).toHaveLength(1);
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
	});
	it("restarts with a gap and preserves expiry when the database disappears", async () => {
		const f = await fixture();
		await f.start();
		f.clock.uptimeMs += 10000;
		await f.restart();
		await f.controller.recover(f.context, signal());
		await f.controller.maintain(signal());
		expect(f.samples.at(-1)?.state).toBe("gap");
		f.control.call.mockRejectedValue(new Error("database down"));
		f.clock.uptimeMs = 400000;
		await f.guard.sweep();
		expect((await f.guard.latest(f.context.allocationId))?.phase).toBe("stopped");
		expect(f.instance?.status).toBe("Stopped");
	});
	it("does not extend local custody until a lost renewal is recovered from committed server state", async () => {
		const f = await fixture();
		await f.start();
		f.clock.uptimeMs = 350000;
		f.setGuestUptime(251);
		f.loseRenew();
		await expect(f.controller.observe(f.context.allocationId, signal())).rejects.toThrow("renew reply lost");
		expect((await f.guard.latest(f.context.allocationId))?.stopAtUptimeMs).toBe(400000);
		await f.controller.maintain(signal());
		expect((await f.guard.latest(f.context.allocationId))?.permit.generation).toBe(2);
		expect(f.control.call.mock.calls.filter((call) => call[0].includes("renew"))).toHaveLength(1);
		expect(f.samples.at(-1)?.state).toBe("gap");
	});
	it("never revives a paid VM after expiry and observes a normal poweroff as terminal", async () => {
		const f = await fixture();
		await f.start();
		f.instance!.status = "Stopped";
		f.instance!.statusCode = 102;
		await f.controller.observe(f.context.allocationId, signal());
		expect(f.permit?.state).toBe("closed");
		expect((await f.guard.latest(f.context.allocationId))?.phase).toBe("stopped");
		await expect(f.controller.start(f.context.allocationId, f.target, signal())).rejects.toThrow("PERMIT_REQUIRED");
	});
	it("refuses replacement physical UUID and expanded mount drift before dispatch", async () => {
		const f = await fixture();
		await f.controller.ensure(f.context, f.context.allocationId, signal());
		f.instance!.expandedDevices = {
			...f.instance!.expandedDevices,
			surprise: { type: "disk", source: "/", path: "/host" },
		};
		await expect(f.controller.start(f.context.allocationId, f.target, signal())).rejects.toThrow(
			"PHYSICAL_INSTANCE_DIFFERS",
		);
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
		f.instance!.expandedDevices = structuredClone(f.target.devices);
		await f.controller.start(f.context.allocationId, f.target, signal());
		f.instance!.config = { ...f.instance!.config, "volatile.uuid": randomUUID() };
		await expect(f.controller.stop(f.context.allocationId, signal())).rejects.toThrow("PHYSICAL_INSTANCE_DIFFERS");
	});
	it("cannot mistake an unknown billing mode for a free computer", async () => {
		const f = await fixture();
		f.control.call.mockResolvedValueOnce({ permit: null, lastSample: null } as never);
		await expect(f.controller.ensure(f.context, f.context.allocationId, signal())).rejects.toThrow(
			"MODE_UNCONFIRMED",
		);
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
		f.setMode("shadow");
		expect(await f.controller.ensure(f.context, f.context.allocationId, signal())).toEqual({ mode: "shadow" });
		expect(f.control.call.mock.calls.filter((call) => call[0].includes("prepare"))).toHaveLength(0);
	});
	it("retains unknown start custody after a lost LXD dispatch reply, including late physical appearance", async () => {
		const f = await fixture();
		await f.controller.ensure(f.context, f.context.allocationId, signal());
		f.client.submitInstanceOperation.mockRejectedValueOnce(new Error("LXD reply lost"));
		await expect(f.controller.start(f.context.allocationId, f.target, signal())).rejects.toThrow("LXD reply lost");
		await f.restart();
		f.instance!.status = "Running";
		f.instance!.statusCode = 103;
		await f.guard.sweep();
		expect(f.instance?.status).toBe("Stopped");
		expect((await f.guard.latest(f.context.allocationId))?.stopReceipt).toBeNull();
	});
});
