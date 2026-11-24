import { SHA256_HEX_PATTERN as SHA, UUID_PATTERN as UUID } from "./wire-values.ts";
/** The most bytes one of the coding guest's helpers may have: the four programs in /opt/qorpera-coding (storage,
 * command, Git, watchdog; scripts/package-coding-guest.mjs). The packager refuses a larger one, and the executor reads
 * each from the machine within it before it compares the helper with its pin (the LXD client allows a read this large
 * only of a helper). Twice the 64 KiB it was until 12 Nov 2026: the helpers bundle contracts, and the command guest was
 * 64,835 bytes then. */
export const CODING_GUEST_HELPER_MAX_BYTES = 131_072;
export interface CloudCodingCommandScope {
	readonly workerId: string;
	readonly vmId: string;
	readonly requestId: string;
	readonly turn: number;
}
export interface CloudCodingCommandReceipt {
	readonly schema: "qorpera.coding-command-result/v2";
	readonly workerId: string;
	readonly commandId: string;
	readonly inputSha256: string;
	/** `machine_stopped`: the member's coding machine stopped or restarted under the command (F3 step 5g), which may
	 * have done part of its work. Its log stays readable. */
	readonly state: "running" | "succeeded" | "failed" | "cancelled" | "unconfirmed" | "machine_stopped";
	readonly exitCode: number | null;
	readonly output: string;
	readonly truncated: boolean;
	readonly log: {
		readonly offset: number;
		readonly nextOffset: number;
		readonly totalBytes: number;
		readonly limitBytes: number;
		readonly limitReached: boolean;
		/** Only when bytes were lost: the command's output that the machine dropped before the host saved it. They are
		 * not in the log, and its offsets do not count them. */
		readonly gapBytes?: number;
	};
}

/** The most output one log page holds, in bytes of UTF-8 (keyholes S1, 12 Nov 2026; it was 16,384): a read's `limit`
 * and a receipt's `output`. The guest pages also stay within 60,000 bytes of JSON escaping (readCodingCommandLog), so a
 * page fits LXD's 64 KiB file answer. The two parsers below write it as a number of the old one's length, which a test
 * pins to this: the coding command guest bundles them, and its program has a few hundred bytes left to the 64 KiB its
 * packager and the coding executor's check allow (12 Nov 2026). */
export const CLOUD_CODING_COMMAND_PAGE_BYTES = 65_536;
/** The most an executor or a guest takes for a page when it does not say what it takes: the bound before
 * CLOUD_CODING_COMMAND_PAGE_BYTES, which older ones refuse to go past. */
export const CLOUD_CODING_COMMAND_LEGACY_PAGE_BYTES = 16_384;
export interface CloudCodingCommandRead {
	readonly commandId: string;
	readonly offset?: number;
	readonly limit?: number;
	readonly tail?: boolean;
}
export function parseCloudCodingCommandRead(value: unknown): CloudCodingCommandRead {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid coding log read");
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).some((key) => !["commandId", "offset", "limit", "tail"].includes(key)) ||
		typeof input.commandId !== "string" ||
		!UUID.test(input.commandId) ||
		(input.offset !== undefined && (!Number.isSafeInteger(input.offset) || Number(input.offset) < 0)) ||
		(input.limit !== undefined &&
			(!Number.isSafeInteger(input.limit) || Number(input.limit) < 4 || Number(input.limit) > 65536)) ||
		(input.tail !== undefined && typeof input.tail !== "boolean") ||
		(input.tail === true && input.offset !== undefined)
	)
		throw new Error("Invalid coding log read");
	return Object.freeze({
		commandId: input.commandId,
		...(input.tail ? { tail: true } : { offset: input.offset ?? 0 }),
		limit: input.limit ?? 4096,
	}) as CloudCodingCommandRead;
}

export function parseCloudCodingCommandReceipt(value: unknown): CloudCodingCommandReceipt {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid coding command result");
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).sort().join() !==
			"commandId,exitCode,inputSha256,log,output,schema,state,truncated,workerId" ||
		input.schema !== "qorpera.coding-command-result/v2" ||
		typeof input.workerId !== "string" ||
		!UUID.test(input.workerId) ||
		typeof input.commandId !== "string" ||
		!UUID.test(input.commandId) ||
		typeof input.inputSha256 !== "string" ||
		!SHA.test(input.inputSha256) ||
		!["running", "succeeded", "failed", "cancelled", "unconfirmed", "machine_stopped"].includes(
			String(input.state),
		) ||
		typeof input.output !== "string" ||
		Buffer.byteLength(input.output) > 65536 ||
		Buffer.from(input.output).toString("utf8") !== input.output ||
		typeof input.truncated !== "boolean" ||
		(input.state === "succeeded"
			? input.exitCode !== 0
			: input.state === "failed"
				? !Number.isInteger(input.exitCode) || Number(input.exitCode) < 1 || Number(input.exitCode) > 255
				: input.exitCode !== null)
	)
		throw new Error("Invalid coding command result");
	const log = input.log as Record<string, unknown>;
	if (
		!log ||
		typeof log !== "object" ||
		Array.isArray(log) ||
		Object.keys(log).sort().join() !==
			(log.gapBytes === undefined
				? "limitBytes,limitReached,nextOffset,offset,totalBytes"
				: "gapBytes,limitBytes,limitReached,nextOffset,offset,totalBytes") ||
		(log.gapBytes !== undefined && (!Number.isSafeInteger(log.gapBytes) || Number(log.gapBytes) < 1)) ||
		![log.offset, log.nextOffset, log.totalBytes, log.limitBytes].every(
			(n) => Number.isSafeInteger(n) && Number(n) >= 0,
		) ||
		Number(log.limitBytes) < 1048576 ||
		Number(log.limitBytes) > 1073741824 ||
		Number(log.offset) > Number(log.nextOffset) ||
		Number(log.nextOffset) > Number(log.totalBytes) ||
		Number(log.nextOffset) - Number(log.offset) > Buffer.byteLength(input.output as string) ||
		Number(log.totalBytes) > Number(log.limitBytes) ||
		typeof log.limitReached !== "boolean" ||
		(log.limitReached && log.totalBytes !== log.limitBytes) ||
		input.truncated !== (Number(log.nextOffset) < Number(log.totalBytes) || log.limitReached) ||
		(log.nextOffset === log.offset && input.output !== "")
	)
		throw new Error("Invalid coding command log");
	return Object.freeze({ ...input, log: Object.freeze({ ...log }) }) as unknown as CloudCodingCommandReceipt;
}
