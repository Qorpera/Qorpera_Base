import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCloudCodingNasPolicy } from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type LxdCodingMachineBinding, lxdCodingMachinePlan } from "../src/coding-machine.ts";
import {
	type CodingPaidComputerMachine,
	type PaidComputerArm,
	PaidComputerGuard,
	PaidComputerGuardJournal,
	type PaidComputerGuardPhysical,
	type PaidComputerHostClock,
	type PaidComputerMachine,
	type PaidComputerPrestartIntent,
} from "../src/computer-paid-guard.ts";
import { PaidComputerGuardClient, servePaidComputerGuard } from "../src/computer-paid-guard-ipc.ts";
import {
	paidComputerUsageCursor,
	parsePaidComputerUsageEntry,
	parsePaidComputerUsagePage,
} from "../src/computer-paid-usage.ts";
import { PaidComputerUsageJournal } from "../src/computer-paid-usage-journal.ts";
import { LxdPaidComputerUsageCapture } from "../src/computer-paid-usage-lxd.ts";
import type { LxdOperationReference } from "../src/lxd-client.ts";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(initialize = true) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "paid-guard-")));
	roots.push(root);
	await chmod(root, 0o700);
	const journalRoot = join(root, "journal");
	await mkdir(journalRoot, { mode: 0o700 });
	const binding: LxdCodingMachineBinding = {
		schema: "qorpera.lxd-coding-machine/v1",
		machineId: randomUUID(),
		companyId: randomUUID(),
		environmentId: randomUUID(),
		memberUserId: randomUUID(),
		providerId: "coding",
		providerPolicySha256: "a".repeat(64),
		project: "coding",
		imageFingerprint: "b".repeat(64),
		bootstrapSha256: "c".repeat(64),
		storagePool: "coding",
		network: "coding",
		cpus: 4,
		memoryBytes: 8589934592,
		rootDiskBytes: 34359738368,
	};
	const plan = lxdCodingMachinePlan(binding);
	const host: PaidComputerHostClock = {
		hostMachineIdSha256: "f".repeat(64),
		hostBootId: randomUUID(),
		uptimeMs: 100000,
	};
	const input: PaidComputerArm & { machine: CodingPaidComputerMachine } = {
		machine: {
			allocationId: binding.machineId,
			nodeId: randomUUID(),
			binding,
			storage: {
				policy: parseCloudCodingNasPolicy({
					schema: "qorpera.coding-nas-policy/v1",
					mountPoint: "/srv/coding",
					rootPath: "/srv/coding",
					source: "192.168.1.40:/coding",
					serverAddress: "192.168.1.40",
				}),
				machineIdSha256: host.hostMachineIdSha256,
			},
			physicalInstanceId: randomUUID(),
			hostMachineIdSha256: host.hostMachineIdSha256,
			hostBootId: host.hostBootId,
		},
		permit: {
			schema: "qorpera.computer-usage-permit/v1",
			mode: "paid",
			permitId: randomUUID(),
			allocationId: binding.machineId,
			instanceSha256: plan.instanceSha256,
			nodeId: "",
			epoch: randomUUID(),
			generation: 1,
			reservationId: randomUUID(),
			hostBootId: host.hostBootId,
			guestBootId: null,
			physicalId: null,
			issuedAt: "2026-09-25T12:00:00.000Z",
			deadline: "2026-09-25T12:05:30.000Z",
			validForMs: 330000,
			windowMs: 300000,
			stopReserveMs: 30000,
			tariffVersion: 1,
			cpuMillis: 4000,
			memoryBytes: 8589934592,
			state: "prepared",
		},
		requestStartedUptimeMs: host.uptimeMs,
	};
	input.permit.nodeId = input.machine.nodeId;
	let state: "running" | "stopped" | "absent" | "other" = "stopped";
	const operation = (): LxdOperationReference => ({
		project: binding.project,
		instanceName: plan.request.name,
		operationId: randomUUID(),
	});
	const physical = {
		inspect: vi.fn(async (_machine: PaidComputerMachine) => state),
		start: vi.fn(async (): Promise<LxdOperationReference> => {
			state = "running";
			return operation();
		}),
		startSettled: vi.fn(async (): Promise<"pending" | "succeeded" | "failed"> => "succeeded"),
		stop: vi.fn(async (): Promise<LxdOperationReference> => {
			state = "stopped";
			return operation();
		}),
	} satisfies PaidComputerGuardPhysical;
	const clock = vi.fn(async () => ({ ...host }));
	const journal = new PaidComputerGuardJournal(journalRoot);
	const guestBootId = randomUUID();
	const capture = {
		capture: vi.fn(async () => ({
			host: { ...host },
			guestBootId,
			guestUptimeMs: host.uptimeMs - 90000,
			evidenceSha256: "e".repeat(64),
			observedAt: new Date().toISOString(),
		})),
	};
	const guard = new PaidComputerGuard(journal, physical, clock, { usageCapture: capture });
	const register = async (arm = input) => {
		const prepareRequestText = JSON.stringify({
			schema: "qorpera.coding-computer-prepare/v2",
			requestId: arm.permit.permitId,
			machineId: arm.machine.allocationId,
			machineIdSha256: arm.machine.hostMachineIdSha256,
			hostBootId: arm.machine.hostBootId,
		});
		const intent: PaidComputerPrestartIntent = {
			schema: "qorpera.computer-prestart-intent/v1",
			permitId: arm.permit.permitId,
			allocationId: arm.machine.allocationId,
			instanceSha256: arm.permit.instanceSha256,
			hostMachineIdSha256: arm.machine.hostMachineIdSha256,
			hostBootId: arm.machine.hostBootId,
			prepareSha256: createHash("sha256").update(prepareRequestText).digest("hex"),
			prepareRequestText,
		};
		const retained = await guard.registerPrestart(intent);
		arm.permit = {
			...arm.permit,
			schema: "qorpera.computer-usage-permit/v2",
			prestart: {
				guardIncarnationId: retained.guardIncarnationId,
				prepareSha256: intent.prepareSha256,
			},
		};
		return intent;
	};
	if (initialize) {
		await guard.initialize();
		await register();
	}
	return {
		root,
		journalRoot,
		journal,
		guard,
		clock,
		capture,
		host,
		input,
		physical,
		operation,
		plan,
		register,
		setState(value: typeof state) {
			state = value;
		},
		restart: () => new PaidComputerGuard(journal, physical, clock, { usageCapture: capture }),
	};
}

async function collect(f: Awaited<ReturnType<typeof fixture>>, guard = f.guard) {
	guard.tickUsage();
	await guard.settleUsage(f.input.permit.permitId);
	return guard.readUsage(f.input.permit.permitId);
}
describe("independent durable paid usage", () => {
	it("publishes before dispatch and collects with no controller or SQL", async () => {
		const f = await fixture();
		expect((await f.guard.arm(f.input)).usageRequired).toBe(true);
		const anchor = join(f.journalRoot, `usage-${f.input.permit.permitId}`, "head.json");
		expect(JSON.parse(await readFile(anchor, "utf8")).head).toBeNull();
		await f.guard.start(f.input.permit.permitId, 1);
		const first = await collect(f),
			one = parsePaidComputerUsageEntry(JSON.parse(first.entries[0].entryText));
		expect(one.sample.state).toBe("running");
		expect(one.previousSha256).toBeNull();
		vi.spyOn(performance, "now").mockReturnValue(performance.now() + 6000);
		f.host.uptimeMs += 5000;
		const second = await collect(f),
			two = parsePaidComputerUsageEntry(JSON.parse(second.entries[1].entryText));
		expect(two.previousSha256).toBe(first.entries[0].sha256);
		expect(two.sample.previousObservationId).toBe(one.sample.observationId);
		expect(two.sample.hostUptimeMs - one.sample.hostUptimeMs).toBe(5000);
		expect(parsePaidComputerUsagePage(second)).toEqual(second);
	});
	it("retains ACK and predecessor across restart with an explicit gap", async () => {
		const f = await fixture();
		await f.guard.arm(f.input);
		await f.guard.start(f.input.permit.permitId, 1);
		const first = await collect(f),
			cursor = paidComputerUsageCursor(first.entries[0]);
		await f.guard.ackUsage(f.input.permit.permitId, cursor);
		await expect(f.guard.ackUsage(f.input.permit.permitId, cursor)).resolves.toEqual(cursor);
		const restarted = f.restart();
		await restarted.initialize();
		await expect(
			restarted.arm({
				...f.input,
				permit: {
					...f.input.permit,
					generation: 2,
					reservationId: randomUUID(),
					issuedAt: "2026-09-25T12:00:05.000Z",
					deadline: "2026-09-25T12:05:35.000Z",
				},
			}),
		).rejects.toThrow("USAGE_GAP");
		f.host.uptimeMs += 5000;
		const page = await collect(f, restarted);
		expect(page.acknowledgedThrough).toEqual(cursor);
		expect(page.entries).toHaveLength(2);
		const gap = parsePaidComputerUsageEntry(JSON.parse(page.entries[0].entryText));
		expect(gap.sample.state).toBe("gap");
		expect(gap.previousSha256).toBe(cursor.sha256);
		expect(gap.sample.previousObservationId).toBe(cursor.observationId);
	});
	it("stops despite a stalled capture and seals only actual stop proof", async () => {
		const f = await fixture();
		await f.guard.arm(f.input);
		await f.guard.start(f.input.permit.permitId, 1);
		const release = deferred<Awaited<ReturnType<typeof f.capture.capture>>>();
		f.capture.capture.mockImplementationOnce(() => release.promise);
		f.guard.tickUsage();
		await vi.waitFor(() => expect(f.capture.capture).toHaveBeenCalled());
		f.host.uptimeMs = 400000;
		await f.guard.sweep();
		const stopped = await f.guard.status(f.input.permit.permitId);
		expect(stopped.phase).toBe("stopped");
		release.resolve({
			host: { ...f.host },
			guestBootId: randomUUID(),
			guestUptimeMs: 1,
			evidenceSha256: "e".repeat(64),
			observedAt: new Date().toISOString(),
		});
		await f.guard.settleUsage(f.input.permit.permitId);
		const page = await collect(f);
		expect(page.state).toBe("sealed");
		expect(page.entries).toHaveLength(1);
		const terminal = parsePaidComputerUsageEntry(JSON.parse(page.entries[0].entryText));
		expect(terminal.stopReceipt).toEqual(stopped.stopReceipt);
		expect(terminal.sample.hostUptimeMs).toBe(stopped.stopReceipt?.closedAtUptimeMs);
		await expect(f.guard.archive(f.input.permit.permitId, {})).rejects.toThrow("NOT_DRAINED");
	});
	it("stops if a marked usage anchor disappears and refuses empty recovery", async () => {
		const f = await fixture();
		await f.guard.arm(f.input);
		await f.guard.start(f.input.permit.permitId, 1);
		await unlink(join(f.journalRoot, `usage-${f.input.permit.permitId}`, "head.json"));
		f.guard.tickUsage();
		await f.guard.settleUsage(f.input.permit.permitId);
		expect((await f.guard.status(f.input.permit.permitId)).phase).toBe("stopped");
		await expect(f.guard.readUsage(f.input.permit.permitId)).rejects.toThrow("UNCONFIRMED");
		await expect(f.restart().initialize()).rejects.toThrow();
	});
	it("recovers one immutable tail and refuses a missing prefix", async () => {
		const f = await fixture();
		await f.guard.arm(f.input);
		await f.guard.start(f.input.permit.permitId, 1);
		const path = join(f.journalRoot, `usage-${f.input.permit.permitId}`),
			before = await readFile(join(path, "head.json"));
		const first = await collect(f);
		await writeFile(join(path, "head.json"), before, { mode: 0o600 });
		const journal = new PaidComputerUsageJournal(path);
		await journal.initialize(await f.guard.status(f.input.permit.permitId));
		expect((await journal.read()).head.sha256).toBe(first.head.sha256);
		await unlink(join(path, "0000000000000001.json"));
		await expect(
			new PaidComputerUsageJournal(path).initialize(await f.guard.status(f.input.permit.permitId)),
		).rejects.toThrow("PREFIX_MISSING");
	});
	it("rejects forged ACKs and changed page heads", async () => {
		const f = await fixture();
		await f.guard.arm(f.input);
		await f.guard.start(f.input.permit.permitId, 1);
		const page = await collect(f),
			cursor = paidComputerUsageCursor(page.entries[0]);
		await expect(f.guard.ackUsage(f.input.permit.permitId, { ...cursor, sha256: "a".repeat(64) })).rejects.toThrow(
			"ACK_DIFFERS",
		);
		await expect(f.guard.ackUsage(f.input.permit.permitId, { ...cursor, sequence: 2 })).rejects.toThrow("ACK_AHEAD");
		expect(() => parsePaidComputerUsagePage({ ...page, head: { ...page.head, sha256: "a".repeat(64) } })).toThrow();
	});
	it("carries exact pages and ACKs over the private socket", async () => {
		const f = await fixture(false),
			abort = new AbortController(),
			report = vi.fn();
		const serving = servePaidComputerGuard({
			guard: f.guard,
			socketPath: join(f.root, "guard.sock"),
			signal: abort.signal,
			report,
		});
		await vi.waitFor(() => expect(report).toHaveBeenCalledWith("ready"));
		try {
			await f.register();
			const client = new PaidComputerGuardClient(join(f.root, "guard.sock"));
			await client.arm(f.input);
			await client.start(f.input.permit.permitId, 1);
			await collect(f);
			const page = await client.readUsage(f.input.permit.permitId, { limit: 1 });
			expect(page.entries).toHaveLength(1);
			expect(await client.ackUsage(f.input.permit.permitId, page.head)).toEqual(page.head);
		} finally {
			abort.abort();
			await serving;
		}
	});
	it("brackets a single paired clock by physical identity and rejects a slow sample", async () => {
		const f = await fixture();
		f.setState("running");
		const guest = { bootId: randomUUID(), uptimeMs: 1000 },
			client = { readInstanceClock: vi.fn(async () => guest) };
		const capture = new LxdPaidComputerUsageCapture(client, f.physical, f.clock);
		expect((await capture.capture(f.input.machine, new AbortController().signal)).guestBootId).toBe(guest.bootId);
		expect(f.physical.inspect).toHaveBeenCalledTimes(2);
		client.readInstanceClock.mockImplementationOnce(async () => {
			f.host.uptimeMs += 1001;
			return guest;
		});
		await expect(capture.capture(f.input.machine, new AbortController().signal)).rejects.toThrow("CLOCK_UNCONFIRMED");
	});
});
describe("durable usage terminal and renewal races", () => {
	it("requires the complete SQL ACK before archival and replays after restart", async () => {
		const f = await fixture();
		await f.guard.arm(f.input);
		await f.guard.start(f.input.permit.permitId, 1);
		await collect(f);
		await f.guard.stop(f.input.permit.permitId);
		const page = await collect(f);
		const closure = { ...f.input.permit, state: "closed", validForMs: 0 };
		await expect(f.guard.archive(f.input.permit.permitId, closure)).rejects.toThrow("NOT_DRAINED");
		await f.guard.ackUsage(f.input.permit.permitId, page.head);
		await f.guard.archive(f.input.permit.permitId, closure);
		expect(await f.guard.list()).toEqual([]);
		const restarted = f.restart();
		await restarted.initialize();
		expect((await restarted.readUsage(f.input.permit.permitId)).head).toEqual(page.head);
		await restarted.archive(f.input.permit.permitId, closure);
		expect(f.physical.start).toHaveBeenCalledOnce();
	});
	it("retains capture generation N when local renewal N+1 wins the capture race", async () => {
		const f = await fixture();
		await f.guard.arm(f.input);
		await f.guard.start(f.input.permit.permitId, 1);
		await collect(f);
		vi.spyOn(performance, "now").mockReturnValue(performance.now() + 6000);
		const original = await f.capture.capture();
		const release = deferred<typeof original>();
		f.capture.capture.mockImplementationOnce(() => release.promise);
		f.guard.tickUsage();
		await vi.waitFor(() => expect(f.capture.capture).toHaveBeenCalledTimes(3));
		f.host.uptimeMs += 5000;
		const renewal = {
			...f.input,
			requestStartedUptimeMs: f.host.uptimeMs,
			permit: {
				...f.input.permit,
				generation: 2,
				reservationId: randomUUID(),
				issuedAt: "2026-09-25T12:00:05.000Z",
				deadline: "2026-09-25T12:05:35.000Z",
			},
		};
		const armed = await f.guard.arm(renewal);
		expect(armed.usageRequired).toBe(true);
		release.resolve(original);
		await f.guard.settleUsage(f.input.permit.permitId);
		const page = await f.guard.readUsage(f.input.permit.permitId);
		expect(parsePaidComputerUsageEntry(JSON.parse(page.entries[0].entryText)).permit.generation).toBe(1);
		vi.mocked(performance.now).mockReturnValue(performance.now() + 6000);
		const next = await collect(f);
		expect(parsePaidComputerUsageEntry(JSON.parse(next.entries[2].entryText)).permit.generation).toBe(2);
	});
	it("does not append a restart gap after a concurrent terminal clock", async () => {
		const f = await fixture();
		await f.guard.arm(f.input);
		await f.guard.start(f.input.permit.permitId, 1);
		await collect(f);
		const restarted = f.restart();
		await restarted.initialize();
		const delayed = deferred<PaidComputerHostClock>();
		f.clock.mockImplementationOnce(async () => ({ ...f.host })).mockImplementationOnce(() => delayed.promise);
		restarted.tickUsage();
		await vi.waitFor(() => expect(f.clock.mock.results.at(-1)?.value).toBe(delayed.promise));
		f.host.uptimeMs += 1000;
		await restarted.stop(f.input.permit.permitId);
		delayed.resolve({ ...f.host, uptimeMs: f.host.uptimeMs + 1000 });
		await restarted.settleUsage(f.input.permit.permitId);
		const page = await collect(f, restarted);
		expect(page.state).toBe("sealed");
		expect(
			page.entries.map((frame) => parsePaidComputerUsageEntry(JSON.parse(frame.entryText)).sample.state),
		).toEqual(["running", "stopped"]);
	});
	it("preserves the known guest boot through a gap and refuses a replacement boot", async () => {
		const f = await fixture();
		await f.guard.arm(f.input);
		await f.guard.start(f.input.permit.permitId, 1);
		await collect(f);
		vi.spyOn(performance, "now").mockReturnValue(performance.now() + 6000);
		f.host.uptimeMs += 5000;
		f.capture.capture.mockRejectedValueOnce(new Error("guest unavailable"));
		const gap = await collect(f);
		const one = parsePaidComputerUsageEntry(JSON.parse(gap.entries[0].entryText)),
			two = parsePaidComputerUsageEntry(JSON.parse(gap.entries[1].entryText));
		expect(two.sample.state).toBe("gap");
		expect(two.sample.guestBootId).toBe(one.sample.guestBootId);
		vi.mocked(performance.now).mockReturnValue(performance.now() + 6000);
		f.host.uptimeMs += 5000;
		f.capture.capture.mockResolvedValueOnce({
			host: { ...f.host },
			guestBootId: randomUUID(),
			guestUptimeMs: 10,
			evidenceSha256: "e".repeat(64),
			observedAt: new Date().toISOString(),
		});
		f.guard.tickUsage();
		await f.guard.settleUsage(f.input.permit.permitId);
		expect((await f.guard.status(f.input.permit.permitId)).phase).toBe("stopped");
	});
});
describe("usage admission and bounded uncertainty", () => {
	it("revalidates a deleted anchor before dispatch and renewal", async () => {
		for (const running of [false, true]) {
			const f = await fixture();
			await f.guard.arm(f.input);
			if (running) {
				await f.guard.start(f.input.permit.permitId, 1);
				await collect(f);
			}
			await unlink(join(f.journalRoot, `usage-${f.input.permit.permitId}`, "head.json"));
			if (running)
				await expect(
					f.guard.arm({
						...f.input,
						permit: {
							...f.input.permit,
							generation: 2,
							reservationId: randomUUID(),
							deadline: "2026-09-25T12:05:35.000Z",
							issuedAt: "2026-09-25T12:00:05.000Z",
						},
					}),
				).rejects.toThrow();
			else await expect(f.guard.start(f.input.permit.permitId, 1)).rejects.toThrow();
			expect(f.physical.start).toHaveBeenCalledTimes(running ? 1 : 0);
		}
	});
	it("does not hold stop custody while a renewal anchor preflight is blocked", async () => {
		const f = await fixture();
		await f.guard.arm(f.input);
		await f.guard.start(f.input.permit.permitId, 1);
		await collect(f);
		const release = deferred<void>(),
			read = PaidComputerUsageJournal.prototype.read;
		const blocked = vi.spyOn(PaidComputerUsageJournal.prototype, "read").mockImplementationOnce(async function (
			this: PaidComputerUsageJournal,
			...args
		) {
			await release.promise;
			return read.apply(this, args);
		});
		const renewing = f.guard.arm({
			...f.input,
			permit: {
				...f.input.permit,
				generation: 2,
				reservationId: randomUUID(),
				deadline: "2026-09-25T12:05:35.000Z",
				issuedAt: "2026-09-25T12:00:05.000Z",
			},
		});
		const rejected = expect(renewing).rejects.toThrow();
		await vi.waitFor(() => expect(blocked).toHaveBeenCalled());
		expect((await f.guard.stop(f.input.permit.permitId)).phase).toBe("stopped");
		release.resolve();
		await rejected;
	});
	it("tolerates one explicit gap, refuses renewal, then resumes only after another pair", async () => {
		const f = await fixture();
		await f.guard.arm(f.input);
		await f.guard.start(f.input.permit.permitId, 1);
		await collect(f);
		vi.spyOn(performance, "now").mockReturnValue(performance.now() + 6000);
		f.host.uptimeMs += 5000;
		f.capture.capture.mockRejectedValueOnce(new Error("transient"));
		const gap = await collect(f);
		expect(parsePaidComputerUsageEntry(JSON.parse(gap.entries[1].entryText)).sample.state).toBe("gap");
		expect(f.physical.stop).not.toHaveBeenCalled();
		const renewal = {
			...f.input,
			requestStartedUptimeMs: f.host.uptimeMs,
			permit: {
				...f.input.permit,
				generation: 2,
				reservationId: randomUUID(),
				issuedAt: "2026-09-25T12:00:05.000Z",
				deadline: "2026-09-25T12:05:35.000Z",
			},
		};
		await expect(f.guard.arm(renewal)).rejects.toThrow("USAGE_GAP");
		vi.mocked(performance.now).mockReturnValue(performance.now() + 6000);
		f.host.uptimeMs += 5000;
		await collect(f);
		expect((await f.guard.arm(renewal)).permit.generation).toBe(2);
	});
	it("stops on the second consecutive failed capture and retains a sealable prefix", async () => {
		const f = await fixture();
		await f.guard.arm(f.input);
		await f.guard.start(f.input.permit.permitId, 1);
		await collect(f);
		vi.spyOn(performance, "now").mockReturnValue(performance.now() + 6000);
		f.host.uptimeMs += 5000;
		f.capture.capture.mockRejectedValue(new Error("clock unavailable"));
		await collect(f);
		vi.mocked(performance.now).mockReturnValue(performance.now() + 6000);
		f.host.uptimeMs += 5000;
		await collect(f);
		expect((await f.guard.status(f.input.permit.permitId)).phase).toBe("stopped");
		const sealed = await collect(f);
		expect(sealed.state).toBe("sealed");
		expect(
			sealed.entries.map((frame) => parsePaidComputerUsageEntry(JSON.parse(frame.entryText)).sample.state),
		).toEqual(["running", "gap", "gap", "stopped"]);
	});
	it("enforces the ten-second evidence deadline independently of stalled capture I/O", async () => {
		const f = await fixture();
		await f.guard.arm(f.input);
		await f.guard.start(f.input.permit.permitId, 1);
		await collect(f);
		vi.spyOn(performance, "now").mockReturnValue(performance.now() + 6000);
		f.host.uptimeMs += 5000;
		const release = deferred<Awaited<ReturnType<typeof f.capture.capture>>>();
		f.capture.capture.mockImplementationOnce(() => release.promise);
		f.guard.tickUsage();
		await vi.waitFor(() => expect(f.capture.capture).toHaveBeenCalledTimes(2));
		f.host.uptimeMs += 5001;
		f.guard.tickUsage();
		await vi.waitFor(() => expect(f.physical.stop).toHaveBeenCalledOnce());
		release.resolve({
			host: { ...f.host },
			guestBootId: randomUUID(),
			guestUptimeMs: 1,
			evidenceSha256: "e".repeat(64),
			observedAt: new Date().toISOString(),
		});
		await f.guard.settleUsage(f.input.permit.permitId);
		expect((await collect(f)).state).toBe("sealed");
	});
	it("retains the trustworthy clock deadline through gap ACK and process restart", async () => {
		const f = await fixture();
		await f.guard.arm(f.input);
		await f.guard.start(f.input.permit.permitId, 1);
		await collect(f);
		vi.spyOn(performance, "now").mockReturnValue(performance.now() + 6000);
		f.host.uptimeMs += 5000;
		f.capture.capture.mockRejectedValueOnce(new Error("transient"));
		const gap = await collect(f);
		await f.guard.ackUsage(f.input.permit.permitId, gap.head);
		const restarted = f.restart();
		await restarted.initialize();
		f.host.uptimeMs += 5001;
		restarted.tickUsage();
		await restarted.settleUsage(f.input.permit.permitId);
		expect((await restarted.status(f.input.permit.permitId)).phase).toBe("stopped");
	});
	it("keeps first-boot missing clocks under the original permit deadline", async () => {
		const f = await fixture();
		const original = await f.guard.arm(f.input);
		await f.guard.start(f.input.permit.permitId, 1);
		f.capture.capture.mockRejectedValue(new Error("guest booting"));
		await collect(f);
		vi.spyOn(performance, "now").mockReturnValue(performance.now() + 6000);
		f.host.uptimeMs += 20000;
		await collect(f);
		expect(f.physical.stop).not.toHaveBeenCalled();
		expect((await f.guard.status(f.input.permit.permitId)).deadlineUptimeMs).toBe(original.deadlineUptimeMs);
		f.host.uptimeMs = original.stopAtUptimeMs;
		await f.guard.sweep();
		expect(f.physical.stop).toHaveBeenCalledOnce();
	});
});
it("refuses positive foreign-host evidence without stopping a foreign machine", async () => {
	const f = await fixture();
	await f.guard.arm(f.input);
	await f.guard.start(f.input.permit.permitId, 1);
	await collect(f);
	f.host.hostMachineIdSha256 = "a".repeat(64);
	f.host.uptimeMs += 11000;
	f.guard.tickUsage();
	await f.guard.settleUsage(f.input.permit.permitId);
	expect(f.physical.stop).not.toHaveBeenCalled();
	await expect(f.guard.readUsage(f.input.permit.permitId)).rejects.toThrow("UNCONFIRMED");
});
it("does not block an existing VM stop while preparing another VM's usage anchor", async () => {
	const f = await fixture();
	await f.guard.arm(f.input);
	await f.guard.start(f.input.permit.permitId, 1);
	await collect(f);
	const second = structuredClone(f.input);
	second.machine.allocationId = randomUUID();
	second.machine.binding = { ...second.machine.binding, machineId: second.machine.allocationId };
	second.machine.physicalInstanceId = randomUUID();
	second.permit = {
		...second.permit,
		permitId: randomUUID(),
		allocationId: second.machine.allocationId,
		instanceSha256: lxdCodingMachinePlan(second.machine.binding).instanceSha256,
		reservationId: randomUUID(),
		epoch: randomUUID(),
	};
	await f.register(second);
	const inspect = f.physical.inspect.getMockImplementation()!;
	f.physical.inspect.mockImplementation(async (machine) =>
		machine.allocationId === second.machine.allocationId ? "stopped" : inspect(machine),
	);
	const release = deferred<void>(),
		initialize = PaidComputerUsageJournal.prototype.initialize;
	const blocked = vi.spyOn(PaidComputerUsageJournal.prototype, "initialize").mockImplementationOnce(async function (
		this: PaidComputerUsageJournal,
		record,
		create,
	) {
		await release.promise;
		return initialize.call(this, record, create);
	});
	const preparing = f.guard.arm(second);
	await vi.waitFor(() => expect(blocked).toHaveBeenCalledOnce());
	expect((await f.guard.stop(f.input.permit.permitId)).phase).toBe("stopped");
	expect((await f.guard.list()).map((record) => record.permit.permitId)).toEqual([f.input.permit.permitId]);
	release.resolve();
	expect((await preparing).phase).toBe("armed");
	expect(f.physical.start).toHaveBeenCalledOnce();
});
