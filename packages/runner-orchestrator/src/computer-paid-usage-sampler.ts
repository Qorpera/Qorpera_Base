import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { PaidComputerGuardRecord, PaidComputerHostClock, PaidComputerMachine } from "./computer-paid-guard.ts";
import type {
	PaidComputerUsageCursor,
	PaidComputerUsageEntry,
	PaidComputerUsagePage,
	PaidComputerUsageReadOptions,
	PaidComputerUsageSample,
} from "./computer-paid-usage.ts";
import { PaidComputerUsageJournal } from "./computer-paid-usage-journal.ts";

export interface PaidComputerUsageCapture {
	capture(
		machine: PaidComputerMachine,
		signal: AbortSignal,
	): Promise<{
		host: PaidComputerHostClock;
		guestBootId: string;
		guestUptimeMs: number;
		evidenceSha256: string;
		observedAt: string;
	}>;
}
interface Stream {
	journal: PaidComputerUsageJournal;
	restarting: boolean;
	pending?: Promise<void>;
	failed: boolean;
	nextAt: number;
	lastRunning: PaidComputerUsageSample | null;
	consecutiveFailures: number;
	renewable: boolean;
	closing: boolean;
	watchdog?: Promise<void>;
	finalCapture?: {
		record: PaidComputerGuardRecord;
		capture: Awaited<ReturnType<PaidComputerUsageCapture["capture"]>>;
	};
}
/** Independent, DB-free writer. A slow capture or disk cannot hold the physical
 * stop serializer; failures revoke new sampling/start authority and request stop. */
export class PaidComputerUsageSampler {
	readonly #root: string;
	readonly #capture: PaidComputerUsageCapture;
	readonly #clock: () => Promise<PaidComputerHostClock>;
	readonly #record: (permitId: string) => Promise<PaidComputerGuardRecord>;
	readonly #failed: (permitId: string) => Promise<void>;
	readonly #streams = new Map<string, Stream>();
	readonly #initializing = new Map<string, Promise<void>>();
	constructor(
		root: string,
		capture: PaidComputerUsageCapture,
		clock: () => Promise<PaidComputerHostClock>,
		record: (permitId: string) => Promise<PaidComputerGuardRecord>,
		failed: (permitId: string) => Promise<void>,
	) {
		this.#root = root;
		this.#capture = capture;
		this.#clock = clock;
		this.#record = record;
		this.#failed = failed;
	}
	async initialize(record: PaidComputerGuardRecord, create: boolean): Promise<void> {
		const pending = this.#initializing.get(record.permit.permitId);
		if (pending) {
			if (create) throw new Error("PAID_USAGE_ALREADY_INITIALIZED");
			return pending;
		}
		const work = this.#initialize(record, create).finally(() => this.#initializing.delete(record.permit.permitId));
		this.#initializing.set(record.permit.permitId, work);
		return work;
	}
	async #initialize(record: PaidComputerGuardRecord, create: boolean): Promise<void> {
		if (this.#streams.has(record.permit.permitId)) {
			if (create) throw new Error("PAID_USAGE_ALREADY_INITIALIZED");
			return;
		}
		const journal = new PaidComputerUsageJournal(join(this.#root, `usage-${record.permit.permitId}`));
		await journal.initialize(record, create);
		const latest = await journal.latest();
		this.#streams.set(record.permit.permitId, {
			journal,
			restarting: !create && latest !== null && !latest.stopReceipt,
			failed: false,
			nextAt: 0,
			lastRunning: (await journal.lastRunning())?.sample ?? null,
			consecutiveFailures: latest?.sample.state === "gap" ? 1 : 0,
			renewable: latest?.sample.state === "running",
			closing: false,
		});
	}
	#stream(permitId: string): Stream {
		const stream = this.#streams.get(permitId);
		if (!stream) throw new Error("PAID_USAGE_NOT_INITIALIZED");
		if (stream.failed) throw new Error("PAID_USAGE_UNCONFIRMED");
		return stream;
	}
	async preflight(permitId: string): Promise<void> {
		await this.#stream(permitId).journal.read({ limit: 1 });
	}
	assertRenewable(permitId: string, clock: PaidComputerHostClock): void {
		const stream = this.#stream(permitId);
		if (
			!stream.renewable ||
			stream.restarting ||
			stream.closing ||
			!stream.lastRunning ||
			clock.hostBootId !== stream.lastRunning.hostBootId ||
			clock.uptimeMs - stream.lastRunning.hostUptimeMs > 10000
		)
			throw new Error("PAID_GUARD_USAGE_GAP");
	}
	async assertReady(permitId: string): Promise<void> {
		this.#stream(permitId).journal.assertReady();
	}
	async read(permitId: string, options: PaidComputerUsageReadOptions = {}): Promise<PaidComputerUsagePage> {
		const record = await this.#record(permitId);
		return this.#stream(permitId).journal.read(options, record.phase === "stopping" || record.phase === "stopped");
	}
	async acknowledge(permitId: string, cursor: PaidComputerUsageCursor): Promise<PaidComputerUsageCursor> {
		return this.#stream(permitId).journal.acknowledge(cursor);
	}
	async assertDrained(permitId: string): Promise<void> {
		const page = await this.#stream(permitId).journal.read();
		if (
			page.state !== "sealed" ||
			page.head.sequence !== page.acknowledgedThrough.sequence ||
			page.head.sha256 !== page.acknowledgedThrough.sha256
		)
			throw new Error("PAID_USAGE_NOT_DRAINED");
	}
	forget(permitId: string): void {
		this.#streams.delete(permitId);
	}
	async #close(record: PaidComputerGuardRecord, stream: Stream): Promise<void> {
		if (stream.closing) return;
		stream.closing = true;
		stream.renewable = false;
		await this.#failed(record.permit.permitId).catch(() => undefined);
	}
	/** At most one transient capture failure is tolerated after a known running
	 * pair. An independent host-uptime deadline also closes stalled capture I/O;
	 * no gap is inferred as billable and no unresolved gap permits renewal. */
	#watch(record: PaidComputerGuardRecord, stream: Stream): void {
		if (
			!stream.lastRunning ||
			stream.watchdog ||
			stream.closing ||
			stream.failed ||
			record.phase === "stopped" ||
			record.phase === "stopping"
		)
			return;
		const work = this.#clock()
			.then(async (clock) => {
				if (clock.hostMachineIdSha256 !== record.machine.hostMachineIdSha256) {
					stream.failed = true;
					stream.renewable = false;
					return;
				}
				if (
					clock.hostBootId !== stream.lastRunning?.hostBootId ||
					clock.uptimeMs - stream.lastRunning.hostUptimeMs > 10000
				)
					await this.#close(record, stream);
			})
			.catch(() => this.#close(record, stream))
			.finally(() => {
				if (stream.watchdog === work) stream.watchdog = undefined;
			});
		stream.watchdog = work;
	}
	/** Starts independent work, never waits for guest or filesystem I/O. */
	tick(records: readonly PaidComputerGuardRecord[]): void {
		for (const record of records) {
			const stream = this.#streams.get(record.permit.permitId);
			if (stream) this.#watch(record, stream);
			if (
				!stream ||
				stream.pending ||
				stream.failed ||
				(stream.closing && record.phase !== "stopped") ||
				(!record.startDispatched && record.phase !== "stopped") ||
				(record.phase !== "stopped" && performance.now() < stream.nextAt)
			)
				continue;
			// Booting guests can expose their first trustworthy clock between ticks.
			// Retry that initial observation promptly; established streams stay at 5s.
			stream.nextAt = performance.now() + (stream.lastRunning ? 5000 : 1000);
			const work = this.#collect(record, stream)
				.catch(async () => {
					stream.failed = true;
					await this.#failed(record.permit.permitId).catch(() => undefined);
				})
				.finally(() => {
					if (stream.pending === work) stream.pending = undefined;
				});
			stream.pending = work;
		}
	}
	async settled(permitId: string): Promise<void> {
		await this.#streams.get(permitId)?.pending;
		await this.#streams.get(permitId)?.watchdog;
	}
	async #append(
		record: PaidComputerGuardRecord,
		stream: Stream,
		value: Omit<PaidComputerUsageSample, "observationId" | "previousObservationId">,
	): Promise<void> {
		const previous = await stream.journal.latest();
		const entry: PaidComputerUsageEntry = {
			schema: "qorpera.computer-guard-usage-entry/v1",
			sequence: (previous?.sequence ?? 0) + 1,
			previousSha256: (await stream.journal.read({ afterSequence: previous?.sequence ?? 0, limit: 1 })).head.sha256,
			permit: record.permit,
			hostMachineIdSha256: record.machine.hostMachineIdSha256,
			physicalInstanceId: record.machine.physicalInstanceId,
			deadlineUptimeMs: record.deadlineUptimeMs,
			stopAtUptimeMs: record.stopAtUptimeMs,
			sample: {
				observationId: randomUUID(),
				previousObservationId: previous?.sample.observationId ?? null,
				...value,
			},
			stopReceipt: value.state === "stopped" || value.state === "absent" ? record.stopReceipt : null,
		};
		await stream.journal.append(entry);
		stream.renewable = value.state === "running";
		if (value.state === "running") {
			if (!stream.lastRunning) stream.nextAt = performance.now() + 5000;
			stream.lastRunning = entry.sample;
			stream.consecutiveFailures = 0;
		}
	}
	async #gap(record: PaidComputerGuardRecord, stream: Stream, reason: string): Promise<void> {
		const host = await this.#clock();
		const observedAt = new Date().toISOString();
		const current = await this.#record(record.permit.permitId);
		if (stream.failed || current.phase === "stopping" || current.phase === "stopped") return;
		if (
			host.hostMachineIdSha256 !== record.machine.hostMachineIdSha256 ||
			host.hostBootId !== record.machine.hostBootId ||
			host.uptimeMs > record.deadlineUptimeMs
		)
			return;
		await this.#append(record, stream, {
			hostBootId: host.hostBootId,
			hostUptimeMs: host.uptimeMs,
			physicalId: record.machine.physicalInstanceId,
			guestBootId: (await stream.journal.latest())?.sample.guestBootId ?? record.permit.guestBootId,
			guestUptimeMs: null,
			observedAt,
			state: "gap",
			evidenceSha256: createHash("sha256")
				.update(JSON.stringify({ reason, permitId: record.permit.permitId, host }))
				.digest("hex"),
		});
	}
	async #collect(record: PaidComputerGuardRecord, stream: Stream): Promise<void> {
		let previous = await stream.journal.latest();
		if (previous?.stopReceipt) return;
		if (record.phase === "stopped") {
			const receipt = record.stopReceipt;
			if (!receipt) throw new Error("PAID_USAGE_STOP_PROOF_MISSING");
			const finalCapture = stream.finalCapture;
			if (
				finalCapture &&
				finalCapture.capture.host.hostBootId === receipt.closedHostBootId &&
				finalCapture.capture.host.uptimeMs < receipt.observedUptimeMs
			) {
				await this.#appendCapture(finalCapture.record, stream, finalCapture.capture);
				previous = await stream.journal.latest();
			}
			stream.finalCapture = undefined;
			await this.#append(record, stream, {
				hostBootId: receipt.closedHostBootId,
				hostUptimeMs: receipt.closedAtUptimeMs,
				physicalId: record.machine.physicalInstanceId,
				guestBootId: previous?.sample.guestBootId ?? record.permit.guestBootId,
				guestUptimeMs: null,
				observedAt: new Date().toISOString(),
				state: receipt.state,
				evidenceSha256: createHash("sha256").update(JSON.stringify(receipt)).digest("hex"),
			});
			return;
		}
		if (record.phase === "stopping") return;
		if (stream.restarting) {
			await this.#gap(record, stream, "collector_restart");
			stream.restarting = false;
		}
		let capture: Awaited<ReturnType<PaidComputerUsageCapture["capture"]>>;
		try {
			capture = await this.#capture.capture(record.machine, AbortSignal.timeout(5000));
		} catch {
			if (stream.failed) return;
			const current = await this.#record(record.permit.permitId);
			if (current.phase !== "stopping" && current.phase !== "stopped") {
				stream.renewable = false;
				stream.consecutiveFailures++;
				await this.#gap(record, stream, "clock_unconfirmed");
				// A slow first failure must not consume the next entire 5s cadence
				// before retrying. The independent 10s host deadline is unchanged.
				if (stream.lastRunning && stream.consecutiveFailures === 1)
					stream.nextAt = Math.min(stream.nextAt, performance.now() + 1000);
				if (stream.lastRunning && stream.consecutiveFailures >= 2) await this.#close(record, stream);
			}
			return;
		}
		const current = await this.#record(record.permit.permitId);
		if (stream.failed) return;
		if (
			capture.host.hostMachineIdSha256 !== record.machine.hostMachineIdSha256 ||
			capture.host.hostBootId !== record.machine.hostBootId ||
			capture.host.uptimeMs > record.deadlineUptimeMs
		)
			return;
		if (current.phase === "stopping" || current.phase === "stopped") {
			// Stop never waits for capture or journal I/O. Retain at most one actual
			// paired observation, then order it against confirmed physical stop proof
			// before publishing it. Late and other-boot observations are discarded.
			stream.finalCapture = { record, capture: structuredClone(capture) };
			return;
		}
		await this.#appendCapture(record, stream, capture);
	}
	async #appendCapture(
		record: PaidComputerGuardRecord,
		stream: Stream,
		capture: Awaited<ReturnType<PaidComputerUsageCapture["capture"]>>,
	): Promise<void> {
		await this.#append(record, stream, {
			hostBootId: capture.host.hostBootId,
			hostUptimeMs: capture.host.uptimeMs,
			physicalId: record.machine.physicalInstanceId,
			guestBootId: capture.guestBootId,
			guestUptimeMs: capture.guestUptimeMs,
			observedAt: capture.observedAt,
			state: "running",
			evidenceSha256: capture.evidenceSha256,
		});
	}
}
