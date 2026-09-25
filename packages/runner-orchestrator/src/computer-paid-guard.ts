import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, rename, statfs, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseCloudCodingNasPolicy } from "@qorpera/contracts";
import { type CodingMachineStorage, type LxdCodingMachineBinding, lxdCodingMachinePlan } from "./coding-machine.ts";
import type { LxdOperationReference } from "./lxd-client.ts";
import { checkDirectory, code, readRecord, syncDirectory } from "./lxd-office-journal-files.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
export const PAID_COMPUTER_WINDOW_MS = 300_000;
export const PAID_COMPUTER_STOP_RESERVE_MS = 30_000;
const MAX_RECORDS = 4096;

export interface PaidComputerHostClock {
	hostMachineIdSha256: string;
	hostBootId: string;
	uptimeMs: number;
}
export interface PaidComputerMachine {
	allocationId: string;
	nodeId: string;
	binding: Readonly<LxdCodingMachineBinding>;
	storage: CodingMachineStorage;
	physicalInstanceId: string;
	hostMachineIdSha256: string;
	hostBootId: string;
}
/** Projection of a confirmed kernel receipt, never authority supplied by a
 * member or guest. The trusted executor validates the originating RPC. */
export interface PaidComputerPermit {
	schema: "qorpera.computer-usage-permit/v1";
	mode: "paid";
	permitId: string;
	allocationId: string;
	instanceSha256: string;
	nodeId: string;
	epoch: string;
	generation: number;
	reservationId: string;
	hostBootId: string;
	guestBootId: string | null;
	physicalId: string | null;
	issuedAt: string;
	state: "prepared" | "bound" | "closed";
	deadline: string;
	validForMs: number;
	windowMs: number;
	stopReserveMs: number;
	tariffVersion: number;
	cpuMillis: number;
	memoryBytes: number;
}
export interface PaidComputerArm {
	machine: PaidComputerMachine;
	permit: PaidComputerPermit;
	/** Same host boot clock, sampled BEFORE requesting the kernel receipt. */
	requestStartedUptimeMs: number;
}
export interface PaidComputerStopReceipt {
	permitId: string;
	generation: number;
	allocationId: string;
	instanceSha256: string;
	physicalInstanceId: string;
	hostBootId: string;
	observedUptimeMs: number;
	closedAtUptimeMs: number;
	closedHostBootId: string;
	state: "stopped" | "absent";
	operationId: string | null;
}
export interface PaidComputerGuardRecord {
	schema: "qorpera.paid-computer-guard/v1";
	machine: PaidComputerMachine;
	permit: PaidComputerPermit;
	deadlineUptimeMs: number;
	stopAtUptimeMs: number;
	phase: "armed" | "starting" | "running" | "stopping" | "stopped";
	/** Set durably before sending start. Null reference after a crash or lost
	 * reply is an unresolved effect; it NEVER permits a stopped receipt. */
	startDispatched: boolean;
	startReference: LxdOperationReference | null;
	startSettled: boolean;
	startSucceeded: boolean | null;
	stopReference: LxdOperationReference | null;
	stopReceipt: PaidComputerStopReceipt | null;
}
export interface PaidComputerGuardPhysical {
	inspect(machine: PaidComputerMachine, signal: AbortSignal): Promise<"running" | "stopped" | "absent" | "other">;
	start(machine: PaidComputerMachine, stopAtUptimeMs: number, signal: AbortSignal): Promise<LxdOperationReference>;
	startSettled(reference: LxdOperationReference, signal: AbortSignal): Promise<"pending" | "succeeded" | "failed">;
	stop(machine: PaidComputerMachine, signal: AbortSignal): Promise<LxdOperationReference>;
}
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("PAID_GUARD_INVALID");
	return value as Record<string, unknown>;
}
function integer(value: unknown, minimum = 0): number {
	if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error("PAID_GUARD_INVALID");
	return Number(value);
}
function id(value: unknown, pattern = UUID): string {
	if (typeof value !== "string" || !pattern.test(value)) throw new Error("PAID_GUARD_INVALID");
	return value;
}
function parseMachine(value: unknown): PaidComputerMachine {
	const m = record(value);
	const binding = lxdCodingMachinePlan(m.binding as LxdCodingMachineBinding).binding;
	const storage = record(m.storage);
	const hostMachineIdSha256 = id(m.hostMachineIdSha256, SHA);
	if (storage.machineIdSha256 !== hostMachineIdSha256) throw new Error("PAID_GUARD_HOST_DIFFERS");
	return {
		allocationId: id(m.allocationId),
		nodeId: id(m.nodeId),
		binding,
		storage: { policy: parseCloudCodingNasPolicy(storage.policy), machineIdSha256: hostMachineIdSha256 },
		physicalInstanceId: id(m.physicalInstanceId),
		hostMachineIdSha256,
		hostBootId: id(m.hostBootId),
	};
}
export function parsePaidComputerPermit(value: unknown): PaidComputerPermit {
	const p = record(value);
	if (
		p.schema !== "qorpera.computer-usage-permit/v1" ||
		p.mode !== "paid" ||
		typeof p.deadline !== "string" ||
		!Number.isFinite(Date.parse(p.deadline)) ||
		typeof p.issuedAt !== "string" ||
		!Number.isFinite(Date.parse(p.issuedAt)) ||
		Date.parse(p.deadline) <= Date.parse(p.issuedAt) ||
		!["prepared", "bound", "closed"].includes(String(p.state)) ||
		p.windowMs !== PAID_COMPUTER_WINDOW_MS ||
		p.stopReserveMs !== PAID_COMPUTER_STOP_RESERVE_MS ||
		integer(p.validForMs) > PAID_COMPUTER_WINDOW_MS + PAID_COMPUTER_STOP_RESERVE_MS ||
		Date.parse(p.deadline) - Date.parse(p.issuedAt) > PAID_COMPUTER_WINDOW_MS + PAID_COMPUTER_STOP_RESERVE_MS
	)
		throw new Error("PAID_GUARD_PERMIT_INVALID");
	return {
		schema: p.schema,
		mode: p.mode,
		permitId: id(p.permitId),
		allocationId: id(p.allocationId),
		instanceSha256: id(p.instanceSha256, SHA),
		nodeId: id(p.nodeId),
		epoch: id(p.epoch),
		generation: integer(p.generation, 1),
		reservationId: id(p.reservationId),
		hostBootId: id(p.hostBootId),
		guestBootId: p.guestBootId === null ? null : id(p.guestBootId),
		physicalId: p.physicalId === null ? null : id(p.physicalId),
		issuedAt: p.issuedAt,
		state: p.state as PaidComputerPermit["state"],
		deadline: p.deadline,
		validForMs: integer(p.validForMs),
		windowMs: p.windowMs,
		stopReserveMs: p.stopReserveMs,
		tariffVersion: integer(p.tariffVersion, 1),
		cpuMillis: integer(p.cpuMillis, 1),
		memoryBytes: integer(p.memoryBytes, 1),
	};
}
export function parsePaidComputerArm(value: unknown): PaidComputerArm {
	const input = record(value),
		machine = parseMachine(input.machine),
		permit = parsePaidComputerPermit(input.permit);
	const plan = lxdCodingMachinePlan(machine.binding);
	if (
		permit.allocationId !== machine.allocationId ||
		permit.nodeId !== machine.nodeId ||
		permit.instanceSha256 !== plan.instanceSha256 ||
		permit.hostBootId !== machine.hostBootId ||
		(permit.physicalId !== null && permit.physicalId !== machine.physicalInstanceId) ||
		permit.cpuMillis !== machine.binding.cpus * 1000 ||
		permit.memoryBytes !== machine.binding.memoryBytes
	)
		throw new Error("PAID_GUARD_BINDING_DIFFERS");
	return { machine, permit, requestStartedUptimeMs: integer(input.requestStartedUptimeMs) };
}
function reference(value: unknown, machine: PaidComputerMachine): LxdOperationReference {
	const ref = record(value),
		plan = lxdCodingMachinePlan(machine.binding);
	if (ref.project !== machine.binding.project || ref.instanceName !== plan.request.name)
		throw new Error("PAID_GUARD_OPERATION_DIFFERS");
	return { project: ref.project, instanceName: ref.instanceName, operationId: id(ref.operationId) };
}
export function parsePaidComputerGuardRecord(value: unknown): PaidComputerGuardRecord {
	const r = record(value),
		machine = parseMachine(r.machine),
		permit = parsePaidComputerPermit(r.permit);
	parsePaidComputerArm({ machine, permit, requestStartedUptimeMs: 0 });
	if (
		r.schema !== "qorpera.paid-computer-guard/v1" ||
		!["armed", "starting", "running", "stopping", "stopped"].includes(String(r.phase)) ||
		typeof r.startDispatched !== "boolean" ||
		typeof r.startSettled !== "boolean" ||
		(r.startSucceeded !== null && typeof r.startSucceeded !== "boolean") ||
		r.startSettled !== (r.startSucceeded !== null) ||
		(r.startSettled && !r.startDispatched) ||
		(r.startReference !== null && !r.startDispatched) ||
		(r.startSettled && r.startReference === null) ||
		(r.phase === "armed" && r.startDispatched) ||
		((r.phase === "starting" || r.phase === "running") && !r.startDispatched) ||
		(r.phase === "running" && r.startReference === null) ||
		(r.phase === "stopped" && r.startDispatched && !r.startSettled) ||
		integer(r.deadlineUptimeMs) - integer(r.stopAtUptimeMs) !== PAID_COMPUTER_STOP_RESERVE_MS ||
		(r.phase === "stopped") !== (r.stopReceipt !== null)
	)
		throw new Error("PAID_GUARD_JOURNAL_INVALID");
	let stopReceipt: PaidComputerStopReceipt | null = null;
	if (r.stopReceipt !== null) {
		const s = record(r.stopReceipt);
		if (
			s.permitId !== permit.permitId ||
			s.generation !== permit.generation ||
			s.allocationId !== machine.allocationId ||
			s.instanceSha256 !== permit.instanceSha256 ||
			s.physicalInstanceId !== machine.physicalInstanceId ||
			s.hostBootId !== machine.hostBootId ||
			(s.state !== "stopped" && s.state !== "absent")
		)
			throw new Error("PAID_GUARD_JOURNAL_INVALID");
		stopReceipt = {
			permitId: permit.permitId,
			generation: permit.generation,
			allocationId: machine.allocationId,
			instanceSha256: permit.instanceSha256,
			physicalInstanceId: machine.physicalInstanceId,
			hostBootId: machine.hostBootId,
			observedUptimeMs: integer(s.observedUptimeMs),
			closedAtUptimeMs: integer(s.closedAtUptimeMs),
			closedHostBootId: id(s.closedHostBootId),
			state: s.state,
			operationId: s.operationId === null ? null : id(s.operationId),
		};
	}
	return {
		schema: r.schema,
		machine,
		permit,
		deadlineUptimeMs: integer(r.deadlineUptimeMs),
		stopAtUptimeMs: integer(r.stopAtUptimeMs),
		phase: r.phase as PaidComputerGuardRecord["phase"],
		startDispatched: r.startDispatched,
		startReference: r.startReference === null ? null : reference(r.startReference, machine),
		startSettled: r.startSettled,
		startSucceeded: r.startSucceeded as boolean | null,
		stopReference: r.stopReference === null ? null : reference(r.stopReference, machine),
		stopReceipt,
	};
}

/** One daemon owns this LOCAL journal. Atomic snapshots are fsynced before any
 * effect or success reply. Systemd must enforce one daemon; this is not an NFS
 * lock or a multi-writer API. Retained terminal records fence old permit replay. */
export class PaidComputerGuardJournal {
	readonly root: string;
	constructor(root: string) {
		if (resolve(root) !== root) throw new Error("PAID_GUARD_JOURNAL_INVALID");
		this.root = root;
	}
	async #directory(): Promise<void> {
		await checkDirectory(this.root);
		// A hard-NFS outage must never occupy stop custody. StateDirectory must
		// be persistent local storage; tmpfs would erase replay fences on reboot.
		if (
			process.platform === "linux" &&
			![0xef53, 0x58465342, 0x9123683e, 0x2fc12fc1, 0x794c7630].includes(
				Number((await statfs(this.root)).type) >>> 0,
			)
		)
			throw new Error("PAID_GUARD_LOCAL_JOURNAL_REQUIRED");
	}
	async load(): Promise<PaidComputerGuardRecord[]> {
		await this.#directory();
		const names = (await readdir(this.root)).filter((name) => name.endsWith(".json"));
		if (names.length > MAX_RECORDS) throw new Error("PAID_GUARD_JOURNAL_FULL");
		const values: PaidComputerGuardRecord[] = [];
		for (const name of names) {
			if (!UUID.test(name.slice(0, -5))) throw new Error("PAID_GUARD_JOURNAL_INVALID");
			const value = parsePaidComputerGuardRecord((await readRecord(join(this.root, name), 32768)).value);
			if (name !== `${value.permit.permitId}.json`) throw new Error("PAID_GUARD_JOURNAL_INVALID");
			values.push(value);
		}
		return values;
	}
	async save(value: PaidComputerGuardRecord): Promise<void> {
		parsePaidComputerGuardRecord(value);
		await this.#directory();
		const temporary = join(this.root, `.write-${randomUUID()}`);
		const file = await open(
			temporary,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
		try {
			await file.writeFile(`${JSON.stringify(value)}\n`);
			await file.sync();
		} finally {
			await file.close();
		}
		try {
			await rename(temporary, join(this.root, `${value.permit.permitId}.json`));
			await syncDirectory(this.root);
		} finally {
			await unlink(temporary).catch((error) => {
				if (!code(error, "ENOENT")) throw error;
			});
		}
	}
}

/** Host-local custody, independent of executor, DB and network availability.
 * Physical calls never occupy the state serializer: expiry may latch stopping
 * even while a start reply is unresolved. Every actual stop remains retriable. */
export class PaidComputerGuard {
	readonly #journal: PaidComputerGuardJournal;
	readonly #physical: PaidComputerGuardPhysical;
	readonly #clock: () => Promise<PaidComputerHostClock>;
	readonly #records = new Map<string, PaidComputerGuardRecord>();
	readonly #stops = new Set<string>();
	readonly #starts = new Map<string, AbortController>();
	#serial: Promise<unknown> = Promise.resolve();
	#loaded = false;
	constructor(
		journal: PaidComputerGuardJournal,
		physical: PaidComputerGuardPhysical,
		clock: () => Promise<PaidComputerHostClock>,
	) {
		this.#journal = journal;
		this.#physical = physical;
		this.#clock = clock;
	}
	async initialize(): Promise<void> {
		if (this.#loaded) throw new Error("PAID_GUARD_ALREADY_INITIALIZED");
		for (const value of await this.#journal.load()) this.#records.set(value.permit.permitId, value);
		this.#loaded = true;
	}
	#exclusive<T>(use: () => Promise<T>): Promise<T> {
		const work = this.#serial
			.catch(() => {})
			.then(() => {
				if (!this.#loaded) throw new Error("PAID_GUARD_NOT_INITIALIZED");
				return use();
			});
		this.#serial = work;
		return work;
	}
	async #save(value: PaidComputerGuardRecord): Promise<void> {
		try {
			await this.#journal.save(value);
			this.#records.set(value.permit.permitId, value);
		} catch (error) {
			// rename may have succeeded before directory fsync failed. Retain the
			// original identity/deadline and close local admission; retrying an
			// ambiguous write must not treat the permit as newly issued.
			this.#records.set(value.permit.permitId, { ...value, phase: "stopping", stopReceipt: null });
			this.#starts.get(value.permit.permitId)?.abort(new Error("PAID_GUARD_JOURNAL_UNCONFIRMED"));
			throw error;
		}
	}
	async #latchStop(value: PaidComputerGuardRecord): Promise<void> {
		const next = { ...value, phase: "stopping" as const };
		this.#records.set(value.permit.permitId, next);
		this.#starts.get(value.permit.permitId)?.abort(new Error("PAID_GUARD_EXPIRED"));
		await this.#journal.save(next);
	}
	#get(permitId: string): PaidComputerGuardRecord {
		const value = this.#records.get(id(permitId));
		if (!value) throw new Error("PAID_GUARD_PERMIT_MISSING");
		return value;
	}
	async arm(raw: PaidComputerArm): Promise<PaidComputerGuardRecord> {
		const input = parsePaidComputerArm(raw);
		return this.#exclusive(async () => {
			const { machine, permit } = input,
				clock = await this.#clock();
			if (
				permit.state === "closed" ||
				clock.hostMachineIdSha256 !== machine.hostMachineIdSha256 ||
				clock.hostBootId !== machine.hostBootId ||
				input.requestStartedUptimeMs > clock.uptimeMs
			)
				throw new Error("PAID_GUARD_HOST_DIFFERS");
			const old = this.#records.get(permit.permitId);
			if (old && permit.generation === old.permit.generation) {
				const { validForMs: _a, state: _s1, guestBootId: _g1, physicalId: _p1, ...a } = permit,
					{ validForMs: _b, state: _s2, guestBootId: _g2, physicalId: _p2, ...b } = old.permit;
				if (!isDeepStrictEqual(a, b) || !isDeepStrictEqual(machine, old.machine))
					throw new Error("PAID_GUARD_REPLAY_DIFFERS");
				if (
					(old.permit.guestBootId !== null && old.permit.guestBootId !== permit.guestBootId) ||
					(old.permit.physicalId !== null && old.permit.physicalId !== permit.physicalId) ||
					(old.permit.state === "bound" && permit.state !== "bound")
				)
					throw new Error("PAID_GUARD_REPLAY_DIFFERS");
				// Original absolute deadline wins, even if a replay's TTL is larger.
				const bound = {
					...old,
					permit: {
						...old.permit,
						guestBootId: permit.guestBootId,
						physicalId: permit.physicalId,
						state: permit.state,
					},
				};
				if (!isDeepStrictEqual(bound, old)) await this.#save(bound);
				return structuredClone(bound);
			}
			if (
				old &&
				(!isDeepStrictEqual(machine, old.machine) ||
					old.phase === "stopping" ||
					old.phase === "stopped" ||
					permit.generation !== old.permit.generation + 1 ||
					permit.epoch !== old.permit.epoch ||
					permit.reservationId === old.permit.reservationId ||
					Date.parse(permit.deadline) <= Date.parse(old.permit.deadline) ||
					clock.uptimeMs >= old.stopAtUptimeMs)
			)
				throw new Error("PAID_GUARD_RENEWAL_REFUSED");
			if (!old) {
				if (permit.generation !== 1 || this.#records.size >= MAX_RECORDS)
					throw new Error("PAID_GUARD_INITIAL_PERMIT_REFUSED");
				for (const current of this.#records.values())
					if (
						current.machine.nodeId === machine.nodeId &&
						current.machine.binding.machineId === machine.binding.machineId &&
						current.phase !== "stopped"
					)
						throw new Error("PAID_GUARD_MACHINE_BUSY");
				if ((await this.#physical.inspect(machine, AbortSignal.timeout(5000))) !== "stopped")
					throw new Error("PAID_GUARD_STOPPED_MACHINE_REQUIRED");
			}
			const deadlineUptimeMs = input.requestStartedUptimeMs + permit.validForMs;
			const stopAtUptimeMs = deadlineUptimeMs - permit.stopReserveMs;
			if (
				!Number.isSafeInteger(deadlineUptimeMs) ||
				stopAtUptimeMs <= (await this.#clock()).uptimeMs ||
				(old && deadlineUptimeMs <= old.deadlineUptimeMs)
			)
				throw new Error("PAID_GUARD_PERMIT_EXPIRED");
			const value: PaidComputerGuardRecord = {
				schema: "qorpera.paid-computer-guard/v1",
				machine,
				permit,
				deadlineUptimeMs,
				stopAtUptimeMs,
				phase: old?.phase ?? "armed",
				startDispatched: old?.startDispatched ?? false,
				startReference: old?.startReference ?? null,
				startSettled: old?.startSettled ?? false,
				startSucceeded: old?.startSucceeded ?? null,
				stopReference: old?.stopReference ?? null,
				stopReceipt: null,
			};
			await this.#save(value);
			return structuredClone(value);
		});
	}
	async start(permitId: string, generation: number): Promise<LxdOperationReference> {
		const dispatch = new AbortController();
		const selected = await this.#exclusive(async () => {
			const current = this.#get(permitId),
				clock = await this.#clock();
			if (current.permit.generation === integer(generation, 1) && current.startReference)
				return { value: current, replay: true };
			if (
				current.permit.generation !== integer(generation, 1) ||
				current.phase !== "armed" ||
				current.startDispatched ||
				clock.hostMachineIdSha256 !== current.machine.hostMachineIdSha256 ||
				clock.hostBootId !== current.machine.hostBootId ||
				clock.uptimeMs + 5000 >= current.stopAtUptimeMs
			)
				throw new Error("PAID_GUARD_START_REFUSED");
			const next = { ...current, phase: "starting" as const, startDispatched: true };
			await this.#save(next);
			this.#starts.set(permitId, dispatch);
			return { value: next, replay: false };
		});
		const value = selected.value;
		if (selected.replay) return structuredClone(value.startReference as LxdOperationReference);
		// A lost reply never clears startDispatched. The watchdog keeps enforcing
		// stop until a known operation settles, or an operator reconciles custody.
		try {
			const clock = await this.#clock();
			if (
				clock.hostBootId !== value.machine.hostBootId ||
				clock.hostMachineIdSha256 !== value.machine.hostMachineIdSha256 ||
				clock.uptimeMs + 5000 >= value.stopAtUptimeMs
			)
				throw new Error("PAID_GUARD_START_EXPIRED");
			dispatch.signal.throwIfAborted();
			const started = reference(
				await this.#physical.start(
					value.machine,
					value.stopAtUptimeMs,
					AbortSignal.any([dispatch.signal, AbortSignal.timeout(5000)]),
				),
				value.machine,
			);
			await this.#exclusive(async () => {
				const current = this.#get(permitId);
				await this.#save({
					...current,
					startReference: started,
					phase: current.phase === "starting" ? "running" : current.phase,
				});
			});
			return started;
		} catch (error) {
			await this.#exclusive(async () => {
				await this.#latchStop(this.#get(permitId));
			}).catch(() => {});
			await this.#stopOne(permitId).catch(() => {});
			throw error;
		} finally {
			this.#starts.delete(permitId);
		}
	}
	async status(permitId: string): Promise<PaidComputerGuardRecord> {
		return this.#exclusive(async () => structuredClone(this.#get(permitId)));
	}
	async list(): Promise<PaidComputerGuardRecord[]> {
		return this.#exclusive(async () => structuredClone([...this.#records.values()]));
	}
	async latest(allocationId: string): Promise<PaidComputerGuardRecord | null> {
		id(allocationId);
		return this.#exclusive(async () =>
			structuredClone(
				[...this.#records.values()]
					.filter((value) => value.machine.allocationId === allocationId)
					.sort((a, b) => Date.parse(b.permit.issuedAt) - Date.parse(a.permit.issuedAt))[0] ?? null,
			),
		);
	}
	async stop(permitId: string): Promise<PaidComputerGuardRecord> {
		let journalFailed = false;
		await this.#exclusive(async () => {
			const value = this.#get(permitId);
			if (value.phase !== "stopped" && value.phase !== "stopping")
				await this.#latchStop(value).catch(() => {
					journalFailed = true;
				});
		});
		await this.#stopOne(permitId);
		if (journalFailed) throw new Error("PAID_GUARD_JOURNAL_UNCONFIRMED");
		return this.status(permitId);
	}
	async sweep(): Promise<void> {
		let journalFailed = false;
		const expired = await this.#exclusive(async () => {
			const clock = await this.#clock().catch(() => null),
				expired: string[] = [];
			for (const value of this.#records.values()) {
				if (value.phase === "stopped") continue;
				if (clock && clock.hostMachineIdSha256 !== value.machine.hostMachineIdSha256)
					throw new Error("PAID_GUARD_HOST_DIFFERS");
				if (
					!clock ||
					value.phase === "stopping" ||
					clock.hostBootId !== value.machine.hostBootId ||
					clock.uptimeMs >= value.stopAtUptimeMs
				) {
					if (value.phase !== "stopping")
						await this.#latchStop(value).catch(() => {
							journalFailed = true;
						});
					expired.push(value.permit.permitId);
				}
			}
			return expired;
		});
		// Record completion while LXD still retains the start operation. Its
		// later garbage collection cannot erase already persisted completion.
		await Promise.allSettled(
			[...this.#records.values()]
				.filter((value) => value.phase !== "stopped" && value.startReference && !value.startSettled)
				.map(async (value) => {
					const outcome = await this.#physical.startSettled(
						value.startReference as LxdOperationReference,
						AbortSignal.timeout(5000),
					);
					if (outcome !== "pending")
						await this.#exclusive(async () => {
							await this.#save({
								...this.#get(value.permit.permitId),
								startSettled: true,
								startSucceeded: outcome === "succeeded",
							});
						});
				}),
		);
		const outcomes = await Promise.allSettled(expired.map((permitId) => this.#stopOne(permitId)));
		if (journalFailed || outcomes.some((outcome) => outcome.status === "rejected"))
			throw new Error("PAID_GUARD_STOP_UNCONFIRMED");
	}
	async #stopOne(permitId: string): Promise<void> {
		if (this.#stops.has(permitId)) return;
		this.#stops.add(permitId);
		try {
			const value = await this.status(permitId);
			if (value.phase !== "stopping") return;
			const signal = AbortSignal.timeout(5000);
			let state = await this.#physical.inspect(value.machine, signal),
				operationId = value.stopReference?.operationId ?? null;
			if (state !== "stopped" && state !== "absent") {
				const stopped = reference(await this.#physical.stop(value.machine, signal), value.machine);
				operationId = stopped.operationId;
				await this.#exclusive(async () => {
					await this.#save({ ...this.#get(permitId), stopReference: stopped });
				});
				state = await this.#physical.inspect(value.machine, signal);
			}
			if (state !== "stopped" && state !== "absent") return;
			if (value.startDispatched && !value.startSettled) {
				if (!value.startReference) return;
				const outcome = await this.#physical.startSettled(value.startReference, signal);
				if (outcome === "pending") return;
				await this.#exclusive(async () => {
					await this.#save({
						...this.#get(permitId),
						startSettled: true,
						startSucceeded: outcome === "succeeded",
					});
				});
			}
			// The start may have completed after our first stopped observation.
			state = await this.#physical.inspect(value.machine, signal);
			if (state !== "stopped" && state !== "absent") return;
			const clock = await this.#clock();
			if (clock.hostMachineIdSha256 !== value.machine.hostMachineIdSha256)
				throw new Error("PAID_GUARD_HOST_DIFFERS");
			await this.#exclusive(async () => {
				const current = this.#get(permitId);
				await this.#save({
					...current,
					phase: "stopped",
					stopReceipt: {
						permitId,
						generation: current.permit.generation,
						allocationId: current.machine.allocationId,
						instanceSha256: current.permit.instanceSha256,
						physicalInstanceId: current.machine.physicalInstanceId,
						hostBootId: current.machine.hostBootId,
						observedUptimeMs: clock.uptimeMs,
						closedAtUptimeMs: clock.uptimeMs,
						closedHostBootId: clock.hostBootId,
						state: state as "stopped" | "absent",
						operationId,
					},
				});
			});
		} finally {
			this.#stops.delete(permitId);
		}
	}
}
