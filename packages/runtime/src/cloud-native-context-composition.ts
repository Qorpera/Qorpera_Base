// Context composition (design RUNTIME-AGENT-MEMORY-TREE.md §6.3; `qorpera.native-context-composition/v1` in
// 0001-cloud-result-fence.patch). Before every provider request the pinned Codex sends the host a manifest of the
// items it is about to send (each one's kind, role, call and size, never its content) on the result fence's socket.
// The host replies with the input to send: Codex's items kept by position, in order, and at most one work message,
// a `qorpera.run-work/v1` envelope standing where the run's earlier steps were (or, on a resumed run, would be).
// Codex checks the reply against its own items before anything changes: it refuses a dropped instruction or user
// message, a call kept without its output, a fold that is not the run's earlier steps, a work message out of place
// or not a plain envelope, and kept host-written text that passes for one. The composed input applies to that one
// request only, so the work message never enters Codex's history; the result fence then runs over what was kept.
// The reply may also set the request's prompt cache key (§6.2), a capability of its own.

import { redactCloudWebhookSecrets } from "./cloud-native-tool-boundary.ts";

export const CLOUD_NATIVE_CONTEXT_COMPOSITION_SCHEMA = "qorpera.native-context-composition/v1";
/** The patch's marker for a prompt cache key set by the composition's reply. */
export const CLOUD_NATIVE_PROMPT_CACHE_KEY_CAPABILITY = "qorpera.native-prompt-cache-key/v1";
/** The work message's bound, as the pinned Codex's. */
export const CLOUD_NATIVE_WORK_MESSAGE_BYTES = 256 * 1024;
const ID = /^[A-Za-z0-9_:.-]{1,160}$/;

/** Every kind of item the pinned Codex names (its `kind`, exhaustive over its items). */
export const CLOUD_NATIVE_CONTEXT_ITEM_KINDS = [
	"additional_tools",
	"message",
	"agent_message",
	"reasoning",
	"local_shell_call",
	"function_call",
	"tool_search_call",
	"function_call_output",
	"custom_tool_call",
	"custom_tool_call_output",
	"tool_search_output",
	"web_search_call",
	"image_generation_call",
	"compaction",
	"configuration_update",
	"compaction_trigger",
	"context_compaction",
	"other",
] as const;

export type CloudNativeContextItemKind = (typeof CLOUD_NATIVE_CONTEXT_ITEM_KINDS)[number];

/** One item of the request Codex is about to send. */
export interface CloudNativeContextItem {
	kind: CloudNativeContextItemKind;
	/** A message's role. */
	role: string | null;
	/** A call's or an output's call id. */
	callId: string | null;
	/** The item's provider id, if it has one. */
	id: string | null;
	/** Bytes of text, arguments and encrypted content; images and audio are counted in `media`. */
	bytes: number;
	media: number;
}

export interface CloudNativeContextRequest {
	schema: typeof CLOUD_NATIVE_CONTEXT_COMPOSITION_SCHEMA;
	requestId: string;
	threadId: string;
	turnId: string | null;
	purpose: "turn" | "prewarm" | "compaction";
	model: string;
	items: CloudNativeContextItem[];
}

/** Keep Codex's item at this position, or put the run's one work message (its envelope's text) here. */
export type CloudNativeContextEntry = { keep: number } | { work: string };

export interface CloudNativeContextComposition {
	input: CloudNativeContextEntry[];
	/**
	 * `qorpera:` and a SHA-256 in unpadded base64url, 51 characters within the provider's 64 (design §6.2,
	 * its own capability); Codex's own key when absent.
	 */
	promptCacheKey?: string;
}

function closed(value: unknown, keys: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys)
		throw new Error("Invalid native context frame");
	return value as Record<string, unknown>;
}

function optionalText(value: unknown, length: number): value is string | null {
	return value === null || (typeof value === "string" && value.length >= 1 && value.length <= length);
}

function size(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function parseCloudNativeContextRequest(value: unknown): CloudNativeContextRequest {
	const request = closed(value, "items,model,purpose,requestId,schema,threadId,turnId");
	if (
		request.schema !== CLOUD_NATIVE_CONTEXT_COMPOSITION_SCHEMA ||
		typeof request.requestId !== "string" ||
		!ID.test(request.requestId) ||
		typeof request.threadId !== "string" ||
		!ID.test(request.threadId) ||
		(request.turnId !== null &&
			!(request.purpose === "prewarm" && request.turnId === "") &&
			(typeof request.turnId !== "string" || !ID.test(request.turnId))) ||
		!["turn", "prewarm", "compaction"].includes(String(request.purpose)) ||
		typeof request.model !== "string" ||
		request.model.length < 1 ||
		request.model.length > 256 ||
		// No count cap on a request's items (founder, 2026-09-24); the frame bounds their size.
		!Array.isArray(request.items)
	)
		throw new Error("Invalid native context frame");
	const items = request.items.map((value): CloudNativeContextItem => {
		const item = closed(value, "bytes,callId,id,kind,media,role");
		if (
			!(CLOUD_NATIVE_CONTEXT_ITEM_KINDS as readonly unknown[]).includes(item.kind) ||
			!optionalText(item.role, 64) ||
			!optionalText(item.callId, 512) ||
			!optionalText(item.id, 512) ||
			!size(item.bytes) ||
			!size(item.media)
		)
			throw new Error("Invalid native context frame");
		return {
			kind: item.kind as CloudNativeContextItemKind,
			role: item.role,
			callId: item.callId,
			id: item.id,
			bytes: item.bytes,
			media: item.media,
		};
	});
	return {
		schema: CLOUD_NATIVE_CONTEXT_COMPOSITION_SCHEMA,
		requestId: request.requestId,
		threadId: request.threadId,
		turnId: request.turnId as string | null,
		purpose: request.purpose as CloudNativeContextRequest["purpose"],
		model: request.model,
		items,
	};
}

/** Every item kept, unchanged: a request with nothing to compose. */
export function cloudNativeContextIdentity(request: CloudNativeContextRequest): CloudNativeContextComposition {
	return { input: request.items.map((_, keep) => ({ keep })) };
}

/** The reply to `request`: only the protocol's own keys, so nothing else a composer returns reaches Codex. */
export function cloudNativeContextReply(
	request: CloudNativeContextRequest,
	composition: CloudNativeContextComposition,
): Record<string, unknown> {
	const input = composition.input.map((entry) => {
		// One key each: an entry that both keeps and adds is not one Codex reads.
		const keys = Object.keys(entry).join();
		if (
			keys === "keep" &&
			"keep" in entry &&
			Number.isSafeInteger(entry.keep) &&
			entry.keep >= 0 &&
			entry.keep < request.items.length
		)
			return { keep: entry.keep };
		if (
			keys === "work" &&
			"work" in entry &&
			typeof entry.work === "string" &&
			Buffer.byteLength(entry.work) <= CLOUD_NATIVE_WORK_MESSAGE_BYTES
		)
			// The run's work message, from its steps and receipts: a webhook signing secret is cut out of it, as out of
			// everything else the run's requests carry (the tool boundary's rule, E3c-2).
			return { work: redactCloudWebhookSecrets(entry.work) };
		throw new Error("Invalid native context composition");
	});
	if (composition.promptCacheKey !== undefined && !/^qorpera:[A-Za-z0-9_-]{43}$/.test(composition.promptCacheKey))
		throw new Error("Invalid native context composition");
	return {
		schema: CLOUD_NATIVE_CONTEXT_COMPOSITION_SCHEMA,
		requestId: request.requestId,
		threadId: request.threadId,
		turnId: request.turnId,
		input,
		...(composition.promptCacheKey === undefined ? {} : { promptCacheKey: composition.promptCacheKey }),
	};
}
