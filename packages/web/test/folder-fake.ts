import {
	type CloudMemberFolderCommit,
	type CloudMemberFolderEntry,
	CloudMemberFolderError,
	type CloudMemberFolderFile,
	type CloudMemberFolderListPage,
	type CloudMemberFolderOutcome,
	type CloudMemberFolderProblem,
	type CloudMemberFolderUnit,
	type CloudMemberFolderUnitResult,
} from "@qorpera/cloud-client/cloud-member-folder";
import { companyPathKey, parseCompanyStateFile } from "@qorpera/cloud-client/company-state-files";
import { vi } from "vitest";
import type { WebMemberFolder } from "../src/cloud/company-folder-writes.ts";

/*
 * A member's company folder in memory, for the web's folder writers (P34a-2): paths with their kind, text, version and
 * seq, and the member client's read, list, readFile, stateFolders and commit over them. A path the member may not
 * read (`deny`) looks absent to reads and listings, as in the core. The commit keeps the core's rules these writers
 * depend on, in the core's order (views.sql): authority first, so a unit on a path closed to the member is `denied`
 * whatever is there; a write or delete naming another version, or a write naming a version of a missing path, is
 * `version_changed`; a create on a taken path is `exists`; a delete of a missing path is `missing`; a missing parent is
 * refused `parent_missing`; a folder delete read before a change under it is `unseen_change`; every state file gets
 * its parse; and the same operation key with the same units replays its answer.
 */

interface Node {
	readonly path: string;
	readonly kind: "file" | "folder";
	readonly text: string | null;
	readonly version: string;
	readonly seq: number;
}

export interface FolderCommitCall {
	readonly operationKey: string;
	readonly units: readonly CloudMemberFolderUnit[];
}

type Answer =
	| {
			readonly kind: "outcome";
			readonly outcome: CloudMemberFolderOutcome;
			readonly reason: string;
			readonly problems: readonly CloudMemberFolderProblem[];
	  }
	| { readonly kind: "lost" }
	| { readonly kind: "throw"; readonly error: unknown };

/** The folder seeded as a new company's, without the files the tests do not use. */
const SEEDED = ["agents", "agents/groups", "skills"];

const encoder = new TextEncoder();

function parentOf(path: string): string {
	return path.slice(0, Math.max(0, path.lastIndexOf("/")));
}

export function folderFake(
	options: {
		seed?: readonly string[];
		/** A routine file's index id from its own id (the routine index keeps its own); the file's id by default. */
		routineIds?: (fileId: string) => string;
		/** False for a cloud whose state folders read does not list routines' files yet. */
		listsRoutines?: boolean;
	} = {},
) {
	const routineIds = options.routineIds ?? ((fileId: string) => fileId);
	const listsRoutines = options.listsRoutines ?? true;
	const nodes = new Map<string, Node>();
	const texts = new Map<string, string>();
	const answers: Answer[] = [];
	const replays = new Map<string, { units: string; answer: CloudMemberFolderCommit }>();
	const denied = new Set<string>();
	const failing = new Map<string, unknown>();
	const commits: FolderCommitCall[] = [];
	let seq = 0;
	let versions = 0;
	let hashes = 0;
	const nextVersion = () => `f0000000-0000-4000-8000-${String(++versions).padStart(12, "0")}`;

	const key = companyPathKey;
	const under = (path: string, root: string) => key(path).startsWith(`${key(root)}/`);
	const hidden = (path: string) => [...denied].some((root) => key(path) === key(root) || under(path, root));
	/** A unit's authority covers its path and everything under it (a subtree's boundaries included). */
	const closed = (path: string) => hidden(path) || [...denied].some((root) => under(root, path));
	const blocked = (path: string) => {
		for (const [root, error] of failing) if (key(path) === key(root) || under(path, root)) throw error;
	};

	function reference(text: string): CloudMemberFolderFile {
		const hash = (++hashes).toString(16).padStart(64, "0");
		texts.set(hash, text);
		return {
			manifestSha256: hash,
			fileSha256: hash,
			bytes: encoder.encode(text).byteLength,
			mediaType: "text/markdown",
			executable: false,
		};
	}

	function entry(node: Node): CloudMemberFolderEntry {
		return {
			path: node.path,
			kind: node.kind,
			version: node.version,
			seq: node.seq,
			updatedAt: "2026-10-04T09:00:00Z",
			file: node.kind === "file" ? reference(node.text ?? "") : null,
		};
	}

	function set(path: string, kind: "file" | "folder", text: string | null, at: number): Node {
		const node = { path, kind, text, version: nextVersion(), seq: at };
		nodes.set(key(path), node);
		return node;
	}

	/** Every folder above `path` that is not there yet, as a change at `at`. */
	function parents(path: string, at: number): void {
		const parts = path.split("/");
		for (let index = 1; index < parts.length; index++) {
			const folder = parts.slice(0, index).join("/");
			if (!nodes.has(key(folder))) set(folder, "folder", null, at);
		}
	}

	function subtree(path: string): Node[] {
		return [...nodes.values()].filter((node) => key(node.path) === key(path) || under(node.path, path));
	}

	function problemsOf(path: string, text: string): CloudMemberFolderProblem[] {
		const parsed = parseCompanyStateFile(path, text);
		return parsed && !parsed.ok
			? parsed.problems.map((problem) => ({
					line: problem.line,
					key: problem.key,
					code: problem.code,
					message: problem.message,
				}))
			: [];
	}

	/** The agents', group chats' and routines' files the member may read, as `qorpera_member_company_state_folders`
	 * answers. A routine is listed by its index id (`routineIds`, the file's own id unless a test says otherwise) and
	 * its owner, the agent whose folder holds it; `routines` is null where the cloud does not list routines' files. */
	function stateFolders(): {
		agents: { staffAgentId: string; file: string }[];
		groups: { roomId: string; file: string }[];
		routines: { routineId: string; staffAgentId: string; file: string }[] | null;
	} {
		const agents: { staffAgentId: string; file: string }[] = [];
		const groups: { roomId: string; file: string }[] = [];
		const routines: { routineId: string; staffAgentId: string; file: string }[] = [];
		const owners = new Map<string, string>();
		for (const node of nodes.values()) {
			if (node.kind !== "file") continue;
			const parsed = parseCompanyStateFile(node.path, node.text ?? "");
			if (parsed?.ok && parsed.file.kind === "agent") owners.set(key(parentOf(node.path)), parsed.file.id);
		}
		for (const node of nodes.values()) {
			if (node.kind !== "file" || hidden(node.path)) continue;
			const parsed = parseCompanyStateFile(node.path, node.text ?? "");
			if (!parsed?.ok) continue;
			if (parsed.file.kind === "agent") agents.push({ staffAgentId: parsed.file.id, file: node.path });
			if (parsed.file.kind === "group") groups.push({ roomId: parsed.file.id, file: node.path });
			const owner = owners.get(key(parentOf(parentOf(node.path))));
			if (parsed.file.kind === "routine" && owner)
				routines.push({ routineId: routineIds(parsed.file.id), staffAgentId: owner, file: node.path });
		}
		routines.sort((a, b) => (key(a.file) < key(b.file) ? -1 : 1));
		return { agents, groups, routines: listsRoutines ? routines : null };
	}

	type Result = Pick<CloudMemberFolderUnitResult, "outcome" | "reason" | "problems" | "version">;
	const conflict = (reason: string): Result => ({ outcome: "conflict", reason, problems: [], version: null });
	const refused = (reason: string, problems: CloudMemberFolderProblem[] = []): Result => ({
		outcome: "refused",
		reason,
		problems,
		version: null,
	});

	const parentMissing = (path: string) => parentOf(path) !== "" && !nodes.has(key(parentOf(path)));

	function apply(unit: CloudMemberFolderUnit, at: number): Result {
		// Authority before anything else: a path closed to the member is `denied`, never `exists` or `missing`.
		if (unit.op === "move" ? closed(unit.from) || closed(unit.to) : closed(unit.path))
			return { outcome: "denied", reason: "denied", problems: [], version: null };
		switch (unit.op) {
			case "write": {
				const node = nodes.get(key(unit.path));
				if (unit.expectedVersion !== undefined) {
					if (node?.kind !== "file" || node.version !== unit.expectedVersion) return conflict("version_changed");
				} else if (node) return conflict("exists");
				if (parentMissing(unit.path)) return refused("parent_missing");
				const problems = problemsOf(unit.path, unit.text);
				if (problems.length) return refused("invalid", problems);
				return {
					outcome: "saved",
					reason: null,
					problems: [],
					version: set(unit.path, "file", unit.text, at).version,
				};
			}
			case "mkdir": {
				if (nodes.has(key(unit.path))) return conflict("exists");
				if (parentMissing(unit.path)) return refused("parent_missing");
				return {
					outcome: "saved",
					reason: null,
					problems: [],
					version: set(unit.path, "folder", null, at).version,
				};
			}
			case "new_folder": {
				if (nodes.has(key(unit.path))) return conflict("exists");
				if (parentMissing(unit.path)) return refused("parent_missing");
				const problems = unit.contents.flatMap((item) =>
					item.kind === "file" ? problemsOf(`${unit.path}/${item.path}`, item.text) : [],
				);
				if (problems.length) return refused("invalid", problems);
				const folder = set(unit.path, "folder", null, at);
				for (const item of unit.contents) {
					const path = `${unit.path}/${item.path}`;
					parents(path, at);
					set(path, item.kind, item.kind === "file" ? item.text : null, at);
				}
				return { outcome: "saved", reason: null, problems: [], version: folder.version };
			}
			case "delete": {
				const node = nodes.get(key(unit.path));
				if (!node) return conflict("missing");
				if (unit.expectedVersion !== undefined && node.version !== unit.expectedVersion)
					return conflict("version_changed");
				const removed = subtree(unit.path);
				if (unit.asOfSeq !== undefined && removed.some((item) => item.seq > (unit.asOfSeq as number)))
					return conflict("unseen_change");
				for (const item of removed) nodes.delete(key(item.path));
				return { outcome: "saved", reason: null, problems: [], version: nextVersion() };
			}
			case "move": {
				const node = nodes.get(key(unit.from));
				if (!node) return conflict("missing");
				if (nodes.has(key(unit.to))) return conflict("exists");
				if (unit.expectedVersion !== undefined && node.version !== unit.expectedVersion)
					return conflict("version_changed");
				const moved = subtree(unit.from);
				if (unit.asOfSeq !== undefined && moved.some((item) => item.seq > (unit.asOfSeq as number)))
					return conflict("unseen_change");
				for (const item of moved) nodes.delete(key(item.path));
				let version: string | null = null;
				for (const item of moved) {
					const placed = set(`${unit.to}${item.path.slice(unit.from.length)}`, item.kind, item.text, at);
					if (item === node) version = placed.version;
				}
				return { outcome: "saved", reason: null, problems: [], version };
			}
		}
	}

	const folder = {
		read: vi.fn(async (path: string, signal: AbortSignal) => {
			signal.throwIfAborted();
			blocked(path);
			const node = hidden(path) ? undefined : nodes.get(key(path));
			return { asOfSeq: seq, entry: node ? entry(node) : null };
		}),
		list: vi.fn(
			async (
				parent: string | null,
				after: string | null,
				limit: number,
				signal: AbortSignal,
			): Promise<CloudMemberFolderListPage> => {
				signal.throwIfAborted();
				if (parent !== null) blocked(parent);
				// A member's listing leaves out what they may not read: a folder closed to them lists empty.
				const children = [...nodes.values()]
					.filter((node) => key(parentOf(node.path)) === key(parent ?? "") && !hidden(node.path))
					.filter((node) => after === null || key(node.path) > key(after))
					.sort((a, b) => (key(a.path) < key(b.path) ? -1 : 1));
				const entries = children.slice(0, limit).map(entry);
				return { asOfSeq: seq, entries, next: entries.length === limit ? (entries.at(-1)?.path ?? null) : null };
			},
		),
		readFile: vi.fn(
			async (file: CloudMemberFolderFile, signal: AbortSignal, maximumBytes = Number.MAX_SAFE_INTEGER) => {
				signal.throwIfAborted();
				if (file.bytes > maximumBytes)
					throw new CloudMemberFolderError("Company folder file exceeds this viewer's limit");
				const text = texts.get(file.fileSha256);
				if (text === undefined)
					throw new CloudMemberFolderError("Company folder object failed integrity verification");
				return encoder.encode(text);
			},
		),
		stateFolders: vi.fn(async (signal: AbortSignal) => {
			signal.throwIfAborted();
			return stateFolders();
		}),
		commit: vi.fn(
			async (
				operationKey: string,
				units: readonly CloudMemberFolderUnit[],
				signal: AbortSignal,
			): Promise<CloudMemberFolderCommit> => {
				signal.throwIfAborted();
				const sent = JSON.stringify(units);
				commits.push({ operationKey, units: JSON.parse(sent) as CloudMemberFolderUnit[] });
				const replay = replays.get(operationKey);
				if (replay) {
					if (replay.units !== sent)
						throw new CloudMemberFolderError("The operation key names another change set", 422);
					return { ...replay.answer, replay: true };
				}
				const injected = answers.shift();
				if (injected?.kind === "throw") throw injected.error;
				if (injected?.kind === "outcome") {
					const answer: CloudMemberFolderCommit = {
						commitId: nextVersion(),
						seq: null,
						replay: false,
						units: units.map((unit, index) => ({
							unit: index + 1,
							op: unit.op,
							path: unit.op === "move" ? unit.from : unit.path,
							to: unit.op === "move" ? unit.to : null,
							version: null,
							outcome: injected.outcome,
							reason: injected.reason,
							problems: injected.problems,
						})),
					};
					replays.set(operationKey, { units: sent, answer });
					return answer;
				}
				const at = seq + 1;
				const results = units.map((unit, index): CloudMemberFolderUnitResult => {
					const result = apply(unit, at);
					return {
						unit: index + 1,
						op: unit.op,
						path: unit.op === "move" ? unit.from : unit.path,
						to: unit.op === "move" ? unit.to : null,
						...result,
					};
				});
				const saved = results.some((result) => result.outcome === "saved");
				if (saved) seq = at;
				const answer: CloudMemberFolderCommit = {
					commitId: nextVersion(),
					seq: saved ? at : null,
					replay: false,
					units: results,
				};
				replays.set(operationKey, { units: sent, answer });
				if (injected?.kind === "lost") throw new TypeError("Failed to fetch");
				return answer;
			},
		),
	};

	const fake = {
		/** The member's folder client, as the writers take it. */
		folder: folder satisfies WebMemberFolder,
		/** Every change set sent, in order. */
		commits,
		get seq() {
			return seq;
		},
		/** What `stateFolders` answers now, without a call. */
		stateFolders,
		/** A file written by someone else (an agent's run, another member): a new version at a new seq. */
		put(path: string, text: string): string {
			const at = ++seq;
			parents(path, at);
			return set(path, "file", text, at).version;
		},
		mkdir(path: string): string {
			const at = ++seq;
			parents(path, at);
			return set(path, "folder", null, at).version;
		},
		remove(path: string): void {
			seq++;
			for (const node of subtree(path)) nodes.delete(key(node.path));
		},
		has(path: string): boolean {
			return nodes.has(key(path));
		},
		kind(path: string): "file" | "folder" | undefined {
			return nodes.get(key(path))?.kind;
		},
		text(path: string): string | undefined {
			return nodes.get(key(path))?.text ?? undefined;
		},
		version(path: string): string | undefined {
			return nodes.get(key(path))?.version;
		},
		/** The paths directly under `parent`, in folder-key order. */
		children(parent: string): string[] {
			return [...nodes.values()]
				.filter((node) => key(parentOf(node.path)) === key(parent))
				.map((node) => node.path)
				.sort((a, b) => (key(a) < key(b) ? -1 : 1));
		},
		/** The next change set is answered `outcome` for every unit and nothing is applied. */
		answer(outcome: CloudMemberFolderOutcome, reason: string, problems: readonly string[] = []): void {
			answers.push({
				kind: "outcome",
				outcome,
				reason,
				problems: problems.map((message) => ({ line: null, key: null, code: reason, message })),
			});
		},
		/** The next change set is applied, and its answer never arrives. */
		loseAnswer(): void {
			answers.push({ kind: "lost" });
		},
		/** The next change set fails before it reaches the core: nothing is applied. */
		failCommit(error: unknown = new TypeError("Failed to fetch")): void {
			answers.push({ kind: "throw", error });
		},
		/** This member may not read or write at or under `root`: reads and listings leave it out, and a unit there is
		 * `denied`. */
		deny(root: string): void {
			denied.add(root);
		},
		/** Reads and listings under `root` fail with `error`: an outage by default, or a refusal (401/403). */
		fail(
			root: string,
			error: unknown = new CloudMemberFolderError("Company folder is unavailable (503)", 503),
		): void {
			failing.set(root, error);
		},
	};
	for (const path of options.seed ?? SEEDED) fake.mkdir(path);
	return fake;
}

export type FolderFake = ReturnType<typeof folderFake>;
