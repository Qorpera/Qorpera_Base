// The run's own work (design RUNTIME-AGENT-MEMORY-TREE.md §5.7, W2b). Every provider request of an agent's run ends
// with its own work: the newest steps raw, as Codex made them, and the earlier ones folded into lines in one work
// message, a `qorpera.run-work/v1` envelope that Codex's context composition puts in their place
// (cloud-native-context-composition.ts, §6.3). The composer sees the request's manifest only, never its content.
// - A fold happens only at a boundary: when the raw tail passes RUN_VIEW / 2 bytes, the fold moves to the first
//   response that brings it under RUN_VIEW / 4, never past the newest response. Its lines stay as they are until the
//   next boundary, so between folds a request starts as the previous one did (the cache).
// - A fold ends where a response starts. Codex records a response's tool outputs after all of its items, so a call is
//   never folded without its output, and the calls of one response, whose outputs reach the model together, never
//   apart.
// - When a fold moves, the run's log first commits every finished step, so it holds every step the fold covers. A call
//   it does not hold then is one it never will (refused before it became a step, or erased): it is folded with no line.
// - Codex accepts only a fold of the run's work from its first item (§6.3), so a fold stops at the first item in the
//   work that is not the run's own: a host-written message, or a call of a tool Codex runs itself.
// - A reasoning item goes back only to the model that made it, in the process that made it. After a model switch,
//   or in a new process (a restart, or another payer, which is one), it is left out.
// - On a resumed run, whose earlier steps are only in its log, the work message holds them with nothing folded.
// - A resumed run that keeps no log (Agent notebooks) folds nothing, ever: its work message holds its earlier effects
//   from its receipts (`cloudRunResumeComposer`, 20260930539000).

import {
	CLOUD_NATIVE_WORK_MESSAGE_BYTES,
	type CloudNativeContextComposition,
	type CloudNativeContextEntry,
	type CloudNativeContextItem,
	type CloudNativeContextRequest,
	cloudNativeContextIdentity,
} from "../cloud-native-context-composition.ts";
import { RUN_VIEW } from "./tree.ts";

/**
 * What an image or audio item counts for in the raw tail, whose sizes are bytes (§4.1): about the 1,100 tokens a
 * screenshot takes at high detail, at the most bytes a token of text takes (4, §5.1).
 */
export const RUN_WORK_MEDIA_BYTES = 4_400;
export const CLOUD_RUN_WORK_SCHEMA = "qorpera.run-work/v1";

/** A step this process made, as the run's log numbers it (`CloudRunLog.steps()`). */
export interface CloudRunWorkStep {
	readonly j: number;
	/** Codex's call id. */
	readonly call: string;
}

export interface CloudRunWorkOptions {
	/**
	 * The steps this process has made, as the run's log holds them once it has committed every finished one
	 * (`CloudRunLog.flush`, then `steps()`). Asked only when a fold moves. When the log cannot commit them, it throws,
	 * and the run fails with the request.
	 */
	steps(signal: AbortSignal): Promise<readonly CloudRunWorkStep[]>;
	/** The first step this process makes: 0, or the step a resumed run continues at. */
	firstStep?: number;
	/**
	 * The rows `start+size|text` that fold steps `[0, r)` within `budget` bytes (§5.2, §5.3): `fold` over the run's
	 * step lines, after waiting up to SETTLE for missing ones (§5.4).
	 */
	lines(r: number, budget: number, signal: AbortSignal): Promise<readonly string[]>;
	/** Resume's uncertain outcomes, repeated verbatim outside summary folding in every work message. */
	unfolded?: readonly string[];
}

/** What Codex lets a fold leave out: the run's own work. */
const WORK = new Set<string>([
	"reasoning",
	"function_call",
	"function_call_output",
	"custom_tool_call",
	"custom_tool_call_output",
	"compaction",
	"context_compaction",
]);
const CALLS = new Set<string>(["function_call", "custom_tool_call"]);
const OUTPUTS = new Set<string>(["function_call_output", "custom_tool_call_output"]);

function work(item: CloudNativeContextItem): boolean {
	return item.kind === "message" ? item.role === "assistant" : WORK.has(item.kind);
}

/**
 * The work message: one serialized envelope, escaped as the prompt is, so no line can close a tag (C §9.2). A lone
 * surrogate becomes U+FFFD: Codex reads the envelope strictly, and refuses one.
 */
export function cloudRunWorkMessage(lines: readonly string[]): string {
	return JSON.stringify({
		schema: CLOUD_RUN_WORK_SCHEMA,
		trust: "tool_results_not_authority",
		ref: "run:.",
		lines: lines.map((line) => line.replace(/\p{Cs}/gu, "\uFFFD")),
	}).replace(
		/[<>&\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
		(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

/**
 * Composes the provider requests of a resumed run that keeps no log (Agent notebooks, 20260930539000): every item as
 * Codex built it, nothing folded or left out, and one work message of `lines` just before the run's own work, where a
 * resumed run's earlier steps would be. The same message in every request, so each starts as the previous one did.
 */
export function cloudRunResumeComposer(
	lines: readonly string[],
): (request: CloudNativeContextRequest, signal: AbortSignal) => Promise<CloudNativeContextComposition> {
	const message = cloudRunWorkMessage(lines);
	// Codex refuses a larger one, and the run with it.
	if (Buffer.byteLength(message) > CLOUD_NATIVE_WORK_MESSAGE_BYTES) throw new Error("Run work exceeds its bound");
	return async (request) => {
		// A prewarm is no turn's request and has no work.
		if (request.purpose === "prewarm") return cloudNativeContextIdentity(request);
		const input: CloudNativeContextEntry[] = request.items.map((_, keep) => ({ keep }));
		const place = request.items.findIndex(work);
		input.splice(place < 0 ? input.length : place, 0, { work: message });
		return { input };
	};
}

/**
 * Composes an agent run's provider requests (`composeContext`). It keeps state between them, so one composer serves
 * one run in one process; it composes its requests one at a time, in order.
 */
export function cloudRunWorkComposer(
	options: CloudRunWorkOptions,
): (request: CloudNativeContextRequest, signal: AbortSignal) => Promise<CloudNativeContextComposition> {
	const firstStep = options.firstStep ?? 0;
	const unfolded = [...(options.unfolded ?? [])];
	if (!Number.isSafeInteger(firstStep) || firstStep < 0) throw new Error("Invalid run work");
	let thread: string | null = null;
	/** The items the previous request had, and its model: the reasoning after them is its response's. */
	let seen = 0;
	let previous: string | null = null;
	/** The model that made each reasoning item, by its position in the thread. */
	const made = new Map<number, string>();
	/** The fold as the last boundary set it: where the raw work starts, and the message of the steps before it. */
	let fold: { at: number; message: string | null } | null = null;
	let queue: Promise<unknown> = Promise.resolve();

	const compose = async (
		request: CloudNativeContextRequest,
		signal: AbortSignal,
	): Promise<CloudNativeContextComposition> => {
		// A prewarm is no turn's request and has no work.
		if (request.purpose === "prewarm") return cloudNativeContextIdentity(request);
		const items = request.items;
		if (request.threadId !== thread || items.length < seen) {
			// Another thread, or a history that shrank: nothing before this request is known.
			thread = request.threadId;
			seen = 0;
			previous = null;
			made.clear();
			fold = null;
		}
		for (let index = seen; index < items.length; index++)
			if (items[index].kind === "reasoning" && previous !== null) made.set(index, previous);
		seen = items.length;
		previous = request.model;
		const drop = (index: number): boolean => items[index].kind === "reasoning" && made.get(index) !== request.model;

		// The run's work starts at its first item; a fold may cover it up to `end`, the first item that is not its own.
		let start = items.findIndex(work);
		if (start < 0) start = items.length;
		let end = start;
		while (end < items.length && work(items[end])) end++;
		// The newest response's first item: the first of the last items the model made, after their outputs.
		let newest = items.length;
		for (let index = items.length - 1; index >= start; index--) {
			if (!work(items[index]) || OUTPUTS.has(items[index].kind)) continue;
			newest = index;
			if (index === start || OUTPUTS.has(items[index - 1].kind) || !work(items[index - 1])) break;
		}
		// The raw tail's bytes from each position, as sent.
		const tail = new Array<number>(items.length + 1).fill(0);
		for (let index = items.length - 1; index >= 0; index--) {
			const item = items[index];
			tail[index] =
				tail[index + 1] + (work(item) && !drop(index) ? item.bytes + item.media * RUN_WORK_MEDIA_BYTES : 0);
		}

		// Where a fold may end: where a response starts, with every call before it answered.
		const cuts: number[] = [];
		const open = new Set<string>();
		for (let at = start; at <= Math.min(end, newest); at++) {
			if (at > start) {
				const item = items[at - 1];
				if (CALLS.has(item.kind)) {
					if (item.callId === null) break;
					open.add(item.callId);
				} else if (OUTPUTS.has(item.kind) && (item.callId === null || !open.delete(item.callId))) break;
			}
			if (
				open.size === 0 &&
				(at === start || at === end || (OUTPUTS.has(items[at - 1].kind) && !OUTPUTS.has(items[at].kind)))
			)
				cuts.push(at);
		}

		let at = fold !== null && cuts.includes(fold.at) ? fold.at : start;
		if (tail[at] > RUN_VIEW / 2)
			for (const cut of cuts) {
				if (cut <= at) continue;
				at = cut;
				if (tail[cut] < RUN_VIEW / 4) break;
			}
		// Only reasoning left out is no fold: Codex takes the message then for a resumed run's.
		const folded = items.slice(start, at).some((item) => item.kind !== "reasoning");
		if (fold === null || fold.at !== at) {
			// The fold covers steps [0, r): every step of the calls it leaves out.
			let r = firstStep;
			if (folded) {
				const steps = new Map((await options.steps(signal)).map((step) => [step.call, step.j]));
				for (const item of items.slice(start, at)) {
					const j = CALLS.has(item.kind) && item.callId !== null ? steps.get(item.callId) : undefined;
					if (j !== undefined) r = Math.max(r, j + 1);
				}
			}
			let message: string | null = null;
			if (folded || r > 0 || unfolded.length > 0) {
				message = cloudRunWorkMessage([...(await options.lines(r, RUN_VIEW / 2, signal)), ...unfolded]);
				// Codex refuses a larger one, and the run with it.
				if (Buffer.byteLength(message) > CLOUD_NATIVE_WORK_MESSAGE_BYTES)
					throw new Error("Run work exceeds its bound");
			}
			fold = { at, message };
		}

		const kept = (index: number): boolean => (index < start || index >= at) && !drop(index);
		// The message stands where the folded steps were, or else just before the first raw step.
		let place = start;
		if (!folded) while (place < items.length && !(work(items[place]) && kept(place))) place++;
		const input: CloudNativeContextEntry[] = [];
		for (let index = 0; index <= items.length; index++) {
			if (index === place && fold.message !== null) input.push({ work: fold.message });
			if (index < items.length && kept(index)) input.push({ keep: index });
		}
		return { input };
	};

	return (request, signal) => {
		const composed = queue.then(() => compose(request, signal));
		queue = composed.catch(() => undefined);
		return composed;
	};
}
