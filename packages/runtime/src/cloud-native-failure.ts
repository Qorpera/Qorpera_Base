import { CLOUD_RUNTIME_ERROR_CATEGORIES, type CloudRuntimeErrorCategory } from "./cloud-runtime-observability.ts";

const STAGES = [
	"company-context",
	"bundle-compatibility",
	"wake-envelope",
	"connector-tools",
	"prompt-composition",
	"native-tools",
	"public-completion",
	"codex-artifact",
	"codex-identity",
	"codex-result-fence",
	"codex-process-start",
	"codex-initialize",
	"codex-configuration",
	"codex-skills",
	"execution-admission",
	"codex-thread-start",
	"codex-turn-start",
	"codex-turn-completion",
] as const;
export type NativeRuntimeFailureStage = (typeof STAGES)[number];
export type NativeRuntimeUsageSignal = "usage_limit" | "rate_limited" | "provider_outage";
export interface NativeRuntimeFailureMetadata {
	stage: NativeRuntimeFailureStage;
	category: CloudRuntimeErrorCategory;
	usageSignal: NativeRuntimeUsageSignal | null;
}

// Error text, stderr, paths, IDs and provider payloads never enter this map.
// A caller cannot forge metadata by attaching similarly named error fields.
const failures = new WeakMap<Error, Readonly<NativeRuntimeFailureMetadata>>();
export function nativeRuntimeFailureMetadata(error: unknown): Readonly<NativeRuntimeFailureMetadata> | undefined {
	let current = error;
	for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
		const metadata = failures.get(current);
		if (metadata) return metadata;
		current = current.cause;
	}
	return undefined;
}

export function tagNativeRuntimeFailure(
	error: unknown,
	stage: NativeRuntimeFailureStage,
	category: CloudRuntimeErrorCategory = "unknown",
	usageSignal: NativeRuntimeUsageSignal | null = null,
): Error {
	const failure = error instanceof Error ? error : new Error("Native runtime failed");
	if (
		!STAGES.includes(stage) ||
		!CLOUD_RUNTIME_ERROR_CATEGORIES.includes(category) ||
		(usageSignal !== null && !["usage_limit", "rate_limited", "provider_outage"].includes(usageSignal))
	)
		throw new Error("Invalid native failure metadata");
	if (!nativeRuntimeFailureMetadata(failure)) failures.set(failure, Object.freeze({ stage, category, usageSignal }));
	return failure;
}

/** Pinned Codex discriminants only; context budgets and arbitrary 429 text are not quota exhaustion. */
export function nativeRuntimeUsageSignal(value: unknown): NativeRuntimeUsageSignal | null {
	if (value === "usageLimitExceeded") return "usage_limit";
	if (value === "serverOverloaded" || value === "internalServerError") return "provider_outage";
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const keys = Object.keys(value);
	if (
		keys.length !== 1 ||
		![
			"httpConnectionFailed",
			"responseStreamConnectionFailed",
			"responseStreamDisconnected",
			"responseTooManyFailedAttempts",
		].includes(keys[0])
	)
		return null;
	const details = (value as Record<string, unknown>)[keys[0]];
	if (
		!details ||
		typeof details !== "object" ||
		Array.isArray(details) ||
		Object.keys(details).join() !== "httpStatusCode"
	)
		return null;
	const status = (details as Record<string, unknown>).httpStatusCode;
	if (status === 429) return "rate_limited";
	if (typeof status === "number" && Number.isSafeInteger(status) && status >= 500 && status <= 599)
		return "provider_outage";
	return null;
}
