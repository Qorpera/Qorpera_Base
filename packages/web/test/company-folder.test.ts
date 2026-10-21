// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import type {
	CloudMemberFolderChangesPage,
	CloudMemberFolderCommit,
	CloudMemberFolderEntry,
	CloudMemberFolderFile,
	CloudMemberFolderHistory,
	CloudMemberFolderListPage,
	CloudMemberFolderOutcome,
	CloudMemberFolderPathHistory,
	CloudMemberFolderProblem,
	CloudMemberFolderUnit,
} from "@qorpera/cloud-client/cloud-member-folder";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CompanyFolderBrowser,
	type CompanyFolderBrowserOptions,
	type CompanyFolderSource,
} from "../src/app/views/company-folder.ts";
import { LiveCompanyFileView } from "../src/app/views/live-company-file.ts";
import { WebCompanyFiles } from "../src/cloud/company-files.ts";
import { setTimeZonePreference } from "../src/ui/preferences.ts";
import { deferred, fixture, id, profileA, settle, team, visibleText } from "./fixtures.ts";

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
/** A Recents change set: one write, of `change-<seq>.txt` unless a path is given. */
function recentSet(seq: number, path = `change-${seq}.txt`) {
	return {
		seq,
		at,
		by: { kind: "member" as const, userId: me },
		paths: [{ path, op: "write" as const, kind: "file" as const, version: id(300 + seq) }],
		more: false,
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
		list: vi.fn(
			async (parent: string | null): Promise<CloudMemberFolderListPage> => ({
				asOfSeq,
				entries: listed(parent ?? ""),
				next: null,
			}),
		),
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

async function opened(options: CompanyFolderBrowserOptions = {}) {
	const fake = folderFake(),
		src = source(fake),
		host = document.createElement("section");
	document.body.append(host);
	const browser = new CompanyFolderBrowser(host, src.value, people, options);
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
/** The frame document's word that it is ready (public/page-preview/index.html), from that frame's window. */
function ready(frame: HTMLIFrameElement) {
	const event = new MessageEvent("message", { data: { type: "qorpera-page-ready" } });
	Object.defineProperty(event, "source", { value: frame.contentWindow });
	window.dispatchEvent(event);
}
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

	it("embeds without a second header, searches from Settings, and switches between icon and detailed list views", async () => {
		const search = document.createElement("input");
		document.body.append(search);
		const { host, fake } = await opened({ embedded: true, search });
		expect(host.querySelector(".files-head")).toBeNull();
		expect(host.querySelector("input")).toBeNull();
		expect(search.parentElement).toBe(document.body);
		expect(host.querySelector(".storage-title")?.textContent).toBe("Documents");
		expect(host.querySelector(".files-list")?.classList.contains("is-grid")).toBe(true);
		expect(host.querySelector('[aria-label="Icon view"]')?.getAttribute("aria-pressed")).toBe("true");
		search.value = "READ";
		search.dispatchEvent(new Event("input"));
		expect(rows(host)).toEqual(["readme.txt"]);
		await click(host.querySelector('[aria-label="List view"]'));
		expect(host.querySelector(".files-list")?.classList.contains("is-list")).toBe(true);
		expect(host.querySelector<HTMLElement>(".storage-columns")?.hidden).toBe(false);
		expect(row(host, "readme.txt")?.querySelector("time")?.getAttribute("datetime")).toBe(at);
		expect(row(host, "readme.txt")?.querySelector(".files-size")?.textContent).toBe("6 B");
		expect(row(host, "readme.txt")?.querySelector(".storage-kind-label")?.textContent).toBe("Text document");
		expect(fake.client.list).toHaveBeenCalledTimes(1);
		search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(search.value).toBe("");
		expect(rows(host)).toEqual(["big", "notes", "logo.png", "readme.txt"]);
	});

	it("combines file type and name filters, then sorts real metadata without extra reads", async () => {
		const search = document.createElement("input");
		const { host, fake } = await opened({ embedded: true, search });
		const filter = host.querySelector<HTMLSelectElement>('[aria-label="File type"]')!;
		filter.value = "image";
		filter.dispatchEvent(new Event("change"));
		expect(rows(host)).toEqual(["logo.png"]);
		expect(row(host, "logo.png")?.querySelector(".files-kind")?.classList.contains("is-image")).toBe(true);
		search.value = "readme";
		search.dispatchEvent(new Event("input"));
		expect(rows(host)).toEqual([]);
		search.value = "";
		search.dispatchEvent(new Event("input"));
		expect(rows(host)).toEqual(["logo.png"]);
		filter.value = "pdf";
		filter.dispatchEvent(new Event("change"));
		expect(visibleText(host.querySelector(".files-empty"))).toBe("No files of this type in this folder.");
		filter.value = "all";
		filter.dispatchEvent(new Event("change"));
		const sort = host.querySelector<HTMLSelectElement>('[aria-label="Sort files"]')!;
		sort.value = "size";
		sort.dispatchEvent(new Event("change"));
		expect(rows(host)).toEqual(["big", "notes", "readme.txt", "logo.png"]);
		expect(fake.client.list).toHaveBeenCalledTimes(1);
		expect(fake.client.read).not.toHaveBeenCalled();
		expect(fake.client.readFile).not.toHaveBeenCalled();
	});

	it("sorts loaded pages by their modification timestamps and makes partial counts explicit", async () => {
		const { host, fake } = await opened({ embedded: true });
		fake.client.list.mockResolvedValueOnce({
			asOfSeq: 4,
			entries: [
				{ ...entry("big/older.txt", "old"), updatedAt: "2026-10-02T10:00:00Z" },
				{ ...entry("big/newer.txt", "new"), updatedAt: "2026-10-03T10:00:00Z" },
			],
			next: "big/older.txt",
		});
		await click(row(host, "big"));
		expect(host.querySelector(".storage-count")?.textContent).toBe("2 of 2 loaded items");
		const sort = host.querySelector<HTMLSelectElement>('[aria-label="Sort files"]')!;
		sort.value = "modified";
		sort.dispatchEvent(new Event("change"));
		expect(rows(host)).toEqual(["newer.txt", "older.txt"]);
		fake.client.list.mockResolvedValueOnce({
			asOfSeq: 4,
			entries: [{ ...entry("big/newest.txt", "newest"), updatedAt: "2026-10-04T10:00:00Z" }],
			next: null,
		});
		await click(host.querySelector(".files-list-more button"));
		expect(fake.client.list).toHaveBeenLastCalledWith("big", "big/older.txt", 200, expect.any(AbortSignal));
		expect(rows(host)).toEqual(["newest.txt", "newer.txt", "older.txt"]);
		expect(host.querySelector(".storage-count")?.textContent).toBe("3 items");
	});

	it("shows searchable Recents from the company change feed, opens a file, and returns to Documents", async () => {
		const search = document.createElement("input");
		const onSectionChange = vi.fn();
		const { host, browser, fake } = await opened({ embedded: true, search, onSectionChange });
		browser.showRecents();
		await settle();
		expect(fake.client.history).toHaveBeenCalledWith(null, 20, expect.any(AbortSignal));
		expect(onSectionChange).toHaveBeenLastCalledWith("recents");
		expect(host.querySelector<HTMLElement>(".storage-documents")?.hidden).toBe(true);
		expect(host.querySelector<HTMLElement>(".storage-recents")?.hidden).toBe(false);
		expect(host.classList.contains("has-preview")).toBe(false);
		search.value = "log";
		search.dispatchEvent(new Event("input"));
		expect(
			[...host.querySelectorAll(".storage-recents button.folder-history-path")].map((item) => item.textContent),
		).toEqual(["notes/log.txt"]);
		await click(host.querySelector(".storage-recents button.folder-history-path"));
		expect(onSectionChange).toHaveBeenLastCalledWith("documents");
		expect(host.querySelector<HTMLElement>(".storage-recents")?.hidden).toBe(true);
		expect(host.querySelector(".files-text")?.textContent).toBe("line one");
		expect(search.value).toBe("");
		browser.showDocuments();
		await settle();
		expect(rows(host)).toEqual(["big", "notes", "logo.png", "readme.txt"]);
		expect(host.classList.contains("has-preview")).toBe(false);
	});

	it("detaches the shared search field and stops Recents reads when disposed", async () => {
		const search = document.createElement("input");
		const { host, browser, fake } = await opened({ embedded: true, search });
		browser.dispose();
		search.value = "nothing";
		search.dispatchEvent(new Event("input"));
		expect(rows(host)).toEqual(["big", "notes", "logo.png", "readme.txt"]);
		search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(search.value).toBe("nothing");
		browser.showRecents();
		browser.showDocuments();
		await settle();
		expect(fake.client.history).not.toHaveBeenCalled();
		expect(fake.client.list).toHaveBeenCalledTimes(1);
	});

	it("paginates Recents and ignores an in-flight answer after disposal", async () => {
		const { host, browser, fake } = await opened({ embedded: true });
		fake.client.history.mockResolvedValueOnce({ asOfSeq: 4, items: [], next: 3 });
		browser.showRecents();
		await settle();
		const release = deferred<CloudMemberFolderHistory>();
		fake.client.history.mockReturnValueOnce(release.promise);
		await click(host.querySelector(".storage-recents button"));
		expect(fake.client.history).toHaveBeenLastCalledWith(3, 20, expect.any(AbortSignal));
		const before = host.innerHTML;
		browser.dispose();
		release.resolve({
			asOfSeq: 4,
			items: [
				{
					seq: 2,
					at,
					by: { kind: "platform" },
					more: false,
					paths: [{ path: "late.txt", kind: "file", op: "write", version: id(2) }],
				},
			],
			next: null,
		});
		await settle();
		expect(host.innerHTML).toBe(before);
	});

	it("honors a section requested before opening and the latest navigation while a read is in flight", async () => {
		const fake = folderFake();
		const src = source(fake);
		const host = document.createElement("section");
		document.body.append(host);
		const onSectionChange = vi.fn();
		const browser = new CompanyFolderBrowser(host, src.value, people, { embedded: true, onSectionChange });
		disposers.push(() => browser.dispose());
		const listing = deferred<CloudMemberFolderListPage>();
		const history = deferred<CloudMemberFolderHistory>();
		fake.client.list.mockReturnValueOnce(listing.promise);
		fake.client.history.mockReturnValueOnce(history.promise);
		browser.showRecents();
		expect(fake.client.history).not.toHaveBeenCalled();
		const opening = browser.open();
		listing.resolve({ asOfSeq: 4, entries: [entry("notes")], next: null });
		await opening;
		await settle();
		expect(onSectionChange).toHaveBeenLastCalledWith("recents");
		browser.showDocuments();
		history.resolve({ asOfSeq: 4, items: [], next: null });
		await settle();
		await settle();
		expect(onSectionChange).toHaveBeenLastCalledWith("documents");
		expect(host.querySelector<HTMLElement>(".storage-recents")?.hidden).toBe(true);
		expect(rows(host)).toEqual(["big", "notes", "logo.png", "readme.txt"]);
	});

	it("keeps the older Recents pages already shown when a background sync reads the newest page again", async () => {
		vi.useFakeTimers();
		const set = recentSet;
		const { fake, src, host, browser } = await opened({ embedded: true });
		const shown = () =>
			[...host.querySelectorAll(".storage-recents button.folder-history-path")].map((path) => path.textContent);
		const older = () =>
			[...host.querySelectorAll<HTMLButtonElement>(".storage-recents button")].find(
				(button) => button.textContent === "Show older",
			);
		fake.client.history.mockResolvedValueOnce({ asOfSeq: 6, items: [set(6), set(5)], next: 5 });
		browser.showRecents();
		await settle();
		fake.client.history.mockResolvedValueOnce({ asOfSeq: 6, items: [set(4), set(3)], next: null });
		await click(older());
		expect(fake.client.history).toHaveBeenLastCalledWith(5, 20, expect.any(AbortSignal));
		expect(shown()).toEqual(["change-6.txt", "change-5.txt", "change-4.txt", "change-3.txt"]);
		expect(older()).toBeUndefined();
		// A new change lands: the sync reads the newest page again, which overlaps what is shown and has more below it.
		fake.client.history.mockResolvedValueOnce({ asOfSeq: 7, items: [set(7), set(6)], next: 6 });
		src.hint(7);
		await vi.advanceTimersByTimeAsync(1100);
		await settle();
		expect(fake.client.history).toHaveBeenLastCalledWith(null, 20, expect.any(AbortSignal));
		expect(shown()).toEqual(["change-7.txt", "change-6.txt", "change-5.txt", "change-4.txt", "change-3.txt"]);
		expect(older()).toBeUndefined();
		// The minute poll with nothing new keeps them too.
		fake.client.history.mockResolvedValueOnce({ asOfSeq: 7, items: [set(7), set(6)], next: 6 });
		await vi.advanceTimersByTimeAsync(61_000);
		await settle();
		expect(shown()).toEqual(["change-7.txt", "change-6.txt", "change-5.txt", "change-4.txt", "change-3.txt"]);
	});

	it("drops older Recents pages after an access change or a feed reset instead of showing them unchecked", async () => {
		vi.useFakeTimers();
		const { fake, src, host, browser } = await opened({ embedded: true });
		const shown = () =>
			[...host.querySelectorAll(".storage-recents button.folder-history-path")].map((path) => path.textContent);
		const older = () =>
			[...host.querySelectorAll<HTMLButtonElement>(".storage-recents button")].find(
				(button) => button.textContent === "Show older",
			);
		const showOlderPage = async () => {
			fake.client.history.mockResolvedValueOnce({ asOfSeq: 6, items: [recentSet(6), recentSet(5)], next: 5 });
			browser.showDocuments();
			await settle();
			browser.showRecents();
			await settle();
			fake.client.history.mockResolvedValueOnce({
				asOfSeq: 6,
				items: [recentSet(4, "secret/plan.md"), recentSet(3)],
				next: null,
			});
			await click(older());
			expect(shown()).toEqual(["change-6.txt", "change-5.txt", "secret/plan.md", "change-3.txt"]);
		};
		await showOlderPage();
		// Access to secret/ is taken away: the authority event reads Recents from its newest page again.
		fake.bump(7);
		fake.changes.push({
			asOfSeq: 7,
			resync: false,
			events: [{ kind: "authority", seq: 7 }],
			next: { afterSeq: 7, cursor: null },
			more: false,
		});
		fake.client.history.mockResolvedValueOnce({ asOfSeq: 7, items: [recentSet(7), recentSet(6)], next: 6 });
		src.hint(7);
		await vi.advanceTimersByTimeAsync(1100);
		await settle();
		expect(shown()).toEqual(["change-7.txt", "change-6.txt"]);
		expect(older()).toBeDefined();
		// A feed reset forgets them the same way.
		await showOlderPage();
		fake.bump(8);
		fake.changes.push({ asOfSeq: 8, resync: true, events: [], next: null, more: false });
		fake.client.history.mockResolvedValueOnce({ asOfSeq: 8, items: [recentSet(8), recentSet(6)], next: 6 });
		src.hint(8);
		await vi.advanceTimersByTimeAsync(1100);
		await settle();
		expect(shown()).toEqual(["change-8.txt", "change-6.txt"]);
		expect(older()).toBeDefined();
	});

	it("clears Recents at an access change even when the reads after it fail, and the next poll shows the newest page", async () => {
		vi.useFakeTimers();
		const { fake, src, host, browser } = await opened({ embedded: true });
		const shown = () =>
			[...host.querySelectorAll(".storage-recents button.folder-history-path")].map((path) => path.textContent);
		const older = () =>
			[...host.querySelectorAll<HTMLButtonElement>(".storage-recents button")].find(
				(button) => button.textContent === "Show older",
			);
		const authorityChange = (seq: number) => {
			fake.bump(seq);
			fake.changes.push({
				asOfSeq: seq,
				resync: false,
				events: [{ kind: "authority", seq }],
				next: { afterSeq: seq, cursor: null },
				more: false,
			});
		};
		fake.client.history.mockResolvedValueOnce({ asOfSeq: 6, items: [recentSet(6), recentSet(5)], next: 5 });
		browser.showRecents();
		await settle();
		fake.client.history.mockResolvedValueOnce({
			asOfSeq: 6,
			items: [recentSet(4, "secret/plan.md"), recentSet(3)],
			next: null,
		});
		await click(older());
		expect(shown()).toContain("secret/plan.md");
		// The folder read after the access change fails: the old rows are gone all the same.
		authorityChange(7);
		fake.client.list.mockRejectedValueOnce(new Error("offline"));
		src.hint(7);
		await vi.advanceTimersByTimeAsync(1100);
		await settle();
		expect(status(host)).toContain("could not be read just now");
		expect(shown()).toEqual([]);
		expect(host.querySelector(".storage-recents")?.textContent).not.toContain("secret/plan.md");
		// The next poll reads Recents' newest page only; nothing from before comes back.
		fake.client.history.mockResolvedValueOnce({ asOfSeq: 7, items: [recentSet(7), recentSet(6)], next: 6 });
		await vi.advanceTimersByTimeAsync(61_000);
		await settle();
		expect(fake.client.history).toHaveBeenLastCalledWith(null, 20, expect.any(AbortSignal));
		expect(shown()).toEqual(["change-7.txt", "change-6.txt"]);
		fake.client.history.mockResolvedValueOnce({
			asOfSeq: 7,
			items: [recentSet(4, "secret/plan.md"), recentSet(3)],
			next: null,
		});
		await click(older());
		expect(shown()).toContain("secret/plan.md");
		// Now the Recents read after the access change fails: its rows are gone too.
		authorityChange(8);
		fake.client.history.mockRejectedValueOnce(new Error("offline"));
		src.hint(8);
		await vi.advanceTimersByTimeAsync(1100);
		await settle();
		expect(status(host)).toContain("could not be read just now");
		expect(shown()).toEqual([]);
		expect(host.querySelector(".storage-recents")?.textContent).not.toContain("secret/plan.md");
		fake.client.history.mockResolvedValueOnce({ asOfSeq: 8, items: [recentSet(8), recentSet(7)], next: 7 });
		await vi.advanceTimersByTimeAsync(61_000);
		await settle();
		expect(fake.client.history).toHaveBeenLastCalledWith(null, 20, expect.any(AbortSignal));
		expect(shown()).toEqual(["change-8.txt", "change-7.txt"]);
		expect(older()).toBeDefined();
	});

	it("forgets older Recents when a folder listing moves past feed changes it never read", async () => {
		vi.useFakeTimers();
		const { fake, src, host, browser } = await opened({ embedded: true });
		const shown = () =>
			[...host.querySelectorAll(".storage-recents button.folder-history-path")].map((path) => path.textContent);
		const older = () =>
			[...host.querySelectorAll<HTMLButtonElement>(".storage-recents button")].find(
				(button) => button.textContent === "Show older",
			);
		fake.client.history.mockResolvedValueOnce({ asOfSeq: 4, items: [recentSet(4), recentSet(3)], next: 3 });
		browser.showRecents();
		await settle();
		fake.client.history.mockResolvedValueOnce({
			asOfSeq: 4,
			items: [recentSet(2, "secret/plan.md"), recentSet(1)],
			next: null,
		});
		await click(older());
		expect(shown()).toContain("secret/plan.md");
		// An ordinary change at 5 in the open folder makes the sync list it again; access to secret/ goes at 6, before
		// the listing answers, so the listing is as of 6 and the feed's authority event at 6 is never read.
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
					by: { kind: "member", userId: other },
					changes: [
						{
							unitNo: 1,
							op: "write",
							kind: "file",
							path: "new.txt",
							version: id(105),
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
		const listing = deferred<CloudMemberFolderListPage>();
		fake.client.list.mockReturnValueOnce(listing.promise);
		fake.client.history.mockResolvedValueOnce({
			asOfSeq: 6,
			items: [recentSet(5, "new.txt"), recentSet(4)],
			next: 4,
		});
		src.hint(5);
		await vi.advanceTimersByTimeAsync(1100);
		fake.bump(6);
		listing.resolve({ asOfSeq: 6, entries: [entry("new.txt", "New.")], next: null });
		await settle();
		expect(shown()).toEqual(["new.txt", "change-4.txt"]);
		expect(host.querySelector(".storage-recents")?.textContent).not.toContain("secret/plan.md");
		expect(older()).toBeDefined();
		// Later polls follow the feed from 6; the forgotten rows do not come back.
		fake.client.history.mockResolvedValueOnce({
			asOfSeq: 6,
			items: [recentSet(5, "new.txt"), recentSet(4)],
			next: 4,
		});
		await vi.advanceTimersByTimeAsync(61_000);
		await settle();
		expect(shown()).toEqual(["new.txt", "change-4.txt"]);
	});

	it("reads through every change that arrived between two refreshes before joining the older Recents pages", async () => {
		vi.useFakeTimers();
		const { fake, src, host, browser } = await opened({ embedded: true });
		const seqs = () =>
			[...host.querySelectorAll(".storage-recents button.folder-history-path")].map((path) =>
				Number(path.textContent?.match(/\d+/)?.[0]),
			);
		const older = () =>
			[...host.querySelectorAll<HTMLButtonElement>(".storage-recents button")].find(
				(button) => button.textContent === "Show older",
			);
		const page = (from: number, to: number, next: number | null) => ({
			asOfSeq: from,
			items: Array.from({ length: from - to + 1 }, (_, index) => recentSet(from - index)),
			next,
		});
		const descending = (from: number, to: number) =>
			Array.from({ length: from - to + 1 }, (_, index) => from - index);
		fake.client.history.mockResolvedValueOnce(page(40, 21, 21));
		browser.showRecents();
		await settle();
		fake.client.history.mockResolvedValueOnce(page(20, 1, null));
		await click(older());
		expect(seqs()).toEqual(descending(40, 1));
		// 25 changes arrive: the newest page alone (65-46) would leave 45-41 out.
		fake.client.history.mockResolvedValueOnce(page(65, 46, 46)).mockResolvedValueOnce(page(45, 26, 26));
		src.hint(65);
		await vi.advanceTimersByTimeAsync(1100);
		await settle();
		expect(fake.client.history).toHaveBeenLastCalledWith(46, 20, expect.any(AbortSignal));
		expect(seqs()).toEqual(descending(65, 1));
		expect(older()).toBeUndefined();
		// Far behind: after five pages that never reach what is shown, only those pages show, and "Show older" goes on.
		for (let from = 200; from > 100; from -= 20)
			fake.client.history.mockResolvedValueOnce(page(from, from - 19, from - 19));
		src.hint(200);
		await vi.advanceTimersByTimeAsync(1100);
		await settle();
		expect(seqs()).toEqual(descending(200, 101));
		expect(older()).toBeDefined();
		fake.client.history.mockResolvedValueOnce(page(100, 81, 81));
		await click(older());
		expect(fake.client.history).toHaveBeenLastCalledWith(101, 20, expect.any(AbortSignal));
		expect(seqs()).toEqual(descending(200, 81));
	});

	it("names yesterday by the calendar, also on the night the clocks change", async () => {
		// 00:30 on 30 March 2026 in Copenhagen, the first night of summer time: 24 hours earlier is still 28 March.
		vi.useFakeTimers({ now: new Date("2026-03-29T22:30:00Z") });
		expect(setTimeZonePreference("Europe/Copenhagen")).toBe(true);
		try {
			const fake = folderFake();
			const dated = (path: string, updatedAt: string) => ({ ...entry(path, "text"), updatedAt });
			fake.client.list.mockResolvedValueOnce({
				asOfSeq: 4,
				entries: [dated("saturday.txt", "2026-03-28T12:00:00Z"), dated("sunday.txt", "2026-03-29T12:00:00Z")],
				next: null,
			});
			fake.client.history.mockResolvedValueOnce({
				asOfSeq: 4,
				items: [
					{ ...recentSet(2), at: "2026-03-29T12:00:00Z" },
					{ ...recentSet(1), at: "2026-03-28T12:00:00Z" },
				],
				next: null,
			});
			const src = source(fake),
				host = document.createElement("section");
			document.body.append(host);
			const browser = new CompanyFolderBrowser(host, src.value, people, { embedded: true });
			disposers.push(() => browser.dispose());
			await browser.open();
			await settle();
			const modified = (name: string) => row(host, name)?.querySelector("time")?.textContent?.replace(/\s/g, " ");
			expect(modified("sunday.txt")).toBe("Yesterday 02:00 PM");
			expect(modified("saturday.txt")).toBe("Mar 28, 01:00 PM");
			browser.showRecents();
			await settle();
			expect([...host.querySelectorAll(".storage-recent-day")].map((day) => day.textContent)).toEqual([
				"Yesterday",
				"Saturday, March 28, 2026",
			]);
		} finally {
			setTimeZonePreference("system");
		}
	});

	it("draws dates again in the time zone chosen since, without reading the folder again", async () => {
		expect(setTimeZonePreference("UTC")).toBe(true);
		try {
			const { fake, host, browser } = await opened({ embedded: true });
			const modified = () =>
				[...host.querySelectorAll<HTMLElement>(".files-row-main")]
					.find((button) => button.querySelector(".files-name")?.textContent === "readme.txt")
					?.querySelector("time")
					?.title.replace(/\s/g, " ");
			expect(modified()).toBe("Oct 3, 2026, 9:12 AM");
			expect(setTimeZonePreference("Pacific/Auckland")).toBe(true);
			browser.redraw();
			expect(modified()).toBe("Oct 3, 2026, 10:12 PM");
			expect(fake.client.list).toHaveBeenCalledOnce();
		} finally {
			setTimeZonePreference("system");
		}
	});

	it("retries a failed Recents read in the same section", async () => {
		const { host, browser, fake } = await opened({ embedded: true });
		fake.client.history.mockRejectedValueOnce(new Error("offline"));
		browser.showRecents();
		await settle();
		expect(host.querySelector<HTMLElement>(".storage-recents")?.hidden).toBe(false);
		expect(status(host)).toContain("could not be read just now");
		await click(host.querySelector(".files-status button"));
		expect(fake.client.history).toHaveBeenCalledTimes(2);
		expect(fake.client.list).toHaveBeenCalledTimes(1);
		expect(host.querySelectorAll(".storage-recents .folder-history-row")).toHaveLength(2);
	});

	it("keeps Documents selected after a failed return from Recents and retries the requested root folder", async () => {
		const onSectionChange = vi.fn();
		const { host, browser, fake } = await opened({ embedded: true, onSectionChange });
		await click(row(host, "notes"));
		browser.showRecents();
		await settle();
		fake.client.list.mockRejectedValueOnce(new Error("offline"));
		browser.showDocuments();
		await settle();
		expect(onSectionChange).toHaveBeenLastCalledWith("documents");
		expect(host.querySelector<HTMLElement>(".storage-documents")?.hidden).toBe(false);
		expect(host.querySelector<HTMLElement>(".storage-recents")?.hidden).toBe(true);
		expect(status(host)).toContain("could not be read just now");
		fake.client.list.mockRejectedValueOnce(new Error("still offline"));
		await click(host.querySelector(".files-status button"));
		expect(fake.client.list).toHaveBeenLastCalledWith(null, null, 200, expect.any(AbortSignal));
		await click(host.querySelector(".files-status button"));
		expect(fake.client.list).toHaveBeenLastCalledWith(null, null, 200, expect.any(AbortSignal));
		expect(fake.client.history).toHaveBeenCalledTimes(1);
		expect(rows(host)).toEqual(["big", "notes", "logo.png", "readme.txt"]);
		expect(host.querySelector(".storage-title")?.textContent).toBe("Documents");
		expect(status(host)).toBe("");
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

	it("shows an HTML page live in a locked-down frame, its source, and the page across the window", async () => {
		HTMLDialogElement.prototype.showModal = function () {
			this.open = true;
		};
		HTMLDialogElement.prototype.close = function () {
			this.open = false;
		};
		const html = "<h1>Sales</h1><script>1</script>";
		const { fake, host, browser } = await opened({ embedded: true });
		fake.folders.add("designs");
		fake.contents.set("designs/sales.html", html);
		browser.showDocuments();
		await settle();
		await click(row(host, "designs"));
		await click(row(host, "sales.html"));
		expect(host.querySelector(".files-preview-head h2")?.textContent).toBe("sales.html");
		const frame = host.querySelector<HTMLIFrameElement>(".files-preview iframe.files-page-frame")!;
		// Scripts run; no origin, no windows, forms, dialogs or moving the app's page; nothing in the frame's address.
		expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
		expect(frame.getAttribute("src")).toBe("./page-preview/");
		expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
		expect(frame.title).toBe("Page: sales.html");
		expect(frame.hidden).toBe(false);
		const views = [...host.querySelectorAll<HTMLButtonElement>(".files-page-toggle button")];
		expect(views.map((view) => [view.textContent, view.getAttribute("aria-pressed")])).toEqual([
			["Page", "true"],
			["Source", "false"],
		]);
		// The frame asks for its page once it is ready, and gets this one.
		const send = vi.spyOn(frame.contentWindow!, "postMessage");
		ready(frame);
		expect(send).toHaveBeenCalledExactlyOnceWith({ type: "qorpera-page", html }, "*");
		// Its source, and back to the same frame, which keeps the page's state.
		views[1]!.click();
		const source = host.querySelector<HTMLElement>(".files-page-source")!;
		expect(source.hidden).toBe(false);
		expect(source.textContent).toBe(html);
		expect(frame.hidden).toBe(true);
		expect(views.map((view) => view.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
		views[0]!.click();
		expect(host.querySelector(".files-page-frame")).toBe(frame);
		expect(frame.hidden).toBe(false);
		expect(source.hidden).toBe(true);
		// Across the window, in a dialog of its own with a frame of its own.
		await click(host.querySelector('.files-preview-head [aria-label="Show sales.html large"]'));
		const dialog = document.querySelector<HTMLDialogElement>("dialog.page-preview-dialog")!;
		expect(dialog.open).toBe(true);
		expect(dialog.querySelector("h2")?.textContent).toBe("sales.html");
		const large = dialog.querySelector<HTMLIFrameElement>("iframe.page-preview-frame")!;
		expect(large.getAttribute("sandbox")).toBe("allow-scripts");
		const sendLarge = vi.spyOn(large.contentWindow!, "postMessage");
		ready(large);
		expect(sendLarge).toHaveBeenCalledExactlyOnceWith({ type: "qorpera-page", html }, "*");
		dialog.querySelector<HTMLButtonElement>(".surface-close")!.click();
		expect(document.querySelector("dialog.page-preview-dialog")).toBeNull();
		// Another file shows as it did; the page's view starts as the page again for the next page.
		views[1]!.click();
		await click(row(host, "sales.html"));
		expect(host.querySelector<HTMLElement>(".files-page-source")?.hidden).toBe(false);
		fake.contents.set("designs/other.htm", "<p>Other</p>");
		await click(host.querySelector(".files-crumb"));
		await click(row(host, "designs"));
		await click(row(host, "other.htm"));
		expect(host.querySelector<HTMLIFrameElement>(".files-page-frame")?.hidden).toBe(false);
		await click(row(host, "sales.html"));
		expect(host.querySelector(".files-page-toggle [aria-pressed=true]")?.textContent).toBe("Page");
		expect(host.querySelector(".files-text.files-page-source")?.textContent).toBe(html);
		expect(host.querySelector('.files-preview-head [aria-label="Show sales.html large"]')).not.toBeNull();
		// A text file has no page view and nothing to show large.
		await click(host.querySelector(".files-crumb"));
		await click(row(host, "readme.txt"));
		expect(host.querySelector(".files-page-toggle")).toBeNull();
		expect(host.querySelector(".files-preview-head [aria-label^='Show']")).toBeNull();
		expect(host.querySelector(".files-text")?.textContent).toBe("Hello.");
	});

	it("shows a page it can't run live as its source, and says so", async () => {
		// The page written out again (XMLSerializer's doctype) parses as something unfit: it isn't run.
		const parse = DOMParser.prototype.parseFromString;
		vi.spyOn(DOMParser.prototype, "parseFromString").mockImplementation(function (this: DOMParser, text, type) {
			return Reflect.apply(parse, this, [
				text.startsWith("<!DOCTYPE html>") ? "<noscript></noscript>" : text,
				type,
			]) as Document;
		});
		const html = '<!doctype html><link rel="preconnect" href="https://x.example"><p>Hi</p>';
		const { fake, host, browser } = await opened({ embedded: true });
		fake.contents.set("hinted.html", html);
		browser.reveal("hinted.html");
		await settle();
		expect(host.querySelector(".files-preview-head h2")?.textContent).toBe("hinted.html");
		expect(visibleText(host.querySelector(".files-page-view .files-note"))).toBe(
			"This page can't be shown live, so its source is shown.",
		);
		expect(host.querySelector(".files-page-source")?.textContent).toBe(html);
		expect(host.querySelector(".files-preview iframe")).toBeNull();
		expect(host.querySelector(".files-page-toggle")).toBeNull();
		expect(host.querySelector(".files-preview-head [aria-label^='Show']")).toBeNull();
	});

	it("tells the platform's folders apart at the top, after the company's own work, each with its one line", async () => {
		const { fake, host, browser } = await opened({ embedded: true });
		for (const name of ["vision", "agents", "human-tasks", "code"]) fake.folders.add(name);
		fake.folders.add("notes/agents");
		browser.showDocuments();
		await settle();
		const items = () =>
			[...host.querySelectorAll<HTMLElement>(".files-list > li")].map((item) =>
				item.classList.contains("storage-group")
					? `# ${item.textContent}`
					: `${item.querySelector(".files-name")?.textContent}${item.querySelector(".storage-folder-note") ? ` — ${item.querySelector(".storage-folder-note")?.textContent}` : ""}`,
			);
		expect(items()).toEqual([
			"big",
			"notes",
			"logo.png",
			"readme.txt",
			"# Qorpera folders",
			"agents — The team: each agent's settings, memory, skills, routines and tasks.",
			"code — Code projects (git repositories).",
			"human-tasks — Jobs agents have handed to people.",
			"vision — What the company is and where it is going. Every agent reads it.",
		]);
		expect(host.querySelector(".storage-group")?.getAttribute("role")).toBe("presentation");
		expect(host.querySelector<HTMLElement>(".storage-folder-note")?.title).toBe(
			"The team: each agent's settings, memory, skills, routines and tasks.",
		);
		expect(host.querySelector(".storage-count")?.textContent).toBe("8 items");
		// The list view keeps both the order and the lines.
		await click(host.querySelector('[aria-label="List view"]'));
		expect(items().at(4)).toBe("# Qorpera folders");
		expect(items().at(-1)).toBe("vision — What the company is and where it is going. Every agent reads it.");
		// Filters apply first: the heading shows only above a platform folder.
		const filter = host.querySelector<HTMLSelectElement>('[aria-label="File type"]')!;
		filter.value = "document";
		filter.dispatchEvent(new Event("change"));
		expect(host.querySelector(".storage-group")).toBeNull();
		filter.value = "folder";
		filter.dispatchEvent(new Event("change"));
		expect(items()).toEqual([
			"big",
			"notes",
			"# Qorpera folders",
			"agents — The team: each agent's settings, memory, skills, routines and tasks.",
			"code — Code projects (git repositories).",
			"human-tasks — Jobs agents have handed to people.",
			"vision — What the company is and where it is going. Every agent reads it.",
		]);
		// Only at the top: a folder of the same name further down is the company's own.
		filter.value = "all";
		filter.dispatchEvent(new Event("change"));
		await click(row(host, "notes"));
		expect(items()).toEqual(["agents", "log.txt", "plan.md"]);
		expect(host.querySelector(".storage-group")).toBeNull();
	});

	it("opens what a folder link names: a file in its folder with its preview, a folder, or says it isn't there", async () => {
		const { fake, host, browser } = await opened({ embedded: true });
		fake.folders.add("designs");
		fake.contents.set("designs/sales.html", "<p>Sales</p>");
		browser.reveal("designs/sales.html");
		await settle();
		expect(fake.client.read).toHaveBeenLastCalledWith("designs/sales.html", expect.any(AbortSignal));
		expect(host.querySelector(".storage-title")?.textContent).toBe("designs");
		expect(rows(host)).toEqual(["sales.html"]);
		expect(host.querySelector(".files-row.is-open .files-name")?.textContent).toBe("sales.html");
		expect(host.querySelector(".files-preview-head h2")?.textContent).toBe("sales.html");
		expect(host.querySelector<HTMLIFrameElement>(".files-page-frame")?.hidden).toBe(false);
		// A folder opens in the list.
		browser.reveal("notes");
		await settle();
		expect(host.querySelector(".storage-title")?.textContent).toBe("notes");
		expect(host.classList.contains("has-preview")).toBe(false);
		// From Recents too, back in Documents; a file at the top opens there.
		browser.showRecents();
		await settle();
		browser.reveal("readme.txt");
		await settle();
		expect(host.querySelector<HTMLElement>(".storage-recents")?.hidden).toBe(true);
		expect(host.querySelector(".storage-title")?.textContent).toBe("Documents");
		expect(host.querySelector(".files-text")?.textContent).toBe("Hello.");
		// Something that isn't there is said so, and nothing else changes.
		browser.reveal("designs/gone.html");
		await settle();
		expect(status(host)).toBe("gone.html could not be found in the Company File.");
		expect(host.classList.contains("has-preview")).toBe(false);
		expect(host.querySelector(".storage-title")?.textContent).toBe("Documents");
	});

	it("opens a folder link in a document it shows, here", async () => {
		const { fake, host } = await opened({ embedded: true });
		fake.contents.set(
			"notes/plan.md",
			"# Plan\n\nSee [the log](folder:notes/log.txt) and [nothing](folder:../log.txt).",
		);
		await click(row(host, "notes"));
		await click(row(host, "plan.md"));
		const links = [...host.querySelectorAll<HTMLButtonElement>(".files-doc .folder-link")];
		expect(links.map((link) => link.dataset.folderPath)).toEqual(["notes/log.txt"]);
		const outside = vi.fn();
		document.body.addEventListener("click", outside);
		await click(links[0]);
		expect(host.querySelector(".files-preview-head h2")?.textContent).toBe("log.txt");
		expect(host.querySelector(".files-text")?.textContent).toBe("line one");
		// The click was answered here: an app listening above sees it as handled.
		expect(outside.mock.calls[0]?.[0].defaultPrevented).toBe(true);
		document.body.removeEventListener("click", outside);
	});

	it("reveals an embedded file after input is enabled, including from Recents, without scrolling for a refresh", async () => {
		vi.useFakeTimers();
		const { fake, src, host, browser } = await opened({ embedded: true });
		const preview = host.querySelector<HTMLElement>(".files-preview")!;
		const reveal = vi.fn(() => {
			expect(host.querySelector<HTMLElement>(".files-root")?.inert).toBe(false);
			expect(preview.hidden).toBe(false);
		});
		preview.scrollIntoView = reveal;
		await click(row(host, "readme.txt"));
		expect(reveal).toHaveBeenCalledExactlyOnceWith({ block: "nearest", inline: "nearest" });
		fake.contents.set("readme.txt", "Changed while reading.");
		fake.bump(5);
		fake.changes.push({
			asOfSeq: 5,
			resync: false,
			events: [{ kind: "authority", seq: 5 }],
			next: { afterSeq: 5, cursor: null },
			more: false,
		});
		src.hint(5);
		await vi.advanceTimersByTimeAsync(1100);
		await settle();
		expect(host.querySelector(".files-text")?.textContent).toBe("Changed while reading.");
		expect(reveal).toHaveBeenCalledTimes(1);
		browser.showRecents();
		await settle();
		await click(host.querySelector(".storage-recents button.folder-history-path"));
		expect(host.querySelector(".files-text")?.textContent).toBe("line one");
		expect(reveal).toHaveBeenCalledTimes(2);
		await click(row(host, "log.txt"));
		expect(reveal).toHaveBeenCalledTimes(3);
	});

	it("leaves scrolling to the standalone file browser layout", async () => {
		const { host } = await opened();
		const reveal = vi.fn();
		host.querySelector<HTMLElement>(".files-preview")!.scrollIntoView = reveal;
		await click(row(host, "readme.txt"));
		expect(host.querySelector(".files-text")?.textContent).toBe("Hello.");
		expect(reveal).not.toHaveBeenCalled();
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
