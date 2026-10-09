// The primary view at run start (design RUNTIME-AGENT-MEMORY-TREE.md §5.3, §5.5, §6, §13; M1b-4a).
// - qorpera_memory_view (migration 20260930204000) answers, for a run in a conversation of a listed company, the
//   conversation, T (the messages before the inputs that woke the run), the sequence of T's last message, and the live
//   tree. Any other run gets null and keeps today's history. The view folds `[0, T)` from the tree's lines; the
//   branches come from qorpera_memory_branches (M4).
// - The blocks whose lines the view and the branches show are released as platform reads under the composed context's
//   SHA-256 (qorpera_memory_release, M1b-3b), before any model request, so no call here keeps a receipt.
// - The run then records its first request (memory_view, §13), once per attempt. The record's answer, the folder clock
//   after the trees were read, is the view reference's asOfSeq (W4a-1): each conversation shown, with its generation,
//   its T and the blocks shown, for a worker the run dispatches. A failed record leaves the run without one.
// - Every request of the run carries the conversation's prompt cache key (§6.2).

import { isUuid, parseClosedRecord, parseInteger, WireValueError } from "@qorpera/contracts";
import type { CloudCodexContextComposer } from "../cloud-codex-tool-session.ts";
import type { CloudCompanyPathControl } from "../cloud-company-path-gateway.ts";
import { type CloudNativeConversationTree, escapeCloudNativeContextJson } from "../cloud-native-company-context.ts";
import { cloudNativeContextIdentity } from "../cloud-native-context-composition.ts";
import { type CloudNativeToolBinding, cloudToolRequest } from "../cloud-native-tool-authority.ts";
import { cloudRuntimeErrorCategory } from "../cloud-runtime-observability.ts";
import {
	type MemoryTreeBlock,
	type MemoryTreeRead,
	type MemoryViewConversation,
	memoryBlockKey,
	memoryRunBranches,
	memoryTreeRead,
} from "./branches.ts";
import { type MemoryTreeBuilt, memoryView } from "./fold.ts";
import { memoryNodeAddress, VIEW } from "./tree.ts";
import { memoryConversationName, memoryConversationView } from "./view.ts";
import { memoryRelease } from "./zoom.ts";

/** The host call's answer schema. */
export const MEMORY_VIEW_SCHEMA = "qorpera.memory-view/v1";
/** qorpera_memory_view_record's answer schema. */
export const MEMORY_VIEW_RECORD_SCHEMA = "qorpera.memory-view-record/v1";
/** The call a composition's release is named by: the run's first request. */
export const MEMORY_COMPOSITION_CALL = "composition:0";
/** A view reference's bound in bytes of its jsonb text (W4a-1). */
export const MEMORY_VIEW_REFERENCE_BYTES = 262_144;

/** A run's primary view and branches, composed before its context is hashed. */
export interface MemoryComposedView {
	/** For the developer message after the head (§5.3, §6.1): VIEW_DOC and the conversation's parts. */
	readonly views: string;
	/** What the context message carries beside it. */
	readonly tree: CloudNativeConversationTree;
	/** The view's parts that show a placeholder (§5.4). */
	readonly placeholders: number;
	/** The run's conversation, then each branch whose tree was read, for the view reference. */
	readonly conversations: MemoryViewConversation[];
	/** The blocks whose lines the view and the branches show, each once, to release. */
	readonly blocks: MemoryTreeBlock[];
}

/** A view reference (W4a-1): the folder clock the run's trees were read by, and each conversation it was shown. */
export interface MemoryViewReference {
	readonly asOfSeq: number;
	readonly conversations: MemoryViewConversation[];
}

/** What the run measured of its first request beside the view (§13). */
export interface MemoryViewMeasures {
	/** The SHA-256 of the context the view is part of, which names its release. */
	readonly contextSha256: string;
	readonly headBytes: number;
	/** The SHA-256 of the developer instructions up to the view (cloudNativeStableInstructions). */
	readonly stablePrefixSha256: string;
}

interface Answer {
	readonly sessionId: string;
	readonly name: string;
	readonly messages: number;
	readonly lastSequence: number | null;
	readonly tree: MemoryTreeRead;
}

function answer(value: unknown): Answer | null {
	if (value === null) return null;
	try {
		const read = parseClosedRecord(value, "the answer", [
			"schema",
			"conversation",
			"messages",
			"lastSequence",
			"tree",
		]);
		if (read.schema !== MEMORY_VIEW_SCHEMA) throw new WireValueError("its schema");
		const conversation = parseClosedRecord(read.conversation, "its conversation", ["sessionId", "kind", "name"]);
		const { kind, name } = conversation;
		if (kind !== "thread" && kind !== "group" && kind !== "conversation") {
			throw new WireValueError("its conversation's kind");
		}
		if (name !== null && typeof name !== "string") throw new WireValueError("its conversation's name");
		if (!isUuid(conversation.sessionId)) throw new WireValueError("its conversation's session");
		const messages = parseInteger(read.messages, "its messages", 0, Number.MAX_SAFE_INTEGER);
		const lastSequence =
			read.lastSequence === null
				? null
				: parseInteger(read.lastSequence, "its last sequence", 1, Number.MAX_SAFE_INTEGER);
		if ((messages === 0) !== (lastSequence === null)) throw new WireValueError("its last sequence");
		const [sessionId, tree] = memoryTreeRead(read.tree);
		if (sessionId !== conversation.sessionId) throw new WireValueError("its tree", "is another conversation's");
		return {
			sessionId,
			name: typeof name === "string" && name.trim() !== "" ? memoryConversationName(kind, name) : kind,
			messages,
			lastSequence,
			tree,
		};
	} catch (error) {
		if (error instanceof WireValueError) {
			throw new Error(`Invalid memory view answer: ${error.message}`, { cause: error });
		}
		throw error;
	}
}

/**
 * The binding's primary view and branches (§5.3, §5.5), or null for a run that has none: a run with no conversation,
 * or one of a company not listed. A failure throws.
 */
export async function memoryComposeView(
	control: CloudCompanyPathControl,
	binding: CloudNativeToolBinding,
	signal: AbortSignal,
): Promise<MemoryComposedView | null> {
	const read = answer(
		await cloudToolRequest(
			(requestSignal) => control.call("qorpera_memory_view", { p_binding: binding }, requestSignal),
			signal,
		),
	);
	if (!read) return null;
	const { tree, messages: T } = read;
	const built: MemoryTreeBuilt = (l, k) => tree.lines.get(memoryNodeAddress(l, k))?.text;
	const parts = memoryView(T, built, VIEW);
	const shown = new Map<string, MemoryTreeBlock>();
	for (const part of parts) {
		const block = part.text === null ? undefined : tree.lines.get(memoryNodeAddress(part.l, part.k))?.block;
		if (block) shown.set(memoryBlockKey(block), block);
	}
	const run = await memoryRunBranches((sessions) =>
		cloudToolRequest(
			(requestSignal) =>
				control.call("qorpera_memory_branches", { p_binding: binding, p_request: { sessions } }, requestSignal),
			signal,
		),
	);
	const own: MemoryViewConversation = {
		sessionId: read.sessionId,
		generation: tree.generation,
		through: T,
		blocks: [...shown.values()],
	};
	const blocks = new Map(shown);
	for (const block of run.blocks) blocks.set(memoryBlockKey(block), block);
	return {
		views: memoryConversationView(read.name, parts),
		tree: { conversationMessages: T, lastSequence: read.lastSequence, branches: run.branches },
		placeholders: parts.filter((part) => part.text === null).length,
		conversations: [own, ...run.conversations],
		blocks: [...blocks.values()],
	};
}

/**
 * The bytes of `value`'s text as jsonb writes it, by which W4a-1 bounds a view reference: JSON with a space after each
 * `:` and `,`, its strings and numbers as JSON.stringify writes them.
 */
export function memoryJsonbTextBytes(value: unknown): number {
	if (Array.isArray(value))
		return value.reduce((bytes: number, item, index) => bytes + (index > 0 ? 2 : 0) + memoryJsonbTextBytes(item), 2);
	if (value !== null && typeof value === "object")
		return Object.entries(value).reduce(
			(bytes: number, [key, item], index) =>
				bytes + (index > 0 ? 2 : 0) + Buffer.byteLength(JSON.stringify(key)) + 2 + memoryJsonbTextBytes(item),
			2,
		);
	return Buffer.byteLength(JSON.stringify(value));
}

/** qorpera_memory_view_record's answer to the request of `step`: its asOfSeq. */
function recordedSeq(value: unknown, step: number): number {
	try {
		const read = parseClosedRecord(value, "the answer", ["schema", "step", "asOfSeq"]);
		if (read.schema !== MEMORY_VIEW_RECORD_SCHEMA || read.step !== step) throw new WireValueError("its step");
		return parseInteger(read.asOfSeq, "its asOfSeq", 0, Number.MAX_SAFE_INTEGER);
	} catch (error) {
		if (error instanceof WireValueError) {
			throw new Error(`Invalid memory view record answer: ${error.message}`, { cause: error });
		}
		throw error;
	}
}

/**
 * After the run's context is composed and hashed: releases the blocks the view and the branches show, under the
 * context's SHA-256, then records the run's first request (memory_view, §13). Answers the view reference, or null when
 * the record failed or the reference passes its bound. A failed release throws: no model request may see lines that
 * were not released. A failed record is logged, and the run goes on.
 */
export async function memoryCommitView(
	control: CloudCompanyPathControl,
	binding: CloudNativeToolBinding,
	composed: MemoryComposedView,
	measures: MemoryViewMeasures,
	signal: AbortSignal,
): Promise<MemoryViewReference | null> {
	if (composed.blocks.length > 0) {
		const shown = { runId: binding.runId, callId: MEMORY_COMPOSITION_CALL, outputSha256: measures.contextSha256 };
		await memoryRelease(control, binding, shown, composed.blocks, signal);
	}
	const request = {
		step: 0,
		messages: composed.tree.conversationMessages,
		headBytes: measures.headBytes,
		viewBytes: Buffer.byteLength(composed.views),
		branchesBytes: Buffer.byteLength(escapeCloudNativeContextJson(JSON.stringify(composed.tree.branches))),
		// The run's own view (§5.7, W2) and the wait for lines (§5.4, settle) come later.
		runViewBytes: 0,
		rawSteps: 0,
		placeholders: composed.placeholders,
		waitMs: 0,
		waitedLines: 0,
		folded: false,
		stablePrefixSha256: measures.stablePrefixSha256,
	};
	let asOfSeq: number;
	try {
		const recorded = await cloudToolRequest(
			(requestSignal) =>
				control.call("qorpera_memory_view_record", { p_binding: binding, p_request: request }, requestSignal),
			signal,
		);
		asOfSeq = recordedSeq(recorded, request.step);
	} catch (error) {
		signal.throwIfAborted();
		console.error(`Memory view was not recorded (${cloudRuntimeErrorCategory(error, signal)})`);
		return null;
	}
	const reference = { asOfSeq, conversations: composed.conversations };
	return memoryJsonbTextBytes(reference) <= MEMORY_VIEW_REFERENCE_BYTES ? reference : null;
}

/**
 * A run's composer that sets the conversation's prompt cache key (§6.2) on every request; `compose` composes the
 * input, and keeps every item without one.
 */
export function memoryCacheKeyComposer(
	promptCacheKey: string,
	compose: CloudCodexContextComposer = cloudNativeContextIdentity,
): CloudCodexContextComposer {
	return async (request, signal) => ({ ...(await compose(request, signal)), promptCacheKey });
}
