/**
 * Child side of transactional company operations.
 *
 * Company mutations belong to the desktop host. Agent tools submit one
 * bounded operation and wait for the host to validate, persist, and
 * acknowledge it before the tool can report success.
 */

import { createHash, randomUUID } from "node:crypto";
import type { KernelIntentCapability } from "@qorpera/pi-protocol";
import { isModelBrokerInstalled } from "./model-broker-client.ts";

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

export interface CompanyOperationResponse {
	message: string;
}

interface PendingOperation {
	resolve: (response: CompanyOperationResponse) => void;
	reject: (error: Error) => void;
}

const MAX_OPERATION_BYTES = 512 * 1024;
const pending = new Map<string, PendingOperation>();
let writeFrame: ((frame: object) => void) | undefined;
let activeIntent: KernelIntentCapability | undefined;
let activeOperationOrdinal = 0;

export function setCompanyOperationBrokerWriter(writer: ((frame: object) => void) | undefined): void {
	writeFrame = writer;
}

export function setCompanyOperationBrokerIntent(intent: KernelIntentCapability | undefined): void {
	if (intent?.nonce !== activeIntent?.nonce) activeOperationOrdinal = 0;
	activeIntent = intent;
}

function deterministicOperationId(executionId: string, ordinal: number): string {
	const hex = createHash("sha256").update(`qorpera-operation\0${executionId}\0${ordinal}`).digest("hex").slice(0, 32);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export function brokeredCompanyOperation(
	kind: CompanyOperationKind,
	input: unknown,
	signal?: AbortSignal,
): Promise<CompanyOperationResponse> {
	return new Promise((resolve, reject) => {
		if (!writeFrame) {
			reject(new Error(`${kind} requires the Qorpera desktop host`));
			return;
		}
		if (isModelBrokerInstalled() && !activeIntent) {
			reject(new Error("company operation has no verified causal intent for this turn"));
			return;
		}
		const requestId = activeIntent?.execution
			? deterministicOperationId(activeIntent.execution.id, ++activeOperationOrdinal)
			: randomUUID();
		const frame = {
			type: "qorpera_company_operation_request",
			requestId,
			kind,
			input,
			intent: activeIntent,
		};
		let serialized: string;
		try {
			serialized = JSON.stringify(frame);
		} catch {
			reject(new Error("company operation is not serializable"));
			return;
		}
		if (Buffer.byteLength(serialized, "utf-8") > MAX_OPERATION_BYTES) {
			reject(new Error("company operation exceeds 512 KiB"));
			return;
		}
		const settle = (action: () => void): void => {
			pending.delete(requestId);
			action();
		};
		pending.set(requestId, {
			resolve: (response) => settle(() => resolve(response)),
			reject: (error) => settle(() => reject(error)),
		});
		if (signal) {
			const onAbort = (): void => pending.get(requestId)?.reject(new Error("Operation aborted"));
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}
		writeFrame(frame);
	});
}

export function handleCompanyOperationBrokerFrame(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const frame = value as {
		type?: unknown;
		requestId?: unknown;
		message?: unknown;
		error?: unknown;
	};
	if (frame.type !== "qorpera_company_operation_response") return false;
	if (typeof frame.requestId !== "string") return true;
	const operation = pending.get(frame.requestId);
	if (!operation) return true;
	if (typeof frame.error === "string") {
		operation.reject(new Error(frame.error));
		return true;
	}
	if (typeof frame.message !== "string" || !frame.message.trim()) {
		operation.reject(new Error("host company operation response is invalid"));
		return true;
	}
	operation.resolve({ message: frame.message });
	return true;
}
