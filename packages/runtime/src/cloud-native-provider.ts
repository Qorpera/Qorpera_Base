import type { NativeProviderLoginAuthorization } from "@qorpera/cloud-client/cloud-native-subscription-control";
import { readBoundedCloudResponse } from "@qorpera/cloud-client/cloud-request";
import {
	HttpNativeProviderIdentityBridge,
	type NativeProviderIdentityBridge,
	type NativeProviderLoginPrompt,
} from "@qorpera/cloud-client/native-provider-login";
import type { JsonValue } from "@qorpera/contracts";
import { isNativeHostPublishableKey } from "./cloud-native-host-dispatch.ts";
import type { CloudRunnerNativeAuthority } from "./cloud-runner-broker.ts";
import type {
	CloudRunnerSandboxGuarantees,
	CloudRunnerSandboxProcess,
	CloudRunnerSandboxRequest,
} from "./cloud-runner-sandbox.ts";

const BRIDGE_REQUEST_SCHEMA = "qorpera.native-provider-execution/v1";
const BRIDGE_CANCEL_SCHEMA = "qorpera.native-provider-cancel/v1";
const BRIDGE_RESPONSE_SCHEMA = "qorpera.native-provider-result/v1";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
// The result plus a keepalive newline a minute (years of them fit).
const MAX_BRIDGE_RESPONSE_BYTES = 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_SESSION_PATTERN = /^[^\0\r\n]{1,1024}$/;

export interface NativeProviderComputerBridge {
	readonly executionGuarantees: Readonly<CloudRunnerSandboxGuarantees>;
	/**
	 * Application boundary: only this trusted computer-side bridge may unwrap a
	 * capsule for the unmodified provider harness. This does not assert that the
	 * infrastructure operator is cryptographically blind to an unattested VM.
	 * No Company File mount, local context, artifact directory or model-chosen route.
	 */
	startCompany?(
		authority: CloudRunnerNativeAuthority,
		job: { jobId: string; attemptCount: number; leaseToken?: string },
	): Promise<CloudRunnerSandboxProcess>;
}

export type NativeProviderExecutionBoundary = CloudRunnerSandboxGuarantees["boundary"];

export function nativeProviderExecutionGuarantees(
	boundary: NativeProviderExecutionBoundary,
): Readonly<CloudRunnerSandboxGuarantees> {
	return Object.freeze({
		boundary,
		hostFilesystem: "none",
		inputFilesystem: "read_only",
		companyCheckout: "job_private",
		outputFilesystem: "job_private",
		network: "deny_by_default",
		environment: "allowlist_only",
		privileges: "unprivileged",
		resourceLimits: "kernel_enforced",
		termination: "boundary_destroyed",
	});
}

export function parseNativeHarnessResult(
	value: unknown,
	runId: string,
	requireFinalSend = true,
): {
	schema: "qorpera.native-harness-result/v2";
	run_id: string;
	message_count: number;
	final_message_id: string | null;
	provider_session_id: string | null;
} {
	const result = record(value, "Native harness result");
	if (
		result.schema !== "qorpera.native-harness-result/v2" ||
		result.run_id !== runId ||
		!Number.isSafeInteger(result.message_count) ||
		(result.message_count as number) < (requireFinalSend ? 1 : 0) ||
		(result.message_count as number) > 2000 ||
		(result.message_count === 0
			? result.final_message_id !== null
			: typeof result.final_message_id !== "string" || !UUID_PATTERN.test(result.final_message_id)) ||
		(result.provider_session_id !== null &&
			(typeof result.provider_session_id !== "string" ||
				!PROVIDER_SESSION_PATTERN.test(result.provider_session_id))) ||
		Object.keys(result).some(
			(key) => !["schema", "run_id", "message_count", "final_message_id", "provider_session_id"].includes(key),
		)
	) {
		throw new Error("Native harness returned an invalid private completion receipt");
	}
	return {
		schema: "qorpera.native-harness-result/v2",
		run_id: runId,
		message_count: result.message_count as number,
		final_message_id: result.final_message_id as string | null,
		provider_session_id: result.provider_session_id as string | null,
	};
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
	return value as Record<string, unknown>;
}

function assertNoCredentialMaterial(value: unknown, label: string): void {
	const pending: unknown[] = [value];
	while (pending.length > 0) {
		const current = pending.pop();
		if (Array.isArray(current)) {
			pending.push(...current);
			continue;
		}
		if (!current || typeof current !== "object") continue;
		for (const [key, child] of Object.entries(current)) {
			if (
				/^(token|(access|refresh|oauth|id|session|bearer|api)[_-]?token)$/i.test(key) ||
				/^(authorization|cookie|password|secret|api[_-]?key|credential|credential[_-]?store|provider[_-]?secret)$/i.test(
					key,
				)
			) {
				throw new Error(`${label} crossed the credential boundary`);
			}
			pending.push(child);
		}
	}
}

function bridgeUrl(value: string): URL {
	const url = new URL(value);
	if (
		(url.protocol !== "https:" &&
			!(url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"))) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new Error("Native provider bridge URL must use HTTPS or loopback transport");
	}
	return url;
}

function bridgeAuthorityProjection(authority: CloudRunnerNativeAuthority): JsonValue {
	return {
		lease_id: authority.leaseId,
		run_id: authority.runId,
		provider_connection_id: authority.providerConnectionId,
		provider_connection_version: authority.providerConnectionVersion,
		credential_capsule_id: authority.credentialCapsuleId,
		encrypted_capsule_reference: authority.encryptedCapsuleReference,
		attestation_policy_sha256: authority.attestationPolicySha256,
		compute_identity_id: authority.computeIdentityId,
		compute_identity_ownership_kind: authority.computeIdentityOwnershipKind,
		compute_identity_owner_user_id: authority.computeIdentityOwnerUserId ?? null,
		compute_identity_owner_scope_key: authority.computeIdentityOwnerScopeKey ?? null,
		credential_ownership_kind: authority.credentialOwnershipKind,
		credential_owner_user_id: authority.credentialOwnerUserId ?? null,
		credential_owner_scope_key: authority.credentialOwnerScopeKey ?? null,
		provider: authority.provider,
		authentication_mode: authority.authenticationMode,
		native_harness: authority.nativeHarness,
		model: authority.model,
		runner_id: authority.runnerId,
		assignment_id: authority.assignmentId,
		expires_at: authority.expiresAt,
	};
}

function bridgeProjection(authority: CloudRunnerNativeAuthority, request: CloudRunnerSandboxRequest): JsonValue {
	return {
		schema: BRIDGE_REQUEST_SCHEMA,
		authority: bridgeAuthorityProjection(authority),
		job: {
			job_id: request.job.jobId,
			job_type: request.job.jobType,
			required_capability: request.job.requiredCapability,
			attempt_count: request.job.attemptCount,
			payload: request.job.payload,
		},
		input: {
			company_base_root: request.input.companyBaseRoot,
			company_root: request.input.companyRoot,
			proposal_root: request.input.proposalRoot ?? null,
			execution_context_path: request.input.executionContextPath,
			queued_inputs_path: request.input.queuedInputsPath,
			transcript_path: request.input.transcriptPath,
			substrate_manifest_path: request.input.substrateManifestPath,
			operations_path: request.input.operationsPath,
			artifacts_root: request.input.artifactsRoot,
			attachments_root: request.input.attachmentsRoot,
			output_root: request.outputRoot,
		},
		limits: {
			wall_time_ms: request.limits.wallTimeMs,
			memory_bytes: request.limits.memoryBytes,
			cpu_count: request.limits.cpuCount,
			max_pids: request.limits.maxPids,
			max_input_bytes: request.limits.maxInputBytes,
			max_output_bytes: request.limits.maxOutputBytes,
			max_result_bytes: request.limits.maxResultBytes,
		},
	};
}

/** The fixed code a provider's refusal carries (nativeProviderFailureCode), if well formed. */
function bridgeRefusalCode(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const code = (value as { code?: unknown }).code;
	return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,41}(:[A-Z0-9][A-Z0-9_]{0,41})?$/.test(code) ? code : undefined;
}
/** The runner's report of a refused bridge request: its status and, when the
 * provider named one, its fixed code (never provider text). */
function bridgeRefusal(status: number, code: string | undefined): Error {
	return new Error(`Native provider bridge request failed (${status})${code ? ` [code=${code}]` : ""}`);
}

export class HttpNativeProviderComputerBridge implements NativeProviderComputerBridge, NativeProviderIdentityBridge {
	readonly executionGuarantees: Readonly<CloudRunnerSandboxGuarantees>;
	readonly #executeUrl: string;
	readonly #cancelUrl: string;
	readonly #loginUrl: string;
	readonly #bridgeToken?: string;
	readonly #fetch: typeof fetch;
	readonly #signal?: AbortSignal;
	readonly #requestTimeoutMs: number | undefined;
	readonly #publishableKey?: string;
	readonly #identityCredential?: string;

	constructor(
		baseUrl: string,
		bridgeToken?: string,
		fetchImplementation: typeof fetch = fetch,
		options: {
			signal?: AbortSignal;
			requestTimeoutMs?: number;
			executionBoundary?: NativeProviderExecutionBoundary;
			/** The project's publishable key, sent with each company execution for the host's calls (G2-2). */
			publishableKey?: string;
			/** On an execution host's slot, this run's machine's identity credential, sent with each execution (G2-3). */
			identityCredential?: string;
		} = {},
	) {
		const base = bridgeUrl(baseUrl);
		if (bridgeToken !== undefined && !TOKEN_PATTERN.test(bridgeToken)) {
			throw new Error("Native provider bridge capability is invalid");
		}
		this.#executeUrl = new URL("execute", base).href;
		this.#cancelUrl = new URL("cancel", base).href;
		this.#loginUrl = new URL("login", base).href;
		this.#bridgeToken = bridgeToken;
		this.#fetch = fetchImplementation;
		this.#signal = options.signal;
		// Sent only when it is a publishable key; a host whose calls need it refuses the execution without it.
		if (isNativeHostPublishableKey(options.publishableKey)) this.#publishableKey = options.publishableKey;
		if (options.identityCredential !== undefined) {
			if (!TOKEN_PATTERN.test(options.identityCredential)) throw new Error("Native identity credential is invalid");
			this.#identityCredential = options.identityCredential;
		}
		// A run has no deadline (founder, 2026-09-24); a timeout is a test or operator choice.
		this.#requestTimeoutMs = options.requestTimeoutMs;
		this.executionGuarantees = nativeProviderExecutionGuarantees(options.executionBoundary ?? "test");
		if (
			this.#requestTimeoutMs !== undefined &&
			(!Number.isSafeInteger(this.#requestTimeoutMs) ||
				this.#requestTimeoutMs < 1 ||
				this.#requestTimeoutMs > 2 ** 31 - 1)
		) {
			throw new Error("Native provider bridge timeout is invalid");
		}
	}
	async beginLogin(authorization: NativeProviderLoginAuthorization): Promise<NativeProviderLoginPrompt> {
		return new HttpNativeProviderIdentityBridge(this.#loginUrl, this.#fetch, { signal: this.#signal }).beginLogin(
			authorization,
		);
	}

	/** The snapshot-v1 execution request. No runner sends it any more; it goes with the native
	 * host's legacy lane and the tests that still drive that lane (legacy sweep step C, C-R3). */
	async start(
		authority: CloudRunnerNativeAuthority,
		request: CloudRunnerSandboxRequest,
	): Promise<CloudRunnerSandboxProcess> {
		if (
			!this.#bridgeToken ||
			authority.authenticationMode !== "native_subscription" ||
			request.job.jobType !== "agent_turn" ||
			request.job.requiredCapability !== "agent_turn"
		) {
			throw new Error("Native provider bridge received an unsupported execution");
		}
		return this.#startExecution(authority, bridgeProjection(authority, request));
	}

	async startCompany(
		authority: CloudRunnerNativeAuthority,
		job: { jobId: string; attemptCount: number; leaseToken?: string },
	): Promise<CloudRunnerSandboxProcess> {
		if (
			!this.#bridgeToken ||
			authority.authenticationMode !== "native_subscription" ||
			authority.provider !== "openai" ||
			authority.nativeHarness !== "codex-cli" ||
			!UUID_PATTERN.test(job.jobId) ||
			!Number.isSafeInteger(job.attemptCount) ||
			job.attemptCount < 1 ||
			(job.leaseToken !== undefined && !TOKEN_PATTERN.test(job.leaseToken))
		) {
			throw new Error("Native provider bridge received an unsupported company runtime");
		}
		// G2-2: the job's lease token and the publishable key travel with the execution, for the host's calls
		// through qorpera_native_host_call; the host holds them for that execution only.
		const credential =
			job.leaseToken !== undefined && this.#publishableKey !== undefined
				? { leaseToken: job.leaseToken, publishableKey: this.#publishableKey }
				: undefined;
		return this.#startExecution(authority, {
			schema: "qorpera.native-company-execution/v1",
			authority: bridgeAuthorityProjection(authority),
			job: {
				job_id: job.jobId,
				attempt_count: job.attemptCount,
				...(credential ? { lease_token: credential.leaseToken } : {}),
			},
			...(credential
				? {
						native_host: {
							publishable_key: credential.publishableKey,
							...(this.#identityCredential !== undefined
								? { identity_credential: this.#identityCredential }
								: {}),
						},
					}
				: {}),
		});
	}

	async #startExecution(authority: CloudRunnerNativeAuthority, body: JsonValue): Promise<CloudRunnerSandboxProcess> {
		const executionAbort = new AbortController();
		const result = this.#request(
			this.#executeUrl,
			body,
			AbortSignal.any([
				executionAbort.signal,
				...(this.#requestTimeoutMs === undefined ? [] : [AbortSignal.timeout(this.#requestTimeoutMs)]),
				...(this.#signal ? [this.#signal] : []),
			]),
		).then((value) => {
			const envelope = record(value, "Native provider bridge response");
			if (
				envelope.schema !== BRIDGE_RESPONSE_SCHEMA ||
				envelope.lease_id !== authority.leaseId ||
				Object.keys(envelope).some((key) => !["schema", "lease_id", "result"].includes(key))
			) {
				throw new Error("Native provider bridge returned another execution");
			}
			assertNoCredentialMaterial(envelope.result, "Native provider result");
			return parseNativeHarnessResult(envelope.result, authority.runId, false);
		});
		let terminated = false;
		return {
			result,
			terminate: async (reason) => {
				if (terminated) return;
				terminated = true;
				executionAbort.abort(new Error(`Native provider execution ${reason}`));
				await this.#request(
					this.#cancelUrl,
					{
						schema: BRIDGE_CANCEL_SCHEMA,
						lease_id: authority.leaseId,
						run_id: authority.runId,
						assignment_id: authority.assignmentId,
						reason,
					},
					AbortSignal.timeout(10_000),
				).catch(() => undefined);
			},
		};
	}

	async #request(
		url: string,
		body: JsonValue,
		signal: AbortSignal,
		bearerToken = this.#bridgeToken,
	): Promise<unknown> {
		if (!bearerToken) throw new Error("Native provider bridge capability is not configured");
		signal.throwIfAborted();
		let abort = (): void => {};
		const cancelled = new Promise<never>((_resolve, reject) => {
			abort = () => reject(new Error("Native provider bridge request stopped"));
			signal.addEventListener("abort", abort, { once: true });
		});
		try {
			return await Promise.race([
				cancelled,
				Promise.resolve().then(async () => {
					signal.throwIfAborted();
					const response = await this.#fetch(url, {
						method: "POST",
						headers: {
							accept: "application/json",
							authorization: `Bearer ${bearerToken}`,
							"content-type": "application/json",
						},
						body: JSON.stringify(body),
						redirect: "error",
						signal,
					});
					if (!response.ok) {
						// A refusal names its fixed code; nothing else of the body is kept.
						// Read for at most 5 s: a stalled body never holds the runner.
						let code: string | undefined;
						if (response.status === 422)
							try {
								code = bridgeRefusalCode(
									JSON.parse(
										new TextDecoder("utf-8", { fatal: true }).decode(
											await readBoundedCloudResponse(
												response,
												4096,
												AbortSignal.any([signal, AbortSignal.timeout(5000)]),
											),
										),
									),
								);
							} catch {
								/* The status alone is reported. */
								void response.body?.cancel().catch(() => undefined);
							}
						else void response.body?.cancel().catch(() => undefined);
						throw bridgeRefusal(response.status, code);
					}
					const bytes = await readBoundedCloudResponse(response, MAX_BRIDGE_RESPONSE_BYTES, signal);
					let value: unknown;
					try {
						// An execution answers 200 at once with keepalive newlines; JSON allows the leading whitespace.
						value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
					} catch {
						throw new Error("Native provider bridge returned invalid JSON");
					}
					// A failure after the execution answered 200 arrives in the body.
					if (
						value &&
						typeof value === "object" &&
						!Array.isArray(value) &&
						["error", "code,error"].includes(Object.keys(value).sort().join())
					)
						throw bridgeRefusal(422, bridgeRefusalCode(value));
					return value;
				}),
			]);
		} finally {
			signal.removeEventListener("abort", abort);
		}
	}
}
