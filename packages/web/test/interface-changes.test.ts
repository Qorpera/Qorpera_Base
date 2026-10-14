// @vitest-environment jsdom

import {
	type CloudMemberFolderCommit,
	CloudMemberFolderError,
	type CloudMemberFolderFile,
	type CloudMemberFolderOp,
	type CloudMemberFolderPathHistory,
	type CloudMemberFolderRead,
	type CloudMemberFolderUnit,
	type CloudMemberFolderUnitResult,
} from "@qorpera/cloud-client/cloud-member-folder";
import { companyPathKey } from "@qorpera/cloud-client/company-state-files";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import type { WorkspaceActions } from "../src/app/workspace-actions.ts";
import {
	INTERFACE_CHANGE_SCHEMA,
	type InterfaceChange,
	type InterfaceUndo,
	type InterfaceUndoFolder,
	interfaceChangeSubjects,
	interfaceChangeUndoable,
	parseInterfaceChange,
	undoInterfaceChange,
} from "../src/cloud/interface-changes.ts";
import { projectTranscript } from "../src/cloud/transcript.ts";
import type { HostedSessionEvent } from "../src/cloud/types.ts";
import { interfaceChangeText, renderInterfaceChangeLine } from "../src/ui/interface-change-line.ts";
import {
	deferred,
	fixture,
	id,
	profileA,
	session,
	settle,
	staff,
	stubFigureMotion,
	team,
	timestamp,
	userA,
} from "./fixtures.ts";

const V = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function change(changes: InterfaceChange["changes"], overrides: Partial<InterfaceChange> = {}): InterfaceChange {
	return { commitId: id(60), seq: 7, runId: id(61), staffAgentId: staff.id, changes, ...overrides };
}

function path(unit: number, op: CloudMemberFolderOp, pathValue: string, priorVersion: string | null = null) {
	return {
		unit,
		op,
		kind: op === "mkdir" ? ("folder" as const) : ("file" as const),
		path: pathValue,
		version: V(unit),
		priorVersion,
	};
}

/** A note's body as the runtime writes it. */
function body(value: InterfaceChange): HostedSessionEvent["body"] {
	return JSON.parse(JSON.stringify({ schema: INTERFACE_CHANGE_SCHEMA, ...value })) as HostedSessionEvent["body"];
}

describe("an interface change's note", () => {
	const made = change([
		path(1, "mkdir", "interfaces/Leads"),
		path(2, "write", "interfaces/Leads/interface.toml"),
		path(3, "write", "interfaces/order.md", V(90)),
	]);

	it("reads a well-formed note", () => {
		expect(parseInterfaceChange(body(made))).toEqual(made);
	});

	it.each([
		["another schema", { schema: "qorpera.peer-link/v1" }],
		["no changes", { changes: [] }],
		["a run that is not an id", { runId: "run" }],
		["no seq", { seq: 0 }],
		["a path outside interfaces/ and tables/", { changes: [path(1, "write", "agents/sales/agent.md")] }],
		["the interfaces folder itself", { changes: [path(1, "write", "interfaces")] }],
		["a path that climbs", { changes: [path(1, "write", "interfaces/../agents/sales/agent.md")] }],
		["an unknown op", { changes: [{ ...path(1, "write", "interfaces/a/b.md"), op: "rename" }] }],
		["a unit 0", { changes: [path(0, "write", "interfaces/a/b.md")] }],
		["a version that is not an id", { changes: [{ ...path(1, "write", "interfaces/a/b.md"), version: "v1" }] }],
		["no prior version", { changes: [{ ...path(1, "write", "interfaces/a/b.md"), priorVersion: undefined }] }],
	])("refuses %s", (_label, overrides) => {
		expect(parseInterfaceChange({ ...(body(made) as Record<string, unknown>), ...overrides })).toBeNull();
	});

	it("shows in the transcript as one item, and a malformed one not at all", () => {
		const note = (sequence: number, value: HostedSessionEvent["body"]): HostedSessionEvent => ({
			sessionId: session.sessionId,
			sequence,
			eventId: id(100 + sequence),
			eventType: "session_info",
			actorUserId: userA.id,
			eventHash: "a".repeat(64),
			createdAt: timestamp,
			body: value,
		});
		const projection = projectTranscript([
			note(1, body(made)),
			note(2, { ...(body(made) as Record<string, unknown>), changes: [] } as HostedSessionEvent["body"]),
		]);
		expect(projection.items).toEqual([
			{ kind: "interface_change", id: id(101), sequence: 1, change: made, createdAt: timestamp },
		]);
		expect(projection.lastSequence).toBe(2);
	});

	it("names what it touched, each interface and table once, in the note's order", () => {
		const touched = change([
			path(1, "mkdir", "interfaces/Leads"),
			path(2, "write", "interfaces/Leads/interface.toml"),
			path(3, "write", "Tables/Clients/table.toml", V(91)),
			path(4, "write", "interfaces/order.md", V(90)),
			path(5, "delete", "tables/old", V(92)),
			path(6, "move_out", "interfaces/Offers", V(93)),
			path(7, "write", "interfaces/leads/view.html"),
		]);
		expect(interfaceChangeSubjects(touched)).toEqual({
			subjects: [
				{ kind: "interface", name: "Leads", how: "made" },
				{ kind: "table", name: "Clients", how: "changed" },
				{ kind: "table", name: "old", how: "removed" },
				{ kind: "interface", name: "Offers", how: "removed" },
			],
			order: true,
		});
		expect(interfaceChangeUndoable(made)).toBe(true);
		// The agent's delete or move is not undone here.
		expect(interfaceChangeUndoable(touched)).toBe(false);
	});
});

describe("an interface change in plain words", () => {
	it("says what it made, changed and deleted, each by its title when it has one", () => {
		const text = interfaceChangeText(
			change([
				path(1, "mkdir", "interfaces/Leads"),
				path(2, "write", "tables/clients/table.toml", V(91)),
				path(3, "write", "interfaces/order.md", V(90)),
				path(4, "delete", "tables/old", V(92)),
				path(5, "delete", "interfaces/offers", V(93)),
			]),
			(subject) =>
				subject.name === "Leads" ? "  Leads\n board " : subject.name === "clients" ? "Clients" : undefined,
		);
		expect(text).toBe(
			"Made the interface “Leads board”, changed the table “Clients” and the order of the interfaces, and deleted " +
				"the table “old” and the interface “offers”",
		);
	});

	it("names four and counts the rest", () => {
		const many = change(
			["a", "b", "c", "d", "e", "f"].map((name, index) => path(index + 1, "mkdir", `interfaces/${name}`)),
		);
		expect(interfaceChangeText(many, () => undefined)).toBe(
			"Made the interface “a”, the interface “b”, the interface “c”, and the interface “d” and 2 other changes",
		);
		const five = change(["a", "b", "c", "d", "e"].map((name, index) => path(index + 1, "mkdir", `tables/${name}`)));
		expect(interfaceChangeText(five, () => undefined)).toMatch(/and 1 other change$/);
	});

	it("draws one line with Undo, and says how Undo went", () => {
		const undo = vi.fn();
		const leads = change([path(1, "mkdir", "interfaces/leads")]);
		const line = renderInterfaceChangeLine(leads, "Made the interface “Leads”", { undo });
		expect(line.getAttribute("role")).toBe("note");
		expect(line.dataset.interfaceChange).toBe(id(60));
		expect(line.querySelector(".interface-change-text")?.textContent).toBe("Made the interface “Leads”");
		const button = line.querySelector("button")!;
		expect(button.textContent).toBe("Undo");
		expect(button.getAttribute("aria-label")).toBe("Undo: Made the interface “Leads”");
		button.click();
		expect(undo).toHaveBeenCalledOnce();
		expect(line.textContent).not.toContain("interfaces/");

		const drawn = (state: Parameters<typeof renderInterfaceChangeLine>[2]["state"], offered = true) =>
			renderInterfaceChangeLine(leads, "Made the interface “Leads”", {
				...(state ? { state } : {}),
				...(offered ? { undo } : {}),
			});
		expect(drawn(undefined, false).querySelector("button")).toBeNull();
		const sending = drawn({ state: "sending" }).querySelector("button")!;
		expect([sending.disabled, sending.textContent, sending.getAttribute("aria-label")]).toEqual([
			true,
			"Undoing…",
			null,
		]);
		const failed = drawn({ state: "failed" });
		expect(failed.querySelector("button")?.disabled).toBe(false);
		expect(failed.querySelector(".interface-change-status.failed")?.textContent).toBe("Could not undo. Try again.");

		const answered = (answer: InterfaceUndo) => {
			const element = drawn({ state: "answered", answer });
			expect(element.querySelector("button")).toBeNull();
			return element.querySelector(".interface-change-status");
		};
		const done = answered({ outcome: "undone", already: false });
		expect([done?.textContent, done?.classList.contains("failed")]).toEqual(["Undone.", false]);
		expect(answered({ outcome: "changed" })?.textContent).toBe("Not undone: it changed again since.");
		expect(answered({ outcome: "too_large" })?.textContent).toBe(
			"This change is too large to undo here. Ask the agent to change it back.",
		);
		expect(answered({ outcome: "unavailable" })?.textContent).toBe(
			"This change can't be undone here. Ask the agent to change it back.",
		);
		const result = (outcome: CloudMemberFolderUnitResult["outcome"], messages: string[] = []) => ({
			unit: 1,
			op: "delete" as const,
			path: "interfaces/leads",
			to: null,
			version: null,
			outcome,
			reason: outcome,
			problems: messages.map((message) => ({ line: null, key: null, code: "invalid", message })),
		});
		expect(answered({ outcome: "not_saved", saved: 0, result: result("denied") })?.textContent).toBe(
			"Not undone. You don't have access to change this.",
		);
		const part = answered({ outcome: "not_saved", saved: 1, result: result("refused", ["Order names no page"]) });
		expect([part?.textContent, part?.classList.contains("failed")]).toEqual([
			"Undone in part. The Company File refused it: Order names no page.",
			true,
		]);
		expect(answered({ outcome: "not_saved", saved: 0, result: result("conflict") })?.textContent).toBe(
			"Not undone. It changed again since.",
		);
	});
});

interface Kept {
	readonly path: string;
	readonly kind: "file" | "folder";
	readonly op: CloudMemberFolderOp;
	readonly version: string;
	readonly seq: number;
	readonly text: string | null;
}

type AgentStep =
	| { readonly op: "write"; readonly path: string; readonly text: string }
	| { readonly op: "mkdir" | "delete"; readonly path: string };

/*
 * A member's company folder with each path's versions, for Undo: reads, a path's history, a file's bytes by its hash
 * (the same text is the same hash), and the member commit route's rules Undo depends on: a unit on a path closed to the
 * member is `denied`; a write or delete naming another version is a conflict; a folder delete as of a seq is a conflict
 * when anything under it changed after that seq; the same key replays its answer.
 */
function historyFolder() {
	const versions: Kept[] = [];
	const hashes = new Map<string, string>();
	const texts = new Map<string, string>();
	const answers = new Map<string, CloudMemberFolderCommit>();
	const closed = new Set<string>();
	const commits: { operationKey: string; units: CloudMemberFolderUnit[] }[] = [];
	const encoder = new TextEncoder();
	let seq = 0;
	let made = 0;
	const nextVersion = () => `f0000000-0000-4000-8000-${String(++made).padStart(12, "0")}`;
	const key = companyPathKey;
	const under = (pathValue: string, root: string) =>
		key(pathValue) === key(root) || key(pathValue).startsWith(`${key(root)}/`);
	const of = (pathValue: string) => versions.filter((kept) => key(kept.path) === key(pathValue));
	const live = (pathValue: string) => {
		const last = of(pathValue).at(-1);
		return last && last.op !== "delete" ? last : undefined;
	};
	const livePaths = (root: string) =>
		[...new Map(versions.map((kept) => [key(kept.path), kept.path])).values()].filter(
			(pathValue) => under(pathValue, root) && live(pathValue),
		);

	function reference(text: string): CloudMemberFolderFile {
		let hash = hashes.get(text);
		if (!hash) {
			hash = (hashes.size + 1).toString(16).padStart(64, "0");
			hashes.set(text, hash);
			texts.set(hash, text);
		}
		return {
			manifestSha256: hash,
			fileSha256: hash,
			bytes: encoder.encode(text).byteLength,
			mediaType: "text/markdown",
			executable: false,
		};
	}

	function save(pathValue: string, kind: "file" | "folder", op: CloudMemberFolderOp, text: string | null, at: number) {
		const kept = { path: pathValue, kind, op, version: nextVersion(), seq: at, text };
		versions.push(kept);
		return kept;
	}

	/** Deletes `root` and what is under it at `at`; the root's delete version. */
	function drop(root: string, at: number): string {
		for (const pathValue of livePaths(root)) save(pathValue, live(pathValue)!.kind, "delete", null, at);
		return of(root).at(-1)!.version;
	}

	const folder = {
		read: vi.fn(async (pathValue: string, signal: AbortSignal): Promise<CloudMemberFolderRead> => {
			signal.throwIfAborted();
			const kept = live(pathValue);
			return {
				asOfSeq: seq,
				entry: kept
					? {
							path: kept.path,
							kind: kept.kind,
							version: kept.version,
							seq: kept.seq,
							updatedAt: timestamp,
							file: kept.kind === "file" ? reference(kept.text ?? "") : null,
						}
					: null,
			};
		}),
		pathHistory: vi.fn(
			async (
				pathValue: string,
				before: string | null,
				limit: number,
				signal: AbortSignal,
			): Promise<CloudMemberFolderPathHistory> => {
				signal.throwIfAborted();
				const all = of(pathValue).reverse();
				const from = before === null ? 0 : all.findIndex((kept) => kept.version === before) + 1;
				const items = all.slice(from, from + limit).map((kept) => ({
					version: kept.version,
					seq: kept.seq,
					op: kept.op,
					kind: kept.kind,
					path: kept.path,
					at: timestamp,
					by: { kind: "platform" as const },
					from: null,
					to: null,
					file: kept.kind === "file" && kept.op !== "delete" ? reference(kept.text ?? "") : null,
				}));
				return { asOfSeq: seq, items, next: null };
			},
		),
		readFile: vi.fn(
			async (file: CloudMemberFolderFile, signal: AbortSignal, maximumBytes = Number.MAX_SAFE_INTEGER) => {
				signal.throwIfAborted();
				if (file.bytes > maximumBytes)
					throw new CloudMemberFolderError("Company folder file exceeds this viewer's limit");
				return encoder.encode(texts.get(file.fileSha256) ?? "");
			},
		),
		commit: vi.fn(
			async (
				operationKey: string,
				units: readonly CloudMemberFolderUnit[],
				signal: AbortSignal,
			): Promise<CloudMemberFolderCommit> => {
				signal.throwIfAborted();
				commits.push({ operationKey, units: [...units] });
				const replay = answers.get(operationKey);
				if (replay) return { ...replay, replay: true };
				const at = seq + 1;
				const results = units.map((unit, index): CloudMemberFolderUnitResult => {
					if (unit.op !== "write" && unit.op !== "delete") throw new Error(`Undo sends no ${unit.op}`);
					const outcome = (value: CloudMemberFolderUnitResult["outcome"], version: string | null = null) => ({
						unit: index + 1,
						op: unit.op,
						path: unit.path,
						to: null,
						version,
						outcome: value,
						reason: value === "saved" ? null : value,
						problems: [],
					});
					if ([...closed].some((root) => under(unit.path, root))) return outcome("denied");
					const current = live(unit.path);
					if (current?.version !== unit.expectedVersion) return outcome("conflict");
					if (unit.op === "write")
						return outcome("saved", save(unit.path, "file", "write", unit.text, at).version);
					const asOfSeq = unit.asOfSeq;
					if (asOfSeq !== undefined && livePaths(unit.path).some((pathValue) => live(pathValue)!.seq > asOfSeq))
						return outcome("conflict");
					return outcome("saved", drop(unit.path, at));
				});
				const saved = results.some((result) => result.outcome === "saved");
				if (saved) seq = at;
				const answer = { commitId: nextVersion(), seq: saved ? at : null, replay: false, units: results };
				answers.set(operationKey, answer);
				return answer;
			},
		),
	} satisfies InterfaceUndoFolder;

	return {
		folder,
		commits,
		/** The agent's commit, each step at one new seq, and its note. */
		agent(steps: readonly AgentStep[]): InterfaceChange {
			const at = ++seq;
			const changes = steps.map((step, index) => {
				const priorVersion = of(step.path).at(-1)?.version ?? null;
				const kind = step.op === "mkdir" ? "folder" : step.op === "write" ? "file" : live(step.path)!.kind;
				const version =
					step.op === "delete"
						? drop(step.path, at)
						: save(step.path, kind, step.op, step.op === "write" ? step.text : null, at).version;
				return { unit: index + 1, op: step.op, kind, path: step.path, version, priorVersion };
			});
			return change(changes, { commitId: `c0000000-0000-4000-8000-${String(at).padStart(12, "0")}`, seq: at });
		},
		/** Someone else's change at a new seq. */
		put(pathValue: string, text: string): void {
			save(pathValue, "file", "write", text, ++seq);
		},
		mkdir(pathValue: string): void {
			save(pathValue, "folder", "mkdir", null, ++seq);
		},
		remove(pathValue: string): void {
			drop(pathValue, ++seq);
		},
		/** A unit at or under `root` is denied to the member. */
		deny(root: string): void {
			closed.add(root);
		},
		text: (pathValue: string) => live(pathValue)?.text ?? undefined,
		has: (pathValue: string) => live(pathValue) !== undefined,
	};
}

describe("Undo of an interface change", () => {
	const signal = new AbortController().signal;
	const undo = (f: ReturnType<typeof historyFolder>, value: InterfaceChange, check = () => {}) =>
		undoInterfaceChange(f.folder, value, signal, check);

	function seeded() {
		const f = historyFolder();
		f.mkdir("interfaces");
		f.mkdir("tables");
		f.put("interfaces/order.md", "- clients\n");
		return f;
	}

	it("deletes what the change made, a folder as of its commit, and gives a rewritten file its text back", async () => {
		const f = seeded();
		const leads = f.agent([
			{ op: "mkdir", path: "interfaces/leads" },
			{ op: "write", path: "interfaces/leads/interface.toml", text: "# Leads\n" },
			{ op: "write", path: "interfaces/leads/view.html", text: "<main></main>\n" },
			{ op: "write", path: "interfaces/order.md", text: "- clients\n- leads\n" },
		]);
		await expect(undo(f, leads)).resolves.toEqual({ outcome: "undone", already: false });
		// One change set, the last unit's change first: the folder goes with what the change made in it.
		expect(f.commits).toEqual([
			{
				operationKey: `interface-undo:${leads.commitId}`,
				units: [
					{
						op: "write",
						path: "interfaces/order.md",
						text: "- clients\n",
						expectedVersion: leads.changes[3]?.version,
					},
					{
						op: "delete",
						path: "interfaces/leads",
						expectedVersion: leads.changes[0]?.version,
						asOfSeq: leads.seq,
					},
				],
			},
		]);
		expect(f.has("interfaces/leads")).toBe(false);
		expect(f.has("interfaces/leads/view.html")).toBe(false);
		expect(f.text("interfaces/order.md")).toBe("- clients\n");
		// Pressed again (another tab, a redraw), it finds it undone and sends nothing.
		await expect(undo(f, leads)).resolves.toEqual({ outcome: "undone", already: true });
		expect(f.commits).toHaveLength(1);
	});

	it("deletes a file the change wrote where an earlier one was deleted", async () => {
		const f = seeded();
		f.mkdir("tables/clients");
		f.put("tables/clients/table.toml", 'title = "Clients"\n');
		f.remove("tables/clients/table.toml");
		const again = f.agent([{ op: "write", path: "tables/clients/table.toml", text: 'title = "Kunder"\n' }]);
		expect(again.changes[0]?.priorVersion).not.toBeNull();
		await expect(undo(f, again)).resolves.toEqual({ outcome: "undone", already: false });
		expect(f.commits.at(-1)?.units).toEqual([
			{ op: "delete", path: "tables/clients/table.toml", expectedVersion: again.changes[0]?.version },
		]);
		expect(f.has("tables/clients/table.toml")).toBe(false);
	});

	it("changes nothing when what the change made changed since", async () => {
		const f = seeded();
		const leads = f.agent([
			{ op: "mkdir", path: "interfaces/leads" },
			{ op: "write", path: "interfaces/leads/interface.toml", text: "# Leads\n" },
		]);
		f.put("interfaces/leads/interface.toml", "# Our leads\n");
		await expect(undo(f, leads)).resolves.toEqual({ outcome: "changed" });
		const order = f.agent([{ op: "write", path: "interfaces/order.md", text: "- leads\n" }]);
		f.put("interfaces/order.md", "- offers\n");
		await expect(undo(f, order)).resolves.toEqual({ outcome: "changed" });
		expect(f.commits).toEqual([]);

		// Something new in a folder the change made: the core refuses the folder's delete as of the commit.
		const offers = f.agent([{ op: "mkdir", path: "interfaces/offers" }]);
		f.put("interfaces/offers/notes.md", "Mine\n");
		await expect(undo(f, offers)).resolves.toEqual({ outcome: "changed" });
		expect(f.commits).toHaveLength(1);
		expect(f.text("interfaces/offers/notes.md")).toBe("Mine\n");
	});

	it("undoes what is left when the member took part of it back already", async () => {
		const f = seeded();
		f.mkdir("interfaces/leads");
		const two = f.agent([
			{ op: "write", path: "interfaces/leads/a.md", text: "A\n" },
			{ op: "write", path: "interfaces/leads/b.md", text: "B\n" },
		]);
		f.remove("interfaces/leads/a.md");
		await expect(undo(f, two)).resolves.toEqual({ outcome: "undone", already: false });
		expect(f.commits).toEqual([
			{
				operationKey: `interface-undo:${two.commitId}:1`,
				units: [{ op: "delete", path: "interfaces/leads/b.md", expectedVersion: two.changes[1]?.version }],
			},
		]);
	});

	it("says which part the core did not save", async () => {
		const f = seeded();
		f.mkdir("interfaces/leads");
		const two = f.agent([
			{ op: "write", path: "interfaces/leads/a.md", text: "A\n" },
			{ op: "write", path: "interfaces/leads/b.md", text: "B\n" },
		]);
		f.deny("interfaces/leads/b.md");
		await expect(undo(f, two)).resolves.toMatchObject({
			outcome: "not_saved",
			saved: 1,
			result: { path: "interfaces/leads/b.md", outcome: "denied" },
		});
		expect([f.has("interfaces/leads/a.md"), f.has("interfaces/leads/b.md")]).toEqual([false, true]);
	});

	it("is too large past the member route's limits, and sends nothing", async () => {
		const f = seeded();
		f.mkdir("interfaces/leads");
		const many = f.agent(
			Array.from({ length: 17 }, (_, index) => ({
				op: "write" as const,
				path: `interfaces/leads/page-${index + 1}.md`,
				text: "Page\n",
			})),
		);
		await expect(undo(f, many)).resolves.toEqual({ outcome: "too_large" });
		f.put("interfaces/leads/big.md", "x".repeat(64 * 1024 + 1));
		const big = f.agent([{ op: "write", path: "interfaces/leads/big.md", text: "small\n" }]);
		await expect(undo(f, big)).resolves.toEqual({ outcome: "too_large" });
		expect(f.folder.readFile).not.toHaveBeenCalled();
		expect(f.commits).toEqual([]);
	});

	it("can't undo a delete, a version the history does not hold, or text that is not UTF-8", async () => {
		const f = seeded();
		f.mkdir("interfaces/leads");
		const deleted = f.agent([{ op: "delete", path: "interfaces/leads" }]);
		await expect(undo(f, deleted)).resolves.toEqual({ outcome: "unavailable" });
		expect(f.folder.read).not.toHaveBeenCalled();

		const order = f.agent([{ op: "write", path: "interfaces/order.md", text: "- leads\n" }]);
		const [unit] = order.changes;
		const elsewhere = { ...order, changes: [{ ...unit!, priorVersion: V(99) }] };
		await expect(undo(f, elsewhere)).resolves.toEqual({ outcome: "unavailable" });
		f.folder.readFile.mockResolvedValueOnce(new Uint8Array([0xff, 0xfe, 0x00]));
		await expect(undo(f, order)).resolves.toEqual({ outcome: "unavailable" });
		expect(f.commits).toEqual([]);
		await expect(undo(f, order)).resolves.toEqual({ outcome: "undone", already: false });
	});

	it("can't undo a folder it made that holds what it moved or copied in, or a path it saved twice", async () => {
		const f = seeded();
		// The move's source is outside interfaces/ and tables/, so the note names only where the file went.
		const moved = change([
			path(1, "mkdir", "interfaces/leads"),
			path(2, "move_in", "interfaces/leads/README.md", V(40)),
		]);
		const copied = change([path(1, "mkdir", "interfaces/leads"), path(2, "copy", "interfaces/leads/notes.md")]);
		const nested = change([
			path(1, "mkdir", "tables/leads"),
			path(2, "mkdir", "tables/leads/files"),
			path(3, "move_in", "tables/leads/files/brief.md", V(41)),
		]);
		const twice = f.agent([
			{ op: "write", path: "interfaces/order.md", text: "- leads\n" },
			{ op: "write", path: "interfaces/order.md", text: "- leads\n- offers\n" },
		]);
		for (const value of [moved, copied, nested, twice]) {
			expect(interfaceChangeUndoable(value)).toBe(false);
			await expect(undo(f, value)).resolves.toEqual({ outcome: "unavailable" });
		}
		expect(f.folder.read).not.toHaveBeenCalled();
		expect(f.commits).toEqual([]);
	});

	it("stops when the member's access changed while it read", async () => {
		const f = seeded();
		const leads = f.agent([{ op: "mkdir", path: "interfaces/leads" }]);
		const check = vi
			.fn<() => void>()
			.mockImplementationOnce(() => {})
			.mockImplementationOnce(() => {
				throw new Error("Conversation access changed.");
			});
		await expect(undo(f, leads, check)).rejects.toThrow("Conversation access changed.");
		expect(f.commits).toEqual([]);
		expect(f.has("interfaces/leads")).toBe(true);
	});
});

let dispose: (() => void) | undefined;
beforeEach(() => {
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	vi.stubGlobal("innerWidth", 1280);
	stubFigureMotion();
	history.replaceState(null, "", `/#/c/${profileA.profileId}/chat/${session.sessionId}`);
});
afterEach(() => {
	dispose?.();
	dispose = undefined;
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("an interface change in the agent's thread", () => {
	const leads = change([path(1, "mkdir", "interfaces/leads"), path(2, "write", "interfaces/leads/interface.toml")]);
	const note = (value: InterfaceChange, sequence = 5): HostedSessionEvent => ({
		sessionId: session.sessionId,
		sequence,
		eventId: id(100 + sequence),
		eventType: "session_info",
		actorUserId: userA.id,
		eventHash: "a".repeat(64),
		createdAt: timestamp,
		body: body(value),
	});

	async function mount(actions: WorkspaceActions, events: HostedSessionEvent[], write = true) {
		const f = fixture();
		const company = new CompanyController(f.api, profileA, userA.id);
		company.store.set({
			team: { ...team, capabilities: { ...team.capabilities, write } },
			staff: [staff],
			sessions: [{ ...session, staffAgentId: staff.id }],
			loading: false,
		});
		company.conversation(session.sessionId, false);
		const view = new ConversationView(company, session.sessionId, actions);
		document.body.append(view.el);
		dispose = () => {
			view.dispose();
			company.stop();
		};
		vi.mocked(f.api.readSessionEvents).mockResolvedValue(events);
		await company.loadConversation(session.sessionId);
		await settle();
		const line = () => view.el.querySelector<HTMLElement>(`[data-interface-change="${id(60)}"]`)!;
		return { ...f, view, line };
	}

	it("is one line, and Undo says how it went with the keyboard kept on the line", async () => {
		const answered = deferred<InterfaceUndo>();
		const undoInterfaceChange = vi.fn<NonNullable<WorkspaceActions["undoInterfaceChange"]>>(() => answered.promise);
		const f = await mount({ undoInterfaceChange }, [note(leads)]);
		expect(f.line().querySelector(".interface-change-text")?.textContent).toBe("Made the interface “leads”");
		expect(f.line().textContent).not.toContain("interfaces/");
		f.line().querySelector<HTMLButtonElement>("button")!.focus();
		f.line().querySelector<HTMLButtonElement>("button")!.click();
		await settle();
		expect(undoInterfaceChange).toHaveBeenCalledWith(leads, expect.any(AbortSignal));
		const sending = f.line().querySelector<HTMLButtonElement>("button")!;
		expect([sending.disabled, sending.textContent]).toEqual([true, "Undoing…"]);
		// Pressed again while it is sent, nothing more is sent.
		sending.click();
		expect(undoInterfaceChange).toHaveBeenCalledOnce();
		expect(document.activeElement).toBe(f.line());
		answered.resolve({ outcome: "undone", already: false });
		await settle();
		expect(f.line().querySelector("button")).toBeNull();
		expect(f.line().querySelector(".interface-change-status")?.textContent).toBe("Undone.");
		expect(document.activeElement).toBe(f.line());
	});

	it("offers Undo again after it failed, with the keyboard on it", async () => {
		const undoInterfaceChange = vi
			.fn<NonNullable<WorkspaceActions["undoInterfaceChange"]>>()
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce({ outcome: "changed" });
		const f = await mount({ undoInterfaceChange }, [note(leads)]);
		f.line().querySelector<HTMLButtonElement>("button")!.focus();
		f.line().querySelector<HTMLButtonElement>("button")!.click();
		await settle();
		expect(f.line().querySelector(".interface-change-status.failed")?.textContent).toBe("Could not undo. Try again.");
		const retry = f.line().querySelector<HTMLButtonElement>("button")!;
		expect(document.activeElement).toBe(retry);
		retry.click();
		await settle();
		expect(undoInterfaceChange).toHaveBeenCalledTimes(2);
		expect(f.line().querySelector(".interface-change-status")?.textContent).toBe(
			"Not undone: it changed again since.",
		);
	});

	it("has no Undo for a member who can't write, or for a change Undo can't take back", async () => {
		const undoInterfaceChange = vi.fn<NonNullable<WorkspaceActions["undoInterfaceChange"]>>();
		const reader = await mount({ undoInterfaceChange }, [note(leads)], false);
		expect(reader.line().querySelector(".interface-change-text")?.textContent).toBe("Made the interface “leads”");
		expect(reader.line().querySelector("button")).toBeNull();
		dispose?.();

		const deleted = change([path(1, "delete", "interfaces/offers", V(93))]);
		const writer = await mount({ undoInterfaceChange }, [note(deleted)]);
		expect(writer.line().querySelector(".interface-change-text")?.textContent).toBe("Deleted the interface “offers”");
		expect(writer.line().querySelector("button")).toBeNull();
		dispose?.();

		const moved = change([
			path(1, "mkdir", "interfaces/leads"),
			path(2, "move_in", "interfaces/leads/README.md", V(40)),
		]);
		const mover = await mount({ undoInterfaceChange }, [note(moved)]);
		expect(mover.line().querySelector(".interface-change-text")?.textContent).toBe("Made the interface “leads”");
		expect(mover.line().querySelector("button")).toBeNull();
		dispose?.();

		const without = await mount({}, [note(leads)]);
		expect(without.line().querySelector("button")).toBeNull();
		expect(undoInterfaceChange).not.toHaveBeenCalled();
	});
});
