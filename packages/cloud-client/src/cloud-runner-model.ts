import { isRecord, isUuidAnyCase, type JsonValue } from "@qorpera/contracts";

const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_MODEL_INPUT_BYTES = 256 * 1024;
const MAX_MODEL_OUTPUT_BYTES = 512 * 1024;

export interface CloudRunnerModelRequest {
	requestId: string;
	provider: string;
	model: string;
	input: JsonValue;
	maxOutputTokens: number;
}

export interface CloudRunnerModelUsage {
	inputTokens: number;
	outputTokens: number;
	costMicrousd: number;
}

export interface CloudRunnerModelResponse {
	requestId: string;
	provider: string;
	model: string;
	output: JsonValue;
	usage: CloudRunnerModelUsage;
}

function modelRecord(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new Error(`Runner model broker contains invalid ${label}`);
	}
	return value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new Error(`Runner model broker contains invalid ${label}`);
	}
	return value as number;
}

function modelUuid(value: unknown, label: string): string {
	if (!isUuidAnyCase(value)) {
		throw new Error(`Runner model broker contains invalid ${label}`);
	}
	return value;
}

function provider(value: unknown): string {
	if (typeof value !== "string" || !PROVIDER_PATTERN.test(value)) {
		throw new Error("Runner model broker contains invalid provider");
	}
	return value;
}

function model(value: unknown): string {
	if (
		typeof value !== "string" ||
		value !== value.trim() ||
		value.length < 1 ||
		value.length > 160 ||
		/[\0\r\n]/.test(value)
	) {
		throw new Error("Runner model broker contains invalid model");
	}
	return value;
}

function json(value: unknown, label: string, maximumBytes: number): JsonValue {
	const encoded = JSON.stringify(value);
	if (encoded === undefined || Buffer.byteLength(encoded) > maximumBytes) {
		throw new Error(`Runner model broker contains invalid ${label}`);
	}
	return value as JsonValue;
}

export function validateCloudRunnerModelRequest(value: CloudRunnerModelRequest): CloudRunnerModelRequest {
	return {
		requestId: modelUuid(value.requestId, "request id"),
		provider: provider(value.provider),
		model: model(value.model),
		input: json(value.input, "request input", MAX_MODEL_INPUT_BYTES),
		maxOutputTokens: integer(value.maxOutputTokens, "requested output tokens", 1, 1_000_000),
	};
}

export function parseCloudRunnerModelResponse(value: unknown): CloudRunnerModelResponse {
	const input = modelRecord(value, "response");
	const usage = modelRecord(input.usage, "response usage");
	return {
		requestId: modelUuid(input.request_id, "response request id"),
		provider: provider(input.provider),
		model: model(input.model),
		output: json(input.output, "response output", MAX_MODEL_OUTPUT_BYTES),
		usage: {
			inputTokens: integer(usage.input_tokens, "response input tokens", 0, 100_000_000),
			outputTokens: integer(usage.output_tokens, "response output tokens", 0, 100_000_000),
			costMicrousd: integer(usage.cost_microusd, "response cost", 0, Number.MAX_SAFE_INTEGER),
		},
	};
}
