import {
	BRANCH_READS,
	MEMORY_BRANCHES_SCHEMA,
	type MemoryBranchesRead,
	memoryRunBranches,
} from "@qorpera/runtime/memory-tree/branches";
import { BRANCH_MIN, BRANCHES, memoryBlockPath, PLACEHOLDER } from "@qorpera/runtime/memory-tree/tree";
import {
	type MemoryBranchSource,
	memoryBranchBytes,
	memoryBranches,
	memoryConversationName,
} from "@qorpera/runtime/memory-tree/view";
import { expect, it } from "vitest";

/** One of the agent's other conversations as the host call sees it: its built lines by `text(l, k)`. */
interface Conversation {
	readonly ref: string;
	readonly name: string;
	readonly messages: number;
	readonly text: (l: number, k: number) => string | undefined;
}

function session(index: number): string {
	return `97000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function version(index: number): string {
	return `97100000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function kind(ref: string): "thread" | "group" {
	return ref.startsWith("thread:") ? "thread" : "group";
}

function root(ref: string): string {
	const handle = ref.slice(ref.indexOf(":") + 1);
	return kind(ref) === "thread" ? `agents/${handle}/memory/thread` : `agents/groups/${handle}/memory`;
}

/** A conversation's line for `node(l, k)` when that node lies within its messages. */
function line(conversation: Conversation, l: number, k: number): string | undefined {
	return (k + 1) * 2 ** l <= conversation.messages ? conversation.text(l, k) : undefined;
}

/** The branch as the list carries it. */
function listing(conversation: Conversation, index: number) {
	const { ref, name, messages } = conversation;
	return { ref, kind: kind(ref), name, sessionId: session(index), messages };
}

/** Its live tree as qorpera_memory_tree_read reads it, each line in the block `blockOf(l, k)` under its root. */
function treeOf(conversation: Conversation, index: number, blockOf = memoryBlockPath) {
	const blocks: { path: string; version: string }[] = [];
	const lines: { l: number; k: number; text: string; block: number }[] = [];
	for (let l = 0; 2 ** l <= conversation.messages; l += 1)
		for (let k = 0; (k + 1) * 2 ** l <= conversation.messages; k += 1) {
			const text = line(conversation, l, k);
			if (text === undefined) continue;
			const path = `${root(conversation.ref)}/${blockOf(l, k)}`;
			let block = blocks.findIndex((item) => item.path === path);
			if (block < 0) block = blocks.push({ path, version: version(blocks.length) }) - 1;
			lines.push({ l, k, text, block });
		}
	return {
		sessionId: session(index),
		generation: 0,
		messages: conversation.messages,
		root: root(conversation.ref),
		nodeBytes: 512,
		blocks,
		lines,
	};
}

/** The host call over `conversations`, the most recently active first, and the sessions of each call made. */
function host(conversations: readonly Conversation[], blockOf = memoryBlockPath) {
	const calls: string[][] = [];
	const read: MemoryBranchesRead = async (sessions) => {
		calls.push([...sessions]);
		return {
			schema: MEMORY_BRANCHES_SCHEMA,
			branches: conversations.map(listing),
			trees: conversations.flatMap((conversation, index) =>
				sessions.includes(session(index)) ? [treeOf(conversation, index, blockOf)] : [],
			),
		};
	};
	return { read, calls };
}

/** The branches with every tree read, for memoryBranches. */
function sources(conversations: readonly Conversation[]): MemoryBranchSource[] {
	return conversations.map((conversation) => ({
		ref: conversation.ref,
		name: memoryConversationName(kind(conversation.ref), conversation.name),
		messages: conversation.messages,
		built: (l, k) => line(conversation, l, k),
	}));
}

/**
 * Reads `conversations`' branches and checks them against memoryBranches with every tree read, and the calls: the
 * list first, then the branches in order, BRANCH_READS at a time, only while BRANCH_MIN was left.
 */
async function lazily(conversations: readonly Conversation[]) {
	const { read, calls } = host(conversations);
	const result = await memoryRunBranches(read);
	const expected = memoryBranches(sources(conversations));
	expect(result.branches).toEqual(expected);
	expect(calls[0]).toEqual([]);
	let room = BRANCHES;
	let loaded = 0;
	for (const call of calls.slice(1)) {
		const batch = conversations.slice(loaded, loaded + BRANCH_READS).map((_, index) => session(loaded + index));
		expect(room).toBeGreaterThanOrEqual(BRANCH_MIN);
		expect(call).toEqual(batch);
		for (const view of expected.slice(loaded, loaded + BRANCH_READS)) room -= memoryBranchBytes(view);
		loaded += call.length;
	}
	expect(loaded === conversations.length || room < BRANCH_MIN).toBe(true);
	return { result, expected, calls, loaded };
}

it("names a branch by its kind: an agent's thread, a group chat, or a session that is no room", () => {
	expect(memoryConversationName("thread", "Bo")).toBe("Bo (thread)");
	expect(memoryConversationName("group", "Launch")).toBe("Launch (group chat)");
	expect(memoryConversationName("conversation", "Support")).toBe("Support");
});

it("reads trees BRANCH_READS at a time while room is left: memoryBranches with every tree read", async () => {
	// Three long threads take most of BRANCHES, ten short group chats little, and the long ones after them their
	// BRANCH_MIN each, until less than BRANCH_MIN is left. The rest are listed, their trees never read.
	const long = (ref: string): Conversation => ({
		ref,
		name: ref.slice(ref.indexOf(":") + 1),
		messages: 700,
		text: (l, k) => `${l}.${k} ${"t".repeat(190)}`,
	});
	const short = (ref: string): Conversation => ({
		ref,
		name: ref.slice(ref.indexOf(":") + 1),
		messages: 2,
		text: (l) => (l === 0 ? "s".repeat(40) : undefined),
	});
	const conversations = [
		...["thread:ada", "thread:bo", "thread:cy"].map(long),
		...Array.from({ length: 10 }, (_, index) => short(`group:team-${index}`)),
		...Array.from({ length: 47 }, (_, index) => long(`thread:agent-${index}`)),
	];
	const { result, calls, loaded } = await lazily(conversations);
	expect(calls.length).toBeGreaterThan(2);
	expect(loaded).toBeLessThan(conversations.length);
	expect(result.branches[1]).toMatchObject({ ref: "thread:bo", name: "bo (thread)", messages: 700 });
	expect(result.branches[3]).toMatchObject({ ref: "group:team-0", name: "team-0 (group chat)", messages: 2 });
	expect(result.branches.at(-1)).toEqual({ ref: "thread:agent-46", name: "agent-46 (thread)", messages: 700 });
	expect(result.branches.reduce((total, view) => total + memoryBranchBytes(view), 0)).toBeLessThanOrEqual(BRANCHES);
});

it("equals memoryBranches with every tree read, whatever the conversations", async () => {
	// A fixed generator, so a failure repeats: sizes from none to a few thousand messages, texts with markup and
	// multibyte characters, a few leaves and from none to all parents built.
	let seed = 970;
	const random = (below: number) => {
		seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
		return (seed >>> 8) % below;
	};
	for (let round = 0; round < 40; round += 1) {
		const conversations = Array.from({ length: random(31) }, (_, index): Conversation => {
			const size = random(20);
			const messages = size < 12 ? random(30) : size < 19 ? random(300) : random(2_000);
			const built = [0, 50, 90, 100][random(4)];
			const width = 1 + random(400);
			const mark = ["w", "<", "ø"][random(3)];
			const salt = random(1_000_000);
			return {
				ref: random(2) === 0 ? `thread:agent-${index}` : `group:group-${index}`,
				name: `Name ${index}`,
				messages,
				text: (l, k) => {
					const hash = Math.imul((l * 73_856_093) ^ (k * 19_349_663) ^ salt, 2_654_435_761) >>> 0;
					if (hash % 100 >= (l === 0 ? 95 : built)) return undefined;
					return `${l}.${k} ${mark.repeat(1 + ((hash >>> 7) % width))}`;
				},
			};
		});
		await lazily(conversations);
	}
});

it("returns the blocks of the lines it shows, each once; a placeholder and earlier|zoom show none", async () => {
	// Every line in a block of its own, named by its address. Bo's thread has every line built and too long for its
	// share, so its oldest parts are named on one line; the launch chat has no parent built, so its oldest pairs merge
	// into placeholders. Less than BRANCH_MIN is then left, and the ops chat is listed.
	const bo: Conversation = { ref: "thread:bo", name: "Bo", messages: 7, text: () => "z".repeat(300) };
	const launch: Conversation = {
		ref: "group:launch",
		name: "Launch",
		messages: 8,
		text: (l) => (l === 0 ? "y".repeat(100) : undefined),
	};
	const ops: Conversation = { ref: "group:ops", name: "Ops", messages: 3, text: () => "o" };
	const { read, calls } = host([bo, launch, ops], (l, k) => `${2 ** l * k}+${2 ** l}`);
	const { branches, blocks } = await memoryRunBranches(read, 1_200);
	expect(branches).toEqual([
		{
			ref: "thread:bo",
			name: "Bo (thread)",
			messages: 7,
			lines: ["earlier|zoom 0+4, 4+2", `6+1|${"z".repeat(300)}`],
		},
		{
			ref: "group:launch",
			name: "Launch (group chat)",
			messages: 8,
			lines: [`0+2|${PLACEHOLDER}`, `2+2|${PLACEHOLDER}`, ...[4, 5, 6, 7].map((k) => `${k}+1|${"y".repeat(100)}`)],
		},
		{ ref: "group:ops", name: "Ops (group chat)", messages: 3 },
	]);
	expect(blocks.map((block) => block.path)).toEqual([
		"agents/bo/memory/thread/6+1",
		"agents/groups/launch/memory/4+1",
		"agents/groups/launch/memory/5+1",
		"agents/groups/launch/memory/6+1",
		"agents/groups/launch/memory/7+1",
	]);
	expect(calls).toEqual([[], [session(0), session(1), session(2)]]);

	// Lines in one block at one version name it once.
	const shared = await memoryRunBranches(host([{ ...ops, messages: 4 }]).read);
	expect(shared.branches[0].lines).toEqual(["0+1|o", "1+1|o", "2+1|o", "3+1|o"]);
	expect(shared.blocks).toEqual([{ path: "agents/groups/ops/memory/t0/00000000.jsonl", version: version(0) }]);
});

it("keeps the first list's branches: a later tree brings its own count, a branch gone shows none built", async () => {
	const bo: Conversation = { ref: "thread:bo", name: "Bo", messages: 3, text: () => "x" };
	const launch: Conversation = { ref: "group:launch", name: "Launch", messages: 4, text: () => "y" };
	// By the second call Bo's thread has two more messages and the launch chat is no longer a branch.
	const grown = { ...bo, messages: 5 };
	const read: MemoryBranchesRead = async (sessions) =>
		sessions.length === 0
			? { schema: MEMORY_BRANCHES_SCHEMA, branches: [listing(bo, 0), listing(launch, 1)], trees: [] }
			: { schema: MEMORY_BRANCHES_SCHEMA, branches: [listing(grown, 0)], trees: [treeOf(grown, 0)] };
	const { branches, blocks } = await memoryRunBranches(read);
	expect(branches).toEqual([
		{ ref: "thread:bo", name: "Bo (thread)", messages: 5, lines: [0, 1, 2, 3, 4].map((k) => `${k}+1|x`) },
		{
			ref: "group:launch",
			name: "Launch (group chat)",
			messages: 4,
			lines: [0, 1, 2, 3].map((k) => `${k}+1|${PLACEHOLDER}`),
		},
	]);
	expect(blocks).toEqual([{ path: "agents/bo/memory/thread/t0/00000000.jsonl", version: version(0) }]);
});

it("asks only for the list when there is no branch", async () => {
	const { read, calls } = host([]);
	expect(await memoryRunBranches(read)).toEqual({ branches: [], blocks: [] });
	expect(calls).toEqual([[]]);
});

it("refuses an answer that is not the host call's", async () => {
	const bo: Conversation = { ref: "thread:bo", name: "Bo", messages: 2, text: () => "x" };
	const first = { schema: MEMORY_BRANCHES_SCHEMA, branches: [listing(bo, 0)], trees: [] as unknown[] };
	const tree = treeOf(bo, 0);
	const second = { ...first, trees: [tree] };
	const answers =
		(one: unknown, two: unknown = second): MemoryBranchesRead =>
		async (sessions) =>
			sessions.length === 0 ? one : two;
	expect((await memoryRunBranches(answers(first))).blocks).toHaveLength(1);

	const branch = listing(bo, 0);
	const firsts: unknown[] = [
		null,
		[],
		"answer",
		{ ...first, schema: "qorpera.memory-branches/v2" },
		{ ...first, more: 1 },
		{ schema: first.schema, branches: first.branches },
		{ ...first, branches: {} },
		{ ...first, branches: [{ ...branch, more: 1 }] },
		{ ...first, branches: [{ ...branch, kind: "conversation" }] },
		{ ...first, branches: [{ ...branch, ref: "group:bo" }] },
		{ ...first, branches: [{ ...branch, ref: "thread:" }] },
		{ ...first, branches: [{ ...branch, name: "" }] },
		{ ...first, branches: [{ ...branch, name: 5 }] },
		{ ...first, branches: [{ ...branch, sessionId: branch.sessionId.toUpperCase().replace("97", "AB") }] },
		{ ...first, branches: [{ ...branch, sessionId: "bo" }] },
		{ ...first, branches: [{ ...branch, messages: -1 }] },
		{ ...first, branches: [{ ...branch, messages: 1.5 }] },
		{ ...first, branches: [{ ...branch, messages: "2" }] },
		{ ...first, branches: [branch, { ...branch, ref: "thread:cy" }] },
		{ ...first, trees: [tree] },
	];
	for (const answer of firsts)
		await expect(memoryRunBranches(answers(answer))).rejects.toThrow(/^Invalid memory branches answer/);

	const [block] = tree.blocks;
	const [row] = tree.lines;
	const seconds: unknown[] = [
		{ ...second, trees: [treeOf(bo, 1)] },
		{ ...second, trees: [tree, tree] },
		{ ...second, trees: [{ ...tree, more: 1 }] },
		{ ...second, trees: [{ ...tree, generation: null }] },
		{ ...second, trees: [{ ...tree, messages: -2 }] },
		{ ...second, trees: [{ ...tree, root: 5 }] },
		{ ...second, trees: [{ ...tree, nodeBytes: "512" }] },
		{ ...second, trees: [{ ...tree, blocks: [{ ...block, version: "v1" }] }] },
		{ ...second, trees: [{ ...tree, blocks: [{ path: block.path }] }] },
		{ ...second, trees: [{ ...tree, lines: [{ ...row, block: tree.blocks.length }] }] },
		{ ...second, trees: [{ ...tree, lines: [{ ...row, l: 60 }] }] },
		{ ...second, trees: [{ ...tree, lines: [{ ...row, k: -1 }] }] },
		{ ...second, trees: [{ ...tree, lines: [{ ...row, text: null }] }] },
		{ ...second, trees: [{ ...tree, lines: [row, row] }] },
		{ ...second, trees: [{ ...tree, lines: [{ ...row, seq: 0 }] }] },
	];
	for (const answer of seconds)
		await expect(memoryRunBranches(answers(first, answer))).rejects.toThrow(/^Invalid memory branches answer/);
});
