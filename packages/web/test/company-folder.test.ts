// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import type {
	CloudMemberFolderChangesPage,
	CloudMemberFolderCommit,
	CloudMemberFolderEntry,
	CloudMemberFolderFile,
	CloudMemberFolderHistory,
	CloudMemberFolderOutcome,
	CloudMemberFolderPathHistory,
	CloudMemberFolderProblem,
	CloudMemberFolderUnit,
} from "@qorpera/cloud-client/cloud-member-folder";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyFolderBrowser, type CompanyFolderSource } from "../src/app/views/company-folder.ts";
import { LiveCompanyFileView } from "../src/app/views/live-company-file.ts";
import { WebCompanyFiles } from "../src/cloud/company-files.ts";
import { fixture, id, profileA, settle, team, visibleText } from "./fixtures.ts";

const me = id(1);
const other = id(2);
const agent = id(30);
const at = "2026-10-03T09:12:33.000000+00:00";
const people = () => ({
	me,
	members: [
		{ userId: me, displayName: "Ada" },
		{ userId: other, displayName: "Bo" },
	],
	staff: [{ id: agent, displayName: "Scout" }],
});

/** A file reference whose hash stands for its text in the fake (short texts only). */
const texts = new Map<string, string>();
function file(text: string): CloudMemberFolderFile {
	const hash = Array.from(new TextEncoder().encode(text), (byte) => byte.toString(16).padStart(2, "0"))
		.join("")
		.padEnd(64, "0")
		.slice(0, 64);
	texts.set(hash, text);
	return { manifestSha256: hash, fileSha256: hash, bytes: text.length, mediaType: "text/plain", executable: false };
}
function entry(path: string, text?: string, seq = 1): CloudMemberFolderEntry {
	return {
		path,
		kind: text === undefined ? "folder" : "file",
		version: id(100 + seq),
		seq,
		updatedAt: at,
		file: text === undefined ? null : file(text),
		target: null,
	};
}
/** A link to `target`: no bytes, and nothing below it. */
function link(path: string, target: string, seq = 1): CloudMemberFolderEntry {
	return { path, kind: "symlink", version: id(100 + seq), seq, updatedAt: at, file: null, target };
}

/** A one-unit commit's answer. */
function answer(
	unit: CloudMemberFolderUnit,
	outcome: CloudMemberFolderOutcome,
	reason: string | null = null,
	problems: CloudMemberFolderProblem[] = [],
): CloudMemberFolderCommit {
	return {
		commitId: id(400),
		seq: outcome === "saved" ? 5 : null,
		replay: false,
		units: [
			{
				unit: 1,
				op: unit.op,
				path: "path" in unit ? unit.path : unit.from,
				to: null,
				version: outcome === "saved" ? id(500) : null,
				outcome,
				reason,
				problems,
			},
		],
	};
}

/** A folder in memory: folders, files and links by path, and what the feed and history answer. A link's version is
 * its own (seq 7), so a write over one names it. */
function folderFake() {
	const contents = new Map<string, string>([
		["notes/plan.md", "# Plan\n\nShip it."],
		["notes/log.txt", "line one"],
		["readme.txt", "Hello."],
		["logo.png", "png"],
	]);
	const folders = new Set(["notes", "big"]);
	/** Each link's target, by path. */
	const links = new Map<string, string>();
	let asOfSeq = 4;
	const changes: CloudMemberFolderChangesPage[] = [];
	const listed = (dir: string) => {
		const under = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "") === dir;
		return [
			...[...folders].filter(under).map((path) => entry(path)),
			...[...contents.keys()].filter(under).map((path) => entry(path, contents.get(path))),
			...[...links].filter(([path]) => under(path)).map(([path, target]) => link(path, target, 7)),
		];
	};
	const linked = (path: string) => {
		const target = links.get(path);
		return target === undefined ? null : link(path, target, 7);
	};
	const client = {
		list: vi.fn(async (parent: string | null) => ({ asOfSeq, entries: listed(parent ?? ""), next: null })),
		read: vi.fn(async (path: string) => ({
			asOfSeq,
			entry: contents.has(path) ? entry(path, contents.get(path)) : folders.has(path) ? entry(path) : linked(path),
		})),
		readFile: vi.fn(async (reference: CloudMemberFolderFile) =>
			new TextEncoder().encode(texts.get(reference.fileSha256) ?? ""),
		),
		pathHistory: vi.fn(
			async (path: string): Promise<CloudMemberFolderPathHistory> => ({
				asOfSeq,
				items: [
					{
						version: id(201),
						seq: 4,
						op: "write",
						kind: "file",
						path,
						at,
						by: { kind: "agent", staffAgentId: agent },
						from: null,
						to: null,
						file: file("old text, longer"),
						target: null,
					},
					{
						version: id(200),
						seq: 2,
						op: "move_in",
						kind: "file",
						path,
						at,
						by: { kind: "member", userId: me },
						from: "drafts/plan.md",
						to: null,
						file: file("older"),
						target: null,
					},
					{
						version: id(199),
						seq: 1,
						op: "write",
						kind: "symlink",
						path,
						at,
						by: { kind: "agent", staffAgentId: agent },
						from: null,
						to: null,
						file: null,
						target: "notes/plan.md",
					},
				],
				next: null,
			}),
		),
		history: vi.fn(
			async (): Promise<CloudMemberFolderHistory> => ({
				asOfSeq,
				items: [
					{
						seq: 4,
						at,
						by: { kind: "member", userId: other },
						paths: [
							{ path: "notes/log.txt", op: "write", kind: "file", version: id(104) },
							{ path: "notes/latest", op: "write", kind: "symlink", version: id(105) },
						],
						more: true,
					},
					{
						seq: 3,
						at,
						by: { kind: "platform" },
						paths: [{ path: "old.txt", op: "delete", kind: "file", version: id(103) }],
						more: false,
					},
				],
				next: null,
			}),
		),
		changes: vi.fn(
			async (): Promise<CloudMemberFolderChangesPage> =>
				changes.shift() ?? {
					asOfSeq,
					resync: false,
					events: [],
					next: { afterSeq: asOfSeq, cursor: null },
					more: false,
				},
		),
		/** Saves a write of a file reference or a link, over whatever file or link is there. */
		commit: vi.fn(
			async (
				_operationKey: string,
				units: readonly CloudMemberFolderUnit[],
				_signal?: AbortSignal,
			): Promise<CloudMemberFolderCommit> => {
				const [unit] = units;
				if (unit?.op === "symlink") {
					contents.delete(unit.path);
					links.set(unit.path, unit.target);
				} else if (unit?.op === "write" && "file" in unit) {
					links.delete(unit.path);
					contents.set(unit.path, texts.get(unit.file.fileSha256) ?? "");
				} else throw new Error("The fake saves a restore only");
				return answer(unit, "saved");
			},
		),
	};
	return {
		client,
		contents,
		folders,
		links,
		changes,
		bump(seq: number) {
			asOfSeq = seq;
		},
	};
}

function source(fake: ReturnType<typeof folderFake>) {
	const stop = new AbortController();
	let hint: ((seq: number) => void) | undefined;
	const value: CompanyFolderSource = {
		signal: stop.signal,
		current: () => stop.signal.throwIfAborted(),
		folder: () => fake.client,
		folderHints: (onHint) => {
			hint = onHint;
			return { close: async () => {} };
		},
	};
	return { value, stop, hint: (seq: number) => hint?.(seq) };
}

const disposers: (() => void)[] = [];
beforeEach(() => {
	vi.stubGlobal("crypto", webcrypto);
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	URL.createObjectURL = vi.fn(() => "blob:fixture-picture");
	URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});

async function opened() {
	const fake = folderFake(),
		src = source(fake),
		host = document.createElement("section");
	document.body.append(host);
	const browser = new CompanyFolderBrowser(host, src.value, people);
	disposers.push(() => browser.dispose());
	await browser.open();
	await settle();
	return { fake, src, host, browser };
}
const rows = (host: HTMLElement) =>
	[...host.querySelectorAll<HTMLElement>(".files-list > .files-row .files-name")].map((name) => name.textContent);
const click = async (element: Element | null | undefined) => {
	(element as HTMLElement).click();
	await settle();
};
const row = (host: HTMLElement, name: string) =>
	[...host.querySelectorAll<HTMLElement>(".files-row-main")].find(
		(button) => button.querySelector(".files-name")?.textContent === name,
	);
const action = (host: HTMLElement, label: string) =>
	[...host.querySelectorAll<HTMLButtonElement>(".files-preview-actions button")].find((button) =>
		button.textContent?.includes(label),
	);
/** Each history row's Restore button, or null. */
const restoreButtons = (host: HTMLElement) =>
	[...host.querySelectorAll(".folder-history-row")].map(
		(line) =>
			[...line.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Restore") ??
			null,
	);
const status = (host: HTMLElement) => visibleText(host.querySelector(".files-status"));
const retries = (host: HTMLElement) => visibleText(host.querySelector(".files-retries"));

describe("a folder-v2 company's Company File", () => {
	it("lists the top folder, folders first, and enters a folder", async () => {
		const { fake, host } = await opened();
		expect(host.querySelector("h1")?.textContent).toBe("Company File");
		expect(rows(host)).toEqual(["big", "notes", "logo.png", "readme.txt"]);
		expect(fake.client.list).toHaveBeenCalledWith(null, null, 200, expect.any(AbortSignal));
		await click(row(host, "notes"));
		expect(fake.client.list).toHaveBeenLastCalledWith("notes", null, 200, expect.any(AbortSignal));
		expect(rows(host)).toEqual(["log.txt", "plan.md"]);
		expect(visibleText(host.querySelector(".files-crumbs"))).toContain("notes");
		await click(host.querySelector(".files-crumb"));
		expect(rows(host)).toEqual(["big", "notes", "logo.png", "readme.txt"]);
	});

	it("shows a link among the files with the target it names, and opens its page with the target, reading no bytes", async () => {
		const { fake, host } = await opened();
		fake.links.set("notes/latest", "../readme.txt");
		await click(row(host, "notes"));
		expect(rows(host)).toEqual(["latest", "log.txt", "plan.md"]);
		// Entering the folder focuses its first row; a link's opens its page too.
		const link = row(host, "latest")!;
		expect(document.activeElement).toBe(link);
		expect(link.tagName).toBe("BUTTON");
		expect(link.closest(".files-row")?.classList.contains("is-link")).toBe(true);
		const target = link.querySelector<HTMLElement>(".files-target")!;
		expect(target.textContent).toBe("→ ../readme.txt");
		expect(target.title).toBe("Link to ../readme.txt");
		await click(link);
		expect(host.classList.contains("has-preview")).toBe(true);
		expect(link.closest(".files-row")?.classList.contains("is-open")).toBe(true);
		expect(host.querySelector(".files-preview-head h2")?.textContent).toBe("latest");
		expect(visibleText(host.querySelector(".files-link-target"))).toBe("Link to ../readme.txt");
		expect(action(host, "History")).toBeDefined();
		expect(action(host, "Download")).toBeUndefined();
		// The link is never followed: nothing is read, here or at its target.
		expect(fake.client.read).not.toHaveBeenCalled();
		expect(fake.client.readFile).not.toHaveBeenCalled();
		expect(rows(host)).toEqual(["latest", "log.txt", "plan.md"]);
	});

	it("filters the open folder by name", async () => {
		const { host } = await opened();
		const search = host.querySelector<HTMLInputElement>(".files-search-input")!;
		search.value = "READ";
		search.dispatchEvent(new Event("input"));
		expect(rows(host)).toEqual(["readme.txt"]);
		search.value = "nothing";
		search.dispatchEvent(new Event("input"));
		expect(visibleText(host.querySelector(".files-empty"))).toContain("nothing");
	});

	it("shows text, Markdown and pictures, and offers a download", async () => {
		const { host } = await opened();
		await click(row(host, "readme.txt"));
		expect(host.querySelector(".files-text")?.textContent).toBe("Hello.");
		expect(host.classList.contains("has-preview")).toBe(true);
		await click(row(host, "logo.png"));
		expect(host.querySelector<HTMLImageElement>(".files-image")?.src).toBe("blob:fixture-picture");
		await click(row(host, "notes"));
		await click(row(host, "plan.md"));
		expect(host.querySelector(".files-doc h2")?.textContent).toBe("Plan");
		expect(visibleText(host.querySelector(".files-preview-actions"))).toContain("Download");
	});

	it("shows a path's history with who and when, a file's and a link's versions, and an earlier one in place of the latest", async () => {
		const { fake, host } = await opened();
		await click(row(host, "readme.txt"));
		await click(action(host, "History"));
		expect(fake.client.pathHistory).toHaveBeenCalledWith("readme.txt", null, 50, expect.any(AbortSignal));
		const lines = [...host.querySelectorAll(".folder-history-row")].map((line) => visibleText(line));
		expect(lines[0]).toContain("Changed");
		expect(lines[0]).toContain("Scout");
		expect(lines[1]).toContain("Moved here from drafts/plan.md");
		expect(lines[1]).toContain("You");
		expect(lines[2]).toContain("Link to notes/plan.md");
		// Every version is viewed; every one but the newest, which the path holds now, is restored.
		expect(
			[...host.querySelectorAll(".folder-history-row")].map((line) =>
				[...line.querySelectorAll("button")].map((button) => button.textContent),
			),
		).toEqual([["View"], ["View", "Restore"], ["View", "Restore"]]);
		expect(restoreButtons(host)[1]?.getAttribute("aria-label")).toMatch(/^Restore the version from /);
		await click(host.querySelector(".folder-history-row button"));
		expect(visibleText(host.querySelector(".files-note"))).toContain("An earlier version");
		expect(host.querySelector(".files-text")?.textContent).toBe("old text, longer");
		await click(action(host, "Show the latest"));
		expect(host.querySelector(".files-note")).toBeNull();
		expect(host.querySelector(".files-text")?.textContent).toBe("Hello.");
		// A link's version holds its target and no bytes: its view shows the target and reads nothing.
		const reads = fake.client.readFile.mock.calls.length;
		await click(action(host, "History"));
		await click(host.querySelectorAll(".folder-history-row")[2]?.querySelector("button"));
		expect(visibleText(host.querySelector(".files-note"))).toContain("An earlier version");
		expect(visibleText(host.querySelector(".files-link-target"))).toBe("Link to notes/plan.md");
		expect(action(host, "Download")).toBeUndefined();
		expect(fake.client.readFile).toHaveBeenCalledTimes(reads);
	});

	it("shows the company's recent changes and opens a changed file or link from them", async () => {
		const { fake, host } = await opened();
		fake.links.set("notes/latest", "plan.md");
		await click(host.querySelector('.files-tool[aria-label="Recent changes"]'));
		expect(fake.client.history).toHaveBeenCalledWith(null, 20, expect.any(AbortSignal));
		const sets = [...host.querySelectorAll(".folder-history-row")].map((line) => visibleText(line));
		expect(sets[0]).toContain("Bo");
		expect(sets[0]).toContain("and more");
		expect(sets[1]).toContain("Qorpera");
		const gone = [...host.querySelectorAll("span.folder-history-path.is-gone")].map((path) => path.textContent);
		expect(gone).toEqual(["old.txt"]);
		const changed = [...host.querySelectorAll("button.folder-history-path")].map((path) => path.textContent);
		expect(changed).toEqual(["notes/log.txt", "notes/latest"]);
		await click(host.querySelector("button.folder-history-path"));
		expect(rows(host)).toEqual(["latest", "log.txt", "plan.md"]);
		expect(host.querySelector(".files-text")?.textContent).toBe("line one");
		await click(host.querySelector('.files-tool[aria-label="Recent changes"]'));
		await click(host.querySelectorAll("button.folder-history-path")[1]);
		expect(host.querySelector(".files-preview-head h2")?.textContent).toBe("latest");
		expect(visibleText(host.querySelector(".files-link-target"))).toBe("Link to plan.md");
	});

	it("restores a link's earlier version as a link at the version there now, over a file or a link", async () => {
		const { fake, host } = await opened();
		await click(row(host, "readme.txt"));
		await click(action(host, "History"));
		await click(restoreButtons(host)[2]);
		await settle();
		expect(fake.client.commit).toHaveBeenCalledTimes(1);
		const [key, units] = fake.client.commit.mock.calls[0]!;
		expect(key).toMatch(/^web:folder-restore:[0-9a-f-]{36}$/);
		// Over a file: the file's version.
		expect(units).toEqual([{ op: "symlink", path: "readme.txt", target: "notes/plan.md", expectedVersion: id(101) }]);
		expect(status(host)).toBe("Restored readme.txt.");
		expect(host.querySelector(".files-note")).toBeNull();
		expect(visibleText(host.querySelector(".files-link-target"))).toBe("Link to notes/plan.md");
		// Over a link: the link's version.
		fake.links.set("notes/latest", "../readme.txt");
		await click(row(host, "notes"));
		await click(row(host, "latest"));
		await click(action(host, "History"));
		await click(restoreButtons(host)[2]);
		await settle();
		expect(fake.client.commit.mock.calls[1]?.[0]).not.toBe(key);
		expect(fake.client.commit.mock.calls[1]?.[1]).toEqual([
			{ op: "symlink", path: "notes/latest", target: "notes/plan.md", expectedVersion: id(107) },
		]);
		expect(visibleText(host.querySelector(".files-link-target"))).toBe("Link to notes/plan.md");
	});

	it("restores a file's earlier version over a link as a write of its reference at the link's version", async () => {
		const { fake, host } = await opened();
		fake.links.set("notes/latest", "../readme.txt");
		await click(row(host, "notes"));
		await click(row(host, "latest"));
		await click(action(host, "History"));
		await click(restoreButtons(host)[1]);
		await settle();
		expect(fake.client.commit.mock.calls[0]?.[1]).toEqual([
			{ op: "write", path: "notes/latest", file: file("older"), expectedVersion: id(107) },
		]);
		expect(status(host)).toBe("Restored latest.");
		expect(host.querySelector(".files-text")?.textContent).toBe("older");
		expect(host.querySelector(".files-link-target")).toBeNull();
	});

	it("says why a restore was not saved, sends a lost one again as the same change set, and leaves a folder alone", async () => {
		const { fake, host } = await opened();
		await click(row(host, "readme.txt"));
		await click(action(host, "History"));
		const unit: CloudMemberFolderUnit = {
			op: "write",
			path: "readme.txt",
			file: file("older"),
			expectedVersion: id(101),
		};
		fake.client.commit.mockResolvedValueOnce(answer(unit, "conflict", "version_changed"));
		await click(restoreButtons(host)[1]);
		await settle();
		expect(status(host)).toBe("readme.txt changed in the meantime, so it was not restored.");
		// The history is read again, to restore from what is there now.
		expect(fake.client.pathHistory).toHaveBeenCalledTimes(2);
		expect(host.querySelector(".folder-history")).not.toBeNull();
		fake.client.commit.mockResolvedValueOnce(answer(unit, "denied", "access_denied"));
		await click(restoreButtons(host)[1]);
		await settle();
		expect(status(host)).toBe("You may not change readme.txt.");
		fake.client.commit.mockResolvedValueOnce(
			answer(unit, "refused", "invalid", [{ line: 2, key: "name", code: "required", message: "name is required" }]),
		);
		await click(restoreButtons(host)[1]);
		await settle();
		expect(status(host)).toBe("readme.txt could not be restored: name is required.");
		expect(fake.contents.get("readme.txt")).toBe("Hello.");
		fake.client.commit.mockRejectedValueOnce(new Error("The answer was lost"));
		await click(restoreButtons(host)[1]);
		await settle();
		expect(retries(host)).toBe("readme.txt could not be restored just now.Try again");
		await click(host.querySelector(".files-retries button"));
		await settle();
		const [lost, again] = fake.client.commit.mock.calls.slice(-2);
		expect(again?.[0]).toBe(lost?.[0]);
		expect(again?.[1]).toEqual(lost?.[1]);
		expect(again?.[1]).toEqual([unit]);
		expect(status(host)).toBe("Restored readme.txt.");
		expect(retries(host)).toBe("");
		expect(host.querySelector(".files-text")?.textContent).toBe("older");
		// A folder at the path now is never replaced: nothing is sent.
		await click(action(host, "History"));
		fake.contents.delete("readme.txt");
		fake.folders.add("readme.txt");
		const sent = fake.client.commit.mock.calls.length;
		await click(restoreButtons(host)[2]);
		await settle();
		expect(status(host)).toBe("readme.txt is a folder now, so this version can't be restored.");
		expect(fake.client.commit).toHaveBeenCalledTimes(sent);
	});

	it("keeps a lost restore's Try again through the hint and the poll, and sends it again from Restore too", async () => {
		vi.useFakeTimers();
		const { fake, src, host } = await opened();
		await click(row(host, "readme.txt"));
		await click(action(host, "History"));
		// The core saves the restore, and its answer is lost on the way back.
		const save = fake.client.commit.getMockImplementation()!;
		fake.client.commit.mockImplementationOnce(async (...args) => {
			await save(...args);
			throw new Error("The answer was lost");
		});
		await click(restoreButtons(host)[1]);
		await settle();
		expect(fake.contents.get("readme.txt")).toBe("older");
		const lost = "readme.txt could not be restored just now.Try again";
		expect(retries(host)).toBe(lost);
		// The restore's own hint, and the slow poll after it, each sync and say nothing; the Try again stays.
		fake.bump(5);
		fake.changes.push({
			asOfSeq: 5,
			resync: false,
			events: [
				{
					kind: "change_set",
					seq: 5,
					commitId: id(301),
					at,
					by: { kind: "member", userId: me },
					changes: [
						{
							unitNo: 1,
							op: "write",
							kind: "file",
							path: "readme.txt",
							version: id(108),
							priorVersion: id(101),
							updatedAt: at,
							file: file("older"),
							target: null,
						},
					],
				},
			],
			next: { afterSeq: 5, cursor: null },
			more: false,
		});
		src.hint(5);
		await vi.advanceTimersByTimeAsync(1100);
		await settle();
		expect(fake.client.changes).toHaveBeenCalledTimes(1);
		expect(host.querySelector(".files-text")?.textContent).toBe("older");
		expect(status(host)).toBe("");
		expect(retries(host)).toBe(lost);
		await vi.advanceTimersByTimeAsync(61_000);
		await settle();
		expect(fake.client.changes).toHaveBeenCalledTimes(2);
		expect(retries(host)).toBe(lost);
		// Restore on the same version sends the lost change set again, which the core answers once.
		await click(action(host, "History"));
		await click(restoreButtons(host)[1]);
		await settle();
		const [first, again] = fake.client.commit.mock.calls;
		expect(fake.client.commit).toHaveBeenCalledTimes(2);
		expect(again?.[0]).toBe(first?.[0]);
		expect(again?.[1]).toEqual(first?.[1]);
		expect(status(host)).toBe("Restored readme.txt.");
		expect(retries(host)).toBe("");
	});

	it("follows the hint from the feed: redraws the folder it touched and the open file", async () => {
		vi.useFakeTimers();
		const { fake, src, host } = await opened();
		await click(row(host, "readme.txt"));
		fake.contents.set("readme.txt", "Hello again.");
		fake.contents.set("new.txt", "New.");
		fake.bump(5);
		fake.changes.push({
			asOfSeq: 5,
			resync: false,
			events: [
				{
					kind: "change_set",
					seq: 5,
					commitId: id(300),
					at,
					by: { kind: "agent", staffAgentId: agent },
					changes: [
						{
							unitNo: 1,
							op: "write",
							kind: "file",
							path: "readme.txt",
							version: id(105),
							priorVersion: null,
							updatedAt: at,
							file: file("Hello again."),
							target: null,
						},
						{
							unitNo: 2,
							op: "write",
							kind: "file",
							path: "new.txt",
							version: id(106),
							priorVersion: null,
							updatedAt: at,
							file: file("New."),
							target: null,
						},
					],
				},
			],
			next: { afterSeq: 5, cursor: null },
			more: false,
		});
		const listsBefore = fake.client.list.mock.calls.length;
		src.hint(5);
		src.hint(5);
		await vi.advanceTimersByTimeAsync(1100);
		await settle();
		expect(fake.client.changes).toHaveBeenCalledTimes(1);
		expect(fake.client.changes).toHaveBeenCalledWith({ afterSeq: 4, cursor: null }, 200, expect.any(AbortSignal));
		expect(fake.client.list.mock.calls.length).toBe(listsBefore + 1);
		expect(rows(host)).toContain("new.txt");
		expect(host.querySelector(".files-text")?.textContent).toBe("Hello again.");
		// The next sync starts where this one ended.
		src.hint(6);
		await vi.advanceTimersByTimeAsync(1100);
		expect(fake.client.changes).toHaveBeenLastCalledWith({ afterSeq: 5, cursor: null }, 200, expect.any(AbortSignal));
	});

	it("reads the folder again after an authority change or a feed that can't be continued", async () => {
		vi.useFakeTimers();
		const { fake, src } = await opened();
		fake.changes.push({
			asOfSeq: 5,
			resync: false,
			events: [{ kind: "authority", seq: 5 }],
			next: { afterSeq: 5, cursor: null },
			more: false,
		});
		const before = fake.client.list.mock.calls.length;
		src.hint(5);
		await vi.advanceTimersByTimeAsync(1100);
		await settle();
		expect(fake.client.list.mock.calls.length).toBe(before + 1);
		fake.changes.push({ asOfSeq: 5, resync: true, events: [], next: null, more: false });
		src.hint(5);
		await vi.advanceTimersByTimeAsync(1100);
		await settle();
		expect(fake.client.list.mock.calls.length).toBe(before + 2);
	});

	it("offers no download over 8 MiB, and says why", async () => {
		const { fake, host } = await opened();
		const huge = { ...entry("huge.zip", "x"), file: { ...file("x"), bytes: 9 * 1024 * 1024 } };
		fake.client.list.mockResolvedValueOnce({ asOfSeq: 4, entries: [huge], next: null });
		await click(row(host, "big"));
		await click(row(host, "huge.zip"));
		const actions = visibleText(host.querySelector(".files-preview-actions"));
		expect(actions).not.toContain("Download");
		expect(actions).toContain("too large to download here");
		expect(fake.client.readFile).not.toHaveBeenCalled();
	});

	it("follows again after a reset whose reload failed", async () => {
		vi.useFakeTimers();
		const { fake, src, host } = await opened();
		fake.changes.push({ asOfSeq: 5, resync: true, events: [], next: null, more: false });
		fake.client.list.mockRejectedValueOnce(new Error("offline"));
		src.hint(5);
		await vi.advanceTimersByTimeAsync(1100);
		await settle();
		expect(visibleText(host.querySelector(".files-status"))).toContain("could not be read just now");
		const lists = fake.client.list.mock.calls.length;
		src.hint(6);
		await vi.advanceTimersByTimeAsync(1100);
		await settle();
		expect(fake.client.list.mock.calls.length).toBe(lists + 1);
		expect(visibleText(host.querySelector(".files-status"))).toBe("");
	});

	it("goes to the nearest folder still there when the open one is deleted", async () => {
		vi.useFakeTimers();
		const { fake, src, host } = await opened();
		await click(row(host, "notes"));
		fake.folders.delete("notes");
		fake.contents.delete("notes/log.txt");
		fake.contents.delete("notes/plan.md");
		fake.changes.push({
			asOfSeq: 5,
			resync: false,
			events: [
				{
					kind: "change_set",
					seq: 5,
					commitId: id(301),
					at,
					by: { kind: "member", userId: other },
					changes: [
						{
							unitNo: 1,
							op: "delete",
							kind: "file",
							path: "notes/log.txt",
							version: id(107),
							priorVersion: null,
							updatedAt: null,
							file: null,
							target: null,
						},
					],
				},
			],
			next: { afterSeq: 5, cursor: null },
			more: false,
		});
		src.hint(5);
		await vi.advanceTimersByTimeAsync(1100);
		await settle();
		expect(rows(host)).toEqual(["big", "logo.png", "readme.txt"]);
	});

	it("reads the folder again rather than follow more than five pages", async () => {
		vi.useFakeTimers();
		const { fake, src } = await opened();
		for (let page = 0; page < 6; page++)
			fake.changes.push({
				asOfSeq: 20,
				resync: false,
				events: [],
				next: { afterSeq: 5 + page, cursor: null },
				more: true,
			});
		const lists = fake.client.list.mock.calls.length;
		src.hint(20);
		await vi.advanceTimersByTimeAsync(1100);
		await settle();
		expect(fake.client.changes).toHaveBeenCalledTimes(5);
		expect(fake.client.list.mock.calls.length).toBe(lists + 1);
	});

	it("says so when the folder can't be read, and tries again", async () => {
		const { fake, host } = await opened();
		fake.client.list.mockRejectedValueOnce(new Error("offline"));
		await click(row(host, "notes"));
		expect(visibleText(host.querySelector(".files-status"))).toContain("could not be read just now");
		await click(host.querySelector(".files-status button"));
		expect(visibleText(host.querySelector(".files-status"))).toBe("");
	});
});

describe("the Company File page", () => {
	it("offers to try again when the folder can't be opened, and opens it then", async () => {
		const fake = folderFake();
		fake.client.list.mockRejectedValueOnce(new Error("offline"));
		vi.spyOn(WebCompanyFiles.prototype, "folder").mockReturnValue(fake.client as never);
		vi.spyOn(WebCompanyFiles.prototype, "folderHints").mockReturnValue({ close: async () => {} } as never);
		const f = fixture(),
			stop = new AbortController();
		const company = new WebCompanyFiles(f.cloud, profileA, me, team.role, stop.signal, () => {});
		const view = new LiveCompanyFileView(company, stop, "key", people);
		disposers.push(() => view.dispose());
		document.body.append(view.el);
		await settle();
		await settle();
		const retry = [...view.el.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("Retry opening Company File"),
		);
		expect(retry).toBeDefined();
		expect(view.el.classList.contains("folder-page")).toBe(false);
		expect(view.el.classList.contains("files-page")).toBe(false);
		retry!.click();
		await settle();
		await settle();
		expect(rows(view.el)).toEqual(["big", "notes", "logo.png", "readme.txt"]);
	});

	it("clears what it shows the moment its company ends, and reads nothing after", async () => {
		vi.useFakeTimers();
		const fake = folderFake();
		let hint: ((seq: number) => void) | undefined;
		const close = vi.fn(async () => {});
		vi.spyOn(WebCompanyFiles.prototype, "folder").mockReturnValue(fake.client as never);
		vi.spyOn(WebCompanyFiles.prototype, "folderHints").mockImplementation((onHint) => {
			hint = onHint;
			return { close } as never;
		});
		const f = fixture(),
			stop = new AbortController();
		const company = new WebCompanyFiles(f.cloud, profileA, me, team.role, stop.signal, () => {});
		const view = new LiveCompanyFileView(company, stop, "key", people);
		disposers.push(() => view.dispose());
		document.body.append(view.el);
		await settle();
		await settle();
		expect(rows(view.el)).toEqual(["big", "notes", "logo.png", "readme.txt"]);
		const lists = fake.client.list.mock.calls.length;
		stop.abort();
		expect(view.el.childElementCount).toBe(0);
		expect(view.el.isConnected).toBe(false);
		expect(view.el.classList.contains("folder-page")).toBe(false);
		expect(close).toHaveBeenCalledTimes(1);
		hint?.(9);
		await vi.advanceTimersByTimeAsync(120_000);
		await settle();
		expect(fake.client.list.mock.calls.length).toBe(lists);
		expect(fake.client.changes).not.toHaveBeenCalled();
	});

	it("is the company's folder, with no other File page to choose", async () => {
		const fake = folderFake();
		vi.spyOn(WebCompanyFiles.prototype, "folder").mockReturnValue(fake.client as never);
		vi.spyOn(WebCompanyFiles.prototype, "folderHints").mockReturnValue({ close: async () => {} } as never);
		const f = fixture(),
			stop = new AbortController();
		const company = new WebCompanyFiles(f.cloud, profileA, me, team.role, stop.signal, () => {});
		const view = new LiveCompanyFileView(company, stop, "key", people);
		disposers.push(() => view.dispose());
		document.body.append(view.el);
		await settle();
		await settle();
		expect(view.el.classList.contains("folder-page")).toBe(true);
		expect(rows(view.el)).toEqual(["big", "notes", "logo.png", "readme.txt"]);
	});
});
