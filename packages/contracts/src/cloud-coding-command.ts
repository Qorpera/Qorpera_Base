const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
export interface CloudCodingCommandScope {
	readonly workerId: string;
	readonly vmId: string;
	readonly requestId: string;
	readonly turn: number;
}
export interface CloudCodingCommandReceipt {
	readonly schema: "qorpera.coding-command-result/v1";
	readonly workerId: string;
	readonly commandId: string;
	readonly inputSha256: string;
	readonly state: "running" | "succeeded" | "failed" | "cancelled" | "unconfirmed";
	readonly exitCode: number | null;
	readonly output: string;
	readonly truncated: boolean;
}

export function parseCloudCodingCommandReceipt(value: unknown): CloudCodingCommandReceipt {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid coding command result");
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).sort().join() !== "commandId,exitCode,inputSha256,output,schema,state,truncated,workerId" ||
		input.schema !== "qorpera.coding-command-result/v1" ||
		typeof input.workerId !== "string" ||
		!UUID.test(input.workerId) ||
		typeof input.commandId !== "string" ||
		!UUID.test(input.commandId) ||
		typeof input.inputSha256 !== "string" ||
		!SHA.test(input.inputSha256) ||
		!["running", "succeeded", "failed", "cancelled", "unconfirmed"].includes(String(input.state)) ||
		typeof input.output !== "string" ||
		Buffer.byteLength(input.output) > 4096 ||
		typeof input.truncated !== "boolean" ||
		(input.state === "succeeded"
			? input.exitCode !== 0
			: input.state === "failed"
				? !Number.isInteger(input.exitCode) || Number(input.exitCode) < 1 || Number(input.exitCode) > 255
				: input.exitCode !== null)
	)
		throw new Error("Invalid coding command result");
	return Object.freeze({ ...input }) as unknown as CloudCodingCommandReceipt;
}
