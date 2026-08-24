import { chmod, chown, lstat, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { JsonValue } from "@qorpera/contracts";
import type { NativeProviderLoginAuthorization } from "./cloud-native-subscription-control.ts";
import type {
	AppendCloudRunnerTranscriptEventInput,
	BindCloudRunnerProviderSessionInput,
	CloudRunnerNativeAuthority,
} from "./cloud-runner-broker.ts";
import {
	type CloudRunnerExecutionResult,
	type CloudRunnerSandboxBackend,
	type CloudRunnerSandboxGuarantees,
	type CloudRunnerSandboxProcess,
	type CloudRunnerSandboxRequest,
	type ExecuteCloudRunnerJobOptions,
	executeCloudRunnerJob,
} from "./cloud-runner-sandbox.ts";

const BRIDGE_REQUEST_SCHEMA = "qorpera.native-provider-execution/v1";
const BRIDGE_CANCEL_SCHEMA = "qorpera.native-provider-cancel/v1";
const BRIDGE_RESPONSE_SCHEMA = "qorpera.native-provider-result/v1";
const BRIDGE_LOGIN_REQUEST_SCHEMA = "qorpera.native-provider-login/v1";
const BRIDGE_LOGIN_RESPONSE_SCHEMA = "qorpera.native-provider-login-result/v1";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_BRIDGE_RESPONSE_BYTES = 64 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_SESSION_PATTERN = /^[^\0\r\n]{1,1024}$/;

export interface NativeProviderComputerBridge {
	readonly executionGuarantees: Readonly<CloudRunnerSandboxGuarantees>;
	/**
	 * Application boundary: only this trusted computer-side bridge may unwrap a
	 * capsule for the unmodified provider harness. This does not assert that the
	 * infrastructure operator is cryptographically blind to an unattested VM.
	 */
	start(authority: CloudRunnerNativeAuthority, request: CloudRunnerSandboxRequest): Promise<CloudRunnerSandboxProcess>;
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

export interface NativeProviderLoginPrompt {
	loginId: string;
	status: "awaiting_member" | "completed";
	interactionUrl?: string;
	userCode?: string;
}

export interface NativeProviderIdentityBridge {
	beginLogin(authorization: NativeProviderLoginAuthorization): Promise<NativeProviderLoginPrompt>;
}

export interface ExecuteNativeCloudRunnerJobOptions
	extends Omit<ExecuteCloudRunnerJobOptions, "backend" | "modelBroker"> {
	authority: CloudRunnerNativeAuthority;
	bridge: NativeProviderComputerBridge;
	nativeWorkspaceGid?: number;
	nativeBroker: {
		appendTranscriptEvent(input: AppendCloudRunnerTranscriptEventInput): Promise<unknown>;
		bindProviderSession(input: BindCloudRunnerProviderSessionInput): Promise<unknown>;
	};
}

function assertWorkspaceChild(root: string, path: string): void {
	const child = relative(root, resolve(path));
	if (!child || child === ".." || child.startsWith(`..${sep}`)) {
		throw new Error("Native provider workspace path escapes the disposable execution root");
	}
}

async function shareNativeWorkspaceTree(root: string, gid: number, writable: boolean): Promise<void> {
	if (process.platform !== "linux") throw new Error("Native workspace groups require Linux");
	if (!Number.isSafeInteger(gid) || gid < 1) throw new Error("Native workspace group is invalid");
	const visit = async (path: string): Promise<void> => {
		const metadata = await lstat(path);
		if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
			throw new Error("Native provider workspace contains an unsupported entry");
		}
		await chown(path, -1, gid);
		if (metadata.isDirectory()) {
			await chmod(path, writable ? 0o2770 : 0o2750);
			for (const entry of await readdir(path)) await visit(join(path, entry));
			return;
		}
		await chmod(path, metadata.mode & 0o100 ? (writable ? 0o770 : 0o750) : writable ? 0o660 : 0o640);
	};
	await visit(root);
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
	return value as Record<string, unknown>;
}

function json(value: unknown, label: string): JsonValue {
	const encoded = JSON.stringify(value);
	if (encoded === undefined || Buffer.byteLength(encoded) > MAX_BRIDGE_RESPONSE_BYTES) {
		throw new Error(`${label} is invalid`);
	}
	return value as JsonValue;
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

function bridgeProjection(authority: CloudRunnerNativeAuthority, request: CloudRunnerSandboxRequest): JsonValue {
	return {
		schema: BRIDGE_REQUEST_SCHEMA,
		authority: {
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
		},
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

export class HttpNativeProviderComputerBridge implements NativeProviderComputerBridge, NativeProviderIdentityBridge {
	readonly executionGuarantees: Readonly<CloudRunnerSandboxGuarantees>;
	readonly #executeUrl: string;
	readonly #cancelUrl: string;
	readonly #loginUrl: string;
	readonly #bridgeToken?: string;
	readonly #fetch: typeof fetch;
	readonly #signal?: AbortSignal;
	readonly #requestTimeoutMs: number;

	constructor(
		baseUrl: string,
		bridgeToken?: string,
		fetchImplementation: typeof fetch = fetch,
		options: {
			signal?: AbortSignal;
			requestTimeoutMs?: number;
			executionBoundary?: NativeProviderExecutionBoundary;
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
		this.#requestTimeoutMs = options.requestTimeoutMs ?? 24 * 60 * 60 * 1000;
		this.executionGuarantees = nativeProviderExecutionGuarantees(options.executionBoundary ?? "test");
		if (!Number.isSafeInteger(this.#requestTimeoutMs) || this.#requestTimeoutMs < 1) {
			throw new Error("Native provider bridge timeout is invalid");
		}
	}

	async beginLogin(authorization: NativeProviderLoginAuthorization): Promise<NativeProviderLoginPrompt> {
		const ownershipIsValid =
			authorization.computeIdentityOwnershipKind === "member"
				? authorization.computeIdentityOwnerUserId !== undefined &&
					UUID_PATTERN.test(authorization.computeIdentityOwnerUserId) &&
					authorization.computeIdentityOwnerScopeKey === undefined
				: authorization.computeIdentityOwnershipKind === "company"
					? authorization.computeIdentityOwnerUserId === undefined &&
						authorization.computeIdentityOwnerScopeKey === undefined
					: (authorization.computeIdentityOwnershipKind === "department" ||
							authorization.computeIdentityOwnershipKind === "security_boundary") &&
						authorization.computeIdentityOwnerUserId === undefined &&
						typeof authorization.computeIdentityOwnerScopeKey === "string" &&
						authorization.computeIdentityOwnerScopeKey.length > 0 &&
						authorization.computeIdentityOwnerScopeKey.length <= 160 &&
						!/\0|\r|\n/.test(authorization.computeIdentityOwnerScopeKey);
		if (
			!TOKEN_PATTERN.test(authorization.capability) ||
			!Number.isFinite(Date.parse(authorization.expiresAt)) ||
			Date.parse(authorization.expiresAt) <= Date.now() ||
			!UUID_PATTERN.test(authorization.loginId) ||
			!UUID_PATTERN.test(authorization.computeIdentityId) ||
			(authorization.nativeHarness !== "codex-cli" && authorization.nativeHarness !== "claude-code") ||
			!ownershipIsValid
		) {
			throw new Error("Native provider login authority is invalid");
		}
		const value = record(
			await this.#request(
				this.#loginUrl,
				{
					schema: BRIDGE_LOGIN_REQUEST_SCHEMA,
					login_id: authorization.loginId,
					client_connection_id: authorization.clientConnectionId,
					compute_identity_id: authorization.computeIdentityId,
					compute_identity_ownership_kind: authorization.computeIdentityOwnershipKind,
					compute_identity_owner_user_id: authorization.computeIdentityOwnerUserId ?? null,
					compute_identity_owner_scope_key: authorization.computeIdentityOwnerScopeKey ?? null,
					provider: authorization.provider,
					native_harness: authorization.nativeHarness,
					login_capability: authorization.capability,
					expires_at: authorization.expiresAt,
				},
				AbortSignal.any([AbortSignal.timeout(30_000), ...(this.#signal ? [this.#signal] : [])]),
				authorization.capability,
			),
			"Native provider login response",
		);
		if (
			value.schema !== BRIDGE_LOGIN_RESPONSE_SCHEMA ||
			value.login_id !== authorization.loginId ||
			(value.status !== "awaiting_member" && value.status !== "completed") ||
			Object.keys(value).some(
				(key) => !["schema", "login_id", "status", "interaction_url", "user_code"].includes(key),
			)
		) {
			throw new Error("Native provider login response crossed the credential boundary");
		}
		const interactionUrl = value.interaction_url;
		if (interactionUrl !== null && interactionUrl !== undefined) {
			if (typeof interactionUrl !== "string") throw new Error("Native provider login URL is invalid");
			const parsed = new URL(interactionUrl);
			if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
				throw new Error("Native provider login URL is invalid");
			}
		}
		const userCode = value.user_code;
		if (
			userCode !== null &&
			userCode !== undefined &&
			(typeof userCode !== "string" || !userCode.trim() || userCode.length > 128 || /[\0\r\n]/.test(userCode))
		) {
			throw new Error("Native provider login code is invalid");
		}
		return {
			loginId: authorization.loginId,
			status: value.status,
			...(typeof interactionUrl === "string" ? { interactionUrl } : {}),
			...(typeof userCode === "string" ? { userCode } : {}),
		};
	}

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
		const executionAbort = new AbortController();
		const result = this.#request(
			this.#executeUrl,
			bridgeProjection(authority, request),
			AbortSignal.any([
				executionAbort.signal,
				AbortSignal.timeout(this.#requestTimeoutMs),
				...(this.#signal ? [this.#signal] : []),
			]),
		).then((value) => {
			const envelope = record(value, "Native provider bridge response");
			if (envelope.schema !== BRIDGE_RESPONSE_SCHEMA || envelope.lease_id !== authority.leaseId) {
				throw new Error("Native provider bridge returned another execution");
			}
			assertNoCredentialMaterial(envelope.result, "Native provider result");
			return json(envelope.result, "Native provider result");
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
		if (!response.ok) throw new Error(`Native provider bridge request failed (${response.status})`);
		const encoded = await response.text();
		if (Buffer.byteLength(encoded) > MAX_BRIDGE_RESPONSE_BYTES) {
			throw new Error("Native provider bridge response exceeds its byte limit");
		}
		return JSON.parse(encoded) as unknown;
	}
}

class NativeProviderSandboxBackend implements CloudRunnerSandboxBackend {
	readonly backendId = "native-provider-computer";
	readonly guarantees: Readonly<CloudRunnerSandboxGuarantees>;
	readonly capabilities = Object.freeze(["agent_turn"] as const);
	readonly jobTypes = Object.freeze(["agent_turn"] as const);
	readonly #authority: CloudRunnerNativeAuthority;
	readonly #bridge: NativeProviderComputerBridge;
	readonly #nativeWorkspaceGid?: number;
	readonly #nativeWorkspaceRoot?: string;

	constructor(
		authority: CloudRunnerNativeAuthority,
		bridge: NativeProviderComputerBridge,
		nativeWorkspaceGid?: number,
		nativeWorkspaceRoot?: string,
	) {
		this.#authority = authority;
		this.#bridge = bridge;
		this.#nativeWorkspaceGid = nativeWorkspaceGid;
		this.#nativeWorkspaceRoot = nativeWorkspaceRoot ? resolve(nativeWorkspaceRoot) : undefined;
		this.guarantees = bridge.executionGuarantees;
	}

	async start(request: CloudRunnerSandboxRequest): Promise<CloudRunnerSandboxProcess> {
		if (this.#nativeWorkspaceGid !== undefined) {
			const executionRoot = dirname(resolve(request.outputRoot));
			const nativeWorkspaceRoot = this.#nativeWorkspaceRoot;
			const inputRoot = dirname(resolve(request.input.companyBaseRoot));
			const workRoot = dirname(resolve(request.input.companyRoot));
			if (
				!nativeWorkspaceRoot ||
				dirname(executionRoot) !== nativeWorkspaceRoot ||
				relative(executionRoot, inputRoot) !== "input" ||
				relative(executionRoot, workRoot) !== "work" ||
				relative(executionRoot, resolve(request.outputRoot)) !== "output"
			) {
				throw new Error("Native provider workspace does not match the disposable execution layout");
			}
			for (const path of [
				request.input.companyBaseRoot,
				request.input.companyRoot,
				...(request.input.proposalRoot ? [request.input.proposalRoot] : []),
				request.input.executionContextPath,
				request.input.queuedInputsPath,
				request.input.transcriptPath,
				request.input.substrateManifestPath,
				request.input.operationsPath,
				request.input.artifactsRoot,
				request.input.attachmentsRoot,
				request.outputRoot,
			]) {
				assertWorkspaceChild(executionRoot, path);
			}
			const [nativeWorkspaceMetadata, rootMetadata] = await Promise.all([
				lstat(nativeWorkspaceRoot),
				lstat(executionRoot),
			]);
			if (!nativeWorkspaceMetadata.isDirectory() || nativeWorkspaceMetadata.isSymbolicLink()) {
				throw new Error("Native provider workspace root contains an unsupported entry");
			}
			if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
				throw new Error("Native provider workspace contains an unsupported entry");
			}
			// The provider receives the exact disposable child path, so it needs only
			// traverse permission on the configured ancestor. Do not grant directory
			// listing or write access to sibling jobs.
			await chown(nativeWorkspaceRoot, -1, this.#nativeWorkspaceGid);
			await chmod(nativeWorkspaceRoot, (nativeWorkspaceMetadata.mode & 0o7707) | 0o10);
			await chown(executionRoot, -1, this.#nativeWorkspaceGid);
			await chmod(executionRoot, 0o2750);
			await shareNativeWorkspaceTree(inputRoot, this.#nativeWorkspaceGid, false);
			await shareNativeWorkspaceTree(workRoot, this.#nativeWorkspaceGid, true);
			await shareNativeWorkspaceTree(request.outputRoot, this.#nativeWorkspaceGid, true);
		}
		return this.#bridge.start(this.#authority, request);
	}
}

export async function executeNativeCloudRunnerJob(
	options: ExecuteNativeCloudRunnerJobOptions,
): Promise<CloudRunnerExecutionResult> {
	const { authority, bridge, nativeBroker, nativeWorkspaceGid, ...execution } = options;
	if (
		authority.authenticationMode !== "native_subscription" ||
		(authority.nativeHarness !== "codex-cli" && authority.nativeHarness !== "claude-code")
	) {
		throw new Error("Native provider execution authority is invalid");
	}
	const completed = await executeCloudRunnerJob({
		...execution,
		backend: new NativeProviderSandboxBackend(
			authority,
			bridge,
			nativeWorkspaceGid,
			nativeWorkspaceGid === undefined ? undefined : execution.temporaryRoot,
		),
	});
	const runnerResult = record(completed.result, "Native runner completion");
	const harnessResult = record(runnerResult.backend_result, "Native harness result");
	if (harnessResult.schema !== "qorpera.native-harness-result/v1") {
		throw new Error("Native harness returned an unsupported result");
	}
	const entry = record(harnessResult.assistant_entry, "Native harness assistant entry");
	const message = record(entry.message, "Native harness assistant message");
	if (
		entry.type !== "message" ||
		typeof entry.id !== "string" ||
		!UUID_PATTERN.test(entry.id) ||
		message.role !== "assistant" ||
		!Array.isArray(message.content) ||
		message.content.length < 1
	) {
		throw new Error("Native harness assistant entry is invalid");
	}
	await nativeBroker.appendTranscriptEvent({
		eventId: entry.id,
		eventType: "message",
		entry: json(entry, "Native harness assistant entry"),
	});
	if (harnessResult.provider_session_id !== null && harnessResult.provider_session_id !== undefined) {
		if (
			typeof harnessResult.provider_session_id !== "string" ||
			!PROVIDER_SESSION_PATTERN.test(harnessResult.provider_session_id)
		) {
			throw new Error("Native harness provider session id is invalid");
		}
		await nativeBroker.bindProviderSession({ providerSessionId: harnessResult.provider_session_id });
	}
	return completed;
}
