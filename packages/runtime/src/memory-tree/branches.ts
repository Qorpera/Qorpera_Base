// A run's branches (design RUNTIME-AGENT-MEMORY-TREE.md §5.5, M4). The native host call qorpera_memory_branches
// (migration 20260930220000) lists them, most recently active first: every other conversation the agent takes part in,
// and for the Co-Founder every other agent's thread. It reads the live tree of each branch it is asked for.
// - Trees are read BRANCH_READS at a time, only while BRANCHES has room for another branch's lines. A branch depends
//   only on the ones before it, so the branches past that are listed just as memoryBranches lists them with every tree
//   read.
// - The first answer's list fixes the branches and their order. A tree read later counts its own messages, so a
//   branch's lines and its count agree. A branch that is no longer one when its tree is asked for has no tree in the
//   answer, and shows no line built.
// - The composer releases the blocks whose lines the branches show with the primary view's (§8, M1b-4), so the call
//   keeps no receipt. Branches are relevance, never a permission (§9).
// - A worker's view reference (§12, W4a-1) keeps each branch's erase generation beside the blocks it shows. The call
//   reads a tree's generation and its lines in one statement, and each branch read keeps the generation it came with.

import { isUuid, parseClosedRecord, parseInteger, WireValueError } from "@qorpera/contracts";
import type { MemoryTreeBuilt } from "./fold.ts";
import { BRANCH_MIN, BRANCHES, memoryNodeAddress } from "./tree.ts";
import {
	type MemoryBranchSource,
	type MemoryBranchView,
	memoryBranchBytes,
	memoryBranches,
	memoryConversationName,
} from "./view.ts";

/** How many trees one branches call reads. */
export const BRANCH_READS = 8;

/** The host call's answer schema. */
export const MEMORY_BRANCHES_SCHEMA = "qorpera.memory-branches/v1";

/** qorpera_memory_branches for the run, asked for the trees of `sessions`; it answers with the call's JSON. */
export type MemoryBranchesRead = (sessions: readonly string[]) => Promise<unknown>;

/** A tree block at one version, as qorpera_memory_tree_read names it and qorpera_memory_release takes it. */
export interface MemoryTreeBlock {
	readonly path: string;
	readonly version: string;
}

/**
 * A branch whose tree was read, as a view reference names a conversation (W4a-1, {sessionId, generation, through,
 * blocks}): the erase generation its tree was read at, the messages its fold covers, and the blocks whose lines it
 * shows, each once, in the order shown.
 */
export interface MemoryViewConversation {
	readonly sessionId: string;
	readonly generation: number;
	readonly through: number;
	readonly blocks: MemoryTreeBlock[];
}

/** A run's branches for the user message, and what was read for them. */
export interface MemoryRunBranches {
	readonly branches: MemoryBranchView[];
	/** Each branch whose tree was read, in the branches' order, for the view reference. */
	readonly conversations: MemoryViewConversation[];
	/** The blocks whose lines the branches show, each once, in the order shown, for the composer to release. */
	readonly blocks: MemoryTreeBlock[];
}

interface Listed {
	readonly ref: string;
	readonly kind: "thread" | "group";
	readonly name: string;
	readonly sessionId: string;
	readonly messages: number;
}

/** A conversation's live tree, as qorpera_memory_tree_read reads it with its erase generation and message count. */
export interface MemoryTreeRead {
	readonly generation: number;
	readonly messages: number;
	/** The tree's folder as its index names it, and its tree.toml's node_bytes; null before the tree is made. */
	readonly root: string | null;
	readonly nodeBytes: number | null;
	/** Each built line by its address, `start+size`, with its block. */
	readonly lines: ReadonlyMap<string, { readonly text: string; readonly block: MemoryTreeBlock }>;
}

/** `value` as a list; a WireValueError names `label` otherwise. */
function list(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) throw new WireValueError(label);
	return value;
}

function whole(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
	return parseInteger(value, label, 0, maximum);
}

function text(value: unknown, label: string): string {
	if (typeof value !== "string" || value === "") throw new WireValueError(label);
	return value;
}

/** A uuid as the database prints it (`isUuid`). */
function id(value: unknown, label: string): string {
	if (!isUuid(value)) throw new WireValueError(label);
	return value;
}

function listed(value: unknown): Listed {
	const branch = parseClosedRecord(value, "a branch", ["ref", "kind", "name", "sessionId", "messages"]);
	const kind = branch.kind;
	if (kind !== "thread" && kind !== "group") throw new WireValueError("a branch's kind");
	const ref = text(branch.ref, "a branch's ref");
	if (!ref.startsWith(`${kind}:`) || ref.length === kind.length + 1) throw new WireValueError("a branch's ref");
	return {
		ref,
		kind,
		name: text(branch.name, "a branch's name"),
		sessionId: id(branch.sessionId, "a branch's session"),
		messages: whole(branch.messages, "a branch's messages"),
	};
}

/** qorpera_memory_tree_read's answer: its session and its tree. A WireValueError says what is wrong. */
export function memoryTreeRead(value: unknown): [string, MemoryTreeRead] {
	const read = parseClosedRecord(value, "a tree", [
		"sessionId",
		"generation",
		"messages",
		"root",
		"nodeBytes",
		"blocks",
		"lines",
	]);
	const generation = whole(read.generation, "a tree's generation");
	const root = read.root === null ? null : text(read.root, "a tree's root");
	const nodeBytes = read.nodeBytes === null ? null : whole(read.nodeBytes, "a tree's node bytes");
	const blocks = list(read.blocks, "a tree's blocks").map((item) => {
		const block = parseClosedRecord(item, "a tree's block", ["path", "version"]);
		return { path: text(block.path, "a block's path"), version: id(block.version, "a block's version") };
	});
	const lines = new Map<string, { text: string; block: MemoryTreeBlock }>();
	for (const item of list(read.lines, "a tree's lines")) {
		const line = parseClosedRecord(item, "a tree's line", ["l", "k", "text", "block"]);
		const address = memoryNodeAddress(whole(line.l, "a line's level", 59), whole(line.k, "a line's k"));
		const block = blocks[whole(line.block, "a line's block")];
		if (!block) throw new WireValueError("a line's block");
		if (lines.has(address)) throw new WireValueError("a tree's line", "is there twice");
		if (typeof line.text !== "string") throw new WireValueError("a line's text");
		lines.set(address, { text: line.text, block });
	}
	const messages = whole(read.messages, "a tree's messages");
	return [id(read.sessionId, "a tree's session"), { generation, messages, root, nodeBytes, lines }];
}

/**
 * An answer to a call for the trees of `sessions`: the branches, and the trees by session. None is `own`, the run's
 * own conversation, which the host leaves out (a group chat's run has the agent's thread as a branch, never the chat).
 */
function answer(
	value: unknown,
	sessions: readonly string[],
	own: string | null,
): { branches: Listed[]; trees: Map<string, MemoryTreeRead> } {
	try {
		const read = parseClosedRecord(value, "the answer", ["schema", "branches", "trees"]);
		if (read.schema !== MEMORY_BRANCHES_SCHEMA) throw new WireValueError("its schema");
		const branches = list(read.branches, "its branches").map(listed);
		if (new Set(branches.map((branch) => branch.sessionId)).size !== branches.length) {
			throw new WireValueError("a branch", "is there twice");
		}
		if (branches.some((branch) => branch.sessionId === own)) {
			throw new WireValueError("a branch", "is the run's own conversation");
		}
		const trees = new Map<string, MemoryTreeRead>();
		for (const item of list(read.trees, "its trees")) {
			const [sessionId, found] = memoryTreeRead(item);
			if (!sessions.includes(sessionId) || trees.has(sessionId)) {
				throw new WireValueError("a tree", "was not asked for or is there twice");
			}
			trees.set(sessionId, found);
		}
		return { branches, trees };
	} catch (error) {
		if (error instanceof WireValueError) {
			throw new Error(`Invalid memory branches answer: ${error.message}`, { cause: error });
		}
		throw error;
	}
}

/** A block's key for keeping each block once: its path and version. */
export function memoryBlockKey(block: MemoryTreeBlock): string {
	return `${block.path}\n${block.version}`;
}

/** A branch listed by its name as it is shown and its count. */
function shown(branch: Listed): MemoryBranchView {
	return { ref: branch.ref, name: memoryConversationName(branch.kind, branch.name), messages: branch.messages };
}

/**
 * The run's branches (§5.5), from `read`, the host call for the run in the conversation `own` (when it has one):
 * folded within `budget` as memoryBranches folds them, with their names as they are shown; each branch read with its
 * generation and the blocks of its lines shown.
 */
export async function memoryRunBranches(
	read: MemoryBranchesRead,
	own: string | null = null,
	budget = BRANCHES,
): Promise<MemoryRunBranches> {
	const all = answer(await read([]), [], own).branches;
	const branches: MemoryBranchView[] = [];
	const conversations: MemoryViewConversation[] = [];
	let room = budget;
	while (branches.length < all.length && room >= BRANCH_MIN) {
		const batch = all.slice(branches.length, branches.length + BRANCH_READS);
		const sessions = batch.map((branch) => branch.sessionId);
		const { trees } = answer(await read(sessions), sessions, own);
		const sources = batch.map((branch): MemoryBranchSource => {
			const found = trees.get(branch.sessionId);
			const built: MemoryTreeBuilt = (l, k) => found?.lines.get(memoryNodeAddress(l, k))?.text;
			return { ...shown(branch), messages: found?.messages ?? branch.messages, built };
		});
		for (const [index, view] of memoryBranches(sources, budget, branches.length, room).entries()) {
			room -= memoryBranchBytes(view);
			branches.push(view);
			const { sessionId } = batch[index];
			const found = trees.get(sessionId);
			if (!found) continue;
			// A row shows a built line when the address before its first `|` is one's; `earlier|zoom …` and a
			// placeholder show none.
			const blocks = new Map<string, MemoryTreeBlock>();
			for (const row of view.lines ?? []) {
				const block = found.lines.get(row.slice(0, row.indexOf("|")))?.block;
				if (block) blocks.set(memoryBlockKey(block), block);
			}
			const { generation, messages: through } = found;
			conversations.push({ sessionId, generation, through, blocks: [...blocks.values()] });
		}
	}
	for (const branch of all.slice(branches.length)) branches.push(shown(branch));
	const blocks = new Map<string, MemoryTreeBlock>();
	for (const block of conversations.flatMap((conversation) => conversation.blocks))
		blocks.set(memoryBlockKey(block), block);
	return { branches, conversations, blocks: [...blocks.values()] };
}
