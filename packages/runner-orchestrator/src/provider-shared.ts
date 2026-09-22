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
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) {
		const entry = (value as Record<string, unknown>)[key];
		if (entry !== undefined) output[key] = canonical(entry);
	}
	return output;
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
