/** Versioned policy of the currently implemented native runtime, not a future wake bus.
 * A routine's own version may select any allowed effort (contract 17); the
 * agent chooses it when it sets the routine up. A member's turn in a
 * conversation takes the effort chosen for that conversation in its Model
 * menu.
 *
 * `unattended`: a run no member is waiting on (a worker's own run, an agent's
 * first run, a coworker's message) takes the effort of its agent's agent.md,
 * else this one, and work that carries on a chain (a worker's report, a
 * machine event) keeps the effort its chain's first run had (contract 17, the
 * 2026-10-22 amendment). Anything else runs at the default effort. The kernel
 * pins the resolved value on the run.
 *
 * `fastMode: "thread"`: a member's turn in a conversation runs on Codex's Fast
 * service tier unless that conversation's Model menu turned it off; every
 * other run is standard. The kernel pins the tier on the run as well. */
export const CLOUD_RUNTIME_REASONING_EFFORTS = Object.freeze(["low", "medium", "high"] as const);

export type CloudRuntimeReasoningEffort = (typeof CLOUD_RUNTIME_REASONING_EFFORTS)[number];

export const CLOUD_RUNTIME_MODEL_POLICY = Object.freeze({
	schema: "qorpera.model-reasoning/v1",
	effort: "low",
	overrides: "routine-and-thread",
	allowed: CLOUD_RUNTIME_REASONING_EFFORTS,
	fastMode: "thread",
	unattended: "high",
} as const);

export const CLOUD_RUNTIME_SERVICE_TIERS = Object.freeze(["fast", "standard"] as const);

export type CloudRuntimeServiceTier = (typeof CLOUD_RUNTIME_SERVICE_TIERS)[number];

export function isCloudRuntimeServiceTier(value: unknown): value is CloudRuntimeServiceTier {
	return typeof value === "string" && (CLOUD_RUNTIME_SERVICE_TIERS as readonly string[]).includes(value);
}

export function isCloudRuntimeReasoningEffort(value: unknown): value is CloudRuntimeReasoningEffort {
	return typeof value === "string" && (CLOUD_RUNTIME_REASONING_EFFORTS as readonly string[]).includes(value);
}
