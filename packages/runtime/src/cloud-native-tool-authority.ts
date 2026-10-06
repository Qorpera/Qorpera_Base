import { performance } from "node:perf_hooks";
import { cloudControlBackoffMs, cloudControlPause, cloudControlRetryable } from "./cloud-control-errors.ts";
import { CloudRuntimeDiagnosticError } from "./cloud-runtime-observability.ts";
import { type CloudRuntimeReasoningEffort, isCloudRuntimeReasoningEffort } from "./cloud-runtime-policy.ts";

export const CLOUD_NATIVE_TOOL_AUTHORITY_SCHEMA = "qorpera.native-tool-authority/v1";
export const CLOUD_NATIVE_TOOL_AUTHORITY_WINDOW_MS = 30_000;
const REQUEST_TIMEOUT_MS = 5_000;
/** The longest one attempt of a cloud tool request may wait. A transport that `CloudNativeToolRun.retry` calls waits
 * this long, so the run's retry decides how long each attempt is (6 Oct 2026). */
export const CLOUD_TOOL_REQUEST_MAX_MS = 300_000;
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
		!isCloudRuntimeReasoningEffort(identity.reasoningEffort) ||
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

/** Two cloud reads sent together that the database serialises on the run's job row. */
export const CLOUD_PAIRED_REQUEST_TIMEOUT_MS = 10_000;
/** The first attempt of the one call before each model request (qorpera_fence_native_context). A lost or late answer
 * is asked again for as long as the run's authority holds, with no budget of its own (5 Oct 2026), each attempt cut at
 * its deadline giving the next twice as long (6 Oct 2026). */
export const CLOUD_NATIVE_FENCE_CALL_TIMEOUT_MS = 10_000;

/** Bounded, cancellation-aware wait, including transports which ignore AbortSignal. */
export function cloudToolRequest<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	signal: AbortSignal,
	timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CLOUD_TOOL_REQUEST_MAX_MS)
		throw new Error("Invalid cloud tool request deadline");
	const timeout = new AbortController();
	const requestSignal = AbortSignal.any([signal, timeout.signal]);
	const timer = setTimeout(() => timeout.abort(), timeoutMs);
	let abort: () => void = () => undefined;
	return new Promise<T>((resolve, reject) => {
		abort = (): void =>
			reject(
				new CloudRuntimeDiagnosticError(
					timeout.signal.aborted ? "timeout" : "cancelled",
					"Cloud tool authority unavailable",
				),
			);
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
	/** When the read whose authority is applied started: answers apply in the order their reads started. */
	#readAt = Number.NEGATIVE_INFINITY;
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

	/**
	 * Rechecks from the cloud after queuing and again before releasing tool data.
	 * `timeoutMs` widens the read's deadline when a caller sends it together with
	 * another read of the same run, which the database serialises on the job row.
	 * A read whose answer is lost or late is asked again (see `retry`); a refusal closes the run at once.
	 */
	async assertActive(signal: AbortSignal, timeoutMs?: number): Promise<void> {
		await this.#check(
			(requestSignal) => this.#reader.describeToolAuthority(this.binding, requestSignal),
			signal,
			timeoutMs,
		);
	}

	/**
	 * assertActive with another cloud call that reads the run's authority in its own
	 * transaction (the one-call context fence reads it with the same describe function), safe to repeat.
	 * The same checks before the call (not closed, the last authority not lapsed) and after
	 * it (same identity, not expired, new deadline). Returns false, changing nothing, when `read` returns undefined:
	 * the database lacks the call and nothing ran.
	 *
	 * It is not queued behind the run's own checks: a lost or late answer is asked again for as long as the run's
	 * authority holds, while the background refresh keeps renewing it. So a slow database never ends the run; lost
	 * authority, a refusal or a cancellation do (5 Oct 2026).
	 */
	async assertActiveWith(
		read: (signal: AbortSignal) => Promise<unknown>,
		signal: AbortSignal,
		timeoutMs?: number,
	): Promise<boolean> {
		const combined = AbortSignal.any([signal, this.signal]);
		try {
			combined.throwIfAborted();
			if (this.#identity && performance.now() >= this.#deadline) throw new Error("Cloud tool authority expired");
			const { value, started } = await this.retry(read, combined, timeoutMs);
			if (value === undefined) return false;
			this.#apply(value, started, combined);
			return true;
		} catch (error) {
			this.close();
			throw new Error("Cloud tool authority unavailable", { cause: error });
		}
	}

	/**
	 * Asks an idempotent read of this run again while its answer is lost or late (a timeout, a connection or gateway
	 * error, a serialization failure, a lock or statement timeout), pausing 250 ms doubling to 2 s, until the run's
	 * authority would lapse (its validity, which the cloud bounds by the run's lease, as renewed meanwhile) or, before
	 * the first authority, within the authority window. A refusal, a cancellation, or any other failure is thrown at
	 * once. A slow database is not a stopped run (control calls, 4 Oct 2026).
	 *
	 * An attempt cut at its deadline gives the next one twice as long, still within the limit: a read slower than one
	 * attempt, queued behind the transaction its cut attempt left running, still lands (6 Oct 2026). That needs a read
	 * whose own transport does not cut it first: the fence's waits `CLOUD_TOOL_REQUEST_MAX_MS`.
	 */
	async retry<T>(
		read: (signal: AbortSignal) => Promise<T>,
		signal: AbortSignal,
		timeoutMs?: number,
	): Promise<{ value: T; started: number }> {
		const combined = AbortSignal.any([signal, this.signal]);
		const begun = performance.now();
		// Read at each step: a refresh that lands meanwhile extends it.
		const limit = (): number => (this.#identity ? this.#deadline : begun + CLOUD_NATIVE_TOOL_AUTHORITY_WINDOW_MS);
		let attemptLimitMs = timeoutMs ?? REQUEST_TIMEOUT_MS;
		for (let attempt = 0; ; attempt += 1) {
			combined.throwIfAborted();
			const started = performance.now();
			try {
				// Every attempt ends by the limit: none starts with less than 1 ms of it.
				const attemptMs = Math.min(attemptLimitMs, Math.floor(limit() - started));
				if (attemptMs < 1) throw new Error("Cloud tool authority unavailable");
				return { value: await cloudToolRequest(read, combined, attemptMs), started };
			} catch (error) {
				if (error instanceof CloudRuntimeDiagnosticError && error.category === "timeout")
					attemptLimitMs = Math.min(CLOUD_TOOL_REQUEST_MAX_MS, attemptLimitMs * 2);
				const pause = cloudControlBackoffMs(attempt);
				if (combined.aborted || !cloudControlRetryable(error) || performance.now() + pause >= limit()) throw error;
				await cloudControlPause(pause, combined);
			}
		}
	}

	async #check(
		read: (signal: AbortSignal) => Promise<unknown>,
		signal: AbortSignal,
		timeoutMs: number | undefined,
	): Promise<void> {
		const combined = AbortSignal.any([signal, this.signal]);
		const check = this.#checking.then(async () => {
			combined.throwIfAborted();
			if (this.#identity && performance.now() >= this.#deadline) throw new Error("Cloud tool authority expired");
			// The attempt that answered dates the authority it read.
			const { value, started } = await this.retry(read, combined, timeoutMs);
			this.#apply(value, started, combined);
		});
		this.#checking = check.catch(() => {
			this.close();
		});
		try {
			await check;
		} catch (error) {
			this.close();
			// The cause only tells a timed-out check apart in observations.
			throw new Error("Cloud tool authority unavailable", { cause: error });
		}
	}

	#apply(value: unknown, started: number, signal: AbortSignal): void {
		const authority = parseCloudNativeToolAuthority(value, this.binding);
		signal.throwIfAborted();
		const identityText = JSON.stringify(authority.identity);
		if (this.#identityText && this.#identityText !== identityText) throw new Error("Cloud tool authority changed");
		// A context fence's read may answer after a refresh that started later: the later read's authority stands.
		if (started <= this.#readAt) return;
		const deadline = started + authority.validForMs;
		if (deadline <= performance.now()) throw new Error("Cloud tool authority expired");
		this.#readAt = started;
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
	}

	close(): void {
		clearTimeout(this.#watchdog);
		clearTimeout(this.#refresh);
		this.#stop.abort();
	}
}
