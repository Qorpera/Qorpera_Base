/**
 * Transport-neutral capability shared by the trusted shell model broker and
 * its sandboxed client. A transport adapter may carry these records over a
 * local process pipe today or HTTPS/WebSocket later without changing the
 * authority semantics.
 */
export interface KernelModelIntentBudget {
	maxCalls: number;
	maxInputTokens: number;
	maxOutputTokens: number;
	maxCostUsd: number;
}

export interface KernelIntentCapability {
	nonce: string;
	sessionId: string;
	requestHash: string;
	attended: boolean;
	issuedAt: string;
	expiresAt: string;
	budget: KernelModelIntentBudget;
	signature: string;
}

export type ModelIntentTerminalStatus = "completed" | "aborted" | "failed" | "expired" | "budget_exhausted";

export interface ModelIntentEndFrame {
	type: "qorpera_model_intent_end";
	sessionId: string;
	intentNonce: string;
	status: ModelIntentTerminalStatus;
}
