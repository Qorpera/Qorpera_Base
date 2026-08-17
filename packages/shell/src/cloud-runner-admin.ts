import { randomUUID } from "node:crypto";
import type { JsonValue } from "@qorpera/pi-protocol";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
	CLOUD_RUNNER_CAPABILITIES,
	type CloudRunner,
	type CloudRunnerAuditReceipt,
	type CloudRunnerCapability,
	type CloudRunnerJob,
	type CloudRunnerPairingSecret,
	createCloudRunnerPairingSecret,
	parseCloudRunner,
	parseCloudRunnerAuditReceipt,
	parseCloudRunnerJob,
	runnerActivationTokenSha256,
} from "./cloud-runner-control.ts";
import {
	type CloudRunnerModelPolicy,
	type CloudRunnerModelUsageObservation,
	type ConfigureCloudRunnerModelPolicyInput,
	normalizeCloudRunnerAllowedModels,
	parseCloudRunnerModelPolicy,
	parseCloudRunnerModelUsageObservation,
} from "./cloud-runner-model.ts";
import { type CloudRunnerUsageObservation, parseCloudRunnerUsageObservation } from "./cloud-runner-usage.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_JOB_BODY_BYTES = 64 * 1024;

export interface PrepareCloudRunnerRegistrationInput {
	profileId: string;
	displayName: string;
	capabilities: CloudRunnerCapability[];
	maxConcurrency?: number;
	clientRunnerId?: string;
}

export interface PreparedCloudRunnerRegistration {
	profileId: string;
	clientRunnerId: string;
	displayName: string;
	capabilities: CloudRunnerCapability[];
	maxConcurrency: number;
	pairingSecret: CloudRunnerPairingSecret;
}

export interface PreparedCloudRunnerActivation {
	runnerId: string;
	pairingSecret: CloudRunnerPairingSecret;
}

export interface CloudRunnerRegistration {
	runner: CloudRunner;
	/** One-time pairing token. Persist locally before the registration request so retries reuse it. */
	activationToken: string;
}

export interface EnqueueCloudRunnerJobInput {
	environmentId: string;
	sessionId?: string;
	substrateVersionId: string;
	clientJobId: string;
	requiredCapability: CloudRunnerCapability;
	jobType: string;
	payload: JsonValue;
}

export interface CloudRunnerAdminTransport {
	createRunnerRegistration(input: {
		p_profile_id: string;
		p_client_runner_id: string;
		p_display_name: string;
		p_capabilities: JsonValue;
		p_max_concurrency: number;
		p_activation_token_sha256: string;
	}): Promise<unknown>;
	reissueRunnerActivation(input: { p_runner_id: string; p_activation_token_sha256: string }): Promise<unknown>;
	listRunners(input: { p_profile_id: string }): Promise<unknown>;
	revokeRunner(input: { p_runner_id: string }): Promise<unknown>;
	enqueueRunnerJob(input: {
		p_environment_id: string;
		p_session_id: string | null;
		p_substrate_version_id: string;
		p_client_job_id: string;
		p_required_capability: CloudRunnerCapability;
		p_job_type: string;
		p_payload: JsonValue;
	}): Promise<unknown>;
	listRunnerJobs(input: { p_profile_id: string; p_limit: number }): Promise<unknown>;
	cancelRunnerJob(input: { p_job_id: string }): Promise<unknown>;
	listRunnerAudit(input: { p_profile_id: string; p_after_id: number; p_limit: number }): Promise<unknown>;
	listRunnerUsage(input: { p_profile_id: string; p_after_id: number; p_limit: number }): Promise<unknown>;
	configureRunnerModelPolicy(input: {
		p_job_id: string;
		p_allowed_models: JsonValue;
		p_max_calls: number;
		p_max_input_tokens: number;
		p_max_output_tokens: number;
	}): Promise<unknown>;
	listRunnerModelUsage(input: { p_profile_id: string; p_after_id: number; p_limit: number }): Promise<unknown>;
}

export interface CloudRunnerAdminDatabase {
	public: {
		Tables: Record<never, never>;
		Views: Record<never, never>;
		Functions: {
			qorpera_create_runner_registration: {
				Args: Parameters<CloudRunnerAdminTransport["createRunnerRegistration"]>[0];
				Returns: JsonValue;
			};
			qorpera_reissue_runner_activation: {
				Args: Parameters<CloudRunnerAdminTransport["reissueRunnerActivation"]>[0];
				Returns: JsonValue;
			};
			qorpera_list_runners: {
				Args: Parameters<CloudRunnerAdminTransport["listRunners"]>[0];
				Returns: JsonValue;
			};
			qorpera_revoke_runner: {
				Args: Parameters<CloudRunnerAdminTransport["revokeRunner"]>[0];
				Returns: JsonValue;
			};
			qorpera_enqueue_runner_job: {
				Args: Parameters<CloudRunnerAdminTransport["enqueueRunnerJob"]>[0];
				Returns: JsonValue;
			};
			qorpera_list_runner_jobs: {
				Args: Parameters<CloudRunnerAdminTransport["listRunnerJobs"]>[0];
				Returns: JsonValue;
			};
			qorpera_cancel_runner_job: {
				Args: Parameters<CloudRunnerAdminTransport["cancelRunnerJob"]>[0];
				Returns: JsonValue;
			};
			qorpera_list_runner_audit: {
				Args: Parameters<CloudRunnerAdminTransport["listRunnerAudit"]>[0];
				Returns: JsonValue;
			};
			qorpera_list_runner_usage: {
				Args: Parameters<CloudRunnerAdminTransport["listRunnerUsage"]>[0];
				Returns: JsonValue;
			};
			qorpera_configure_runner_model_policy: {
				Args: Parameters<CloudRunnerAdminTransport["configureRunnerModelPolicy"]>[0];
				Returns: JsonValue;
			};
			qorpera_list_runner_model_usage: {
				Args: Parameters<CloudRunnerAdminTransport["listRunnerModelUsage"]>[0];
				Returns: JsonValue;
			};
		};
	};
}

function rpcError(error: { message: string; code?: string }): Error {
	return new Error(error.code ? `${error.message} (${error.code})` : error.message);
}

export class SupabaseCloudRunnerAdminTransport implements CloudRunnerAdminTransport {
	readonly #client: SupabaseClient<CloudRunnerAdminDatabase>;

	constructor(client: SupabaseClient<CloudRunnerAdminDatabase>) {
		this.#client = client;
	}

	async createRunnerRegistration(
		input: Parameters<CloudRunnerAdminTransport["createRunnerRegistration"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.#client.rpc("qorpera_create_runner_registration", input);
		if (error) throw rpcError(error);
		return data;
	}

	async reissueRunnerActivation(
		input: Parameters<CloudRunnerAdminTransport["reissueRunnerActivation"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.#client.rpc("qorpera_reissue_runner_activation", input);
		if (error) throw rpcError(error);
		return data;
	}

	async listRunners(input: Parameters<CloudRunnerAdminTransport["listRunners"]>[0]): Promise<unknown> {
		const { data, error } = await this.#client.rpc("qorpera_list_runners", input);
		if (error) throw rpcError(error);
		return data;
	}

	async revokeRunner(input: Parameters<CloudRunnerAdminTransport["revokeRunner"]>[0]): Promise<unknown> {
		const { data, error } = await this.#client.rpc("qorpera_revoke_runner", input);
		if (error) throw rpcError(error);
		return data;
	}

	async enqueueRunnerJob(input: Parameters<CloudRunnerAdminTransport["enqueueRunnerJob"]>[0]): Promise<unknown> {
		const { data, error } = await this.#client.rpc("qorpera_enqueue_runner_job", input);
		if (error) throw rpcError(error);
		return data;
	}

	async listRunnerJobs(input: Parameters<CloudRunnerAdminTransport["listRunnerJobs"]>[0]): Promise<unknown> {
		const { data, error } = await this.#client.rpc("qorpera_list_runner_jobs", input);
		if (error) throw rpcError(error);
		return data;
	}

	async cancelRunnerJob(input: Parameters<CloudRunnerAdminTransport["cancelRunnerJob"]>[0]): Promise<unknown> {
		const { data, error } = await this.#client.rpc("qorpera_cancel_runner_job", input);
		if (error) throw rpcError(error);
		return data;
	}

	async listRunnerAudit(input: Parameters<CloudRunnerAdminTransport["listRunnerAudit"]>[0]): Promise<unknown> {
		const { data, error } = await this.#client.rpc("qorpera_list_runner_audit", input);
		if (error) throw rpcError(error);
		return data;
	}

	async listRunnerUsage(input: Parameters<CloudRunnerAdminTransport["listRunnerUsage"]>[0]): Promise<unknown> {
		const { data, error } = await this.#client.rpc("qorpera_list_runner_usage", input);
		if (error) throw rpcError(error);
		return data;
	}

	async configureRunnerModelPolicy(
		input: Parameters<CloudRunnerAdminTransport["configureRunnerModelPolicy"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.#client.rpc("qorpera_configure_runner_model_policy", input);
		if (error) throw rpcError(error);
		return data;
	}

	async listRunnerModelUsage(
		input: Parameters<CloudRunnerAdminTransport["listRunnerModelUsage"]>[0],
	): Promise<unknown> {
		const { data, error } = await this.#client.rpc("qorpera_list_runner_model_usage", input);
		if (error) throw rpcError(error);
		return data;
	}
}

function requiredUuid(value: string, label: string): void {
	if (!UUID_PATTERN.test(value)) throw new Error(`${label} is invalid`);
}

function capabilities(value: CloudRunnerCapability[]): CloudRunnerCapability[] {
	if (value.length < 1 || value.length > CLOUD_RUNNER_CAPABILITIES.length) {
		throw new Error("Runner capabilities are invalid");
	}
	if (!value.every((item) => CLOUD_RUNNER_CAPABILITIES.some((candidate) => candidate === item))) {
		throw new Error("Runner capabilities are invalid");
	}
	const normalized = [...value].sort();
	if (new Set(normalized).size !== normalized.length) throw new Error("Runner capabilities contain duplicates");
	return normalized;
}

function jsonObject(value: JsonValue, label: string): JsonValue {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
	const encoded = JSON.stringify(value);
	if (encoded === undefined || Buffer.byteLength(encoded) > MAX_JOB_BODY_BYTES)
		throw new Error(`${label} is too large`);
	return value;
}

function validatePairingSecret(secret: CloudRunnerPairingSecret): void {
	if (
		!SHA256_PATTERN.test(secret.activationTokenSha256) ||
		runnerActivationTokenSha256(secret.activationToken) !== secret.activationTokenSha256
	) {
		throw new Error("Runner activation token hash is invalid");
	}
}

function rows(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`Runner administration returned invalid ${label}`);
	return value;
}

export function prepareCloudRunnerRegistration(
	input: PrepareCloudRunnerRegistrationInput,
): PreparedCloudRunnerRegistration {
	requiredUuid(input.profileId, "Runner profile id");
	const clientRunnerId = input.clientRunnerId ?? randomUUID();
	requiredUuid(clientRunnerId, "Client runner id");
	const displayName = input.displayName.trim();
	if (!displayName || displayName.length > 120) throw new Error("Runner display name is invalid");
	const maxConcurrency = input.maxConcurrency ?? 1;
	if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 16) {
		throw new Error("Runner concurrency must be between 1 and 16");
	}
	return {
		profileId: input.profileId,
		clientRunnerId,
		displayName,
		capabilities: capabilities(input.capabilities),
		maxConcurrency,
		pairingSecret: createCloudRunnerPairingSecret(),
	};
}

export function prepareCloudRunnerActivation(runnerId: string): PreparedCloudRunnerActivation {
	requiredUuid(runnerId, "Runner id");
	return { runnerId, pairingSecret: createCloudRunnerPairingSecret() };
}

export class QorperaCloudRunnerAdmin {
	readonly #transport: CloudRunnerAdminTransport;

	constructor(transport: CloudRunnerAdminTransport) {
		this.#transport = transport;
	}

	async registerRunner(prepared: PreparedCloudRunnerRegistration): Promise<CloudRunnerRegistration> {
		requiredUuid(prepared.profileId, "Runner profile id");
		requiredUuid(prepared.clientRunnerId, "Client runner id");
		const displayName = prepared.displayName.trim();
		if (!displayName || displayName.length > 120) throw new Error("Runner display name is invalid");
		if (
			!Number.isSafeInteger(prepared.maxConcurrency) ||
			prepared.maxConcurrency < 1 ||
			prepared.maxConcurrency > 16
		) {
			throw new Error("Runner concurrency must be between 1 and 16");
		}
		validatePairingSecret(prepared.pairingSecret);
		const runner = parseCloudRunner(
			await this.#transport.createRunnerRegistration({
				p_profile_id: prepared.profileId,
				p_client_runner_id: prepared.clientRunnerId,
				p_display_name: displayName,
				p_capabilities: capabilities(prepared.capabilities),
				p_max_concurrency: prepared.maxConcurrency,
				p_activation_token_sha256: prepared.pairingSecret.activationTokenSha256,
			}),
		);
		if (runner.profileId !== prepared.profileId || runner.clientRunnerId !== prepared.clientRunnerId) {
			throw new Error("Runner registration returned another runner");
		}
		return { runner, activationToken: prepared.pairingSecret.activationToken };
	}

	async reissueRunnerActivation(prepared: PreparedCloudRunnerActivation): Promise<CloudRunnerRegistration> {
		requiredUuid(prepared.runnerId, "Runner id");
		validatePairingSecret(prepared.pairingSecret);
		const runner = parseCloudRunner(
			await this.#transport.reissueRunnerActivation({
				p_runner_id: prepared.runnerId,
				p_activation_token_sha256: prepared.pairingSecret.activationTokenSha256,
			}),
		);
		if (runner.runnerId !== prepared.runnerId || runner.status !== "pending") {
			throw new Error("Runner activation reissue returned another runner");
		}
		return { runner, activationToken: prepared.pairingSecret.activationToken };
	}

	async listRunners(profileId: string): Promise<CloudRunner[]> {
		requiredUuid(profileId, "Runner profile id");
		return rows(await this.#transport.listRunners({ p_profile_id: profileId }), "runner list").map(parseCloudRunner);
	}

	async revokeRunner(runnerId: string): Promise<CloudRunner> {
		requiredUuid(runnerId, "Runner id");
		return parseCloudRunner(await this.#transport.revokeRunner({ p_runner_id: runnerId }));
	}

	async enqueueJob(input: EnqueueCloudRunnerJobInput): Promise<CloudRunnerJob> {
		requiredUuid(input.environmentId, "Runner job environment id");
		if (input.sessionId) requiredUuid(input.sessionId, "Runner job session id");
		requiredUuid(input.substrateVersionId, "Runner job substrate id");
		requiredUuid(input.clientJobId, "Runner client job id");
		if (!CLOUD_RUNNER_CAPABILITIES.some((candidate) => candidate === input.requiredCapability)) {
			throw new Error("Runner job capability is invalid");
		}
		if (!/^[a-z][a-z0-9_-]{0,63}$/.test(input.jobType)) throw new Error("Runner job type is invalid");
		return parseCloudRunnerJob(
			await this.#transport.enqueueRunnerJob({
				p_environment_id: input.environmentId,
				p_session_id: input.sessionId ?? null,
				p_substrate_version_id: input.substrateVersionId,
				p_client_job_id: input.clientJobId,
				p_required_capability: input.requiredCapability,
				p_job_type: input.jobType,
				p_payload: jsonObject(input.payload, "Runner job payload"),
			}),
		);
	}

	async listJobs(profileId: string, limit = 200): Promise<CloudRunnerJob[]> {
		requiredUuid(profileId, "Runner profile id");
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
			throw new Error("Runner job page size must be between 1 and 500");
		}
		return rows(
			await this.#transport.listRunnerJobs({ p_profile_id: profileId, p_limit: limit }),
			"runner job list",
		).map(parseCloudRunnerJob);
	}

	async cancelJob(jobId: string): Promise<CloudRunnerJob> {
		requiredUuid(jobId, "Runner job id");
		return parseCloudRunnerJob(await this.#transport.cancelRunnerJob({ p_job_id: jobId }));
	}

	async listAudit(profileId: string, afterReceiptId = 0, limit = 200): Promise<CloudRunnerAuditReceipt[]> {
		requiredUuid(profileId, "Runner profile id");
		if (!Number.isSafeInteger(afterReceiptId) || afterReceiptId < 0) {
			throw new Error("Runner audit cursor must be a non-negative integer");
		}
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
			throw new Error("Runner audit page size must be between 1 and 500");
		}
		return rows(
			await this.#transport.listRunnerAudit({
				p_profile_id: profileId,
				p_after_id: afterReceiptId,
				p_limit: limit,
			}),
			"runner audit list",
		).map(parseCloudRunnerAuditReceipt);
	}

	async listUsage(profileId: string, afterObservationId = 0, limit = 200): Promise<CloudRunnerUsageObservation[]> {
		requiredUuid(profileId, "Runner profile id");
		if (!Number.isSafeInteger(afterObservationId) || afterObservationId < 0) {
			throw new Error("Runner usage cursor must be a non-negative integer");
		}
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
			throw new Error("Runner usage page size must be between 1 and 500");
		}
		return rows(
			await this.#transport.listRunnerUsage({
				p_profile_id: profileId,
				p_after_id: afterObservationId,
				p_limit: limit,
			}),
			"runner usage list",
		).map(parseCloudRunnerUsageObservation);
	}

	async configureModelPolicy(input: ConfigureCloudRunnerModelPolicyInput): Promise<CloudRunnerModelPolicy> {
		requiredUuid(input.jobId, "Runner model policy job id");
		if (!Number.isSafeInteger(input.maxCalls) || input.maxCalls < 1 || input.maxCalls > 128) {
			throw new Error("Runner model policy call limit must be between 1 and 128");
		}
		if (
			!Number.isSafeInteger(input.maxInputTokens) ||
			input.maxInputTokens < 1 ||
			input.maxInputTokens > 100_000_000 ||
			!Number.isSafeInteger(input.maxOutputTokens) ||
			input.maxOutputTokens < 1 ||
			input.maxOutputTokens > 100_000_000
		) {
			throw new Error("Runner model policy token limits are invalid");
		}
		const allowedModels: JsonValue = normalizeCloudRunnerAllowedModels(input.allowedModels).map(
			(entry): JsonValue => ({ provider: entry.provider, model: entry.model }),
		);
		return parseCloudRunnerModelPolicy(
			await this.#transport.configureRunnerModelPolicy({
				p_job_id: input.jobId,
				p_allowed_models: allowedModels,
				p_max_calls: input.maxCalls,
				p_max_input_tokens: input.maxInputTokens,
				p_max_output_tokens: input.maxOutputTokens,
			}),
		);
	}

	async listModelUsage(
		profileId: string,
		afterObservationId = 0,
		limit = 200,
	): Promise<CloudRunnerModelUsageObservation[]> {
		requiredUuid(profileId, "Runner profile id");
		if (!Number.isSafeInteger(afterObservationId) || afterObservationId < 0) {
			throw new Error("Runner model usage cursor must be a non-negative integer");
		}
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
			throw new Error("Runner model usage page size must be between 1 and 500");
		}
		return rows(
			await this.#transport.listRunnerModelUsage({
				p_profile_id: profileId,
				p_after_id: afterObservationId,
				p_limit: limit,
			}),
			"runner model usage list",
		).map(parseCloudRunnerModelUsageObservation);
	}
}
