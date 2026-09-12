export * from "./company-computer-adoption.ts";
export * from "./company-computer-boot-adoption.ts";
export * from "./company-computer-boot-configuration.ts";
export * from "./company-computer-boot-service-restart.ts";
export * from "./company-computer-boot-service-start.ts";
export * from "./company-computer-configuration.ts";
export * from "./company-computer-native-endpoint.ts";
export * from "./company-computer-preparation.ts";
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
export * from "./company-computer-activation.ts";
export * from "./company-computer-boot-intent.ts";
export * from "./company-computer-boot-successor.ts";
export * from "./company-computer-lifecycle.ts";
export * from "./company-computer-reset-custody.ts";
export * from "./company-computer-service-restart.ts";
export * from "./company-computer-service-start.ts";
export * from "./company-computer-service-stop.ts";
export * from "./company-computer-service-successor.ts";
export * from "./company-computer-stop-acknowledgement.ts";
export * from "./company-computer-stop-history.ts";
