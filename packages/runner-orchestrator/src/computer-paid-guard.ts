import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, rename, statfs, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseCloudCodingNasPolicy } from "@qorpera/contracts";
import { type CodingMachineStorage, type LxdCodingMachineBinding, lxdCodingMachinePlan } from "./coding-machine.ts";
import { assertComputerAbandonmentReceipt } from "./computer-prestart-control.ts";
import type { LxdOperationReference } from "./lxd-client.ts";
import { checkDirectory, code, readRecord, syncDirectory } from "./lxd-office-journal-files.ts";
import { parseRuntimePaidComputerMachine, type RuntimePaidComputerMachine } from "./runtime-paid-machine.ts";

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
export interface CodingPaidComputerMachine {
	allocationId: string;
	nodeId: string;
	binding: Readonly<LxdCodingMachineBinding>;
	storage: CodingMachineStorage;
	physicalInstanceId: string;
	hostMachineIdSha256: string;
	hostBootId: string;
}
export type PaidComputerMachine = CodingPaidComputerMachine | RuntimePaidComputerMachine;
export function isRuntimePaidComputerMachine(machine: PaidComputerMachine): machine is RuntimePaidComputerMachine {
	return "kind" in machine && machine.kind === "runtime";
}
export function paidComputerTarget(machine: PaidComputerMachine): { project: string; instanceName: string } {
	if (isRuntimePaidComputerMachine(machine)) return machine.physicalTarget;
	return { project: machine.binding.project, instanceName: lxdCodingMachinePlan(machine.binding).request.name };
}
/** Projection of a confirmed kernel receipt, never authority supplied by a
 * member or guest. The trusted executor validates the originating RPC. */
export interface PaidComputerPermit {
	schema: "qorpera.computer-usage-permit/v1" | "qorpera.computer-usage-permit/v2";
	prestart?: { guardIncarnationId: string; prepareSha256: string };
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
export interface PaidComputerPrestartIntent {
	schema: "qorpera.computer-prestart-intent/v1";
	permitId: string;
	allocationId: string;
	instanceSha256: string;
	hostMachineIdSha256: string;
	hostBootId: string;
	prepareSha256: string;
	prepareRequestText: string;
}
export interface PaidComputerPrestartAbandonment {
	schema: "qorpera.computer-prestart-abandonment/v1";
	permitId: string;
	allocationId: string;
	instanceSha256: string;
	hostMachineIdSha256: string;
	hostBootId: string;
	prepareSha256: string;
	guardIncarnationId: string;
}
export interface PaidComputerPrestartRecord {
	schema: "qorpera.computer-prestart-record/v1";
	intent: PaidComputerPrestartIntent;
	guardIncarnationId: string;
	requestStartedUptimeMs: number;
	state: "registered" | "dispatched" | "retired" | "abandoned";
	abandonment: PaidComputerPrestartAbandonment | null;
}
interface PaidComputerPrestartJournal {
	schema: "qorpera.computer-prestart-journal/v1" | "qorpera.computer-prestart-journal/v2";
	guardIncarnationId: string;
	records: PaidComputerPrestartRecord[];
	archiveCount?: number;
	archiveHeadSha256?: string | null;
}
interface PaidComputerArchive {
	schema: "qorpera.computer-guard-archive/v1";
	sequence: number;
	previousSha256: string | null;
	prestart: PaidComputerPrestartRecord;
	guard: PaidComputerGuardRecord | null;
	closure: Record<string, unknown> | PaidComputerPermit;
}
interface PaidComputerArchiveIndex {
	sequence: number;
	sha256: string;
	allocationId: string;
	issuedAt: string | null;
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
export function parsePaidComputerPrestartIntent(value: unknown): PaidComputerPrestartIntent {
	const raw = record(value);
	if (
		raw.schema !== "qorpera.computer-prestart-intent/v1" ||
		Object.keys(raw).length !== 8 ||
		typeof raw.prepareRequestText !== "string" ||
		Buffer.byteLength(raw.prepareRequestText) > 20000 ||
		createHash("sha256").update(raw.prepareRequestText).digest("hex") !== raw.prepareSha256
	)
		throw new Error("PAID_GUARD_PRESTART_INVALID");
	const request = record(JSON.parse(raw.prepareRequestText));
	const pending: { value: unknown; depth: number }[] = [{ value: request, depth: 0 }];
	while (pending.length) {
		const next = pending.pop()!;
		if (next.depth > 32) throw new Error("PAID_GUARD_PRESTART_INVALID");
		if (next.value && typeof next.value === "object")
			for (const [key, child] of Object.entries(next.value)) {
				if (/secret|token|password|credential|authorization|prestart|preparerequesttext/i.test(key))
					throw new Error("PAID_GUARD_PRESTART_SECRET");
				pending.push({ value: child, depth: next.depth + 1 });
			}
	}
	if (
		request.requestId !== raw.permitId ||
		(request.allocationId ?? request.machineId) !== raw.allocationId ||
		request.machineIdSha256 !== raw.hostMachineIdSha256 ||
		request.hostBootId !== raw.hostBootId ||
		(request.instanceSha256 !== undefined && request.instanceSha256 !== raw.instanceSha256)
	)
		throw new Error("PAID_GUARD_PRESTART_DIFFERS");
	return {
		schema: raw.schema,
		permitId: id(raw.permitId),
		allocationId: id(raw.allocationId),
		instanceSha256: id(raw.instanceSha256, SHA),
		hostMachineIdSha256: id(raw.hostMachineIdSha256, SHA),
		hostBootId: id(raw.hostBootId),
		prepareSha256: id(raw.prepareSha256, SHA),
		prepareRequestText: raw.prepareRequestText,
	};
}
export function parsePaidComputerPrestartAbandonment(value: unknown): PaidComputerPrestartAbandonment {
	const raw = record(value);
	if (raw.schema !== "qorpera.computer-prestart-abandonment/v1" || Object.keys(raw).length !== 8)
		throw new Error("PAID_GUARD_PRESTART_INVALID");
	return {
		schema: raw.schema,
		permitId: id(raw.permitId),
		allocationId: id(raw.allocationId),
		instanceSha256: id(raw.instanceSha256, SHA),
		hostMachineIdSha256: id(raw.hostMachineIdSha256, SHA),
		hostBootId: id(raw.hostBootId),
		prepareSha256: id(raw.prepareSha256, SHA),
		guardIncarnationId: id(raw.guardIncarnationId),
	};
}
export function parsePaidComputerPrestartRecord(value: unknown): PaidComputerPrestartRecord {
	const raw = record(value),
		intent = parsePaidComputerPrestartIntent(raw.intent),
		guardIncarnationId = id(raw.guardIncarnationId);
	if (
		raw.schema !== "qorpera.computer-prestart-record/v1" ||
		Object.keys(raw).length !== 6 ||
		!["registered", "dispatched", "retired", "abandoned"].includes(String(raw.state)) ||
		(raw.state === "abandoned") !== (raw.abandonment !== null)
	)
		throw new Error("PAID_GUARD_PRESTART_INVALID");
	const abandonment = raw.abandonment === null ? null : parsePaidComputerPrestartAbandonment(raw.abandonment);
	const { schema: _schema, prepareRequestText: _text, ...identity } = intent;
	if (
		abandonment &&
		!isDeepStrictEqual(abandonment, {
			schema: "qorpera.computer-prestart-abandonment/v1",
			...identity,
			guardIncarnationId,
		})
	)
		throw new Error("PAID_GUARD_PRESTART_DIFFERS");
	return {
		schema: raw.schema,
		intent,
		guardIncarnationId,
		requestStartedUptimeMs: integer(raw.requestStartedUptimeMs),
		state: raw.state as PaidComputerPrestartRecord["state"],
		abandonment,
	};
}
function parseMachine(value: unknown): PaidComputerMachine {
	const m = record(value);
	if (m.kind === "runtime") return parseRuntimePaidComputerMachine(m);
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
		(p.schema !== "qorpera.computer-usage-permit/v1" && p.schema !== "qorpera.computer-usage-permit/v2") ||
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
	const prestart = p.schema === "qorpera.computer-usage-permit/v2" ? record(p.prestart) : undefined;
	if ((prestart && Object.keys(prestart).length !== 2) || (!prestart && p.prestart !== undefined))
		throw new Error("PAID_GUARD_PERMIT_INVALID");
	return {
		schema: p.schema,
		...(prestart
			? {
					prestart: {
						guardIncarnationId: id(prestart.guardIncarnationId),
						prepareSha256: id(prestart.prepareSha256, SHA),
					},
				}
			: {}),
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
	const runtime = isRuntimePaidComputerMachine(machine);
	if (
		permit.allocationId !== machine.allocationId ||
		permit.nodeId !== machine.nodeId ||
		permit.instanceSha256 !==
			(runtime ? machine.instanceSha256 : lxdCodingMachinePlan(machine.binding).instanceSha256) ||
		permit.hostBootId !== machine.hostBootId ||
		(permit.physicalId !== null && permit.physicalId !== machine.physicalInstanceId) ||
		permit.cpuMillis !== (runtime ? machine.cpuMillis : machine.binding.cpus * 1000) ||
		permit.memoryBytes !== (runtime ? machine.memoryBytes : machine.binding.memoryBytes)
	)
		throw new Error("PAID_GUARD_BINDING_DIFFERS");
	return { machine, permit, requestStartedUptimeMs: integer(input.requestStartedUptimeMs) };
}
function reference(value: unknown, machine: PaidComputerMachine): LxdOperationReference {
	const ref = record(value),
		target = paidComputerTarget(machine);
	if (ref.project !== target.project || ref.instanceName !== target.instanceName)
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

function archiveClosure(
	value: unknown,
	prestart: PaidComputerPrestartRecord,
	guard: PaidComputerGuardRecord | null,
): PaidComputerArchive["closure"] {
	if (guard) {
		const p = guard.permit,
			intent = prestart.intent;
		if (
			guard.phase !== "stopped" ||
			!guard.stopReceipt ||
			p.schema !== "qorpera.computer-usage-permit/v2" ||
			p.permitId !== intent.permitId ||
			p.allocationId !== intent.allocationId ||
			p.instanceSha256 !== intent.instanceSha256 ||
			p.hostBootId !== intent.hostBootId ||
			guard.machine.hostMachineIdSha256 !== intent.hostMachineIdSha256 ||
			p.prestart?.guardIncarnationId !== prestart.guardIncarnationId ||
			p.prestart.prepareSha256 !== intent.prepareSha256 ||
			(guard.startDispatched && (prestart.state !== "dispatched" || !guard.startSettled))
		)
			throw new Error("PAID_GUARD_ARCHIVE_UNCONFIRMED");
	}
	if (prestart.state === "abandoned") {
		if (guard && (guard.startDispatched || guard.permit.state !== "prepared" || guard.permit.generation !== 1))
			throw new Error("PAID_GUARD_ARCHIVE_UNCONFIRMED");
		assertComputerAbandonmentReceipt(value, prestart);
		const receipt = record(value);
		return {
			schema: receipt.schema,
			permitId: receipt.permitId,
			state: receipt.state,
			abandonment: prestart.abandonment,
			reservationReleased: receipt.reservationReleased,
			debitedUs: "0",
			releasedUs: receipt.releasedUs,
		};
	}
	if (!guard) throw new Error("PAID_GUARD_ARCHIVE_UNCONFIRMED");
	const closed = parsePaidComputerPermit(value);
	parsePaidComputerArm({ machine: guard.machine, permit: closed, requestStartedUptimeMs: 0 });
	const { state: _state, validForMs: _ttl, guestBootId: _guest, physicalId: _physical, ...identity } = closed;
	const { state: _oldState, validForMs: _oldTtl, guestBootId, physicalId, ...original } = guard.permit;
	if (
		closed.state !== "closed" ||
		!isDeepStrictEqual(identity, original) ||
		(guestBootId !== null && closed.guestBootId !== guestBootId) ||
		(physicalId !== null && closed.physicalId !== physicalId)
	)
		throw new Error("PAID_GUARD_ARCHIVE_UNCONFIRMED");
	// TTL is recomputed on every SQL read; it is not closure identity.
	return { ...closed, validForMs: 0 };
}
function parseArchive(value: unknown): PaidComputerArchive {
	const raw = record(value);
	if (raw.schema !== "qorpera.computer-guard-archive/v1" || Object.keys(raw).length !== 6)
		throw new Error("PAID_GUARD_ARCHIVE_INVALID");
	const prestart = parsePaidComputerPrestartRecord(raw.prestart);
	const guard = raw.guard === null ? null : parsePaidComputerGuardRecord(raw.guard);
	return {
		schema: raw.schema,
		sequence: integer(raw.sequence, 1),
		previousSha256: raw.previousSha256 === null ? null : id(raw.previousSha256, SHA),
		prestart,
		guard,
		closure: archiveClosure(raw.closure, prestart, guard),
	};
}
function archiveName(sequence: number): string {
	return `${String(integer(sequence, 1)).padStart(16, "0")}.json`;
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
		const names = (await readdir(this.root)).filter((name) => name.endsWith(".json") && name !== "prestarts.json");
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
	async loadPrestarts(): Promise<PaidComputerPrestartJournal | null> {
		await this.#directory();
		const loaded = await readRecord(join(this.root, "prestarts.json"), 16 * 1024 ** 2).catch((error) => {
			if (!code(error, "ENOENT")) throw error;
			return null;
		});
		if (!loaded) return null;
		const raw = record(loaded.value),
			guardIncarnationId = id(raw.guardIncarnationId);
		if (
			(raw.schema !== "qorpera.computer-prestart-journal/v1" &&
				raw.schema !== "qorpera.computer-prestart-journal/v2") ||
			Object.keys(raw).length !== (raw.schema === "qorpera.computer-prestart-journal/v1" ? 3 : 5) ||
			!Array.isArray(raw.records) ||
			raw.records.length > MAX_RECORDS
		)
			throw new Error("PAID_GUARD_PRESTART_INVALID");
		const records = raw.records.map(parsePaidComputerPrestartRecord);
		if (
			new Set(records.map((entry) => entry.intent.permitId)).size !== records.length ||
			records.some((entry) => entry.guardIncarnationId !== guardIncarnationId)
		)
			throw new Error("PAID_GUARD_PRESTART_DIFFERS");
		const archiveCount = raw.schema === "qorpera.computer-prestart-journal/v2" ? integer(raw.archiveCount) : 0;
		const archiveHeadSha256 = archiveCount ? id(raw.archiveHeadSha256, SHA) : null;
		if (raw.schema === "qorpera.computer-prestart-journal/v2" && !archiveCount && raw.archiveHeadSha256 !== null)
			throw new Error("PAID_GUARD_ARCHIVE_INVALID");
		return { schema: raw.schema, guardIncarnationId, records, archiveCount, archiveHeadSha256 };
	}
	/** Active records plus the durable head of permanent archival history. */
	async savePrestarts(value: PaidComputerPrestartJournal): Promise<void> {
		if (
			value.records.length > MAX_RECORDS ||
			value.records.some(
				(entry) => parsePaidComputerPrestartRecord(entry).guardIncarnationId !== value.guardIncarnationId,
			)
		)
			throw new Error("PAID_GUARD_PRESTART_INVALID");
		await this.#write("prestarts.json", value);
	}
	async save(value: PaidComputerGuardRecord): Promise<void> {
		parsePaidComputerGuardRecord(value);
		await this.#write(`${value.permit.permitId}.json`, value);
	}
	async archiveNames(): Promise<string[] | null> {
		await this.#directory();
		const directory = join(this.root, "archive");
		try {
			await checkDirectory(directory);
		} catch (error) {
			if (code(error, "ENOENT")) return null;
			throw error;
		}
		const names = (await readdir(directory)).filter((name) => !name.startsWith(".write-"));
		if (names.some((name) => !/^[0-9]{16}\.json$/.test(name))) throw new Error("PAID_GUARD_ARCHIVE_INVALID");
		return names.sort();
	}
	async readArchive(sequence: number): Promise<{ value: PaidComputerArchive; sha256: string }> {
		await checkDirectory(join(this.root, "archive"));
		const loaded = await readRecord(join(this.root, "archive", archiveName(sequence)), 65536);
		const value = parseArchive(loaded.value);
		if (value.sequence !== sequence) throw new Error("PAID_GUARD_ARCHIVE_INVALID");
		return { value, sha256: createHash("sha256").update(loaded.bytes).digest("hex") };
	}
	async appendArchive(value: PaidComputerArchive): Promise<string> {
		parseArchive(value);
		await this.#directory();
		const directory = join(this.root, "archive");
		await mkdir(directory, { mode: 0o700 }).catch((error) => {
			if (!code(error, "EEXIST")) throw error;
		});
		await checkDirectory(directory);
		await syncDirectory(this.root);
		const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
		if (bytes.length > 65536) throw new Error("PAID_GUARD_ARCHIVE_INVALID");
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const existing = await this.readArchive(value.sequence).catch((error) => {
			if (!code(error, "ENOENT")) throw error;
			return null;
		});
		if (existing && existing.sha256 !== sha256) throw new Error("PAID_GUARD_ARCHIVE_DIFFERS");
		// This journal has exactly one daemon writer. Atomic rename avoids a
		// link/unlink crash leaving a two-link file that custody checks refuse.
		// An existing sequence is verified and never overwritten.
		if (!existing) await this.#write(archiveName(value.sequence), value, directory);
		else await syncDirectory(directory);
		return sha256;
	}
	async removeArchivedGuard(permitId: string): Promise<void> {
		await this.#directory();
		await unlink(join(this.root, `${id(permitId)}.json`)).catch((error) => {
			if (!code(error, "ENOENT")) throw error;
		});
		await syncDirectory(this.root);
	}
	async #write(
		name: string,
		value: PaidComputerGuardRecord | PaidComputerPrestartJournal | PaidComputerArchive,
		directory = this.root,
	): Promise<void> {
		await this.#directory();
		await checkDirectory(directory);
		const bytes = `${JSON.stringify(value)}\n`;
		if (Buffer.byteLength(bytes) > 16 * 1024 ** 2) throw new Error("PAID_GUARD_JOURNAL_FULL");
		const temporary = join(directory, `.write-${randomUUID()}`);
		const file = await open(
			temporary,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
		try {
			await file.writeFile(bytes);
			await file.sync();
		} finally {
			await file.close();
		}
		try {
			await rename(temporary, join(directory, name));
			await syncDirectory(directory);
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
	readonly #prestarts = new Map<string, PaidComputerPrestartRecord>();
	readonly #archives = new Map<string, PaidComputerArchiveIndex>();
	#archiveCount = 0;
	#archiveHeadSha256: string | null = null;
	#guardIncarnationId = "";
	#prestartsUnconfirmed = false;
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
		const prestarts = await this.#journal.loadPrestarts();
		if (
			!prestarts &&
			[...this.#records.values()].some((entry) => entry.permit.schema === "qorpera.computer-usage-permit/v2")
		)
			throw new Error("PAID_GUARD_PRESTART_MISSING");
		this.#guardIncarnationId = prestarts?.guardIncarnationId ?? randomUUID();
		for (const entry of prestarts?.records ?? []) this.#prestarts.set(entry.intent.permitId, entry);
		const names = await this.#journal.archiveNames();
		if (!prestarts && names !== null) throw new Error("PAID_GUARD_ARCHIVE_ANCHOR_MISSING");
		const count = prestarts?.archiveCount ?? 0;
		if ((names?.length ?? 0) < count || (names?.length ?? 0) > count + 1)
			throw new Error("PAID_GUARD_ARCHIVE_INVALID");
		for (let sequence = 1; sequence <= (names?.length ?? 0); sequence++) {
			if (names![sequence - 1] !== archiveName(sequence)) throw new Error("PAID_GUARD_ARCHIVE_INVALID");
			const { value, sha256 } = await this.#journal.readArchive(sequence);
			const permitId = value.prestart.intent.permitId;
			if (
				value.previousSha256 !== this.#archiveHeadSha256 ||
				this.#archives.has(permitId) ||
				value.prestart.guardIncarnationId !== this.#guardIncarnationId
			)
				throw new Error("PAID_GUARD_ARCHIVE_DIFFERS");
			const active = this.#records.get(permitId) ?? null;
			if (sequence <= count) {
				if (this.#prestarts.has(permitId) || (active && !isDeepStrictEqual(active, value.guard)))
					throw new Error("PAID_GUARD_ARCHIVE_DIFFERS");
			} else {
				// Only an exact terminal write interrupted before the anchor may be
				// completed. Unrelated or partial tails never manufacture authority.
				if (
					!isDeepStrictEqual(this.#prestarts.get(permitId), value.prestart) ||
					!isDeepStrictEqual(active, value.guard)
				)
					throw new Error("PAID_GUARD_ARCHIVE_DIFFERS");
			}
			this.#indexArchive(value, sha256);
			if (sequence === count && this.#archiveHeadSha256 !== prestarts?.archiveHeadSha256)
				throw new Error("PAID_GUARD_ARCHIVE_DIFFERS");
			if (sequence > count) this.#prestarts.delete(permitId);
		}
		// Validate all anchored history before changing any retained evidence.
		if (this.#archiveCount > count) await this.#persistPrestarts();
		for (const permitId of this.#records.keys()) {
			if (!this.#archives.has(permitId)) continue;
			await this.#journal.removeArchivedGuard(permitId);
			this.#records.delete(permitId);
		}
		for (const entry of this.#records.values()) {
			const intent = this.#prestarts.get(entry.permit.permitId);
			if (entry.permit.schema === "qorpera.computer-usage-permit/v2") {
				this.#matchPrestart(entry.permit, entry.machine);
				if (
					(entry.startDispatched && intent?.state !== "dispatched") ||
					(intent?.state === "abandoned" && entry.startDispatched)
				)
					throw new Error("PAID_GUARD_PRESTART_DIFFERS");
				// Retirement was fsynced before the stopping record. A crash between
				// those writes must resume stop custody, never reopen admission.
				if (intent?.state === "retired" && entry.phase === "armed") {
					const stopping = { ...entry, phase: "stopping" as const };
					await this.#journal.save(stopping);
					this.#records.set(entry.permit.permitId, stopping);
				}
			} else if (intent) throw new Error("PAID_GUARD_PRESTART_DIFFERS");
		}
		if (!prestarts) await this.#persistPrestarts();
		this.#loaded = true;
	}
	async #persistPrestarts(): Promise<void> {
		try {
			await this.#journal.savePrestarts({
				schema: "qorpera.computer-prestart-journal/v2",
				guardIncarnationId: this.#guardIncarnationId,
				records: [...this.#prestarts.values()],
				archiveCount: this.#archiveCount,
				archiveHeadSha256: this.#archiveHeadSha256,
			});
		} catch (error) {
			// A rename may have committed. No admission or abandonment receipt can
			// follow an uncertain snapshot; existing physical stop custody survives.
			this.#prestartsUnconfirmed = true;
			throw error;
		}
	}
	#confirmedPrestarts(): void {
		if (this.#prestartsUnconfirmed) throw new Error("PAID_GUARD_PRESTART_UNCONFIRMED");
	}
	#indexArchive(value: PaidComputerArchive, sha256: string): void {
		this.#archives.set(value.prestart.intent.permitId, {
			sequence: value.sequence,
			sha256,
			allocationId: value.prestart.intent.allocationId,
			issuedAt: value.guard?.permit.issuedAt ?? null,
		});
		this.#archiveCount = value.sequence;
		this.#archiveHeadSha256 = sha256;
	}
	async #archived(permitId: string): Promise<PaidComputerArchive | null> {
		const index = this.#archives.get(permitId);
		if (!index) return null;
		const { value, sha256 } = await this.#journal.readArchive(index.sequence);
		if (sha256 !== index.sha256 || value.prestart.intent.permitId !== permitId)
			throw new Error("PAID_GUARD_ARCHIVE_DIFFERS");
		return value;
	}
	async archive(permitId: string, receipt: unknown): Promise<void> {
		id(permitId);
		await this.#exclusive(async () => {
			this.#confirmedPrestarts();
			if (this.#starts.has(permitId) || this.#stops.has(permitId)) throw new Error("PAID_GUARD_ARCHIVE_BUSY");
			const archived = await this.#archived(permitId);
			if (archived) {
				if (!isDeepStrictEqual(archiveClosure(receipt, archived.prestart, archived.guard), archived.closure))
					throw new Error("PAID_GUARD_ARCHIVE_DIFFERS");
				await this.#journal.removeArchivedGuard(permitId);
				this.#records.delete(permitId);
				return;
			}
			const prestart = this.#prestarts.get(permitId);
			if (!prestart) throw new Error("PAID_GUARD_PRESTART_MISSING");
			const guard = this.#records.get(permitId) ?? null;
			const closure = archiveClosure(receipt, prestart, guard);
			const value: PaidComputerArchive = {
				schema: "qorpera.computer-guard-archive/v1",
				sequence: this.#archiveCount + 1,
				previousSha256: this.#archiveHeadSha256,
				prestart,
				guard,
				closure,
			};
			try {
				const sha256 = await this.#journal.appendArchive(value);
				this.#indexArchive(value, sha256);
				this.#prestarts.delete(permitId);
				await this.#persistPrestarts();
				await this.#journal.removeArchivedGuard(permitId);
				this.#records.delete(permitId);
			} catch (error) {
				// A published tail or committed anchor requires restart recovery.
				// Keep stop custody; never overwrite or bypass uncertain history.
				this.#prestartsUnconfirmed = true;
				throw error;
			}
		});
	}
	async hasHistory(allocationId: string): Promise<boolean> {
		id(allocationId);
		return this.#exclusive(async () => {
			this.#confirmedPrestarts();
			return (
				[...this.#archives.values()].some((entry) => entry.allocationId === allocationId) ||
				[...this.#prestarts.values()].some((entry) => entry.intent.allocationId === allocationId) ||
				[...this.#records.values()].some((entry) => entry.machine.allocationId === allocationId)
			);
		});
	}
	#matchPrestart(permit: PaidComputerPermit, machine: PaidComputerMachine): PaidComputerPrestartRecord {
		const intent = this.#prestarts.get(permit.permitId);
		if (
			!intent ||
			!permit.prestart ||
			permit.prestart.guardIncarnationId !== this.#guardIncarnationId ||
			intent.guardIncarnationId !== this.#guardIncarnationId ||
			permit.prestart.prepareSha256 !== intent.intent.prepareSha256 ||
			intent.intent.allocationId !== permit.allocationId ||
			intent.intent.instanceSha256 !== permit.instanceSha256 ||
			intent.intent.hostBootId !== permit.hostBootId ||
			intent.intent.hostMachineIdSha256 !== machine.hostMachineIdSha256
		)
			throw new Error("PAID_GUARD_PRESTART_DIFFERS");
		return intent;
	}
	async registerPrestart(raw: PaidComputerPrestartIntent): Promise<PaidComputerPrestartRecord> {
		const intent = parsePaidComputerPrestartIntent(raw);
		return this.#exclusive(async () => {
			this.#confirmedPrestarts();
			if (this.#archives.has(intent.permitId)) throw new Error("PAID_GUARD_ARCHIVED");
			const clock = await this.#clock();
			if (clock.hostMachineIdSha256 !== intent.hostMachineIdSha256) throw new Error("PAID_GUARD_HOST_DIFFERS");
			const old = this.#prestarts.get(intent.permitId);
			if (old) {
				if (!isDeepStrictEqual(old.intent, intent)) throw new Error("PAID_GUARD_PRESTART_DIFFERS");
				return structuredClone(old);
			}
			if (this.#records.has(intent.permitId)) throw new Error("PAID_GUARD_PRESTART_LEGACY");
			if (this.#prestarts.size >= MAX_RECORDS) throw new Error("PAID_GUARD_JOURNAL_FULL");
			if (clock.hostMachineIdSha256 !== intent.hostMachineIdSha256 || clock.hostBootId !== intent.hostBootId)
				throw new Error("PAID_GUARD_HOST_DIFFERS");
			const value: PaidComputerPrestartRecord = {
				schema: "qorpera.computer-prestart-record/v1",
				intent,
				guardIncarnationId: this.#guardIncarnationId,
				requestStartedUptimeMs: integer(clock.uptimeMs),
				state: "registered",
				abandonment: null,
			};
			// Reserve room for every retained intent's future abandonment receipt.
			// Capacity refusal must not strand an existing intent's terminal write.
			if (
				Buffer.byteLength(JSON.stringify([...this.#prestarts.values(), value])) +
					1024 * (this.#prestarts.size + 1) >
				16 * 1024 ** 2 - 4096
			)
				throw new Error("PAID_GUARD_JOURNAL_FULL");
			this.#prestarts.set(intent.permitId, value);
			await this.#persistPrestarts();
			return structuredClone(value);
		});
	}
	async prestartStatus(permitId: string): Promise<PaidComputerPrestartRecord | null> {
		id(permitId);
		return this.#exclusive(async () => {
			this.#confirmedPrestarts();
			return structuredClone((await this.#archived(permitId))?.prestart ?? this.#prestarts.get(permitId) ?? null);
		});
	}
	async listPrestarts(): Promise<PaidComputerPrestartRecord[]> {
		return this.#exclusive(async () => {
			this.#confirmedPrestarts();
			return structuredClone([...this.#prestarts.values()]);
		});
	}
	async abandonPrestart(raw: PaidComputerPrestartIntent): Promise<PaidComputerPrestartRecord> {
		const intent = parsePaidComputerPrestartIntent(raw);
		return this.#exclusive(async () => {
			this.#confirmedPrestarts();
			const archived = await this.#archived(intent.permitId);
			if (archived) {
				if (archived.prestart.state !== "abandoned" || !isDeepStrictEqual(archived.prestart.intent, intent))
					throw new Error("PAID_GUARD_ARCHIVED");
				return structuredClone(archived.prestart);
			}
			const old = this.#prestarts.get(intent.permitId),
				guarded = this.#records.get(intent.permitId);
			if (!old || !isDeepStrictEqual(intent, old.intent)) throw new Error("PAID_GUARD_PRESTART_MISSING");
			if (old.state === "retired") throw new Error("PAID_GUARD_PRESTART_RETIRED");
			if (
				old.state === "dispatched" ||
				guarded?.startDispatched ||
				(guarded && (guarded.permit.state !== "prepared" || guarded.permit.generation !== 1))
			)
				throw new Error("PAID_GUARD_PRESTART_DISPATCHED");
			if ((await this.#clock()).hostMachineIdSha256 !== intent.hostMachineIdSha256)
				throw new Error("PAID_GUARD_HOST_DIFFERS");
			if (old.state === "abandoned") return structuredClone(old);
			const { schema: _schema, prepareRequestText: _text, ...identity } = intent;
			const next: PaidComputerPrestartRecord = {
				...old,
				state: "abandoned",
				abandonment: {
					schema: "qorpera.computer-prestart-abandonment/v1",
					...identity,
					guardIncarnationId: old.guardIncarnationId,
				},
			};
			this.#prestarts.set(intent.permitId, next);
			await this.#persistPrestarts();
			return structuredClone(next);
		});
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
		const prestart = this.#prestarts.get(value.permit.permitId);
		if (prestart?.state === "registered") {
			this.#prestarts.set(value.permit.permitId, { ...prestart, state: "retired" });
			await this.#persistPrestarts();
		}
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
			this.#confirmedPrestarts();
			if (this.#archives.has(permit.permitId)) throw new Error("PAID_GUARD_ARCHIVED");
			const prestart = this.#prestarts.get(permit.permitId);
			if (prestart?.state === "abandoned") throw new Error("PAID_GUARD_PRESTART_ABANDONED");
			if (prestart?.state === "retired") throw new Error("PAID_GUARD_PRESTART_RETIRED");
			if (
				permit.state === "closed" ||
				clock.hostMachineIdSha256 !== machine.hostMachineIdSha256 ||
				clock.hostBootId !== machine.hostBootId ||
				input.requestStartedUptimeMs > clock.uptimeMs
			)
				throw new Error("PAID_GUARD_HOST_DIFFERS");
			const old = this.#records.get(permit.permitId);
			if (permit.schema === "qorpera.computer-usage-permit/v2") this.#matchPrestart(permit, machine);
			else if (!old || prestart) throw new Error("PAID_GUARD_PRESTART_REQUIRED");
			if (!old && prestart?.state === "dispatched") throw new Error("PAID_GUARD_PRESTART_DISPATCHED");
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
						paidComputerTarget(current.machine).project === paidComputerTarget(machine).project &&
						paidComputerTarget(current.machine).instanceName === paidComputerTarget(machine).instanceName &&
						current.phase !== "stopped"
					)
						throw new Error("PAID_GUARD_MACHINE_BUSY");
				if ((await this.#physical.inspect(machine, AbortSignal.timeout(5000))) !== "stopped")
					throw new Error("PAID_GUARD_STOPPED_MACHINE_REQUIRED");
			}
			const deadlineUptimeMs = Math.min(
				input.requestStartedUptimeMs + permit.validForMs,
				permit.generation === 1 && prestart
					? prestart.requestStartedUptimeMs + permit.windowMs + permit.stopReserveMs
					: Number.MAX_SAFE_INTEGER,
			);
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
			this.#confirmedPrestarts();
			if (this.#archives.has(permitId)) throw new Error("PAID_GUARD_ARCHIVED");
			const current = this.#get(permitId),
				clock = await this.#clock();
			const prestart = this.#prestarts.get(permitId);
			if (prestart?.state === "abandoned") throw new Error("PAID_GUARD_PRESTART_ABANDONED");
			if (prestart?.state === "retired") throw new Error("PAID_GUARD_PRESTART_RETIRED");
			if (prestart?.state === "dispatched" && !current.startDispatched)
				throw new Error("PAID_GUARD_PRESTART_DISPATCHED");
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
			if (prestart) {
				this.#prestarts.set(permitId, { ...prestart, state: "dispatched" });
				await this.#persistPrestarts();
			}
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
		id(permitId);
		return this.#exclusive(async () =>
			structuredClone((await this.#archived(permitId))?.guard ?? this.#get(permitId)),
		);
	}
	async list(): Promise<PaidComputerGuardRecord[]> {
		return this.#exclusive(async () => structuredClone([...this.#records.values()]));
	}
	async latest(allocationId: string): Promise<PaidComputerGuardRecord | null> {
		id(allocationId);
		return this.#exclusive(async () => {
			let selected: PaidComputerGuardRecord | null =
				[...this.#records.values()]
					.filter((value) => value.machine.allocationId === allocationId)
					.sort((a, b) => Date.parse(b.permit.issuedAt) - Date.parse(a.permit.issuedAt))[0] ?? null;
			let archivedPermitId: string | null = null;
			let newest = selected ? Date.parse(selected.permit.issuedAt) : Number.NEGATIVE_INFINITY;
			for (const [permitId, index] of this.#archives) {
				if (index.allocationId === allocationId && index.issuedAt !== null && Date.parse(index.issuedAt) > newest) {
					archivedPermitId = permitId;
					newest = Date.parse(index.issuedAt);
				}
			}
			if (archivedPermitId) selected = (await this.#archived(archivedPermitId))!.guard;
			return structuredClone(selected);
		});
	}
	async stop(permitId: string): Promise<PaidComputerGuardRecord> {
		let journalFailed = false;
		const stopped = await this.#exclusive(async () => {
			if (this.#archives.has(permitId)) {
				const archived = await this.#archived(permitId);
				if (!archived?.guard) throw new Error("PAID_GUARD_PERMIT_MISSING");
				return structuredClone(archived.guard);
			}
			const value = this.#get(permitId);
			if (value.phase === "stopped") return structuredClone(value);
			if (value.phase !== "stopping")
				await this.#latchStop(value).catch(() => {
					journalFailed = true;
				});
			return null;
		});
		if (stopped) return stopped;
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
