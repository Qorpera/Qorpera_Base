/** Versioned policy of the currently implemented native runtime, not a future wake bus.
 * An attended thread runs at the default effort. A routine's own version may
 * select any allowed effort (contract 17); the agent chooses it when it sets
 * the routine up, and the kernel pins the resolved value on the run. */
export const CLOUD_RUNTIME_REASONING_EFFORTS = Object.freeze(["low", "medium", "high"] as const);

export type CloudRuntimeReasoningEffort = (typeof CLOUD_RUNTIME_REASONING_EFFORTS)[number];

export const CLOUD_RUNTIME_MODEL_POLICY = Object.freeze({
	schema: "qorpera.model-reasoning/v1",
	effort: "low",
	overrides: "routine",
	allowed: CLOUD_RUNTIME_REASONING_EFFORTS,
} as const);

export function isCloudRuntimeReasoningEffort(value: unknown): value is CloudRuntimeReasoningEffort {
	return typeof value === "string" && (CLOUD_RUNTIME_REASONING_EFFORTS as readonly string[]).includes(value);
}
