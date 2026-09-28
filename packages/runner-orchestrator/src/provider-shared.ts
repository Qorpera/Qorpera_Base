import { createHash, randomBytes } from "node:crypto";
import type { CloudRunnerInstance, CloudRunnerWork } from "./orchestrator.ts";

/** Helpers every provider backend shares. The attempt-id derivation and the
 * provisioned-runner check in particular must stay identical across backends:
 * SQL binds a runner row to the client runner id, so two backends deriving
 * different ids for the same attempt would provision twice. */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
	return value as Record<string, unknown>;
}

export function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((entry) => canonical(entry));
	if (!value || typeof value !== "object") return value;
	// Object.fromEntries keeps a `__proto__` key as an entry. Assigning it
	// would set the copy's prototype and drop the key from every comparison.
	const input = value as Record<string, unknown>;
	return Object.fromEntries(
		Object.keys(input)
			.sort()
			.filter((key) => input[key] !== undefined)
			.map((key) => [key, canonical(input[key])]),
	);
}

export function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function uuid(value: unknown, label: string): string {
	if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error(`${label} is invalid`);
	return value;
}

export function token(): string {
	return randomBytes(32).toString("base64url");
}

export function supabaseServiceHeaders(serviceKey: string): Record<string, string> {
	const headers: Record<string, string> = { apikey: serviceKey };
	if (serviceKey.startsWith("eyJ") && serviceKey.split(".").length === 3) {
		headers.authorization = `Bearer ${serviceKey}`;
	}
	return headers;
}

/** The control plane annotates each dispatch with attempt-scoped fields; a
 * retry is the same immutable run, so the journal digest must not vary with
 * them — or every second attempt is refused as foreign work. */
export function workSha256(work: CloudRunnerWork): string {
	const { attempt: _attempt, ...immutable } = work as CloudRunnerWork & { attempt?: unknown };
	return sha256(JSON.stringify(canonical(immutable)));
}

/** The first attempt retains its original key and historical journals. A
 * control-plane continuation gets a new physical sandbox or guest, never a
 * replay of the prior attempt's credentials, activation or retained state. */
export function runAttemptAcquisitionId(runId: string, attempt: number): string {
	if (attempt === 1) return runId;
	const digest = sha256(`qorpera.lxd-run-attempt/v1:${runId}:${attempt}`);
	const variant = ((Number.parseInt(digest[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
	return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export function exactRunner(value: unknown, work: CloudRunnerWork, adapterId: string): CloudRunnerInstance {
	const input = record(value, "Provisioned runner");
	if (
		input.runner_kind !== "qorpera_computer" ||
		input.provider_adapter !== adapterId ||
		input.status === "revoked" ||
		input.compute_identity_id !== work.computeIdentityId ||
		input.logical_computer_id !== (work.logicalComputerId ?? null) ||
		input.worker_class !== work.workerClass ||
		input.template_key !== work.computeTemplateKey ||
		input.template_version !== work.computeTemplateVersion ||
		input.compute_policy_sha256 !== work.computePolicySha256 ||
		!Array.isArray(input.capabilities) ||
		!input.capabilities.includes(work.requiredCapability)
	) {
		throw new Error("Provisioned runner does not match immutable compute authority");
	}
	return {
		runnerId: uuid(input.runner_id, "Provisioned runner id"),
		...(work.logicalComputerId ? { logicalComputerId: work.logicalComputerId } : {}),
		...(work.computeIdentityId ? { computeIdentityId: work.computeIdentityId } : {}),
		workerClass: work.workerClass,
		providerAdapter: adapterId,
		capabilities: input.capabilities as CloudRunnerInstance["capabilities"],
		templateKey: work.computeTemplateKey as string,
		templateVersion: work.computeTemplateVersion as string,
		policySha256: work.computePolicySha256 as string,
	};
}

/** An admission refusal or deferral the provider service answers as a 422
 * `admission_refused` body: the control plane defers the job instead of
 * spending an infrastructure retry. `NODE_NOT_PREFERRED` and
 * `NODE_IDENTITY_ELSEWHERE` defer this orchestrator only; every other reason
 * defers every orchestrator for a short while. */
export class ProviderAdmissionRefused extends Error {
	readonly category = "admission_refused" as const;
	readonly state: "refused" | "deferred";
	readonly reason: string;

	constructor(state: "refused" | "deferred", reason: string, message = "Start was not admitted") {
		super(message);
		this.name = "ProviderAdmissionRefused";
		this.state = state;
		this.reason = reason;
	}
}

const RPC_ERROR_CODE = /^(?:[0-9A-Z]{5}|PGRST[0-9X][0-9]{2})$/;

/** A database call a provider made that failed. Its function name, HTTP status and error code
 * (the SQLSTATE or PostgREST code) are fixed values the provider may log; the answer's text is not. */
export class ProviderRpcFailed extends Error {
	readonly rpc: string;
	readonly status: number;
	readonly code: string | undefined;

	constructor(message: string, rpc: string, status: number, code: string | undefined) {
		super(message);
		this.name = "ProviderRpcFailed";
		this.rpc = rpc;
		this.status = status;
		this.code = code;
	}
}

/** Reads a failed PostgREST answer's error code, and nothing else of its body. */
export async function providerRpcErrorCode(response: Pick<Response, "text">): Promise<string | undefined> {
	try {
		const code = (JSON.parse((await response.text()).slice(0, 8192)) as { code?: unknown }).code;
		return typeof code === "string" && RPC_ERROR_CODE.test(code) ? code : undefined;
	} catch {
		return undefined;
	}
}

/** A provider step that failed with an error rather than an admission answer. The provider service
 * logs the step's fixed name and, for a failed database call, its function, status and code; never
 * the error's own text, which may carry request bodies, host paths or credentials. */
export class ProviderStepFailed extends Error {
	readonly category = "provider_step" as const;
	readonly stage: string;
	readonly rpc: string | undefined;
	readonly rpcStatus: number | undefined;
	readonly rpcCode: string | undefined;

	constructor(stage: string, cause: unknown) {
		super(cause instanceof Error ? cause.message : "Provider step failed", { cause });
		this.name = "ProviderStepFailed";
		this.stage = stage;
		this.rpc = cause instanceof ProviderRpcFailed ? cause.rpc : undefined;
		this.rpcStatus = cause instanceof ProviderRpcFailed ? cause.status : undefined;
		this.rpcCode = cause instanceof ProviderRpcFailed ? cause.code : undefined;
	}
}

/** Names the step an error came from; an admission answer, or an error that already names its
 * step, is passed on unchanged. */
export function providerStepFailure(stage: string, error: unknown): unknown {
	const category = error && typeof error === "object" ? (error as { category?: unknown }).category : undefined;
	return category === "admission_refused" || category === "provider_step"
		? error
		: new ProviderStepFailed(stage, error);
}
