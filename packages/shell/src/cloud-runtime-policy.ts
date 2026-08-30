/** Versioned policy of the currently implemented native runtime, not a future wake bus. */
export const CLOUD_RUNTIME_MODEL_POLICY = Object.freeze({
	schema: "qorpera.model-reasoning/v1",
	effort: "low",
	overrides: "none",
} as const);

export type CloudRuntimeReasoningEffort = typeof CLOUD_RUNTIME_MODEL_POLICY.effort;
