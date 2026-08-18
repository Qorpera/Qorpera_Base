/**
 * Child side of the host-managed computer lane.
 *
 * Staff agents remain network-isolated. Browser work is submitted over the
 * existing RPC pipe and executed by the desktop host in a visible,
 * company-scoped Google Chrome profile. The model receives bounded Playwright-style
 * snapshots and may navigate public setup UI, but the host alone decides
 * whether the page has reached a genuine user-only sign-in boundary.
 */

import { randomUUID } from "node:crypto";
import type { KernelIntentCapability } from "@qorpera/pi-protocol";
import { isModelBrokerInstalled } from "./model-broker-client.ts";

export type ComputerAction =
	| "open"
	| "snapshot"
	| "click"
	| "fill"
	| "press"
	| "screenshot"
	| "read_public_value"
	| "store_secret"
	| "handoff";

export interface ComputerBrokerRequest {
	action: ComputerAction;
	url?: string;
	ref?: string;
	text?: string;
	key?: string;
	secretName?: string;
}

export interface ComputerBrokerResponse {
	url: string;
	title: string;
	snapshot: string;
	handoffReady: boolean;
	publicValue?: string;
	screenshotBase64?: string;
}

interface PendingRequest {
	resolve: (response: ComputerBrokerResponse) => void;
	reject: (error: Error) => void;
}

const pending = new Map<string, PendingRequest>();
let writeFrame: ((frame: object) => void) | undefined;
let activeIntent: KernelIntentCapability | undefined;

export function setComputerBrokerWriter(writer: ((frame: object) => void) | undefined): void {
	writeFrame = writer;
}

export function setComputerBrokerIntent(intent: KernelIntentCapability | undefined): void {
	activeIntent = intent;
}

export function isComputerBrokerAvailable(): boolean {
	return writeFrame !== undefined;
}

export function brokeredComputerAction(
	request: ComputerBrokerRequest,
	signal?: AbortSignal,
): Promise<ComputerBrokerResponse> {
	return new Promise((resolve, reject) => {
		if (!writeFrame) {
			reject(new Error("use_computer requires the Qorpera desktop host"));
			return;
		}
		if (isModelBrokerInstalled() && !activeIntent) {
			reject(new Error("host computer action has no verified causal intent for this turn"));
			return;
		}
		const requestId = randomUUID();
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
		writeFrame({ type: "qorpera_computer_request", requestId, ...request, intent: activeIntent });
	});
}

/** Consume host-originated computer response frames from RPC stdin. */
export function handleComputerBrokerFrame(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const frame = value as {
		type?: unknown;
		requestId?: unknown;
		url?: unknown;
		title?: unknown;
		snapshot?: unknown;
		handoffReady?: unknown;
		publicValue?: unknown;
		screenshotBase64?: unknown;
		error?: unknown;
	};
	if (frame.type !== "qorpera_computer_response") return false;
	if (typeof frame.requestId !== "string") return true;
	const entry = pending.get(frame.requestId);
	if (!entry) return true;
	if (typeof frame.error === "string") {
		entry.reject(new Error(frame.error));
		return true;
	}
	if (
		typeof frame.url !== "string" ||
		typeof frame.title !== "string" ||
		typeof frame.snapshot !== "string" ||
		typeof frame.handoffReady !== "boolean" ||
		(frame.publicValue !== undefined && typeof frame.publicValue !== "string") ||
		(frame.screenshotBase64 !== undefined && typeof frame.screenshotBase64 !== "string")
	) {
		entry.reject(new Error("host computer response frame is invalid"));
		return true;
	}
	entry.resolve({
		url: frame.url,
		title: frame.title,
		snapshot: frame.snapshot,
		handoffReady: frame.handoffReady,
		...(frame.publicValue !== undefined ? { publicValue: frame.publicValue } : {}),
		...(frame.screenshotBase64 !== undefined ? { screenshotBase64: frame.screenshotBase64 } : {}),
	});
	return true;
}
