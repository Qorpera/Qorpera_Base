export * from "./company-computer-adoption.ts";
export * from "./company-computer-boot-adoption.ts";
export * from "./company-computer-boot-configuration.ts";
export * from "./company-computer-boot-service-restart.ts";
export * from "./company-computer-boot-service-start.ts";
export * from "./company-computer-code-package-provision.ts";
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

export * from "./cloud-coding.ts";
export * from "./cloud-coding-command.ts";
export * from "./cloud-coding-guest.ts";
export * from "./cloud-coding-session.ts";
export * from "./cloud-coding-storage.ts";
export * from "./cloud-machine.ts";
export * from "./company-computer-activation.ts";
export * from "./company-computer-boot-intent.ts";
export * from "./company-computer-boot-successor.ts";
export * from "./company-computer-delete-disposition.ts";
export * from "./company-computer-lifecycle.ts";
export * from "./company-computer-reset.ts";
export * from "./company-computer-reset-custody.ts";
export * from "./company-computer-reset-service-restart.ts";
export * from "./company-computer-reset-successor.ts";
export * from "./company-computer-service-restart.ts";
export * from "./company-computer-service-software.ts";
export * from "./company-computer-service-software-measurement.ts";
export * from "./company-computer-service-start.ts";
export * from "./company-computer-service-stop.ts";
export * from "./company-computer-service-successor.ts";
export * from "./company-computer-stop-acknowledgement.ts";
export * from "./company-computer-stop-history.ts";
export * from "./folder-key.ts";
export * from "./idle-rule.ts";
export * from "./wire-values.ts";
