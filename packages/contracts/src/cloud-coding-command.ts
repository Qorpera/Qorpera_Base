const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
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
	readonly state: "running" | "succeeded" | "failed" | "cancelled" | "unconfirmed";
	readonly exitCode: number | null;
	readonly output: string;
	readonly truncated: boolean;
	readonly log: {
		readonly offset: number;
		readonly nextOffset: number;
		readonly totalBytes: number;
		readonly limitBytes: number;
		readonly limitReached: boolean;
	};
}

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
			(!Number.isSafeInteger(input.limit) || Number(input.limit) < 4 || Number(input.limit) > 16384)) ||
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
		!["running", "succeeded", "failed", "cancelled", "unconfirmed"].includes(String(input.state)) ||
		typeof input.output !== "string" ||
		Buffer.byteLength(input.output) > 16384 ||
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
		Object.keys(log).sort().join() !== "limitBytes,limitReached,nextOffset,offset,totalBytes" ||
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
