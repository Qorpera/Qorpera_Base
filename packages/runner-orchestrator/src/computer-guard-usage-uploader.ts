import { isDeepStrictEqual } from "node:util";
import { type PaidComputerPermit, parsePaidComputerPermit } from "./computer-paid-guard.ts";
import {
	type PaidComputerUsageCursor,
	type PaidComputerUsagePage,
	type PaidComputerUsageReadOptions,
	type PaidComputerUsageSample,
	paidComputerUsageCursor,
	parsePaidComputerUsageCursor,
	parsePaidComputerUsageEntry,
	parsePaidComputerUsagePage,
	parsePaidComputerUsageSample,
} from "./computer-paid-usage.ts";

export interface ComputerGuardUsagePort {
	readUsage(
		permitId: string,
		options?: PaidComputerUsageReadOptions,
		signal?: AbortSignal,
	): Promise<PaidComputerUsagePage>;
	ackUsage(permitId: string, cursor: PaidComputerUsageCursor, signal?: AbortSignal): Promise<PaidComputerUsageCursor>;
}

/** Consume only the independent guard's immutable observations. An upload or
 * acknowledgement failure leaves the exact prefix available for replay. */
export async function drainComputerGuardUsage(options: {
	permit: PaidComputerPermit;
	lastSample: unknown;
	guard: ComputerGuardUsagePort;
	recover(): Promise<{ permit: unknown; lastSample: unknown }>;
	call(request: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
	signal: AbortSignal;
}): Promise<{ permit: PaidComputerPermit; sample: PaidComputerUsageSample | null; sealed: boolean }> {
	let permit = options.permit;
	let sample = options.lastSample === null ? null : parsePaidComputerUsageSample(options.lastSample);
	const read = async () => {
		const page = parsePaidComputerUsagePage(
			await options.guard.readUsage(permit.permitId, undefined, options.signal),
		);
		if (page.permitId !== permit.permitId || page.epoch !== permit.epoch || page.state === "unconfirmed")
			throw new Error("COMPUTER_GUARD_USAGE_UNCONFIRMED");
		return page;
	};
	let page = await read();
	// Freeze the current prefix rather than chasing a producer that remains
	// active while the controller uploads. A sealed page fixes the final tip.
	const target = page.head.sequence;
	while (page.acknowledgedThrough.sequence < target) {
		options.signal.throwIfAborted();
		const entries = page.entries.filter((entry) => entry.sequence <= target);
		if (entries.length === 0 || entries[0]!.sequence !== page.acknowledgedThrough.sequence + 1)
			throw new Error("COMPUTER_GUARD_USAGE_PREFIX_MISSING");
		const tip = paidComputerUsageCursor(entries.at(-1)!);
		const value = await options.call(
			{ permitId: permit.permitId, generation: permit.generation, entries },
			options.signal,
		);
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error("COMPUTER_GUARD_USAGE_RECEIPT_INVALID");
		const receipt = value as Record<string, unknown>;
		if (
			Object.keys(receipt).length !== 5 ||
			receipt.schema !== "qorpera.computer-guard-usage-receipt/v1" ||
			typeof receipt.sealed !== "boolean"
		)
			throw new Error("COMPUTER_GUARD_USAGE_RECEIPT_INVALID");
		const canonical = parsePaidComputerPermit(receipt.permit),
			cursor = parsePaidComputerUsageCursor(receipt.cursor);
		const acceptedSample = parsePaidComputerUsageSample(receipt.lastSample);
		if (
			canonical.permitId !== permit.permitId ||
			canonical.allocationId !== permit.allocationId ||
			canonical.epoch !== permit.epoch ||
			canonical.instanceSha256 !== permit.instanceSha256 ||
			canonical.nodeId !== permit.nodeId ||
			canonical.hostBootId !== permit.hostBootId ||
			canonical.cpuMillis !== permit.cpuMillis ||
			canonical.memoryBytes !== permit.memoryBytes ||
			canonical.tariffVersion !== permit.tariffVersion ||
			!isDeepStrictEqual(canonical.prestart, permit.prestart) ||
			canonical.generation < permit.generation ||
			canonical.generation > permit.generation + 1 ||
			cursor.sequence < tip.sequence ||
			cursor.observationId !== acceptedSample.observationId ||
			receipt.sealed !== (acceptedSample.state === "stopped" || acceptedSample.state === "absent") ||
			(cursor.sequence === tip.sequence &&
				(!isDeepStrictEqual(cursor, tip) ||
					!isDeepStrictEqual(
						acceptedSample,
						parsePaidComputerUsageEntry(JSON.parse(entries.at(-1)!.entryText)).sample,
					)))
		)
			throw new Error("COMPUTER_GUARD_USAGE_RECEIPT_DIFFERS");
		// A concurrent/recovered upload may already have accepted a later prefix.
		// The guard verifies that canonical cursor against its own durable chain.
		const acknowledged = parsePaidComputerUsageCursor(
			await options.guard.ackUsage(permit.permitId, cursor, options.signal),
		);
		if (!isDeepStrictEqual(acknowledged, cursor)) throw new Error("COMPUTER_GUARD_USAGE_ACK_DIFFERS");
		permit = canonical;
		sample = acceptedSample;
		page = await read();
		if (page.acknowledgedThrough.sequence < cursor.sequence) throw new Error("COMPUTER_GUARD_USAGE_ACK_LOST");
	}
	if (page.acknowledgedThrough.sequence > 0 && page.acknowledgedThrough.observationId !== sample?.observationId) {
		// ACK may have fsynced and deleted its prefix before its reply was lost.
		// Recover the accepted sample from immutable SQL history, never recreate
		// the deleted local observation or infer it from acknowledgement time.
		const recovered = await options.recover();
		const canonical = parsePaidComputerPermit(recovered.permit);
		const acceptedSample = parsePaidComputerUsageSample(recovered.lastSample);
		if (
			canonical.permitId !== permit.permitId ||
			canonical.allocationId !== permit.allocationId ||
			canonical.epoch !== permit.epoch ||
			canonical.instanceSha256 !== permit.instanceSha256 ||
			canonical.nodeId !== permit.nodeId ||
			canonical.hostBootId !== permit.hostBootId ||
			canonical.cpuMillis !== permit.cpuMillis ||
			canonical.memoryBytes !== permit.memoryBytes ||
			canonical.tariffVersion !== permit.tariffVersion ||
			!isDeepStrictEqual(canonical.prestart, permit.prestart) ||
			canonical.generation < permit.generation ||
			canonical.generation > permit.generation + 1 ||
			acceptedSample.observationId !== page.acknowledgedThrough.observationId
		)
			throw new Error("COMPUTER_GUARD_USAGE_CANONICAL_TIP_DIFFERS");
		permit = canonical;
		sample = acceptedSample;
	}
	const sealed = page.state === "sealed" && page.finalSequence === page.acknowledgedThrough.sequence;
	if (sealed && sample?.state !== "stopped" && sample?.state !== "absent")
		throw new Error("COMPUTER_GUARD_USAGE_TERMINAL_MISSING");
	return { permit, sample, sealed };
}
