import { UUID_PATTERN } from "@qorpera/contracts";
import type { CloudCompanyPathControl } from "@qorpera/runtime/cloud-company-path-gateway";
import { escapeCloudNativeContextJson } from "@qorpera/runtime/cloud-native-company-context";
import {
	CLOUD_NATIVE_CONTEXT_COMPOSITION_SCHEMA,
	type CloudNativeContextRequest,
} from "@qorpera/runtime/cloud-native-context-composition";
import { MEMORY_BRANCHES_SCHEMA } from "@qorpera/runtime/memory-tree/branches";
import {
	MEMORY_VIEW_RECORD_SCHEMA,
	MEMORY_VIEW_REFERENCE_BYTES,
	MEMORY_VIEW_SCHEMA,
	type MemoryComposedView,
	memoryCacheKeyComposer,
	memoryCommitView,
	memoryComposeView,
	memoryJsonbTextBytes,
} from "@qorpera/runtime/memory-tree/compose";
import { memoryView } from "@qorpera/runtime/memory-tree/fold";
import { memoryBlockPath, VIEW } from "@qorpera/runtime/memory-tree/tree";
import { memoryConversationView, memoryPromptCacheKey } from "@qorpera/runtime/memory-tree/view";
import { MEMORY_RELEASE_SCHEMA } from "@qorpera/runtime/memory-tree/zoom";
import { describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "../fixtures/native-tool-authority-fixture.ts";

const SESSION = "97300000-0000-4000-8000-000000000001";
const BRANCH = "97300000-0000-4000-8000-000000000002";
/** Bo's thread memory, which holds the tree's blocks, and Ida's, a branch. */
const ROOT = "agents/bo/memory/thread";
const BRANCH_ROOT = "agents/ida/memory/thread";
const CONTEXT = "c".repeat(64);
const MEASURES = { contextSha256: CONTEXT, headBytes: 1234, stablePrefixSha256: "a".repeat(64) };
const WAIT = { waitMs: 1500, waitedLines: 3 };

function version(index: number): string {
	return `97400000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

/** The text of `node(l, k)`. */
function text(l: number, k: number): string {
	return `line ${l}.${k}: what happened`;
}

/**
 * A live tree as qorpera_memory_tree_read reads it: the lines of every node within its first `built` messages, each in
 * its block under `root`.
 */
function treeOf(sessionId: string, root: string, messages: number, built = messages, generation = 3) {
	const blocks: { path: string; version: string }[] = [];
	const lines: { l: number; k: number; text: string; block: number }[] = [];
	for (let l = 0; 2 ** l <= built; l += 1)
		for (let k = 0; (k + 1) * 2 ** l <= built; k += 1) {
			const path = `${root}/${memoryBlockPath(l, k)}`;
			let block = blocks.findIndex((item) => item.path === path);
			if (block < 0) block = blocks.push({ path, version: version(blocks.length) }) - 1;
			lines.push({ l, k, text: text(l, k), block });
		}
	return { sessionId, generation, messages, root, nodeBytes: 512, blocks, lines };
}

type Tree = ReturnType<typeof treeOf>;

/** qorpera_memory_view's answer: Bo's thread, T messages up to sequence `last`, and its tree. */
function viewed(T: number, last: number | null, tree: Tree, name: string | null = "Bo", kind = "thread") {
	return {
		schema: MEMORY_VIEW_SCHEMA,
		conversation: { sessionId: SESSION, kind, name },
		messages: T,
		lastSequence: last,
		tree,
	};
}

/** The blocks of `tree` whose lines the parts of `T`'s view show, each once, in the order they are shown. */
function shownBlocks(tree: Tree, T: number) {
	const built = (l: number, k: number) => tree.lines.find((line) => line.l === l && line.k === k);
	const shown = new Map<string, { path: string; version: string }>();
	for (const part of memoryView(T, (l, k) => built(l, k)?.text, VIEW)) {
		const line = part.text === null ? undefined : built(part.l, part.k);
		if (line) shown.set(tree.blocks[line.block].path, tree.blocks[line.block]);
	}
	return [...shown.values()];
}

/** The parts of `T`'s view of `tree`. */
function partsOf(tree: Tree, T: number) {
	return memoryView(T, (l, k) => tree.lines.find((line) => line.l === l && line.k === k)?.text, VIEW);
}

/** qorpera_memory_view_record's answer to `request`, at folder clock 42. */
function recordedAt(request: Record<string, unknown>) {
	return { schema: MEMORY_VIEW_RECORD_SCHEMA, step: request.step, asOfSeq: 42 };
}

/**
 * A host whose qorpera_memory_view answers `view`; qorpera_memory_branches lists Ida's thread with the tree `branch`,
 * or nothing; the release accepts, and the record answers `recorded`.
 */
function host(
	view: unknown,
	options: { branch?: Tree; recorded?: (request: Record<string, unknown>) => unknown } = {},
) {
	const { binding } = nativeToolAuthorityFixture();
	const recorded = options.recorded ?? recordedAt;
	const call = vi.fn<CloudCompanyPathControl["call"]>(async (method, args) => {
		const request = (args as { p_request?: Record<string, unknown> }).p_request ?? {};
		if (method === "qorpera_memory_view") return view;
		if (method === "qorpera_memory_branches") {
			const { branch } = options;
			const sessions = request.sessions as string[];
			return {
				schema: MEMORY_BRANCHES_SCHEMA,
				branches: branch
					? [{ ref: "thread:ida", kind: "thread", name: "Ida", sessionId: BRANCH, messages: branch.messages }]
					: [],
				trees: branch && sessions.includes(BRANCH) ? [branch] : [],
			};
		}
		if (method === "qorpera_memory_release")
			return {
				schema: MEMORY_RELEASE_SCHEMA,
				releaseId: request.releaseId,
				reads: (request.blocks as unknown[]).length,
				replay: false,
			};
		if (method === "qorpera_memory_view_record") return recorded(request);
		throw new Error(`Unexpected host call ${method}`);
	});
	const requests = (method: string) =>
		call.mock.calls
			.filter(([made]) => made === method)
			.map(([, args]) => (args as { p_request: Record<string, unknown> }).p_request);
	return { binding, call, control: { call }, requests };
}

describe("memory view composition", () => {
	it("answers null for a run without a view, and reads nothing more", async () => {
		const h = host(null);
		await expect(memoryComposeView(h.control, h.binding, new AbortController().signal)).resolves.toBeNull();
		expect(h.call.mock.calls.map(([method, args]) => [method, args])).toEqual([
			["qorpera_memory_view", { p_binding: h.binding }],
		]);
	});

	it("folds the view of the messages before the run's inputs, with the branches, each block once", async () => {
		// Bo's tree has lines past T (16 messages), which the view leaves out.
		const tree = treeOf(SESSION, ROOT, 16);
		const branch = treeOf(BRANCH, BRANCH_ROOT, 4, 4, 7);
		const h = host(viewed(12, 40, tree), { branch });
		const composed = await memoryComposeView(h.control, h.binding, new AbortController().signal);
		expect(composed).not.toBeNull();
		const parts = partsOf(tree, 12);
		expect(composed?.views).toBe(memoryConversationView("Bo (thread)", parts));
		expect(composed?.views).not.toContain(text(0, 12));
		expect(composed?.placeholders).toBe(0);
		expect(composed?.tree.conversationMessages).toBe(12);
		expect(composed?.tree.lastSequence).toBe(40);
		expect(composed?.tree.branches.map((view) => [view.ref, view.name, view.messages])).toEqual([
			["thread:ida", "Ida (thread)", 4],
		]);
		const own = shownBlocks(tree, 12);
		expect(own.length).toBeGreaterThan(0);
		expect(composed?.conversations[0]).toEqual({ sessionId: SESSION, generation: 3, through: 12, blocks: own });
		const others = composed?.conversations.slice(1) ?? [];
		const listed = others.map(({ sessionId, generation, through }) => [sessionId, generation, through]);
		expect(listed).toEqual([[BRANCH, 7, 4]]);
		const theirs = composed?.conversations[1].blocks ?? [];
		expect(theirs.length).toBeGreaterThan(0);
		expect(composed?.blocks).toEqual([...own, ...theirs]);
		// The view first; then the branches' list, and Ida's tree.
		expect(h.call.mock.calls.map(([method]) => method)).toEqual([
			"qorpera_memory_view",
			"qorpera_memory_branches",
			"qorpera_memory_branches",
		]);
		expect(h.requests("qorpera_memory_branches")).toEqual([{ sessions: [] }, { sessions: [BRANCH] }]);
	});

	it("shows a placeholder for a line not built yet, and names a nameless conversation by its kind", async () => {
		const tree = treeOf(SESSION, ROOT, 12, 8);
		const h = host(viewed(12, 40, tree, null, "group"));
		const composed = await memoryComposeView(h.control, h.binding, new AbortController().signal);
		const parts = partsOf(tree, 12);
		const placeholders = parts.filter((part) => part.text === null).length;
		expect(placeholders).toBeGreaterThan(0);
		expect(composed?.placeholders).toBe(placeholders);
		expect(composed?.views).toBe(memoryConversationView("group", parts));
		const blocks = shownBlocks(tree, 12);
		expect(composed?.conversations).toEqual([{ sessionId: SESSION, generation: 3, through: 12, blocks }]);
		// A blank name is no name either.
		const blank = host(viewed(12, 40, tree, " ", "thread"));
		const named = await memoryComposeView(blank.control, blank.binding, new AbortController().signal);
		expect(named?.views).toBe(memoryConversationView("thread", parts));
	});

	it("composes an empty view when no message comes before the run's inputs", async () => {
		const h = host(viewed(0, null, treeOf(SESSION, ROOT, 0)));
		const composed = await memoryComposeView(h.control, h.binding, new AbortController().signal);
		expect(composed?.tree).toEqual({ conversationMessages: 0, lastSequence: null, branches: [] });
		expect(composed?.blocks).toEqual([]);
		expect(composed?.conversations).toEqual([{ sessionId: SESSION, generation: 3, through: 0, blocks: [] }]);
	});

	const changes: [string, string, unknown][] = [
		["another schema", "schema", "qorpera.memory-view/v2"],
		["another key", "extra", 1],
		["a kind that is no conversation's", "conversation", { sessionId: SESSION, kind: "room", name: "Bo" }],
		["a name that is no text", "conversation", { sessionId: SESSION, kind: "thread", name: 7 }],
		["no last sequence for messages", "lastSequence", null],
		["a last sequence for none", "messages", 0],
		["a negative count", "messages", -1],
		["another conversation's tree", "tree", treeOf(BRANCH, ROOT, 12)],
	];
	it.each(changes)("refuses an answer with %s", async (_, key, value) => {
		const h = host({ ...viewed(12, 40, treeOf(SESSION, ROOT, 12)), [key]: value });
		await expect(memoryComposeView(h.control, h.binding, new AbortController().signal)).rejects.toThrow(
			"Invalid memory view answer",
		);
	});

	it("releases the blocks shown under the context's hash, records the request, answers the reference", async () => {
		const tree = treeOf(SESSION, ROOT, 12, 8);
		const h = host(viewed(12, 40, tree), { branch: treeOf(BRANCH, BRANCH_ROOT, 4, 4, 7) });
		const signal = new AbortController().signal;
		const composed = (await memoryComposeView(h.control, h.binding, signal)) as MemoryComposedView;
		const reference = await memoryCommitView(h.control, h.binding, composed, MEASURES, WAIT, signal);
		expect(reference).toEqual({ asOfSeq: 42, conversations: composed.conversations });
		const [release] = h.requests("qorpera_memory_release");
		expect(release).toEqual({
			releaseId: expect.stringMatching(UUID_PATTERN),
			outputSha256: CONTEXT,
			blocks: composed.blocks,
		});
		expect(h.requests("qorpera_memory_view_record")).toEqual([
			{
				step: 0,
				messages: 12,
				headBytes: 1234,
				viewBytes: Buffer.byteLength(composed.views),
				branchesBytes: Buffer.byteLength(escapeCloudNativeContextJson(JSON.stringify(composed.tree.branches))),
				runViewBytes: 0,
				rawSteps: 0,
				placeholders: composed.placeholders,
				waitMs: 1500,
				waitedLines: 3,
				folded: false,
				stablePrefixSha256: "a".repeat(64),
			},
		]);
		expect(composed.placeholders).toBeGreaterThan(0);
		// The release comes before the record, both for the run's binding; a retry replays the same release.
		const made = h.call.mock.calls.slice(3);
		expect(made.map(([method, args]) => [method, (args as { p_binding: unknown }).p_binding])).toEqual([
			["qorpera_memory_release", h.binding],
			["qorpera_memory_view_record", h.binding],
		]);
		await memoryCommitView(h.control, h.binding, composed, MEASURES, WAIT, signal);
		const releases = h.requests("qorpera_memory_release");
		expect(releases[1].releaseId).toBe(releases[0].releaseId);
		// Another context names another release.
		await memoryCommitView(
			h.control,
			h.binding,
			composed,
			{ ...MEASURES, contextSha256: "d".repeat(64) },
			WAIT,
			signal,
		);
		expect(h.requests("qorpera_memory_release")[2].releaseId).not.toBe(releases[0].releaseId);
	});

	it("records without a release when nothing is shown", async () => {
		const h = host(viewed(0, null, treeOf(SESSION, ROOT, 0)));
		const signal = new AbortController().signal;
		const composed = (await memoryComposeView(h.control, h.binding, signal)) as MemoryComposedView;
		await expect(memoryCommitView(h.control, h.binding, composed, MEASURES, WAIT, signal)).resolves.toEqual({
			asOfSeq: 42,
			conversations: [{ sessionId: SESSION, generation: 3, through: 0, blocks: [] }],
		});
		expect(h.requests("qorpera_memory_release")).toEqual([]);
		expect(h.requests("qorpera_memory_view_record")[0]).toMatchObject({
			step: 0,
			messages: 0,
			viewBytes: Buffer.byteLength(composed.views),
		});
	});

	it("fails on a release that fails, before the record", async () => {
		const h = host(viewed(12, 40, treeOf(SESSION, ROOT, 12, 8)));
		const signal = new AbortController().signal;
		const composed = (await memoryComposeView(h.control, h.binding, signal)) as MemoryComposedView;
		h.call.mockRejectedValueOnce(new Error("release refused"));
		await expect(memoryCommitView(h.control, h.binding, composed, MEASURES, WAIT, signal)).rejects.toThrow(
			"release refused",
		);
		expect(h.requests("qorpera_memory_view_record")).toEqual([]);
	});

	it("goes on without a view reference when the record fails or answers otherwise", async () => {
		const signal = new AbortController().signal;
		const failures: ((request: Record<string, unknown>) => unknown)[] = [
			...[
				{ schema: MEMORY_VIEW_RECORD_SCHEMA, step: 1, asOfSeq: 42 },
				{ schema: MEMORY_VIEW_RECORD_SCHEMA, step: 0, asOfSeq: -1 },
				{ schema: "qorpera.memory-view-record/v2", step: 0, asOfSeq: 42 },
				{ schema: MEMORY_VIEW_RECORD_SCHEMA, step: 0, asOfSeq: 42, replay: true },
				null,
			].map((recorded) => () => recorded),
			() => {
				throw new Error("memory view step was recorded otherwise");
			},
		];
		const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			for (const recorded of failures) {
				const h = host(viewed(12, 40, treeOf(SESSION, ROOT, 12, 8)), { recorded });
				const composed = (await memoryComposeView(h.control, h.binding, signal)) as MemoryComposedView;
				await expect(memoryCommitView(h.control, h.binding, composed, MEASURES, WAIT, signal)).resolves.toBeNull();
				expect(h.requests("qorpera_memory_release")).toHaveLength(1);
			}
			expect(logged.mock.calls).toEqual(failures.map(() => ["Memory view was not recorded (unknown)"]));
		} finally {
			logged.mockRestore();
		}
		// A cancelled run stops there.
		const h = host(viewed(0, null, treeOf(SESSION, ROOT, 0)));
		const composed = (await memoryComposeView(h.control, h.binding, signal)) as MemoryComposedView;
		const cancelled = new AbortController();
		cancelled.abort();
		await expect(
			memoryCommitView(h.control, h.binding, composed, MEASURES, WAIT, cancelled.signal),
		).rejects.toMatchObject({
			name: "AbortError",
		});
	});

	it("leaves out a view reference past its bound in jsonb's text, which spaces each : and ,", async () => {
		expect(memoryJsonbTextBytes({ a: [1, "x"], b: {}, c: null, d: true, e: [] })).toBe(
			Buffer.byteLength('{"a": [1, "x"], "b": {}, "c": null, "d": true, "e": []}'),
		);
		const h = host(null);
		const signal = new AbortController().signal;
		const view = (count: number): MemoryComposedView => ({
			views: "",
			tree: { conversationMessages: 0, lastSequence: null, branches: [] },
			placeholders: 0,
			conversations: [
				{
					sessionId: SESSION,
					generation: 3,
					through: 0,
					blocks: Array.from({ length: count }, (_, index) => ({
						path: `${ROOT}/t0/${String(index).padStart(5, "0")}.jsonl`,
						version: version(index),
					})),
				},
			],
			blocks: [],
		});
		// Within the bound as JSON.stringify writes it, past it as jsonb does.
		const large = view(2544);
		const reference = { asOfSeq: 42, conversations: large.conversations };
		expect(Buffer.byteLength(JSON.stringify(reference))).toBeLessThanOrEqual(MEMORY_VIEW_REFERENCE_BYTES);
		expect(memoryJsonbTextBytes(reference)).toBeGreaterThan(MEMORY_VIEW_REFERENCE_BYTES);
		await expect(memoryCommitView(h.control, h.binding, large, MEASURES, WAIT, signal)).resolves.toBeNull();
		const within = view(2400);
		await expect(memoryCommitView(h.control, h.binding, within, MEASURES, WAIT, signal)).resolves.toEqual({
			asOfSeq: 42,
			conversations: within.conversations,
		});
	});

	it("gives every request of the run the conversation's prompt cache key", async () => {
		const key = memoryPromptCacheKey({ payerLoginConnectionId: "login", agentId: "bo", conversationId: SESSION });
		const request: CloudNativeContextRequest = {
			schema: CLOUD_NATIVE_CONTEXT_COMPOSITION_SCHEMA,
			requestId: "request-1",
			threadId: "thread-1",
			turnId: null,
			purpose: "turn",
			model: "gpt",
			items: [],
		};
		const signal = new AbortController().signal;
		await expect(memoryCacheKeyComposer(key)(request, signal)).resolves.toEqual({ input: [], promptCacheKey: key });
		const compose = vi.fn(async () => ({ input: [{ keep: 0 }], promptCacheKey: "qorpera:other" }));
		await expect(memoryCacheKeyComposer(key, compose)(request, signal)).resolves.toEqual({
			input: [{ keep: 0 }],
			promptCacheKey: key,
		});
		expect(compose).toHaveBeenCalledWith(request, signal);
	});
});
