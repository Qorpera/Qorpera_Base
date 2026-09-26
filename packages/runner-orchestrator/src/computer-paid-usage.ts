import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	type PaidComputerPermit,
	type PaidComputerStopReceipt,
	parsePaidComputerPermit,
} from "./computer-paid-guard.ts";

export interface PaidComputerUsageSample {
	observationId: string;
	previousObservationId: string | null;
	hostBootId: string;
	hostUptimeMs: number;
	physicalId: string | null;
	guestBootId: string | null;
	guestUptimeMs: number | null;
	observedAt: string;
	state: "running" | "gap" | "stopped" | "absent";
	evidenceSha256: string;
}
export interface PaidComputerUsageEntry {
	schema: "qorpera.computer-guard-usage-entry/v1";
	sequence: number;
	previousSha256: string | null;
	permit: PaidComputerPermit;
	hostMachineIdSha256: string;
	physicalInstanceId: string;
	deadlineUptimeMs: number;
	stopAtUptimeMs: number;
	sample: PaidComputerUsageSample;
	stopReceipt: PaidComputerStopReceipt | null;
}
export interface PaidComputerUsageFrame {
	sequence: number;
	sha256: string;
	entryText: string;
}
export interface PaidComputerUsageCursor {
	sequence: number;
	sha256: string | null;
	observationId: string | null;
}
export interface PaidComputerUsagePage {
	schema: "qorpera.computer-guard-usage-page/v1";
	permitId: string;
	epoch: string;
	acknowledgedThrough: PaidComputerUsageCursor;
	head: PaidComputerUsageCursor;
	entries: PaidComputerUsageFrame[];
	state: "open" | "sealing" | "sealed" | "unconfirmed";
	finalSequence: number | null;
}
export interface PaidComputerUsageReadOptions {
	afterSequence?: number;
	limit?: number;
}
export const PAID_COMPUTER_USAGE_ZERO: Readonly<PaidComputerUsageCursor> = Object.freeze({
	sequence: 0,
	sha256: null,
	observationId: null,
});
export const PAID_COMPUTER_USAGE_PAGE_BYTES = 48 * 1024;
export const PAID_COMPUTER_USAGE_ENTRY_BYTES = 8192;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(value, key))
	)
		throw new Error("PAID_USAGE_INVALID");
	return value as Record<string, unknown>;
}
function text(value: unknown, pattern = UUID): string {
	if (typeof value !== "string" || !pattern.test(value)) throw new Error("PAID_USAGE_INVALID");
	return value;
}
function integer(value: unknown, minimum = 0): number {
	if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error("PAID_USAGE_INVALID");
	return Number(value);
}
export function parsePaidComputerUsageCursor(value: unknown): PaidComputerUsageCursor {
	const r = object(value, ["sequence", "sha256", "observationId"]),
		sequence = integer(r.sequence);
	if (sequence === 0) {
		if (r.sha256 !== null || r.observationId !== null) throw new Error("PAID_USAGE_CURSOR_INVALID");
		return { ...PAID_COMPUTER_USAGE_ZERO };
	}
	return { sequence, sha256: text(r.sha256, SHA), observationId: text(r.observationId) };
}
export function parsePaidComputerUsageSample(value: unknown): PaidComputerUsageSample {
	const r = object(value, [
		"observationId",
		"previousObservationId",
		"hostBootId",
		"hostUptimeMs",
		"physicalId",
		"guestBootId",
		"guestUptimeMs",
		"observedAt",
		"state",
		"evidenceSha256",
	]);
	if (
		!["running", "gap", "stopped", "absent"].includes(String(r.state)) ||
		typeof r.observedAt !== "string" ||
		!Number.isFinite(Date.parse(r.observedAt)) ||
		new Date(r.observedAt).toISOString() !== r.observedAt
	)
		throw new Error("PAID_USAGE_SAMPLE_INVALID");
	const sample: PaidComputerUsageSample = {
		observationId: text(r.observationId),
		previousObservationId: r.previousObservationId === null ? null : text(r.previousObservationId),
		hostBootId: text(r.hostBootId),
		hostUptimeMs: integer(r.hostUptimeMs),
		physicalId: r.physicalId === null ? null : text(r.physicalId),
		guestBootId: r.guestBootId === null ? null : text(r.guestBootId),
		guestUptimeMs: r.guestUptimeMs === null ? null : integer(r.guestUptimeMs),
		observedAt: r.observedAt,
		state: r.state as PaidComputerUsageSample["state"],
		evidenceSha256: text(r.evidenceSha256, SHA),
	};
	if (
		sample.state === "running"
			? sample.physicalId === null || sample.guestBootId === null || sample.guestUptimeMs === null
			: sample.guestUptimeMs !== null
	)
		throw new Error("PAID_USAGE_SAMPLE_INVALID");
	return sample;
}
export function parsePaidComputerUsageEntry(value: unknown): PaidComputerUsageEntry {
	const r = object(value, [
		"schema",
		"sequence",
		"previousSha256",
		"permit",
		"hostMachineIdSha256",
		"physicalInstanceId",
		"deadlineUptimeMs",
		"stopAtUptimeMs",
		"sample",
		"stopReceipt",
	]);
	const permit = parsePaidComputerPermit(r.permit),
		sample = parsePaidComputerUsageSample(r.sample),
		sequence = integer(r.sequence, 1);
	const physicalInstanceId = text(r.physicalInstanceId),
		deadlineUptimeMs = integer(r.deadlineUptimeMs),
		stopAtUptimeMs = integer(r.stopAtUptimeMs);
	const previousSha256 = r.previousSha256 === null ? null : text(r.previousSha256, SHA);
	if (
		r.schema !== "qorpera.computer-guard-usage-entry/v1" ||
		permit.schema !== "qorpera.computer-usage-permit/v2" ||
		permit.state === "closed" ||
		!permit.prestart ||
		!isDeepStrictEqual(permit, r.permit) ||
		deadlineUptimeMs - stopAtUptimeMs !== permit.stopReserveMs ||
		(sequence === 1) !== (previousSha256 === null) ||
		(sequence === 1) !== (sample.previousObservationId === null) ||
		sample.physicalId !== physicalInstanceId ||
		(permit.physicalId !== null && permit.physicalId !== physicalInstanceId) ||
		(sample.guestBootId !== null && permit.guestBootId !== null && sample.guestBootId !== permit.guestBootId)
	)
		throw new Error("PAID_USAGE_ENTRY_DIFFERS");
	let stopReceipt: PaidComputerStopReceipt | null = null;
	const terminal = sample.state === "stopped" || sample.state === "absent";
	if (terminal !== (r.stopReceipt !== null)) throw new Error("PAID_USAGE_TERMINAL_DIFFERS");
	if (r.stopReceipt !== null) {
		const s = object(r.stopReceipt, [
			"permitId",
			"generation",
			"allocationId",
			"instanceSha256",
			"physicalInstanceId",
			"hostBootId",
			"observedUptimeMs",
			"closedAtUptimeMs",
			"closedHostBootId",
			"state",
			"operationId",
		]);
		if (
			s.permitId !== permit.permitId ||
			s.generation !== permit.generation ||
			s.allocationId !== permit.allocationId ||
			s.instanceSha256 !== permit.instanceSha256 ||
			s.physicalInstanceId !== physicalInstanceId ||
			s.hostBootId !== permit.hostBootId ||
			s.state !== sample.state ||
			s.closedHostBootId !== sample.hostBootId ||
			s.closedAtUptimeMs !== sample.hostUptimeMs ||
			integer(s.observedUptimeMs) > integer(s.closedAtUptimeMs)
		)
			throw new Error("PAID_USAGE_TERMINAL_DIFFERS");
		stopReceipt = {
			permitId: permit.permitId,
			generation: permit.generation,
			allocationId: permit.allocationId,
			instanceSha256: permit.instanceSha256,
			physicalInstanceId,
			hostBootId: permit.hostBootId,
			observedUptimeMs: integer(s.observedUptimeMs),
			closedAtUptimeMs: integer(s.closedAtUptimeMs),
			closedHostBootId: text(s.closedHostBootId),
			state: sample.state as "stopped" | "absent",
			operationId: s.operationId === null ? null : text(s.operationId),
		};
	} else if (sample.hostBootId !== permit.hostBootId || sample.hostUptimeMs > deadlineUptimeMs)
		throw new Error("PAID_USAGE_CAPTURE_EXPIRED");
	return {
		schema: r.schema,
		sequence,
		previousSha256,
		permit,
		hostMachineIdSha256: text(r.hostMachineIdSha256, SHA),
		physicalInstanceId,
		deadlineUptimeMs,
		stopAtUptimeMs,
		sample,
		stopReceipt,
	};
}
export function paidComputerUsageFrame(value: PaidComputerUsageEntry): PaidComputerUsageFrame {
	const entry = parsePaidComputerUsageEntry(value),
		entryText = `${JSON.stringify(entry)}\n`;
	if (Buffer.byteLength(entryText) > PAID_COMPUTER_USAGE_ENTRY_BYTES) throw new Error("PAID_USAGE_ENTRY_TOO_LARGE");
	return { sequence: entry.sequence, sha256: createHash("sha256").update(entryText).digest("hex"), entryText };
}
export function parsePaidComputerUsageFrame(value: unknown): PaidComputerUsageFrame {
	const r = object(value, ["sequence", "sha256", "entryText"]);
	if (
		typeof r.entryText !== "string" ||
		Buffer.byteLength(r.entryText) > PAID_COMPUTER_USAGE_ENTRY_BYTES ||
		createHash("sha256").update(r.entryText).digest("hex") !== r.sha256
	)
		throw new Error("PAID_USAGE_FRAME_INVALID");
	const entry = parsePaidComputerUsageEntry(JSON.parse(r.entryText));
	if (entry.sequence !== r.sequence) throw new Error("PAID_USAGE_FRAME_INVALID");
	return { sequence: entry.sequence, sha256: text(r.sha256, SHA), entryText: r.entryText };
}
export function paidComputerUsageCursor(frame: PaidComputerUsageFrame): PaidComputerUsageCursor {
	const parsed = parsePaidComputerUsageFrame(frame),
		entry = parsePaidComputerUsageEntry(JSON.parse(parsed.entryText));
	return { sequence: parsed.sequence, sha256: parsed.sha256, observationId: entry.sample.observationId };
}
export function parsePaidComputerUsagePage(value: unknown): PaidComputerUsagePage {
	const r = object(value, [
		"schema",
		"permitId",
		"epoch",
		"acknowledgedThrough",
		"head",
		"entries",
		"state",
		"finalSequence",
	]);
	const acknowledgedThrough = parsePaidComputerUsageCursor(r.acknowledgedThrough),
		head = parsePaidComputerUsageCursor(r.head);
	if (
		r.schema !== "qorpera.computer-guard-usage-page/v1" ||
		!Array.isArray(r.entries) ||
		r.entries.length > 16 ||
		Buffer.byteLength(JSON.stringify(r.entries)) > PAID_COMPUTER_USAGE_PAGE_BYTES ||
		!["open", "sealing", "sealed", "unconfirmed"].includes(String(r.state)) ||
		acknowledgedThrough.sequence > head.sequence ||
		(acknowledgedThrough.sequence === head.sequence && !isDeepStrictEqual(acknowledgedThrough, head)) ||
		(r.state === "sealed" ? r.finalSequence !== head.sequence || head.sequence === 0 : r.finalSequence !== null)
	)
		throw new Error("PAID_USAGE_PAGE_INVALID");
	const entries = r.entries.map(parsePaidComputerUsageFrame),
		permitId = text(r.permitId),
		epoch = text(r.epoch);
	let previous: PaidComputerUsageCursor | null =
		entries[0]?.sequence === acknowledgedThrough.sequence + 1 ? acknowledgedThrough : null;
	for (const frame of entries) {
		const entry = parsePaidComputerUsageEntry(JSON.parse(frame.entryText));
		if (
			entry.permit.permitId !== permitId ||
			entry.permit.epoch !== epoch ||
			frame.sequence <= acknowledgedThrough.sequence ||
			frame.sequence > head.sequence ||
			(previous &&
				(frame.sequence !== previous.sequence + 1 ||
					entry.previousSha256 !== previous.sha256 ||
					entry.sample.previousObservationId !== previous.observationId))
		)
			throw new Error("PAID_USAGE_PAGE_DIFFERS");
		previous = paidComputerUsageCursor(frame);
		if (frame.sequence === head.sequence && !isDeepStrictEqual(previous, head))
			throw new Error("PAID_USAGE_PAGE_DIFFERS");
	}
	return {
		schema: r.schema,
		permitId,
		epoch,
		acknowledgedThrough,
		head,
		entries,
		state: r.state as PaidComputerUsagePage["state"],
		finalSequence: r.finalSequence === null ? null : integer(r.finalSequence, 1),
	};
}
