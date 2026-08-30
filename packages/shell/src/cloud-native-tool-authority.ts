import { performance } from "node:perf_hooks";
import { CLOUD_RUNTIME_MODEL_POLICY, type CloudRuntimeReasoningEffort } from "./cloud-runtime-policy.ts";

export const CLOUD_NATIVE_TOOL_AUTHORITY_SCHEMA = "qorpera.native-tool-authority/v1";
export const CLOUD_NATIVE_TOOL_AUTHORITY_WINDOW_MS = 30_000;
const REQUEST_TIMEOUT_MS = 5_000;
const REFRESH_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

/** Host-only binding. No field in this object is a model-selectable tool argument. */
export interface CloudNativeToolBinding {
	readonly leaseId: string;
	readonly runId: string;
	readonly jobId: string;
	readonly runnerId: string;
	readonly assignmentId: string;
	readonly credentialCapsuleId: string;
	readonly computeIdentityId: string;
	readonly provider: "openai";
	readonly nativeHarness: "codex-cli";
	readonly model: string;
}

/** Projected by the cloud from the admitted run, not reconstructed from a prompt or a local file. */
export interface CloudNativeToolIdentity {
	readonly companyId: string;
	readonly environmentId: string;
	readonly runId: string;
	readonly jobId: string;
	readonly runnerId: string;
	readonly assignmentId: string;
	readonly leaseId: string;
	readonly computeIdentityId: string;
	readonly staffAgentId: string;
	readonly staffVersion: number;
	readonly sessionId: string | null;
	readonly requesterUserId: string;
	readonly sponsorUserId: string | null;
	readonly sponsorBindingId: string;
	readonly sponsorVersion: number;
	readonly providerConnectionId: string;
	readonly providerConnectionVersion: number;
	readonly audienceKind: "company" | "member_private";
	readonly audienceUserId: string | null;
	readonly runtimeBundleId: string;
	readonly runtimeBundleSha256: string;
	readonly reasoningEffort: CloudRuntimeReasoningEffort;
	readonly reasoningPolicySha256: string;
	readonly provider: "openai";
	readonly nativeHarness: "codex-cli";
	readonly model: string;
}

export interface CloudNativeToolAuthority {
	readonly schema: typeof CLOUD_NATIVE_TOOL_AUTHORITY_SCHEMA;
	readonly identity: CloudNativeToolIdentity;
	/** Server-derived remaining time, bounded by all leases and the run deadline. */
	readonly validForMs: number;
}

export interface CloudNativeToolAuthorityReader {
	describeToolAuthority(binding: CloudNativeToolBinding, signal: AbortSignal): Promise<unknown>;
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid cloud tool authority");
	return value as Record<string, unknown>;
}

export function parseCloudNativeToolBinding(value: unknown): CloudNativeToolBinding {
	const input = record(value);
	const keys = ["leaseId", "runId", "jobId", "runnerId", "assignmentId", "credentialCapsuleId", "computeIdentityId"];
	if (
		keys.some((key) => typeof input[key] !== "string" || !UUID.test(input[key] as string)) ||
		Object.keys(input).some((key) => ![...keys, "provider", "nativeHarness", "model"].includes(key)) ||
		input.provider !== "openai" ||
		input.nativeHarness !== "codex-cli" ||
		typeof input.model !== "string" ||
		!input.model.trim() ||
		input.model.length > 160 ||
		/[\0\r\n]/.test(input.model)
	)
		throw new Error("Invalid cloud tool binding");
	return Object.freeze({
		leaseId: input.leaseId as string,
		runId: input.runId as string,
		jobId: input.jobId as string,
		runnerId: input.runnerId as string,
		assignmentId: input.assignmentId as string,
		credentialCapsuleId: input.credentialCapsuleId as string,
		computeIdentityId: input.computeIdentityId as string,
		provider: "openai",
		nativeHarness: "codex-cli",
		model: input.model,
	});
}

export function parseCloudNativeToolAuthority(
	value: unknown,
	binding: CloudNativeToolBinding,
): CloudNativeToolAuthority {
	const input = record(value);
	const identity = record(input.identity);
	const uuidKeys = [
		"companyId",
		"environmentId",
		"runId",
		"jobId",
		"runnerId",
		"assignmentId",
		"leaseId",
		"computeIdentityId",
		"staffAgentId",
		"requesterUserId",
		"sponsorBindingId",
		"providerConnectionId",
		"runtimeBundleId",
	] as const;
	const nullableUuidKeys = ["sessionId", "sponsorUserId", "audienceUserId"] as const;
	const versionKeys = ["staffVersion", "sponsorVersion", "providerConnectionVersion"] as const;
	if (
		input.schema !== CLOUD_NATIVE_TOOL_AUTHORITY_SCHEMA ||
		Object.keys(input).some((key) => !["schema", "identity", "validForMs"].includes(key)) ||
		!Number.isSafeInteger(input.validForMs) ||
		(input.validForMs as number) < 1 ||
		(input.validForMs as number) > CLOUD_NATIVE_TOOL_AUTHORITY_WINDOW_MS ||
		uuidKeys.some((key) => typeof identity[key] !== "string" || !UUID.test(identity[key] as string)) ||
		nullableUuidKeys.some(
			(key) => identity[key] !== null && (typeof identity[key] !== "string" || !UUID.test(identity[key] as string)),
		) ||
		versionKeys.some((key) => !Number.isSafeInteger(identity[key]) || (identity[key] as number) < 1) ||
		!(["company", "member_private"] as const).includes(identity.audienceKind as "company" | "member_private") ||
		typeof identity.runtimeBundleSha256 !== "string" ||
		!SHA256.test(identity.runtimeBundleSha256) ||
		identity.reasoningEffort !== CLOUD_RUNTIME_MODEL_POLICY.effort ||
		typeof identity.reasoningPolicySha256 !== "string" ||
		!SHA256.test(identity.reasoningPolicySha256) ||
		(identity.audienceKind === "company" && identity.audienceUserId !== null) ||
		(identity.audienceKind === "member_private" &&
			(identity.audienceUserId === null || identity.audienceUserId !== identity.requesterUserId)) ||
		Object.keys(identity).some(
			(key) =>
				![
					...uuidKeys,
					...nullableUuidKeys,
					...versionKeys,
					"audienceKind",
					"runtimeBundleSha256",
					"reasoningEffort",
					"reasoningPolicySha256",
					"provider",
					"nativeHarness",
					"model",
				].includes(key),
		) ||
		[
			"leaseId",
			"runId",
			"jobId",
			"runnerId",
			"assignmentId",
			"computeIdentityId",
			"provider",
			"nativeHarness",
			"model",
		].some((key) => identity[key] !== binding[key as keyof CloudNativeToolBinding])
	)
		throw new Error("Cloud tool authority does not match its run");
	// Build a closed copy so extra data and references cannot become provenance.
	const projected = Object.fromEntries(
		[
			...uuidKeys,
			...nullableUuidKeys,
			...versionKeys,
			"audienceKind",
			"runtimeBundleSha256",
			"reasoningEffort",
			"reasoningPolicySha256",
			"provider",
			"nativeHarness",
			"model",
		].map((key) => [key, identity[key]]),
	) as unknown as CloudNativeToolIdentity;
	return Object.freeze({
		schema: CLOUD_NATIVE_TOOL_AUTHORITY_SCHEMA,
		identity: Object.freeze(projected),
		validForMs: input.validForMs as number,
	});
}

/** Bounded, cancellation-aware wait, including transports which ignore AbortSignal. */
export function cloudToolRequest<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	signal: AbortSignal,
	timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
		throw new Error("Invalid cloud tool request deadline");
	const timeout = new AbortController();
	const requestSignal = AbortSignal.any([signal, timeout.signal]);
	const timer = setTimeout(() => timeout.abort(), timeoutMs);
	let abort: () => void = () => undefined;
	return new Promise<T>((resolve, reject) => {
		abort = (): void => reject(new Error("Cloud tool authority unavailable"));
		requestSignal.addEventListener("abort", abort, { once: true });
		if (requestSignal.aborted) abort();
		else
			Promise.resolve()
				.then(() => {
					requestSignal.throwIfAborted();
					return operation(requestSignal);
				})
				.then(resolve, reject);
	}).finally(() => {
		clearTimeout(timer);
		requestSignal.removeEventListener("abort", abort);
	});
}

/** Live authority, not a path grant. Each effect gateway must still check its exact target atomically. */
export class CloudNativeToolRun {
	readonly binding: CloudNativeToolBinding;
	readonly signal: AbortSignal;
	readonly #reader: CloudNativeToolAuthorityReader;
	readonly #stop = new AbortController();
	#identity?: CloudNativeToolIdentity;
	#identityText?: string;
	#deadline = 0;
	#watchdog?: ReturnType<typeof setTimeout>;
	#refresh?: ReturnType<typeof setTimeout>;
	#checking: Promise<void> = Promise.resolve();

	private constructor(binding: CloudNativeToolBinding, reader: CloudNativeToolAuthorityReader, signal: AbortSignal) {
		this.binding = parseCloudNativeToolBinding(binding);
		this.#reader = reader;
		this.signal = AbortSignal.any([signal, this.#stop.signal]);
		this.signal.addEventListener(
			"abort",
			() => {
				clearTimeout(this.#watchdog);
				clearTimeout(this.#refresh);
			},
			{ once: true },
		);
	}

	static async open(
		binding: CloudNativeToolBinding,
		reader: CloudNativeToolAuthorityReader,
		signal: AbortSignal,
	): Promise<CloudNativeToolRun> {
		const run = new CloudNativeToolRun(binding, reader, signal);
		try {
			await run.assertActive(signal);
			return run;
		} catch {
			run.close();
			throw new Error("Cloud tool authority unavailable");
		}
	}

	get identity(): CloudNativeToolIdentity {
		if (!this.#identity) throw new Error("Cloud tool run is not admitted");
		return this.#identity;
	}

	/** Rechecks from the cloud after queuing and again before releasing tool data. */
	async assertActive(signal: AbortSignal): Promise<void> {
		const combined = AbortSignal.any([signal, this.signal]);
		const check = this.#checking.then(async () => {
			combined.throwIfAborted();
			if (this.#identity && performance.now() >= this.#deadline) throw new Error("Cloud tool authority expired");
			const started = performance.now();
			const authority = parseCloudNativeToolAuthority(
				await cloudToolRequest(
					(requestSignal) => this.#reader.describeToolAuthority(this.binding, requestSignal),
					combined,
				),
				this.binding,
			);
			combined.throwIfAborted();
			const identityText = JSON.stringify(authority.identity);
			const deadline = started + authority.validForMs;
			if ((this.#identityText && this.#identityText !== identityText) || deadline <= performance.now()) {
				throw new Error("Cloud tool authority changed or expired");
			}
			this.#identity = authority.identity;
			this.#identityText = identityText;
			this.#deadline = deadline;
			clearTimeout(this.#watchdog);
			clearTimeout(this.#refresh);
			this.#watchdog = setTimeout(() => this.close(), Math.max(1, deadline - performance.now()));
			this.#refresh = setTimeout(
				() => {
					void this.assertActive(this.signal).catch(() => undefined);
				},
				Math.min(REFRESH_MS, Math.max(1, (deadline - performance.now()) / 2)),
			);
		});
		this.#checking = check.catch(() => {
			this.close();
		});
		try {
			await check;
		} catch {
			this.close();
			throw new Error("Cloud tool authority unavailable");
		}
	}

	close(): void {
		clearTimeout(this.#watchdog);
		clearTimeout(this.#refresh);
		this.#stop.abort();
	}
}
