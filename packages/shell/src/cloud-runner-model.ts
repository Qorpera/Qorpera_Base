import type { JsonValue } from "@qorpera/contracts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_MODEL_INPUT_BYTES = 256 * 1024;
const MAX_MODEL_OUTPUT_BYTES = 512 * 1024;

export interface CloudRunnerAllowedModel {
	provider: string;
	model: string;
}

export interface ConfigureCloudRunnerModelPolicyInput {
	jobId: string;
	allowedModels: readonly CloudRunnerAllowedModel[];
	maxCalls: number;
	maxInputTokens: number;
	maxOutputTokens: number;
}

export interface CloudRunnerModelPolicy extends ConfigureCloudRunnerModelPolicyInput {
	profileId: string;
	environmentId: string;
	authorizedByUserId: string;
	createdAt: string;
}

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

export interface CloudRunnerModelUsageObservation extends CloudRunnerModelUsage {
	observationId: number;
	profileId: string;
	environmentId: string;
	jobId: string;
	requestId: string;
	runnerId: string;
	actorUserId: string;
	authorizedByUserId: string;
	provider: string;
	model: string;
	outcome: "completed" | "failed";
	createdAt: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Runner model broker contains invalid ${label}`);
	}
	return value as Record<string, unknown>;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new Error(`Runner model broker contains invalid ${label}`);
	}
	return value as number;
}

function uuid(value: unknown, label: string): string {
	if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
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

function timestamp(value: unknown, label: string): string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
		throw new Error(`Runner model broker contains invalid ${label}`);
	}
	return new Date(value).toISOString();
}

function json(value: unknown, label: string, maximumBytes: number): JsonValue {
	const encoded = JSON.stringify(value);
	if (encoded === undefined || Buffer.byteLength(encoded) > maximumBytes) {
		throw new Error(`Runner model broker contains invalid ${label}`);
	}
	return value as JsonValue;
}

export function normalizeCloudRunnerAllowedModels(
	value: readonly CloudRunnerAllowedModel[],
): CloudRunnerAllowedModel[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
		throw new Error("Runner model policy must allow between 1 and 32 models");
	}
	const normalized = value
		.map((entry) => ({ provider: provider(entry.provider), model: model(entry.model) }))
		.sort((left, right) =>
			left.provider === right.provider
				? left.model.localeCompare(right.model, "en")
				: left.provider.localeCompare(right.provider, "en"),
		);
	if (new Set(normalized.map((entry) => `${entry.provider}\0${entry.model}`)).size !== normalized.length) {
		throw new Error("Runner model policy contains duplicate models");
	}
	return normalized;
}

export function parseCloudRunnerModelPolicy(value: unknown): CloudRunnerModelPolicy {
	const input = record(value, "policy");
	if (!Array.isArray(input.allowed_models)) throw new Error("Runner model broker contains invalid allowed models");
	return {
		jobId: uuid(input.job_id, "policy job id"),
		profileId: uuid(input.profile_id, "policy profile id"),
		environmentId: uuid(input.environment_id, "policy environment id"),
		allowedModels: normalizeCloudRunnerAllowedModels(
			input.allowed_models.map((value) => {
				const entry = record(value, "allowed model");
				return { provider: provider(entry.provider), model: model(entry.model) };
			}),
		),
		maxCalls: integer(input.max_calls, "call limit", 1, 128),
		maxInputTokens: integer(input.max_input_tokens, "input-token limit", 1, 100_000_000),
		maxOutputTokens: integer(input.max_output_tokens, "output-token limit", 1, 100_000_000),
		authorizedByUserId: uuid(input.authorized_by_user_id, "policy authorizer id"),
		createdAt: timestamp(input.created_at, "policy creation time"),
	};
}

export function validateCloudRunnerModelRequest(value: CloudRunnerModelRequest): CloudRunnerModelRequest {
	return {
		requestId: uuid(value.requestId, "request id"),
		provider: provider(value.provider),
		model: model(value.model),
		input: json(value.input, "request input", MAX_MODEL_INPUT_BYTES),
		maxOutputTokens: integer(value.maxOutputTokens, "requested output tokens", 1, 1_000_000),
	};
}

export function parseCloudRunnerModelResponse(value: unknown): CloudRunnerModelResponse {
	const input = record(value, "response");
	const usage = record(input.usage, "response usage");
	return {
		requestId: uuid(input.request_id, "response request id"),
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

export function parseCloudRunnerModelUsageObservation(value: unknown): CloudRunnerModelUsageObservation {
	const input = record(value, "usage observation");
	if (input.outcome !== "completed" && input.outcome !== "failed") {
		throw new Error("Runner model broker contains invalid usage outcome");
	}
	return {
		observationId: integer(input.observation_id, "observation id", 1, Number.MAX_SAFE_INTEGER),
		profileId: uuid(input.profile_id, "observation profile id"),
		environmentId: uuid(input.environment_id, "observation environment id"),
		jobId: uuid(input.job_id, "observation job id"),
		requestId: uuid(input.request_id, "observation request id"),
		runnerId: uuid(input.runner_id, "observation runner id"),
		actorUserId: uuid(input.actor_user_id, "observation actor id"),
		authorizedByUserId: uuid(input.authorized_by_user_id, "observation authorizer id"),
		provider: provider(input.provider),
		model: model(input.model),
		outcome: input.outcome,
		inputTokens: integer(input.input_tokens, "observation input tokens", 0, 100_000_000),
		outputTokens: integer(input.output_tokens, "observation output tokens", 0, 100_000_000),
		costMicrousd: integer(input.cost_microusd, "observation cost", 0, Number.MAX_SAFE_INTEGER),
		createdAt: timestamp(input.created_at, "observation creation time"),
	};
}
