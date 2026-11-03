import { CLOUD_RUNTIME_ERROR_CATEGORIES, type CloudRuntimeErrorCategory } from "./cloud-runtime-observability.ts";

const STAGES = [
	"company-context",
	"bundle-compatibility",
	"wake-envelope",
	"connector-tools",
	"prompt-composition",
	// A coding session's turn, which runs in its own composition (21 October 2026).
	"coding-session",
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
	/** Codex's own error discriminant as a fixed name (nativeCodexErrorToken), for the host's journal only. */
	codexError: string | null;
}

/** Codex's `codexErrorInfo` discriminants without a payload, as pinned. */
const CODEX_ERROR_NAMES: readonly string[] = [
	"contextWindowExceeded",
	"sessionBudgetExceeded",
	"usageLimitExceeded",
	"serverOverloaded",
	"cyberPolicy",
	"internalServerError",
	"unauthorized",
	"badRequest",
	"threadRollbackFailed",
	"sandboxError",
	"other",
];
/** Its discriminants whose one field is an HTTP status. */
const CODEX_ERROR_STATUS_NAMES: readonly string[] = [
	"httpConnectionFailed",
	"responseStreamConnectionFailed",
	"responseStreamDisconnected",
	"responseTooManyFailedAttempts",
];

/** A fixed name for Codex's error discriminant (3 November 2026: a login's turns ended in two seconds and nobody could
 * tell why): a pinned name as it is, `<name>:<HTTP status>` (or `<name>:null`) for one that carries a status, `null`
 * for none, and `unknown` for anything else. Only names from the lists above and a three-digit status come out, never
 * the error's message, details or any other text. */
export function nativeCodexErrorToken(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string") return CODEX_ERROR_NAMES.includes(value) ? value : "unknown";
	if (!value || typeof value !== "object" || Array.isArray(value)) return "unknown";
	const keys = Object.keys(value);
	if (keys.length !== 1 || !CODEX_ERROR_STATUS_NAMES.includes(keys[0])) return "unknown";
	const details = (value as Record<string, unknown>)[keys[0]];
	if (!details || typeof details !== "object" || Array.isArray(details) || Object.keys(details).join() !== "httpStatusCode")
		return "unknown";
	const status = (details as Record<string, unknown>).httpStatusCode;
	if (status === null) return `${keys[0]}:null`;
	return Number.isSafeInteger(status) && (status as number) >= 100 && (status as number) <= 599
		? `${keys[0]}:${status}`
		: "unknown";
}

function codexErrorTokenIsValid(token: string): boolean {
	if (token === "null" || token === "unknown" || CODEX_ERROR_NAMES.includes(token)) return true;
	const parts = token.split(":");
	return (
		parts.length === 2 &&
		CODEX_ERROR_STATUS_NAMES.includes(parts[0]) &&
		(parts[1] === "null" || /^[1-5][0-9]{2}$/.test(parts[1]))
	);
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
	codexError: string | null = null,
): Error {
	const failure = error instanceof Error ? error : new Error("Native runtime failed");
	if (
		!STAGES.includes(stage) ||
		!CLOUD_RUNTIME_ERROR_CATEGORIES.includes(category) ||
		(usageSignal !== null && !["usage_limit", "rate_limited", "provider_outage"].includes(usageSignal)) ||
		(codexError !== null && !codexErrorTokenIsValid(codexError))
	)
		throw new Error("Invalid native failure metadata");
	if (!nativeRuntimeFailureMetadata(failure))
		failures.set(failure, Object.freeze({ stage, category, usageSignal, codexError }));
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
