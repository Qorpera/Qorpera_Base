/** JSON-compatible durable data accepted by Qorpera cloud contracts. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Durable execution identity assigned by the cloud control plane. */
export interface ExecutionIdentity {
	kind: "turn" | "wake";
	id: string;
	claimantId: string;
}

/** Bounded authority granted to one execution attachment. */
export interface ExecutionIntentBudget {
	maxCalls: number;
	maxInputTokens: number;
	maxOutputTokens: number;
	maxCostUsd: number;
}

/** Short-lived, request-bound authority presented by an execution worker. */
export interface ExecutionIntentCapability {
	nonce: string;
	sessionId: string;
	requestHash: string;
	attended: boolean;
	issuedAt: string;
	expiresAt: string;
	budget: ExecutionIntentBudget;
	execution?: ExecutionIdentity;
	signature: string;
}

/** Mutations a provider-native worker may request through the company operation broker. */
export const COMPANY_OPERATION_KINDS = [
	"request_connection",
	"authorize_connector_http",
	"manage_routine",
	"assess_artifact_source",
	"record_artifact_observation",
	"report_artifact_source_issue",
	"complete_setup",
	"finish_trigger_build",
	"finish_trigger_check",
	"send_agent_message",
	"delegate_to_staff",
] as const;

export type CompanyOperationKind = (typeof COMPANY_OPERATION_KINDS)[number];
