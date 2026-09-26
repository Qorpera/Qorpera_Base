import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	assertPaidComputerTerminalPermit,
	type PaidComputerArm,
	PaidComputerGuard,
	PaidComputerGuardJournal,
	type PaidComputerGuardPhysical,
	type PaidComputerHostClock,
	type PaidComputerPermit,
	type PaidComputerPrestartRecord,
} from "../src/computer-paid-guard.ts";
import { PaidComputerGuardClient, servePaidComputerGuard } from "../src/computer-paid-guard-ipc.ts";
import type { LxdOperationReference } from "../src/lxd-client.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "guard-archive-")));
	roots.push(root);
	await chmod(root, 0o700);
	const journalRoot = join(root, "journal");
	await mkdir(journalRoot, { mode: 0o700 });
	const host: PaidComputerHostClock = {
		hostMachineIdSha256: "a".repeat(64),
		hostBootId: randomUUID(),
		uptimeMs: 100000,
	};
	const allocationId = randomUUID(),
		nodeId = randomUUID(),
		permitId = randomUUID();
	const input: PaidComputerArm = {
		machine: {
			kind: "runtime",
			allocationId,
			nodeId,
			instanceSha256: "b".repeat(64),
			providerKind: "native",
			physicalTarget: {
				kind: "lxd",
				project: "runtime",
				instanceName: "archive-machine",
				profiles: [],
				config: {},
				devices: {},
			},
			cpuMillis: 4000,
			memoryBytes: 8589934592,
			physicalInstanceId: randomUUID(),
			hostMachineIdSha256: host.hostMachineIdSha256,
			hostBootId: host.hostBootId,
		},
		permit: {
			schema: "qorpera.computer-usage-permit/v2",
			mode: "paid",
			permitId,
			allocationId,
			instanceSha256: "b".repeat(64),
			nodeId,
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
	let state: "running" | "stopped" = "stopped";
	const operation = (): LxdOperationReference => ({
		project: "runtime",
		instanceName: "archive-machine",
		operationId: randomUUID(),
	});
	const physical = {
		inspect: vi.fn(async () => state),
		start: vi.fn(async () => {
			state = "running";
			return operation();
		}),
		startSettled: vi.fn(async (): Promise<"pending" | "succeeded" | "failed"> => "succeeded"),
		stop: vi.fn(async () => {
			state = "stopped";
			return operation();
		}),
	} satisfies PaidComputerGuardPhysical;
	const journal = new PaidComputerGuardJournal(journalRoot);
	const clock = async () => ({ ...host });
	const guard = new PaidComputerGuard(journal, physical, clock);
	await guard.initialize();
	const prepareRequestText = JSON.stringify({
		schema: "qorpera.runtime-computer-prepare/v2",
		requestId: permitId,
		allocationId,
		instanceSha256: input.permit.instanceSha256,
		machineIdSha256: host.hostMachineIdSha256,
		hostBootId: host.hostBootId,
	});
	const prestart = await guard.registerPrestart({
		schema: "qorpera.computer-prestart-intent/v1",
		permitId,
		allocationId,
		instanceSha256: input.permit.instanceSha256,
		hostMachineIdSha256: host.hostMachineIdSha256,
		hostBootId: host.hostBootId,
		prepareRequestText,
		prepareSha256: createHash("sha256").update(prepareRequestText).digest("hex"),
	});
	input.permit.prestart = {
		guardIncarnationId: prestart.guardIncarnationId,
		prepareSha256: prestart.intent.prepareSha256,
	};
	return {
		journalRoot,
		journal,
		guard,
		input,
		prestart,
		physical,
		host,
		restart: () => new PaidComputerGuard(journal, physical, clock),
		async stopped() {
			await guard.arm(input);
			await guard.start(permitId, 1);
			return guard.stop(permitId);
		},
		closed: () => ({ ...input.permit, state: "closed", validForMs: 0 }),
	};
}

function abandonment(entry: PaidComputerPrestartRecord) {
	return {
		schema: "qorpera.computer-abandonment-receipt/v1",
		permitId: entry.intent.permitId,
		state: "abandoned_before_dispatch",
		abandonment: entry.abandonment,
		reservationReleased: true,
		debitedUs: "0",
		releasedUs: "330000000",
	};
}

async function unusedAttempt(f: Awaited<ReturnType<typeof fixture>>) {
	const permitId = randomUUID();
	const prepareRequestText = JSON.stringify({
		...JSON.parse(f.prestart.intent.prepareRequestText),
		requestId: permitId,
	});
	const entry = await f.guard.registerPrestart({
		...f.prestart.intent,
		permitId,
		prepareRequestText,
		prepareSha256: createHash("sha256").update(prepareRequestText).digest("hex"),
	});
	return f.guard.abandonPrestart(entry.intent);
}

describe("paid guard startup stop custody", () => {
	it("enforces the original deadline during archive validation without publishing readiness or a receipt", async () => {
		const f = await fixture();
		const unused = await unusedAttempt(f);
		await f.guard.archive(unused.intent.permitId, abandonment(unused));
		const armed = await f.guard.arm(f.input);
		await f.guard.start(f.input.permit.permitId, 1);
		await f.guard.sweep();
		const original = await f.guard.status(f.input.permit.permitId);
		f.host.uptimeMs = armed.stopAtUptimeMs - 1;
		let release!: () => void;
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const read = f.journal.readArchive.bind(f.journal);
		const blocked = vi.spyOn(f.journal, "readArchive").mockImplementationOnce(async (sequence) => {
			await barrier;
			return read(sequence);
		});
		const restarted = f.restart(),
			controller = new AbortController(),
			report = vi.fn(),
			progress = vi.fn();
		const serving = servePaidComputerGuard({
			guard: restarted,
			socketPath: join(f.journalRoot, "guard.sock"),
			signal: controller.signal,
			report,
			startupProgress: progress,
		});
		try {
			await vi.waitFor(() => expect(blocked).toHaveBeenCalledOnce());
			expect(f.physical.stop).not.toHaveBeenCalled();
			f.host.uptimeMs = armed.stopAtUptimeMs;
			await vi.waitFor(() => expect(f.physical.stop).toHaveBeenCalledOnce(), { timeout: 2500 });
			expect(report).not.toHaveBeenCalledWith("ready");
			expect(progress).toHaveBeenCalled();
			await expect(restarted.status(f.input.permit.permitId)).rejects.toThrow("NOT_INITIALIZED");
			expect(JSON.parse(await readFile(join(f.journalRoot, `${f.input.permit.permitId}.json`), "utf8"))).toEqual(
				original,
			);
			release();
			await vi.waitFor(() => expect(report).toHaveBeenCalledWith("ready"));
			const stopped = await restarted.stop(f.input.permit.permitId);
			expect(stopped.phase).toBe("stopped");
			expect(stopped.stopReceipt).not.toBeNull();
			expect(stopped.stopAtUptimeMs).toBe(original.stopAtUptimeMs);
			expect(f.physical.start).toHaveBeenCalledOnce();
		} finally {
			release();
			controller.abort();
			await serving;
		}
	});

	it("retires a pending startup clock read before a ready guard can renew the permit", async () => {
		const f = await fixture(),
			unused = await unusedAttempt(f);
		await f.guard.archive(unused.intent.permitId, abandonment(unused));
		const armed = await f.guard.arm(f.input);
		await f.guard.start(f.input.permit.permitId, 1);
		await f.guard.sweep();
		let releaseArchive!: () => void, releaseClock!: () => void;
		const archiveBarrier = new Promise<void>((resolve) => {
			releaseArchive = resolve;
		});
		const clockBarrier = new Promise<void>((resolve) => {
			releaseClock = resolve;
		});
		const read = f.journal.readArchive.bind(f.journal);
		const blocked = vi.spyOn(f.journal, "readArchive").mockImplementationOnce(async (sequence) => {
			await archiveBarrier;
			return read(sequence);
		});
		let pauseClock = false,
			clockPending = false,
			clockResumed = false;
		const restarted = new PaidComputerGuard(f.journal, f.physical, async () => {
			if (pauseClock) {
				pauseClock = false;
				clockPending = true;
				await clockBarrier;
				clockResumed = true;
			}
			return { ...f.host };
		});
		const initializing = restarted.initialize();
		try {
			await vi.waitFor(() => expect(blocked).toHaveBeenCalledOnce());
			pauseClock = true;
			await vi.waitFor(() => expect(clockPending).toBe(true), { timeout: 2500 });
			releaseArchive();
			await initializing;
			f.host.uptimeMs = armed.stopAtUptimeMs - 1000;
			const renewed = await restarted.arm({
				...f.input,
				requestStartedUptimeMs: f.host.uptimeMs,
				permit: {
					...f.input.permit,
					generation: 2,
					reservationId: randomUUID(),
					issuedAt: "2026-09-25T12:04:00.000Z",
					deadline: "2026-09-25T12:09:30.000Z",
				},
			});
			f.host.uptimeMs = armed.stopAtUptimeMs;
			releaseClock();
			await vi.waitFor(() => expect(clockResumed).toBe(true));
			await new Promise((resolve) => setTimeout(resolve, 25));
			expect(f.physical.stop).not.toHaveBeenCalled();
			expect(await restarted.status(f.input.permit.permitId)).toEqual(renewed);
		} finally {
			releaseArchive();
			releaseClock();
			await initializing;
		}
	});

	it("physically closes validated active custody when interrupted archive repair cannot write its anchor", async () => {
		const f = await fixture();
		await f.guard.arm(f.input);
		await f.guard.start(f.input.permit.permitId, 1);
		await f.guard.sweep();
		const original = await f.guard.status(f.input.permit.permitId);
		const unused = await unusedAttempt(f);
		const save = vi.spyOn(f.journal, "savePrestarts").mockRejectedValue(new Error("ENOSPC"));
		await expect(f.guard.archive(unused.intent.permitId, abandonment(unused))).rejects.toThrow("ENOSPC");
		expect(await readdir(join(f.journalRoot, "archive"))).toContain("0000000000000001.json");
		const restarted = f.restart();
		await expect(restarted.initialize()).rejects.toThrow("ENOSPC");
		expect(f.physical.stop).toHaveBeenCalledOnce();
		expect(JSON.parse(await readFile(join(f.journalRoot, `${f.input.permit.permitId}.json`), "utf8"))).toEqual(
			original,
		);
		await expect(restarted.status(f.input.permit.permitId)).rejects.toThrow("NOT_INITIALIZED");
		save.mockRestore();
		const repaired = f.restart();
		await repaired.initialize();
		await repaired.archive(unused.intent.permitId, abandonment(unused));
		const stopped = await repaired.stop(f.input.permit.permitId);
		expect(stopped.phase).toBe("stopped");
		expect(stopped.stopAtUptimeMs).toBe(original.stopAtUptimeMs);
		expect(f.physical.start).toHaveBeenCalledOnce();
	});

	it.each([false, true])(
		"rejects corrupt history and only closes machines on the enrolled host (foreign: %s)",
		async (foreign) => {
			const f = await fixture(),
				unused = await unusedAttempt(f);
			await f.guard.archive(unused.intent.permitId, abandonment(unused));
			await f.guard.arm(f.input);
			await f.guard.start(f.input.permit.permitId, 1);
			await f.guard.sweep();
			await writeFile(join(f.journalRoot, "archive", "0000000000000001.json"), "{}", { mode: 0o600 });
			if (foreign) f.host.hostMachineIdSha256 = "f".repeat(64);
			await expect(f.restart().initialize()).rejects.toThrow();
			expect(f.physical.stop).toHaveBeenCalledTimes(foreign ? 0 : 1);
		},
	);

	it("does not assert physical start custody from an abandoned never-dispatched arm during corrupt recovery", async () => {
		const f = await fixture(),
			unused = await unusedAttempt(f);
		await f.guard.archive(unused.intent.permitId, abandonment(unused));
		await f.guard.arm(f.input);
		await f.guard.abandonPrestart(f.prestart.intent);
		await writeFile(join(f.journalRoot, "archive", "0000000000000001.json"), "{}", { mode: 0o600 });
		f.physical.inspect.mockResolvedValue("running");
		await expect(f.restart().initialize()).rejects.toThrow();
		expect(f.physical.stop).not.toHaveBeenCalled();
	});

	it("does not stop a valid running machine on an ordinary restart before its original deadline", async () => {
		const f = await fixture();
		await f.guard.arm(f.input);
		await f.guard.start(f.input.permit.permitId, 1);
		await f.guard.sweep();
		const original = await f.guard.status(f.input.permit.permitId);
		const restarted = f.restart();
		await restarted.initialize();
		expect(await restarted.status(f.input.permit.permitId)).toEqual(original);
		expect(f.physical.stop).not.toHaveBeenCalled();
	});
});

describe("paid guard terminal archival", () => {
	it.each([false, true])(
		"archives a lost SQL renewal without changing physical stop evidence (late commit: %s)",
		async (late) => {
			const f = await fixture(),
				stopped = await f.stopped();
			const renewed: PaidComputerPermit = {
				...f.input.permit,
				state: "bound",
				generation: 2,
				reservationId: randomUUID(),
				physicalId: f.input.machine.physicalInstanceId,
				guestBootId: randomUUID(),
				issuedAt: late ? "2026-09-25T12:06:00.000Z" : "2026-09-25T12:04:00.000Z",
				deadline: "2026-09-25T12:09:30.000Z",
				validForMs: 0,
			};
			assertPaidComputerTerminalPermit(stopped, renewed);
			await expect(f.guard.arm({ ...f.input, permit: renewed })).rejects.toThrow();
			expect(await f.guard.status(renewed.permitId)).toEqual(stopped);
			await expect(f.guard.archive(renewed.permitId, renewed)).rejects.toThrow();
			const closed = { ...renewed, state: "closed" };
			await f.guard.archive(renewed.permitId, closed);
			const persisted = JSON.parse(await readFile(join(f.journalRoot, "archive", "0000000000000001.json"), "utf8"));
			expect(persisted.guard).toEqual(stopped);
			expect(persisted.closure).toEqual(closed);
			const restarted = f.restart();
			await restarted.initialize();
			await restarted.archive(renewed.permitId, closed);
			expect(await restarted.stop(renewed.permitId)).toEqual(stopped);
			await expect(restarted.start(renewed.permitId, 2)).rejects.toThrow();
			expect(f.physical.start).toHaveBeenCalledOnce();
			expect(f.physical.stop).toHaveBeenCalledOnce();
		},
	);
	it("rejects skipped windows and changed renewal lineage while retaining terminal custody", async () => {
		const f = await fixture(),
			stopped = await f.stopped();
		const closed: PaidComputerPermit = {
			...f.input.permit,
			state: "closed",
			generation: 2,
			reservationId: randomUUID(),
			physicalId: f.input.machine.physicalInstanceId,
			guestBootId: randomUUID(),
			issuedAt: "2026-09-25T12:04:00.000Z",
			deadline: "2026-09-25T12:09:30.000Z",
			validForMs: 0,
		};
		for (const altered of [
			{ ...closed, generation: 3 },
			{ ...closed, reservationId: f.input.permit.reservationId },
			{ ...closed, epoch: randomUUID() },
			{ ...closed, nodeId: randomUUID() },
			{ ...closed, guestBootId: null },
			{ ...closed, physicalId: null },
			{ ...closed, physicalId: randomUUID() },
			{ ...closed, tariffVersion: 2 },
			{ ...closed, issuedAt: f.input.permit.issuedAt, deadline: f.input.permit.deadline },
			{ ...closed, prestart: { ...closed.prestart!, prepareSha256: "c".repeat(64) } },
		])
			await expect(f.guard.archive(closed.permitId, altered)).rejects.toThrow();
		expect(await f.guard.status(closed.permitId)).toEqual(stopped);
		expect(await f.guard.list()).toHaveLength(1);
	});
	it("requires a successful settled start before reconciling a successor generation", async () => {
		const f = await fixture();
		f.physical.startSettled.mockResolvedValue("failed");
		await f.stopped();
		await expect(
			f.guard.archive(f.input.permit.permitId, {
				...f.closed(),
				generation: 2,
				reservationId: randomUUID(),
				physicalId: f.input.machine.physicalInstanceId,
				guestBootId: randomUUID(),
				issuedAt: "2026-09-25T12:04:00.000Z",
				deadline: "2026-09-25T12:09:30.000Z",
			}),
		).rejects.toThrow();
		await f.guard.archive(f.input.permit.permitId, f.closed());
	});
	it("pins a previously bound guest and requires terminal custody before successor reconciliation", async () => {
		const f = await fixture();
		await f.guard.arm(f.input);
		await f.guard.start(f.input.permit.permitId, 1);
		const bound: PaidComputerPermit = {
			...f.input.permit,
			state: "bound",
			physicalId: f.input.machine.physicalInstanceId,
			guestBootId: randomUUID(),
		};
		const running = await f.guard.arm({ ...f.input, permit: bound });
		const successor: PaidComputerPermit = {
			...bound,
			state: "closed",
			generation: 2,
			reservationId: randomUUID(),
			issuedAt: "2026-09-25T12:04:00.000Z",
			deadline: "2026-09-25T12:09:30.000Z",
			validForMs: 0,
		};
		expect(() => assertPaidComputerTerminalPermit(running, successor)).toThrow();
		await f.guard.stop(bound.permitId);
		await expect(f.guard.archive(bound.permitId, { ...successor, guestBootId: randomUUID() })).rejects.toThrow();
		await f.guard.archive(bound.permitId, successor);
	});
	it("exposes archival and retained ownership through the private guard IPC", async () => {
		const f = await fixture(),
			controller = new AbortController(),
			report = vi.fn();
		const socketPath = join(f.journalRoot, "guard.sock"),
			serverGuard = f.restart();
		const serving = servePaidComputerGuard({ guard: serverGuard, socketPath, signal: controller.signal, report });
		await vi.waitFor(() => expect(report).toHaveBeenCalledWith("ready"));
		const client = new PaidComputerGuardClient(socketPath);
		try {
			await client.arm(f.input);
			const stopped = await client.stop(f.input.permit.permitId);
			await client.archive(f.input.permit.permitId, f.closed());
			expect(await client.hasHistory(f.input.permit.allocationId)).toBe(true);
			expect(await client.list()).toEqual([]);
			expect(await client.listPrestarts()).toEqual([]);
			expect(await client.status(f.input.permit.permitId)).toEqual(stopped);
			await expect(client.start(f.input.permit.permitId, 1)).rejects.toThrow();
		} finally {
			controller.abort();
			await serving;
		}
		expect(f.physical.start).not.toHaveBeenCalled();
	});

	it("keeps exact direct recovery evidence while removing settled records from active enumeration", async () => {
		const f = await fixture(),
			stopped = await f.stopped();
		const prestart = await f.guard.prestartStatus(f.input.permit.permitId);
		await f.guard.archive(f.input.permit.permitId, f.closed());
		expect(await f.guard.list()).toEqual([]);
		expect(await f.guard.listPrestarts()).toEqual([]);
		expect(await f.guard.status(f.input.permit.permitId)).toEqual(stopped);
		expect(await f.guard.prestartStatus(f.input.permit.permitId)).toEqual(prestart);
		expect(await f.guard.latest(f.input.permit.allocationId)).toEqual(stopped);
		expect(await f.guard.hasHistory(f.input.permit.allocationId)).toBe(true);
		const restarted = f.restart();
		await restarted.initialize();
		expect(await restarted.status(f.input.permit.permitId)).toEqual(stopped);
		expect(await restarted.prestartStatus(f.input.permit.permitId)).toEqual(prestart);
		expect(await restarted.latest(f.input.permit.allocationId)).toEqual(stopped);
		await restarted.archive(f.input.permit.permitId, f.closed());
		await expect(restarted.registerPrestart(f.prestart.intent)).rejects.toThrow();
		await expect(restarted.arm(f.input)).rejects.toThrow();
		await expect(restarted.start(f.input.permit.permitId, 1)).rejects.toThrow();
		expect(await restarted.stop(f.input.permit.permitId)).toEqual(stopped);
		await restarted.sweep();
		expect(f.physical.start).toHaveBeenCalledOnce();
		expect(f.physical.stop).toHaveBeenCalledOnce();
	});

	it("retains abandoned commands and allocation ownership even when no physical guard ever existed", async () => {
		const f = await fixture(),
			cancelled = await f.guard.abandonPrestart(f.prestart.intent);
		await f.guard.archive(f.input.permit.permitId, abandonment(cancelled));
		const restarted = f.restart();
		await restarted.initialize();
		expect(await restarted.listPrestarts()).toEqual([]);
		expect(await restarted.prestartStatus(f.input.permit.permitId)).toEqual(cancelled);
		expect(await restarted.abandonPrestart(f.prestart.intent)).toEqual(cancelled);
		expect(await restarted.hasHistory(f.input.permit.allocationId)).toBe(true);
		expect(await restarted.hasHistory(randomUUID())).toBe(false);
		await expect(restarted.arm(f.input)).rejects.toThrow();
		await expect(restarted.start(f.input.permit.permitId, 1)).rejects.toThrow();
		expect(f.physical.inspect).not.toHaveBeenCalled();
	});

	it("refuses missing SQL acknowledgement and changed terminal identity", async () => {
		const f = await fixture();
		await f.stopped();
		for (const receipt of [
			null,
			{},
			{ ...f.closed(), state: "bound" },
			{ ...f.closed(), permitId: randomUUID() },
			{ ...f.closed(), allocationId: randomUUID() },
			{ ...f.closed(), epoch: randomUUID() },
			{ ...f.closed(), reservationId: randomUUID() },
			{ ...f.closed(), generation: 2 },
			{ ...f.closed(), hostBootId: randomUUID() },
			{ ...f.closed(), cpuMillis: 8000 },
			{ ...f.closed(), prestart: { ...f.input.permit.prestart, guardIncarnationId: randomUUID() } },
		]) {
			await expect(f.guard.archive(f.input.permit.permitId, receipt)).rejects.toThrow();
		}
		expect(await f.guard.list()).toHaveLength(1);
		await f.guard.archive(f.input.permit.permitId, f.closed());
		await expect(
			f.guard.archive(f.input.permit.permitId, { ...f.closed(), reservationId: randomUUID() }),
		).rejects.toThrow();
	});

	it("accepts SQL binding learned after arm but rejects a different physical machine", async () => {
		const f = await fixture();
		await f.stopped();
		await expect(
			f.guard.archive(f.input.permit.permitId, {
				...f.closed(),
				guestBootId: randomUUID(),
				physicalId: randomUUID(),
			}),
		).rejects.toThrow();
		await f.guard.archive(f.input.permit.permitId, {
			...f.closed(),
			guestBootId: randomUUID(),
			physicalId: f.input.machine.physicalInstanceId,
		});
		expect(await f.guard.list()).toEqual([]);
	});

	it("reads only the newest archived guard when recovering an allocation with repeated use", async () => {
		const f = await fixture();
		let newest = f.input.permit.permitId;
		for (let index = 0; index < 3; index++) {
			const input = structuredClone(f.input);
			if (index > 0) {
				const permitId = randomUUID(),
					prepareRequestText = JSON.stringify({
						...JSON.parse(f.prestart.intent.prepareRequestText),
						requestId: permitId,
					});
				const prestart = await f.guard.registerPrestart({
					...f.prestart.intent,
					permitId,
					prepareRequestText,
					prepareSha256: createHash("sha256").update(prepareRequestText).digest("hex"),
				});
				input.permit.permitId = permitId;
				input.permit.prestart = {
					guardIncarnationId: prestart.guardIncarnationId,
					prepareSha256: prestart.intent.prepareSha256,
				};
				input.permit.issuedAt = new Date(Date.parse(input.permit.issuedAt) + index * 600000).toISOString();
				input.permit.deadline = new Date(Date.parse(input.permit.deadline) + index * 600000).toISOString();
			}
			await f.guard.arm(input);
			await f.guard.stop(input.permit.permitId);
			await f.guard.archive(input.permit.permitId, { ...input.permit, state: "closed", validForMs: 0 });
			newest = input.permit.permitId;
		}
		const restarted = f.restart();
		await restarted.initialize();
		const read = vi.spyOn(f.journal, "readArchive");
		expect((await restarted.latest(f.input.permit.allocationId))?.permit.permitId).toBe(newest);
		expect(read).toHaveBeenCalledExactlyOnceWith(3);
	});

	it("refuses registered, running and unresolved-dispatch custody despite an apparent SQL closure", async () => {
		const f = await fixture();
		await expect(f.guard.archive(f.input.permit.permitId, f.closed())).rejects.toThrow();
		await f.guard.arm(f.input);
		await expect(f.guard.archive(f.input.permit.permitId, f.closed())).rejects.toThrow();
		f.physical.start.mockRejectedValueOnce(new Error("lost start reply"));
		await expect(f.guard.start(f.input.permit.permitId, 1)).rejects.toThrow("lost start reply");
		await expect(f.guard.archive(f.input.permit.permitId, f.closed())).rejects.toThrow();
		expect((await f.guard.status(f.input.permit.permitId)).phase).toBe("stopping");
	});

	it("requires the exact zero-debit abandonment acknowledgement", async () => {
		const f = await fixture(),
			cancelled = await f.guard.abandonPrestart(f.prestart.intent),
			closure = abandonment(cancelled);
		for (const receipt of [
			{ ...closure, debitedUs: "1" },
			{ ...closure, permitId: randomUUID() },
			{ ...closure, abandonment: { ...cancelled.abandonment, prepareSha256: "c".repeat(64) } },
		])
			await expect(f.guard.archive(f.input.permit.permitId, receipt)).rejects.toThrow();
		expect(await f.guard.listPrestarts()).toHaveLength(1);
	});

	it("keeps an abandoned armed guard in stop custody until its physical stop is confirmed", async () => {
		const f = await fixture();
		await f.guard.arm(f.input);
		const cancelled = await f.guard.abandonPrestart(f.prestart.intent),
			receipt = abandonment(cancelled);
		await expect(f.guard.archive(f.input.permit.permitId, receipt)).rejects.toThrow();
		expect(await f.guard.list()).toHaveLength(1);
		await f.guard.stop(f.input.permit.permitId);
		await f.guard.archive(f.input.permit.permitId, receipt);
		expect(await f.guard.list()).toEqual([]);
		expect((await f.guard.status(f.input.permit.permitId)).phase).toBe("stopped");
		expect(f.physical.start).not.toHaveBeenCalled();
	});

	it("accepts exact post-anchor physical leftovers but rejects conflicting duplicates", async () => {
		const f = await fixture();
		await f.stopped();
		const path = join(f.journalRoot, `${f.input.permit.permitId}.json`),
			bytes = await readFile(path);
		await f.guard.archive(f.input.permit.permitId, f.closed());
		await writeFile(path, bytes, { mode: 0o600 });
		const restarted = f.restart();
		await restarted.initialize();
		expect(await restarted.list()).toEqual([]);
		const changed = JSON.parse(bytes.toString("utf8"));
		changed.stopReceipt.operationId = randomUUID();
		await writeFile(path, JSON.stringify(changed), { mode: 0o600 });
		await expect(f.restart().initialize()).rejects.toThrow();
	});

	it("validates the complete archive before removing any physical recovery leftovers", async () => {
		const f = await fixture();
		await f.stopped();
		const path = join(f.journalRoot, `${f.input.permit.permitId}.json`),
			bytes = await readFile(path);
		await f.guard.archive(f.input.permit.permitId, f.closed());
		const permitId = randomUUID(),
			prepareRequestText = JSON.stringify({
				...JSON.parse(f.prestart.intent.prepareRequestText),
				requestId: permitId,
			});
		const next = await f.guard.registerPrestart({
			...f.prestart.intent,
			permitId,
			prepareRequestText,
			prepareSha256: createHash("sha256").update(prepareRequestText).digest("hex"),
		});
		const cancelled = await f.guard.abandonPrestart(next.intent);
		await f.guard.archive(permitId, abandonment(cancelled));
		await writeFile(path, bytes, { mode: 0o600 });
		await writeFile(join(f.journalRoot, "archive", "0000000000000002.json"), "{}", { mode: 0o600 });
		await expect(f.restart().initialize()).rejects.toThrow();
		expect(await readFile(path)).toEqual(bytes);
	});

	it.each(["missing", "corrupt"])("fails closed if an anchored archive record is %s", async (mode) => {
		const f = await fixture();
		await f.stopped();
		await f.guard.archive(f.input.permit.permitId, f.closed());
		const directory = join(f.journalRoot, "archive"),
			names = await readdir(directory);
		expect(names.length).toBeGreaterThan(0);
		const path = join(directory, names[0]);
		if (mode === "missing") await unlink(path);
		else await writeFile(path, "{}", { mode: 0o600 });
		await expect(f.restart().initialize()).rejects.toThrow();
	});

	it("refuses a missing anchor instead of treating retained archives as a new guard", async () => {
		const f = await fixture();
		await f.stopped();
		await f.guard.archive(f.input.permit.permitId, f.closed());
		await unlink(join(f.journalRoot, "prestarts.json"));
		await expect(f.restart().initialize()).rejects.toThrow();
	});

	it("recovers a committed archive whose anchor acknowledgement was lost without reopening admission", async () => {
		const f = await fixture();
		await f.stopped();
		const save = f.journal.savePrestarts.bind(f.journal);
		vi.spyOn(f.journal, "savePrestarts").mockImplementationOnce(async (value) => {
			await save(value);
			throw new Error("anchor fsync reply lost");
		});
		await expect(f.guard.archive(f.input.permit.permitId, f.closed())).rejects.toThrow();
		await expect(f.guard.registerPrestart(f.prestart.intent)).rejects.toThrow();
		const restarted = f.restart();
		await restarted.initialize();
		await restarted.archive(f.input.permit.permitId, f.closed());
		expect(await restarted.listPrestarts()).toEqual([]);
		expect(await restarted.hasHistory(f.input.permit.allocationId)).toBe(true);
		await expect(restarted.start(f.input.permit.permitId, 1)).rejects.toThrow();
	});

	it("recovers an archive append interrupted before the anchor and retains the original terminal proof", async () => {
		const f = await fixture(),
			stopped = await f.stopped();
		vi.spyOn(f.journal, "savePrestarts").mockRejectedValueOnce(new Error("anchor write unavailable"));
		await expect(f.guard.archive(f.input.permit.permitId, f.closed())).rejects.toThrow();
		const restarted = f.restart();
		await restarted.initialize();
		expect(await restarted.status(f.input.permit.permitId)).toEqual(stopped);
		await expect(restarted.start(f.input.permit.permitId, 1)).rejects.toThrow();
		await restarted.archive(f.input.permit.permitId, f.closed());
		expect(await restarted.listPrestarts()).toEqual([]);
		expect(await restarted.list()).toEqual([]);
		expect(f.physical.start).toHaveBeenCalledOnce();
		expect(f.physical.stop).toHaveBeenCalledOnce();
	});

	it("recovers an immutable append whose durability acknowledgement is lost", async () => {
		const f = await fixture();
		await f.stopped();
		const append = f.journal.appendArchive.bind(f.journal);
		vi.spyOn(f.journal, "appendArchive").mockImplementationOnce(async (value) => {
			await append(value);
			throw new Error("archive directory fsync reply lost");
		});
		await expect(f.guard.archive(f.input.permit.permitId, f.closed())).rejects.toThrow();
		await expect(f.guard.start(f.input.permit.permitId, 1)).rejects.toThrow();
		const restarted = f.restart();
		await restarted.initialize();
		await restarted.archive(f.input.permit.permitId, f.closed());
		expect(await restarted.list()).toEqual([]);
		expect(await restarted.hasHistory(f.input.permit.allocationId)).toBe(true);
		expect(f.physical.start).toHaveBeenCalledOnce();
	});

	it("ignores an interrupted private temporary file without manufacturing an archive fence", async () => {
		const f = await fixture(),
			directory = join(f.journalRoot, "archive"),
			forged = randomUUID();
		await mkdir(directory, { mode: 0o700, recursive: true });
		await writeFile(join(directory, `.write-${randomUUID()}`), `{"permitId":"${forged}","partial":`, { mode: 0o600 });
		const restarted = f.restart();
		await restarted.initialize();
		expect(await restarted.prestartStatus(forged)).toBeNull();
		expect(await restarted.prestartStatus(f.input.permit.permitId)).toEqual(f.prestart);
		const cancelled = await restarted.abandonPrestart(f.prestart.intent);
		await restarted.archive(f.input.permit.permitId, abandonment(cancelled));
		const again = f.restart();
		await again.initialize();
		expect(await again.prestartStatus(forged)).toBeNull();
		expect(await again.prestartStatus(f.input.permit.permitId)).toEqual(cancelled);
		expect(await again.listPrestarts()).toEqual([]);
	});

	it("retains exact deny history beyond the active-record limit while admitting new work", async () => {
		const f = await fixture(),
			directory = join(f.journalRoot, "archive");
		await mkdir(directory, { mode: 0o700, recursive: true });
		let previousSha256: string | null = null;
		const retained: PaidComputerPrestartRecord[] = [];
		for (let sequence = 1; sequence <= 4097; sequence++) {
			const permitId = randomUUID(),
				prepareRequestText = JSON.stringify({
					...JSON.parse(f.prestart.intent.prepareRequestText),
					requestId: permitId,
				});
			const intent = {
				...f.prestart.intent,
				permitId,
				prepareRequestText,
				prepareSha256: createHash("sha256").update(prepareRequestText).digest("hex"),
			};
			const { schema: _schema, prepareRequestText: _request, ...identity } = intent;
			const prestart: PaidComputerPrestartRecord = {
				...f.prestart,
				intent,
				state: "abandoned",
				abandonment: {
					schema: "qorpera.computer-prestart-abandonment/v1",
					...identity,
					guardIncarnationId: f.prestart.guardIncarnationId,
				},
			};
			const bytes: string = `${JSON.stringify({
				schema: "qorpera.computer-guard-archive/v1",
				sequence,
				previousSha256,
				prestart,
				guard: null,
				closure: abandonment(prestart),
			})}\n`;
			await writeFile(join(directory, `${String(sequence).padStart(16, "0")}.json`), bytes, { mode: 0o600 });
			previousSha256 = createHash("sha256").update(bytes).digest("hex");
			if (sequence === 1 || sequence === 4097) retained.push(prestart);
		}
		await writeFile(
			join(f.journalRoot, "prestarts.json"),
			JSON.stringify({
				schema: "qorpera.computer-prestart-journal/v2",
				guardIncarnationId: f.prestart.guardIncarnationId,
				records: [],
				archiveCount: 4097,
				archiveHeadSha256: previousSha256,
			}),
			{ mode: 0o600 },
		);
		const restarted = f.restart();
		await restarted.initialize();
		expect(await restarted.listPrestarts()).toEqual([]);
		for (const prestart of retained) {
			expect(await restarted.prestartStatus(prestart.intent.permitId)).toEqual(prestart);
			await expect(restarted.registerPrestart(prestart.intent)).rejects.toThrow();
			await expect(restarted.start(prestart.intent.permitId, 1)).rejects.toThrow();
		}
		expect(await restarted.hasHistory(f.input.permit.allocationId)).toBe(true);
		expect((await restarted.registerPrestart(f.prestart.intent)).state).toBe("registered");
		expect(await restarted.listPrestarts()).toHaveLength(1);
		expect(f.physical.start).not.toHaveBeenCalled();
	}, 60000);
});
