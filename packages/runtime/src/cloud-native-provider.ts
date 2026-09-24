import { chmod, chown, lstat, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { NativeProviderLoginAuthorization } from "@qorpera/cloud-client/cloud-native-subscription-control";
import { readBoundedCloudResponse } from "@qorpera/cloud-client/cloud-request";
import {
	HttpNativeProviderIdentityBridge,
	type NativeProviderIdentityBridge,
	type NativeProviderLoginPrompt,
} from "@qorpera/cloud-client/native-provider-login";
import type { JsonValue } from "@qorpera/contracts";
import type { BindCloudRunnerProviderSessionInput, CloudRunnerNativeAuthority } from "./cloud-runner-broker.ts";
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
	 */
	start(authority: CloudRunnerNativeAuthority, request: CloudRunnerSandboxRequest): Promise<CloudRunnerSandboxProcess>;
	/** No Company File mount, local context, artifact directory or model-chosen route. */
	startCompany?(
		authority: CloudRunnerNativeAuthority,
		job: { jobId: string; attemptCount: number },
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

export interface ExecuteNativeCloudRunnerJobOptions
	extends Omit<ExecuteCloudRunnerJobOptions, "backend" | "modelBroker"> {
	authority: CloudRunnerNativeAuthority;
	refreshAuthority: () => Promise<CloudRunnerNativeAuthority>;
	bridge: NativeProviderComputerBridge;
	nativeWorkspaceGid?: number;
	nativeBroker: {
		bindProviderSession(input: BindCloudRunnerProviderSessionInput): Promise<unknown>;
	};
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

export class HttpNativeProviderComputerBridge implements NativeProviderComputerBridge, NativeProviderIdentityBridge {
	readonly executionGuarantees: Readonly<CloudRunnerSandboxGuarantees>;
	readonly #executeUrl: string;
	readonly #cancelUrl: string;
	readonly #loginUrl: string;
	readonly #bridgeToken?: string;
	readonly #fetch: typeof fetch;
	readonly #signal?: AbortSignal;
	readonly #requestTimeoutMs: number | undefined;

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
		job: { jobId: string; attemptCount: number },
	): Promise<CloudRunnerSandboxProcess> {
		if (
			!this.#bridgeToken ||
			authority.authenticationMode !== "native_subscription" ||
			authority.provider !== "openai" ||
			authority.nativeHarness !== "codex-cli" ||
			!UUID_PATTERN.test(job.jobId) ||
			!Number.isSafeInteger(job.attemptCount) ||
			job.attemptCount < 1
		) {
			throw new Error("Native provider bridge received an unsupported company runtime");
		}
		return this.#startExecution(authority, {
			schema: "qorpera.native-company-execution/v1",
			authority: bridgeAuthorityProjection(authority),
			job: { job_id: job.jobId, attempt_count: job.attemptCount },
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
						void response.body?.cancel().catch(() => undefined);
						throw new Error(`Native provider bridge request failed (${response.status})`);
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
					if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).join() === "error")
						throw new Error("Native provider bridge request failed (422)");
					return value;
				}),
			]);
		} finally {
			signal.removeEventListener("abort", abort);
		}
	}
}

class NativeProviderSandboxBackend implements CloudRunnerSandboxBackend {
	readonly backendId = "native-provider-computer";
	readonly guarantees: Readonly<CloudRunnerSandboxGuarantees>;
	readonly capabilities = Object.freeze(["agent_turn"] as const);
	readonly jobTypes = Object.freeze(["agent_turn"] as const);
	readonly #authority: CloudRunnerNativeAuthority;
	readonly #refreshAuthority: () => Promise<CloudRunnerNativeAuthority>;
	readonly #bridge: NativeProviderComputerBridge;
	readonly #nativeWorkspaceGid?: number;
	readonly #nativeWorkspaceRoot?: string;
	readonly #liveCompanyRoot?: string;
	readonly #requireFinalSend: boolean;

	constructor(
		authority: CloudRunnerNativeAuthority,
		refreshAuthority: () => Promise<CloudRunnerNativeAuthority>,
		bridge: NativeProviderComputerBridge,
		requireFinalSend: boolean,
		nativeWorkspaceGid?: number,
		nativeWorkspaceRoot?: string,
		liveCompanyRoot?: string,
	) {
		this.#authority = authority;
		this.#refreshAuthority = refreshAuthority;
		this.#bridge = bridge;
		this.#requireFinalSend = requireFinalSend;
		this.#nativeWorkspaceGid = nativeWorkspaceGid;
		this.#nativeWorkspaceRoot = nativeWorkspaceRoot ? resolve(nativeWorkspaceRoot) : undefined;
		this.#liveCompanyRoot = liveCompanyRoot ? resolve(liveCompanyRoot) : undefined;
		this.guarantees = bridge.executionGuarantees;
	}

	async start(request: CloudRunnerSandboxRequest): Promise<CloudRunnerSandboxProcess> {
		if (this.#nativeWorkspaceGid !== undefined) {
			const executionRoot = dirname(resolve(request.outputRoot));
			const nativeWorkspaceRoot = this.#nativeWorkspaceRoot;
			const inputRoot = dirname(resolve(request.input.companyBaseRoot));
			const workRoot = dirname(resolve(request.input.companyRoot));
			/* The company root is either the disposable work layout, or exactly
			 * the declared live company tree (founder ruling 2026-08-26): the
			 * harness works on the one authoritative file, so the live mount is
			 * a sanctioned workspace, never a layout violation. */
			const liveMode =
				this.#liveCompanyRoot !== undefined && resolve(request.input.companyRoot) === this.#liveCompanyRoot;
			if (
				!nativeWorkspaceRoot ||
				dirname(executionRoot) !== nativeWorkspaceRoot ||
				relative(executionRoot, inputRoot) !== "input" ||
				(!liveMode && relative(executionRoot, workRoot) !== "work") ||
				relative(executionRoot, resolve(request.outputRoot)) !== "output"
			) {
				throw new Error("Native provider workspace does not match the disposable execution layout");
			}
			for (const path of [
				request.input.companyBaseRoot,
				...(liveMode ? [] : [request.input.companyRoot]),
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
			/* The live company tree is not group-shared: its NAS export squashes
			 * every writer to one owner and the tree carries open modes, so a
			 * chown sweep is both impossible (read-only mount parent) and
			 * unnecessary. */
			if (!liveMode) await shareNativeWorkspaceTree(workRoot, this.#nativeWorkspaceGid, true);
			await shareNativeWorkspaceTree(request.outputRoot, this.#nativeWorkspaceGid, true);
		}
		const authority = await this.#refreshAuthority();
		if (
			authority.leaseId !== this.#authority.leaseId ||
			authority.runId !== this.#authority.runId ||
			authority.assignmentId !== this.#authority.assignmentId
		) {
			throw new Error("Native provider authority refresh returned another execution");
		}
		const process = await this.#bridge.start(authority, request);
		return {
			result: process.result.then((value) =>
				parseNativeHarnessResult(value, authority.runId, this.#requireFinalSend),
			),
			terminate: (reason) => process.terminate(reason),
		};
	}
}

export async function executeNativeCloudRunnerJob(
	options: ExecuteNativeCloudRunnerJobOptions,
): Promise<CloudRunnerExecutionResult> {
	const { authority, refreshAuthority, bridge, nativeBroker, nativeWorkspaceGid, ...execution } = options;
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
			refreshAuthority,
			bridge,
			execution.job.sessionId !== undefined,
			nativeWorkspaceGid,
			nativeWorkspaceGid === undefined ? undefined : execution.temporaryRoot,
			execution.environment?.QORPERA_LIVE_COMPANY_ROOT,
		),
	});
	const runnerResult = record(completed.result, "Native runner completion");
	const harnessResult = parseNativeHarnessResult(
		runnerResult.backend_result,
		authority.runId,
		execution.job.sessionId !== undefined,
	);
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
