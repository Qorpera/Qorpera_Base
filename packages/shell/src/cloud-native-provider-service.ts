import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import type { JsonValue } from "@qorpera/contracts";
import {
	type CloudAgentSendInput,
	type CloudAgentSendReceipt,
	parseCloudAgentSendInput,
	parseCloudAgentSendReceipt,
} from "./cloud-agent-mouth.ts";
import type {
	CompleteNativeProviderLoginInput,
	NativeCredentialCapsuleStore,
	NativeProviderControlPlane,
	NativeProviderExecutionRequest,
	NativeProviderHost,
	NativeProviderLoginDescription,
	NativeProviderLoginRequest,
} from "./cloud-native-provider-host.ts";

const LOGIN_SCHEMA = "qorpera.native-provider-login/v1";
const EXECUTION_SCHEMA = "qorpera.native-provider-execution/v1";
const CANCEL_SCHEMA = "qorpera.native-provider-cancel/v1";
const RESULT_SCHEMA = "qorpera.native-provider-result/v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_CAPSULE_BYTES = 64 * 1024 * 1024 + 1024 * 1024;
const CAPSULE_BUCKET = "qorpera-native-compute-capsules";

function supabaseServiceHeaders(serviceKey: string): Record<string, string> {
	const headers: Record<string, string> = { apikey: serviceKey };
	if (serviceKey.startsWith("eyJ") && serviceKey.split(".").length === 3) {
		headers.authorization = `Bearer ${serviceKey}`;
	}
	return headers;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
	return value as Record<string, unknown>;
}

function uuid(value: unknown, label: string): string {
	if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error(`${label} is invalid`);
	return value;
}

function text(value: unknown, label: string, maximum = 512): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\0\r\n]/.test(value)) {
		throw new Error(`${label} is invalid`);
	}
	return value;
}

function nullableUuid(value: unknown, label: string): string | undefined {
	return value === null || value === undefined ? undefined : uuid(value, label);
}

function nullableText(value: unknown, label: string, maximum = 512): string | undefined {
	return value === null || value === undefined ? undefined : text(value, label, maximum);
}

function internalRejectionCategory(error: unknown): string {
	let current = error;
	for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
		const code = (current as NodeJS.ErrnoException).code;
		if (current.name === "AbortError" || code === "ABORT_ERR") return "cancelled";
		if (current.name === "TimeoutError" || code === "ETIMEDOUT") return "timeout";
		if (["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EROFS", "EISDIR", "ENOTEMPTY"].includes(code ?? "")) {
			return "filesystem";
		}
		if (["ENOSPC", "EMFILE", "ENFILE", "ENOMEM"].includes(code ?? "")) return "resource";
		if (["EPIPE", "ERR_STREAM_WRITE_AFTER_END"].includes(code ?? "")) return "process";
		if (current.cause instanceof Error) {
			current = current.cause;
			continue;
		}
		if (current.name === "TypeError") return "type-error";
		if (current.name === "SyntaxError") return "syntax-error";
		if (current.name === "RangeError") return "range-error";
		if (current.name === "AggregateError") return "aggregate-error";
		return "error";
	}
	return "unknown";
}

function safeRequestDiagnostic(error: unknown): string {
	const message = error instanceof Error ? error.message : "";
	const diagnostic = message.replace(/ \[mouth=(?:uninitialized|initialized|ready|send-unconfirmed|delivered)\]$/, "");
	if (
		/^Provider harness exited with [A-Za-z0-9_-]{1,32}(?: \((?:authentication|model|provider allowance|provider capacity|provider context|provider network|provider policy|local sandbox|provider request|provider authorization|provider tool schema|harness configuration|harness internal|public message transport) unavailable\))?$/.test(
			diagnostic,
		) ||
		/^Codex did not complete its turn(?: \((?:authentication|model|provider allowance|provider capacity|provider context|provider network|provider policy|local sandbox|provider request|provider authorization|provider tool schema|harness configuration|harness internal|public message transport) unavailable\))?$/.test(
			diagnostic,
		) ||
		/^Native provider execution (?:initial-authority-validation|temporary-workspace|credential-download|credential-opening|prompt-materialization|public-mouth-start|public-mouth-completion|harness-execution|workspace-normalization|completion-authority-validation|credential-sealing|credential-upload|authority-monitor|cleanup|internal-completion) stage failed(?: \((?:storage-budget|unsupported-entry|invalid-path|symbolic-link|filesystem-(?:not-found|permission|read-only|layout)|resource-(?:capacity|file-descriptors|memory)|process-pipe|cancelled|timeout|unknown)\))?$/.test(
			diagnostic,
		) ||
		diagnostic === "Provider harness output exceeded its byte limit"
	) {
		return message;
	}
	const messageSha256 = createHash("sha256").update(message).digest("hex").slice(0, 16);
	return `internal rejection (${internalRejectionCategory(error)}; message-sha256=${messageSha256})`;
}

function ownership(
	value: unknown,
	ownerUserId: unknown,
	ownerScopeKey: unknown,
): Pick<
	NativeProviderLoginRequest,
	"computeIdentityOwnershipKind" | "computeIdentityOwnerUserId" | "computeIdentityOwnerScopeKey"
> {
	if (value !== "member" && value !== "company" && value !== "department" && value !== "security_boundary") {
		throw new Error("Native compute ownership is invalid");
	}
	const userId = nullableUuid(ownerUserId, "Native compute owner user id");
	const scopeKey = nullableText(ownerScopeKey, "Native compute owner scope", 160);
	if (
		(value === "member" && (!userId || scopeKey)) ||
		(value === "company" && (userId || scopeKey)) ||
		((value === "department" || value === "security_boundary") && (userId || !scopeKey))
	) {
		throw new Error("Native compute ownership is inconsistent");
	}
	return {
		computeIdentityOwnershipKind: value,
		...(userId ? { computeIdentityOwnerUserId: userId } : {}),
		...(scopeKey ? { computeIdentityOwnerScopeKey: scopeKey } : {}),
	};
}

function parseHarness(value: unknown): "codex-cli" | "claude-code" {
	if (value !== "codex-cli" && value !== "claude-code") throw new Error("Native harness is invalid");
	return value;
}

function parseProvider(value: unknown): "openai" | "anthropic" {
	if (value !== "openai" && value !== "anthropic") throw new Error("Native provider is invalid");
	return value;
}

function parseLogin(value: unknown): NativeProviderLoginRequest {
	const input = record(value, "Native login request");
	if (input.schema !== LOGIN_SCHEMA || !TOKEN_PATTERN.test(String(input.login_capability))) {
		throw new Error("Native login request is invalid");
	}
	return {
		loginId: uuid(input.login_id, "Native login id"),
		clientConnectionId: uuid(input.client_connection_id, "Native client connection id"),
		computeIdentityId: uuid(input.compute_identity_id, "Native compute identity id"),
		...ownership(
			input.compute_identity_ownership_kind,
			input.compute_identity_owner_user_id,
			input.compute_identity_owner_scope_key,
		),
		provider: parseProvider(input.provider),
		nativeHarness: parseHarness(input.native_harness),
		capability: input.login_capability as string,
		expiresAt: new Date(text(input.expires_at, "Native login expiry", 64)).toISOString(),
	};
}

function parseExecution(value: unknown): NativeProviderExecutionRequest {
	const input = record(value, "Native execution request");
	if (input.schema !== EXECUTION_SCHEMA) throw new Error("Native execution schema is invalid");
	const authority = record(input.authority, "Native execution authority");
	const job = record(input.job, "Native execution job");
	const paths = record(input.input, "Native execution paths");
	if (
		authority.authentication_mode !== "native_subscription" ||
		job.job_type !== "agent_turn" ||
		job.required_capability !== "agent_turn" ||
		!Number.isSafeInteger(job.attempt_count) ||
		(job.attempt_count as number) < 1
	) {
		throw new Error("Native execution request is invalid");
	}
	const model = text(authority.model, "Native execution model", 160);
	return {
		authority: {
			leaseId: uuid(authority.lease_id, "Native lease id"),
			runId: uuid(authority.run_id, "Native run id"),
			credentialCapsuleId: uuid(authority.credential_capsule_id, "Native capsule id"),
			encryptedCapsuleReference: text(authority.encrypted_capsule_reference, "Native capsule reference"),
			attestationPolicySha256: text(authority.attestation_policy_sha256, "Native attestation hash", 64),
			computeIdentityId: uuid(authority.compute_identity_id, "Native compute identity id"),
			runnerId: uuid(authority.runner_id, "Native runner id"),
			assignmentId: uuid(authority.assignment_id, "Native assignment id"),
			provider: parseProvider(authority.provider),
			nativeHarness: parseHarness(authority.native_harness),
			model,
			expiresAt: new Date(text(authority.expires_at, "Native authority expiry", 64)).toISOString(),
		},
		job: {
			jobId: uuid(job.job_id, "Native job id"),
			jobType: "agent_turn",
			requiredCapability: "agent_turn",
			attemptCount: job.attempt_count as number,
			payload: job.payload as JsonValue,
		},
		input: {
			companyRoot: text(paths.company_root, "Native Company File root", 4096),
			executionContextPath: text(paths.execution_context_path, "Native execution context path", 4096),
			queuedInputsPath: text(paths.queued_inputs_path, "Native queued inputs path", 4096),
			transcriptPath: text(paths.transcript_path, "Native transcript path", 4096),
		},
		outputRoot: text(paths.output_root, "Native output root", 4096),
	};
}

function tokenMatches(expected: string, authorization: string | undefined): boolean {
	if (!authorization?.startsWith("Bearer ")) return false;
	const left = Buffer.from(expected, "utf-8");
	const right = Buffer.from(authorization.slice("Bearer ".length), "utf-8");
	return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function sourceMatches(expected: string | undefined, remoteAddress: string | undefined): boolean {
	if (!expected) return true;
	const normalized = remoteAddress?.startsWith("::ffff:") ? remoteAddress.slice("::ffff:".length) : remoteAddress;
	return normalized === expected;
}

export class SupabaseNativeProviderControlPlane implements NativeProviderControlPlane {
	readonly #rpcUrl: string;
	readonly #serviceKey: string;
	readonly #fetch: typeof fetch;

	constructor(baseUrl: string, serviceKey: string, fetchImplementation: typeof fetch = fetch) {
		const url = new URL("/rest/v1/rpc/", baseUrl);
		if (
			url.protocol !== "https:" &&
			!(url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"))
		) {
			throw new Error("Native control-plane URL must use HTTPS");
		}
		if (!serviceKey.trim() || /[\0\r\n]/.test(serviceKey)) throw new Error("Native service key is invalid");
		this.#rpcUrl = url.href;
		this.#serviceKey = serviceKey;
		this.#fetch = fetchImplementation;
	}

	async describeLogin(
		loginId: string,
		capability: string,
		signal?: AbortSignal,
	): Promise<NativeProviderLoginDescription> {
		const value = record(
			await this.#rpc(
				"qorpera_describe_native_provider_login",
				{
					p_login_id: loginId,
					p_capability_sha256: createHash("sha256").update(capability).digest("hex"),
				},
				signal,
			),
			"Native login description",
		);
		return {
			loginId: uuid(value.login_id, "Native login id"),
			profileId: uuid(value.profile_id, "Native login profile id"),
			clientConnectionId: uuid(value.client_connection_id, "Native client connection id"),
			computeIdentityId: uuid(value.compute_identity_id, "Native compute identity id"),
			...ownership(
				value.compute_identity_ownership_kind,
				value.compute_identity_owner_user_id,
				value.compute_identity_owner_scope_key,
			),
			provider: parseProvider(value.provider),
			nativeHarness: parseHarness(value.native_harness),
			expiresAt: new Date(text(value.expires_at, "Native login expiry", 64)).toISOString(),
		};
	}

	async completeLogin(input: CompleteNativeProviderLoginInput, signal?: AbortSignal): Promise<void> {
		await this.#rpc(
			"qorpera_complete_native_provider_login",
			{
				p_login_id: input.loginId,
				p_capability_sha256: createHash("sha256").update(input.capability).digest("hex"),
				p_capsule_id: input.capsuleId,
				p_encrypted_capsule_reference: input.encryptedCapsuleReference,
				p_attestation_policy_sha256: input.attestationPolicySha256,
				p_provider_account_reference: input.providerAccountReference ?? null,
				p_billing_source: "personal_subscription",
				p_consent_version: "qorpera-native-subscription-v1",
				p_quota_policy: {
					monthly_microusd: 1,
					reservation_microusd: 1,
					max_calls_per_run: 128,
					max_input_tokens_per_run: 100_000_000,
					max_output_tokens_per_run: 100_000_000,
					max_concurrent_runs: 1,
				},
			},
			signal,
		);
	}

	async validateExecution(request: NativeProviderExecutionRequest, signal?: AbortSignal): Promise<void> {
		await this.#rpc(
			"qorpera_validate_native_provider_execution_lease",
			{
				p_lease_id: request.authority.leaseId,
				p_run_id: request.authority.runId,
				p_job_id: request.job.jobId,
				p_runner_id: request.authority.runnerId,
				p_assignment_id: request.authority.assignmentId,
				p_credential_capsule_id: request.authority.credentialCapsuleId,
				p_compute_identity_id: request.authority.computeIdentityId,
				p_provider: request.authority.provider,
				p_native_harness: request.authority.nativeHarness,
			},
			signal,
		);
	}

	async sendMessage(
		request: NativeProviderExecutionRequest,
		input: CloudAgentSendInput,
		signal?: AbortSignal,
	): Promise<CloudAgentSendReceipt> {
		const message = parseCloudAgentSendInput(input);
		const receipt = await this.#rpc(
			"qorpera_send_native_agent_message",
			{
				p_lease_id: request.authority.leaseId,
				p_run_id: request.authority.runId,
				p_job_id: request.job.jobId,
				p_runner_id: request.authority.runnerId,
				p_assignment_id: request.authority.assignmentId,
				p_credential_capsule_id: request.authority.credentialCapsuleId,
				p_compute_identity_id: request.authority.computeIdentityId,
				p_provider: request.authority.provider,
				p_native_harness: request.authority.nativeHarness,
				p_idempotency_key: message.idempotencyKey,
				p_text: message.text,
				p_phase: message.phase,
			},
			signal,
		);
		return parseCloudAgentSendReceipt(receipt, request.authority.runId);
	}

	async #rpc(name: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		const response = await this.#fetch(new URL(name, this.#rpcUrl), {
			method: "POST",
			headers: {
				...supabaseServiceHeaders(this.#serviceKey),
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
		});
		if (!response.ok) throw new Error(`Native control-plane RPC failed (${response.status})`);
		return response.json() as Promise<unknown>;
	}
}

export class SupabaseNativeCredentialCapsuleStore implements NativeCredentialCapsuleStore {
	readonly #objectUrl: string;
	readonly #serviceKey: string;
	readonly #fetch: typeof fetch;

	constructor(baseUrl: string, serviceKey: string, fetchImplementation: typeof fetch = fetch) {
		const url = new URL(`/storage/v1/object/${CAPSULE_BUCKET}/`, baseUrl);
		if (
			url.protocol !== "https:" &&
			!(url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"))
		) {
			throw new Error("Native capsule storage URL must use HTTPS");
		}
		if (!serviceKey.trim() || /[\0\r\n]/.test(serviceKey)) throw new Error("Native capsule service key is invalid");
		this.#objectUrl = url.href;
		this.#serviceKey = serviceKey;
		this.#fetch = fetchImplementation;
	}

	async put(reference: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
		if (bytes.byteLength > MAX_CAPSULE_BYTES) throw new Error("Native capsule exceeds its encrypted byte limit");
		const response = await this.#fetch(this.#url(reference), {
			method: "POST",
			headers: {
				...supabaseServiceHeaders(this.#serviceKey),
				"content-type": "application/octet-stream",
				"x-upsert": "true",
			},
			body: Uint8Array.from(bytes).buffer,
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
		});
		if (!response.ok) throw new Error(`Native capsule upload failed (${response.status})`);
	}

	async get(reference: string, signal?: AbortSignal): Promise<Uint8Array> {
		const response = await this.#fetch(this.#url(reference), {
			headers: supabaseServiceHeaders(this.#serviceKey),
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
		});
		if (!response.ok) throw new Error(`Native capsule download failed (${response.status})`);
		const length = Number(response.headers.get("content-length") ?? "0");
		if (Number.isFinite(length) && length > MAX_CAPSULE_BYTES) {
			throw new Error("Native capsule exceeds its encrypted byte limit");
		}
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength > MAX_CAPSULE_BYTES) throw new Error("Native capsule exceeds its encrypted byte limit");
		return bytes;
	}

	#url(reference: string): string {
		const matched = /^native-capsule\/([0-9a-f-]{36})$/.exec(reference);
		if (!matched || !UUID_PATTERN.test(matched[1] as string)) throw new Error("Native capsule reference is invalid");
		return new URL(`${matched[1]}.capsule`, this.#objectUrl).href;
	}
}

export class HttpNativeProviderHostService {
	readonly #host: NativeProviderHost;
	readonly #token: string;
	readonly #listenHost: string;
	readonly #port: number;
	readonly #trustedSource?: string;
	readonly #executions = new Map<string, AbortController>();
	#server?: Server;

	constructor(host: NativeProviderHost, token: string, listenHost = "127.0.0.1", port = 0, trustedSource?: string) {
		if (!TOKEN_PATTERN.test(token)) throw new Error("Native provider host token is invalid");
		if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error("Native provider port is invalid");
		if (trustedSource !== undefined && isIP(trustedSource) !== 4) {
			throw new Error("Native provider trusted source is invalid");
		}
		this.#host = host;
		this.#token = token;
		this.#listenHost = listenHost;
		this.#port = port;
		this.#trustedSource = trustedSource;
	}

	async start(): Promise<number> {
		if (this.#server) throw new Error("Native provider host is already started");
		const server = createServer((request, response) => void this.#handle(request, response));
		this.#server = server;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.#port, this.#listenHost, () => {
				server.off("error", reject);
				resolve();
			});
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Native provider host address is unavailable");
		return address.port;
	}

	async close(): Promise<void> {
		for (const controller of this.#executions.values()) controller.abort(new Error("Native provider host stopped"));
		this.#executions.clear();
		const server = this.#server;
		this.#server = undefined;
		if (!server) return;
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}

	async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		response.setHeader("cache-control", "no-store");
		if (request.method === "GET" && request.url === "/healthz") {
			response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}\n');
			return;
		}
		if (request.method !== "POST" || !["/login", "/execute", "/cancel"].includes(request.url ?? "")) {
			response.writeHead(404).end();
			return;
		}
		if (!sourceMatches(this.#trustedSource, request.socket.remoteAddress)) {
			response.writeHead(403).end();
			return;
		}
		try {
			let encoded = "";
			for await (const chunk of request) {
				encoded += Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
				if (Buffer.byteLength(encoded) > MAX_REQUEST_BYTES) throw new Error("Native provider request is too large");
			}
			const body = JSON.parse(encoded) as unknown;
			let value: JsonValue;
			if (request.url === "/login") {
				const parsed = parseLogin(body);
				if (!tokenMatches(parsed.capability, request.headers.authorization)) {
					response.writeHead(401).end();
					return;
				}
				value = await this.#host.beginLogin(parsed);
			} else if (request.url === "/execute") {
				if (!tokenMatches(this.#token, request.headers.authorization)) {
					response.writeHead(401).end();
					return;
				}
				const parsed = parseExecution(body);
				if (this.#executions.has(parsed.authority.leaseId))
					throw new Error("Native execution lease is already active");
				const controller = new AbortController();
				this.#executions.set(parsed.authority.leaseId, controller);
				try {
					value = {
						schema: RESULT_SCHEMA,
						lease_id: parsed.authority.leaseId,
						result: await this.#host.execute(parsed, controller.signal),
					};
				} finally {
					this.#executions.delete(parsed.authority.leaseId);
				}
			} else {
				if (!tokenMatches(this.#token, request.headers.authorization)) {
					response.writeHead(401).end();
					return;
				}
				const cancel = record(body, "Native provider cancellation");
				if (cancel.schema !== CANCEL_SCHEMA) throw new Error("Native provider cancellation is invalid");
				const leaseId = uuid(cancel.lease_id, "Native cancellation lease id");
				this.#executions.get(leaseId)?.abort(new Error("Native execution cancelled"));
				value = { cancelled: true };
			}
			response.writeHead(200, { "content-type": "application/json" }).end(`${JSON.stringify(value)}\n`);
		} catch (error) {
			console.error(`Native provider request rejected: ${safeRequestDiagnostic(error)}`);
			response.writeHead(422, { "content-type": "application/json" }).end('{"error":"request rejected"}\n');
		}
	}
}
