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

/** A run's branches for the user message, and the blocks whose lines they show, each once, in the order shown. */
export interface MemoryRunBranches {
	readonly branches: MemoryBranchView[];
	readonly blocks: MemoryTreeBlock[];
}

interface Listed {
	readonly ref: string;
	readonly kind: "thread" | "group";
	readonly name: string;
	readonly sessionId: string;
	readonly messages: number;
}

interface Tree {
	readonly messages: number;
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

function tree(value: unknown): [string, Tree] {
	const read = parseClosedRecord(value, "a tree", [
		"sessionId",
		"generation",
		"messages",
		"root",
		"nodeBytes",
		"blocks",
		"lines",
	]);
	whole(read.generation, "a tree's generation");
	if (read.root !== null) text(read.root, "a tree's root");
	if (read.nodeBytes !== null) whole(read.nodeBytes, "a tree's node bytes");
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
	return [id(read.sessionId, "a tree's session"), { messages: whole(read.messages, "a tree's messages"), lines }];
}

/** An answer to a call for the trees of `sessions`: the branches, and the trees by session. */
function answer(value: unknown, sessions: readonly string[]): { branches: Listed[]; trees: Map<string, Tree> } {
	try {
		const read = parseClosedRecord(value, "the answer", ["schema", "branches", "trees"]);
		if (read.schema !== MEMORY_BRANCHES_SCHEMA) throw new WireValueError("its schema");
		const branches = list(read.branches, "its branches").map(listed);
		if (new Set(branches.map((branch) => branch.sessionId)).size !== branches.length) {
			throw new WireValueError("a branch", "is there twice");
		}
		const trees = new Map<string, Tree>();
		for (const item of list(read.trees, "its trees")) {
			const [sessionId, found] = tree(item);
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

/** A branch listed by its name as it is shown and its count. */
function shown(branch: Listed): MemoryBranchView {
	return { ref: branch.ref, name: memoryConversationName(branch.kind, branch.name), messages: branch.messages };
}

/**
 * The run's branches (§5.5), from `read`, the host call for the run: folded within `budget` as memoryBranches folds
 * them, with their names as they are shown, and the blocks of the lines shown.
 */
export async function memoryRunBranches(read: MemoryBranchesRead, budget = BRANCHES): Promise<MemoryRunBranches> {
	const all = answer(await read([]), []).branches;
	const branches: MemoryBranchView[] = [];
	const blocks = new Map<string, MemoryTreeBlock>();
	let room = budget;
	while (branches.length < all.length && room >= BRANCH_MIN) {
		const batch = all.slice(branches.length, branches.length + BRANCH_READS);
		const sessions = batch.map((branch) => branch.sessionId);
		const { trees } = answer(await read(sessions), sessions);
		const sources = batch.map((branch): MemoryBranchSource => {
			const found = trees.get(branch.sessionId);
			const built: MemoryTreeBuilt = (l, k) => found?.lines.get(memoryNodeAddress(l, k))?.text;
			return { ...shown(branch), messages: found?.messages ?? branch.messages, built };
		});
		for (const [index, view] of memoryBranches(sources, budget, branches.length, room).entries()) {
			room -= memoryBranchBytes(view);
			// A row shows a built line when the address before its first `|` is one's; `earlier|zoom …` and a
			// placeholder show none.
			const lines = trees.get(batch[index].sessionId)?.lines;
			for (const row of view.lines ?? []) {
				const block = lines?.get(row.slice(0, row.indexOf("|")))?.block;
				if (block) blocks.set(`${block.path}\n${block.version}`, block);
			}
			branches.push(view);
		}
	}
	for (const branch of all.slice(branches.length)) branches.push(shown(branch));
	return { branches, blocks: [...blocks.values()] };
}
