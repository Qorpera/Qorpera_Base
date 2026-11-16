// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import type {
	CloudMemberFolderChangesPage,
	CloudMemberFolderEntry,
	CloudMemberFolderFile,
	CloudMemberFolderListPage,
} from "@qorpera/cloud-client/cloud-member-folder";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyFolderBrowser, type CompanyFolderSource } from "../src/app/views/company-folder.ts";
import { FOLDER_DOWNLOAD_MAX_LISTINGS, sizeBeside, zipSegment } from "../src/app/views/folder-download.ts";
import { crc32 } from "../src/app/views/folder-zip.ts";
import type { CodeDownload, CodeImportAnswer, CodeRepositories } from "../src/cloud/code-downloads.ts";
import { setLanguagePreference } from "../src/ui/preferences.ts";
import { id, settle } from "./fixtures.ts";
import { readZip } from "./zip-reader.ts";

const MIB = 1024 * 1024;
const at = "2026-11-16T09:12:33.000000+00:00";
const encoder = new TextEncoder();

type Spec =
	| { readonly kind: "folder" }
	| { readonly kind: "symlink"; readonly target: string }
	| { readonly kind: "file"; readonly pieces: readonly Uint8Array[]; readonly bytes: number };

function folderFake() {
	const nodes = new Map<string, Spec>();
	const references = new Map<string, string>();
	const failing = new Set<string>();
	const holding = new Map<string, { after: number; signals: AbortSignal[] }>();
	const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
	const addParents = (path: string) => {
		for (let parent = parentOf(path); parent; parent = parentOf(parent))
			if (!nodes.has(parent)) nodes.set(parent, { kind: "folder" });
	};
	const reference = (path: string, spec: Spec & { kind: "file" }): CloudMemberFolderFile => {
		const hash = [...path]
			.reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7)
			.toString(16)
			.padStart(64, "0");
		references.set(hash, path);
		return { manifestSha256: hash, fileSha256: hash, bytes: spec.bytes, mediaType: "text/plain", executable: false };
	};
	const entry = (path: string): CloudMemberFolderEntry | null => {
		const spec = nodes.get(path);
		if (!spec) return null;
		return {
			path,
			kind: spec.kind,
			version: id(100),
			seq: 1,
			updatedAt: at,
			file: spec.kind === "file" ? reference(path, spec) : null,
			target: spec.kind === "symlink" ? spec.target : null,
		};
	};
	const client = {
		list: vi.fn(
			async (
				parent: string | null,
				after: string | null,
				limit: number,
				_signal: AbortSignal,
			): Promise<CloudMemberFolderListPage> => {
				const children = [...nodes.keys()]
					.filter((path) => parentOf(path) === (parent ?? "") && (after === null || path > after))
					.sort()
					.slice(0, limit);
				return {
					asOfSeq: 4,
					entries: children.map((path) => entry(path)!),
					next: children.length === limit ? children.at(-1)! : null,
				};
			},
		),
		read: vi.fn(async (path: string) => ({ asOfSeq: 4, entry: entry(path) })),
		readFile: vi.fn(async () => new Uint8Array()),
		readFilePieces: vi.fn(
			async (
				file: CloudMemberFolderFile,
				signal: AbortSignal,
				onPiece: (piece: Uint8Array, index: number, count: number) => void,
			): Promise<void> => {
				const path = references.get(file.fileSha256)!;
				const spec = nodes.get(path) as Spec & { kind: "file" };
				await Promise.resolve();
				if (failing.has(path)) throw new Error("The object gateway did not answer");
				const hold = holding.get(path);
				for (const [index, piece] of spec.pieces.entries()) {
					if (hold && index === hold.after) {
						hold.signals.push(signal);
						await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
					}
					onPiece(piece, index, spec.pieces.length);
					await Promise.resolve();
				}
			},
		),
		pathHistory: vi.fn(),
		history: vi.fn(),
		changes: vi.fn(
			async (): Promise<CloudMemberFolderChangesPage> => ({
				asOfSeq: 4,
				resync: false,
				events: [],
				next: { afterSeq: 4, cursor: null },
				more: false,
			}),
		),
		commit: vi.fn(),
	};
	return {
		client,
		failing,
		holding,
		folder(path: string) {
			nodes.set(path, { kind: "folder" });
			addParents(path);
		},
		file(path: string, ...texts: string[]) {
			const pieces = texts.map((text) => encoder.encode(text));
			nodes.set(path, { kind: "file", pieces, bytes: pieces.reduce((sum, piece) => sum + piece.byteLength, 0) });
			addParents(path);
		},
		sized(path: string, bytes: number) {
			nodes.set(path, { kind: "file", pieces: [], bytes });
			addParents(path);
		},
		link(path: string, target: string) {
			nodes.set(path, { kind: "symlink", target });
			addParents(path);
		},
		listed(): (string | null)[] {
			return client.list.mock.calls.map((call) => call[0]);
		},
		read(): string[] {
			return client.readFilePieces.mock.calls.map((call) => references.get(call[0].fileSha256)!);
		},
	};
}

function callsFake(canDownload = true) {
	return {
		list: vi.fn(
			async (_signal: AbortSignal): Promise<CodeRepositories> => ({
				canDownload,
				repositories: [{ owner: "qorpera", name: "shop" }],
				githubCopies: [],
			}),
		),
		request: vi.fn(async (): Promise<CodeDownload> => ({ state: "queued", requestId: id(700), file: "files" })),
		read: vi.fn(async (): Promise<CodeDownload> => ({ state: "queued", requestId: id(700), file: "files" })),
		bringIn: vi.fn(async (): Promise<CodeImportAnswer> => ({ state: "refused", reason: "failed" })),
	};
}

const bytesOf = (blob: Blob) =>
	new Promise<Uint8Array>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
		reader.onerror = () => reject(reader.error);
		reader.readAsArrayBuffer(blob);
	});

const disposers: (() => void)[] = [];
const saved: { name: string; blob: Blob }[] = [];
const { showModal, close } = HTMLDialogElement.prototype;
beforeEach(() => {
	HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
		this.open = true;
	};
	HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
		this.open = false;
	};
	vi.stubGlobal("crypto", webcrypto);
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	const blobs: Blob[] = [];
	URL.createObjectURL = vi.fn((blob: Blob) => `blob:fixture-${blobs.push(blob)}`);
	URL.revokeObjectURL = vi.fn();
	vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
		saved.push({ name: this.download, blob: blobs[Number(this.href.split("-").at(-1)) - 1]! });
	});
});
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	saved.length = 0;
	HTMLDialogElement.prototype.showModal = showModal;
	HTMLDialogElement.prototype.close = close;
	setLanguagePreference("system");
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});

async function until(done: () => boolean): Promise<void> {
	for (let round = 0; round < 400 && !done(); round++) await settle();
	expect(done()).toBe(true);
}

async function storage(fake = folderFake(), options: { code?: boolean; canDownload?: boolean } = {}) {
	const stop = new AbortController();
	const source: CompanyFolderSource = {
		signal: stop.signal,
		current: () => stop.signal.throwIfAborted(),
		folder: () => fake.client,
		folderHints: () => ({ close: async () => {} }),
		...(options.code ? { codeDownloads: () => callsFake(options.canDownload) } : {}),
	};
	const host = document.createElement("section");
	document.body.append(host);
	const browser = new CompanyFolderBrowser(host, source, () => ({ me: id(1), members: [], staff: [] }), {
		embedded: true,
		search: document.createElement("input"),
	});
	disposers.push(() => browser.dispose());
	await browser.open();
	await settle();
	const download = () => host.querySelector<HTMLButtonElement>(".storage-download-button")!;
	const line = () => host.querySelector<HTMLElement>(".storage-download-line")!;
	return {
		host,
		download,
		line,
		async go(path: string) {
			browser.reveal(path);
			await until(() => host.querySelector(".storage-title")?.textContent === path.split("/").at(-1));
			await settle();
		},
		async press() {
			fake.client.list.mockClear();
			download().click();
			await settle();
		},
		async zip() {
			await until(() => saved.length === 1);
			return readZip(await bytesOf(saved[0]!.blob));
		},
	};
}

describe("downloading a folder from Storage (app/views/folder-download.ts)", () => {
	it("saves the open folder as <name>.zip, with its name as the top folder and what Storage lists under it", async () => {
		const fake = folderFake();
		fake.file("Kunder æøå/Årsrapport.md", "# Årsrapport\n");
		fake.file("Kunder æøå/notes.txt", "one\n", "two\n");
		fake.folder("Kunder æøå/Tom");
		fake.file("Kunder æøå/Søren/brev.txt", "Kære Søren\n");
		fake.link("Kunder æøå/genvej", "Kunder æøå/Søren");
		fake.file("other.txt", "not in it\n");
		const page = await storage(fake);
		await page.go("Kunder æøå");
		expect(page.download().hidden).toBe(false);
		expect(page.download().getAttribute("aria-label")).toBe("Download this folder");
		expect(page.line().getAttribute("role")).toBe("status");
		await page.press();
		const entries = await page.zip();
		expect(saved.map((each) => each.name)).toEqual(["Kunder æøå.zip"]);
		expect(entries.map((entry) => entry.name)).toEqual([
			"Kunder æøå/",
			"Kunder æøå/Søren/",
			"Kunder æøå/Tom/",
			"Kunder æøå/notes.txt",
			"Kunder æøå/Årsrapport.md",
			"Kunder æøå/Søren/brev.txt",
		]);
		const notes = entries.find((entry) => entry.name === "Kunder æøå/notes.txt")!;
		expect(new TextDecoder().decode(notes.bytes)).toBe("one\ntwo\n");
		expect(notes.crc).toBe(crc32(encoder.encode("one\ntwo\n")));
		expect(fake.listed()).toEqual(["Kunder æøå", "Kunder æøå/Søren", "Kunder æøå/Tom"]);
		await until(() => page.line().textContent !== "" && !page.line().querySelector(".spinner-dot"));
		expect(page.line().textContent).toBe(
			"Kunder æøå.zip is ready: your browser saves it in your downloads. The folder's links are not in it.",
		);
		expect(page.download().hasAttribute("aria-busy")).toBe(false);
		expect(page.download().hasAttribute("aria-disabled")).toBe(false);
	});

	it("saves the company's top folder under the name its title shows", async () => {
		const fake = folderFake();
		fake.file("readme.md", "hi\n");
		fake.file("notes/a.md", "a\n");
		const page = await storage(fake);
		await page.press();
		const entries = await page.zip();
		expect(saved[0]!.name).toBe("Documents.zip");
		expect(entries.map((entry) => entry.name)).toEqual([
			"Documents/",
			"Documents/notes/",
			"Documents/readme.md",
			"Documents/notes/a.md",
		]);
		expect(fake.listed()).toEqual([null, "notes"]);
	});

	it("refuses a folder of more than 2,000 files from its listing, before any file is read", async () => {
		const fake = folderFake();
		for (let index = 0; index < 2001; index++) fake.file(`Many/${String(index).padStart(4, "0")}.txt`, "x");
		const page = await storage(fake);
		await page.go("Many");
		await page.press();
		await until(() => !page.line().querySelector(".spinner-dot") && page.line().textContent !== "");
		expect(page.line().textContent).toBe(
			"Many has 2,001 files (201 KiB), more than a download here can hold (2,000 files).",
		);
		expect(fake.listed()).toHaveLength(11);
		expect(fake.client.readFilePieces).not.toHaveBeenCalled();
		expect(saved).toEqual([]);
	});

	it("refuses a folder over 256 MiB from its listing, before any file is read, and says its size", async () => {
		const fake = folderFake();
		fake.sized("Films/one.mov", 200 * MIB);
		fake.sized("Films/two.mov", 100 * MIB);
		const page = await storage(fake);
		await page.go("Films");
		await page.press();
		await until(() => !page.line().querySelector(".spinner-dot") && page.line().textContent !== "");
		expect(page.line().textContent).toBe("Films is 300 MiB, more than a download here can hold (256 MiB).");
		expect(fake.client.readFilePieces).not.toHaveBeenCalled();
		expect(saved).toEqual([]);
	});

	it("counts the zip's own headers toward 256 MiB: a zip of exactly that is read, one byte more is refused", async () => {
		const room = 256 * MIB - (22 + 2 * (30 + 46) + 2 * "Edge/".length + 2 * "Edge/film.mov".length);
		const fake = folderFake();
		fake.sized("Edge/film.mov", room + 1);
		fake.sized("Fits/film.mov", room);
		const page = await storage(fake);
		await page.go("Edge");
		await page.press();
		await until(() => !page.line().querySelector(".spinner-dot") && page.line().textContent !== "");
		expect(page.line().textContent).toBe("Edge is 256.1 MiB, more than a download here can hold (256 MiB).");
		expect(sizeBeside(256 * MIB, 256 * MIB)).toBe("256 MiB");
		expect(sizeBeside(300 * MIB, 256 * MIB)).toBe("300 MiB");
		expect(sizeBeside(256 * MIB + 1, 256 * MIB)).toBe("256.1 MiB");
		expect(sizeBeside(4 * MIB + 1, 4 * MIB)).toBe("4.01 MiB");
		expect(fake.client.readFilePieces).not.toHaveBeenCalled();
		await page.go("Fits");
		await page.press();
		await until(() => fake.client.readFilePieces.mock.calls.length === 1);
		expect(fake.read()).toEqual(["Fits/film.mov"]);
	});

	it("stops listing at its bound and reads nothing", async () => {
		const fake = folderFake();
		fake.folder(Array.from({ length: FOLDER_DOWNLOAD_MAX_LISTINGS + 1 }, () => "d").join("/"));
		const page = await storage(fake);
		await page.go("d");
		await page.press();
		await until(() => !page.line().querySelector(".spinner-dot") && page.line().textContent !== "");
		expect(page.line().textContent).toBe("d has more than 400 folders, more than a download here can go through.");
		expect(fake.listed()).toHaveLength(FOLDER_DOWNLOAD_MAX_LISTINGS);
		expect(saved).toEqual([]);
	});

	it("says how far it is, and Cancel stops the reads, saves nothing and says nothing", async () => {
		const fake = folderFake();
		fake.file("Work/a.txt", "aaaa");
		fake.file("Work/b.txt", "bbbb", "bbbb", "bbbb");
		fake.file("Work/c.txt", "cccc");
		fake.holding.set("Work/b.txt", { after: 1, signals: [] });
		const page = await storage(fake);
		await page.go("Work");
		await page.press();
		await until(() => fake.holding.get("Work/b.txt")!.signals.length === 1);
		expect(page.line().textContent).toBe("Downloading Work…40%Cancel");
		expect(page.line().querySelector(".storage-download-percent")!.getAttribute("aria-hidden")).toBe("true");
		expect(page.download().getAttribute("aria-busy")).toBe("true");
		expect(page.download().getAttribute("aria-disabled")).toBe("true");
		page.download().click();
		await settle();
		expect(fake.read()).toEqual(["Work/a.txt", "Work/b.txt"]);
		const cancel = [...page.line().querySelectorAll("button")].find((each) => each.textContent === "Cancel")!;
		cancel.focus();
		cancel.click();
		await until(() => page.line().textContent === "");
		expect(fake.holding.get("Work/b.txt")!.signals[0]!.aborted).toBe(true);
		expect(fake.read()).toEqual(["Work/a.txt", "Work/b.txt"]);
		expect(saved).toEqual([]);
		expect(page.download().hasAttribute("aria-busy")).toBe(false);
		expect(document.activeElement).toBe(page.download());
	});

	it("saves nothing when a file cannot be read, and names that file", async () => {
		const fake = folderFake();
		fake.file("Work/a.txt", "aaaa");
		fake.file("Work/Reports/broken.txt", "xxxx");
		fake.file("Work/z.txt", "zzzz");
		fake.failing.add("Work/Reports/broken.txt");
		const page = await storage(fake);
		await page.go("Work");
		await page.press();
		await until(() => !page.line().querySelector(".spinner-dot") && page.line().textContent !== "");
		expect(page.line().textContent).toBe(
			"Reports/broken.txt could not be read, so nothing was downloaded. Try again.",
		);
		expect(fake.read()).toEqual(["Work/a.txt", "Work/z.txt", "Work/Reports/broken.txt"]);
		expect(saved).toEqual([]);
	});

	it("says the folder could not be read when its listing fails, and saves nothing", async () => {
		const fake = folderFake();
		fake.file("Work/a.txt", "aaaa");
		const page = await storage(fake);
		await page.go("Work");
		fake.client.list.mockRejectedValueOnce(new Error("offline"));
		page.download().click();
		await until(() => !page.line().querySelector(".spinner-dot") && page.line().textContent !== "");
		expect(page.line().textContent).toBe("Work could not be read just now. Try again.");
		expect(saved).toEqual([]);
	});

	it("is the third choice of Download the code on a code project's folder, which leaves repo.git, worktrees and downloads out", async () => {
		const fake = folderFake();
		fake.file("code/qorpera/shop/main/README.md", "# Shop\n");
		fake.file("code/qorpera/shop/changes/1.md", "# 1\n");
		fake.file("code/qorpera/shop/repo.git/HEAD", "ref: refs/heads/main\n");
		fake.file("code/qorpera/shop/worktrees/one/README.md", "# Shop\n");
		fake.file("code/qorpera/shop/downloads/shop.zip", "PK");
		fake.holding.set("code/qorpera/shop/changes/1.md", { after: 0, signals: [] });
		const page = await storage(fake, { code: true });
		await page.go("code");
		await page.go("code/qorpera");
		expect(page.download().hidden).toBe(false);
		await page.go("code/qorpera/shop");
		const code = () =>
			page.host.querySelector<HTMLButtonElement>(".storage-code-button:not(.storage-import-button)")!;
		await until(() => code().hidden === false);
		expect(page.download().hidden).toBe(true);
		const visible = [...page.host.querySelectorAll<HTMLElement>(".storage-toolbar > button:not([hidden])")];
		expect(visible).toEqual([code()]);
		const choose = async (label: string) => {
			code().click();
			const rows = [...document.querySelectorAll<HTMLElement>(".context-menu [role=menuitem]")];
			expect(rows.map((row) => row.querySelector(".context-menu-label")?.textContent)).toEqual([
				"The files",
				"With full history",
				"The whole folder",
			]);
			rows.find((row) => row.querySelector(".context-menu-label")?.textContent === label)!.click();
			await settle();
		};
		fake.client.list.mockClear();
		await choose("The whole folder");
		await until(() => fake.holding.get("code/qorpera/shop/changes/1.md")!.signals.length === 1);
		expect(page.line().textContent).toBe("Downloading shop…Cancel");
		expect(code().getAttribute("aria-disabled")).toBe("true");
		code().click();
		expect(document.querySelector(".context-menu")).toBeNull();
		const cancel = [...page.line().querySelectorAll("button")].find((each) => each.textContent === "Cancel")!;
		cancel.focus();
		cancel.click();
		await until(() => page.line().textContent === "");
		expect(code().hasAttribute("aria-disabled")).toBe(false);
		expect(document.activeElement).toBe(code());
		expect(saved).toEqual([]);
		fake.holding.clear();
		fake.client.list.mockClear();
		fake.client.readFilePieces.mockClear();
		await choose("The whole folder");
		const entries = await page.zip();
		expect(saved[0]!.name).toBe("shop.zip");
		expect(entries.map((entry) => entry.name)).toEqual([
			"shop/",
			"shop/changes/",
			"shop/main/",
			"shop/changes/1.md",
			"shop/main/README.md",
		]);
		expect(fake.listed()).toEqual(["code/qorpera/shop", "code/qorpera/shop/changes", "code/qorpera/shop/main"]);
		expect(fake.read()).toEqual(["code/qorpera/shop/changes/1.md", "code/qorpera/shop/main/README.md"]);
		await until(() => /is ready/.test(page.line().textContent ?? ""));
		expect(page.line().textContent).toBe("shop.zip is ready: your browser saves it in your downloads.");
	});

	it("keeps its own button with its word on a code project's folder for a member who may not download the code", async () => {
		const fake = folderFake();
		fake.file("code/qorpera/shop/main/README.md", "# Shop\n");
		const page = await storage(fake, { code: true, canDownload: false });
		await page.go("code/qorpera/shop");
		await settle();
		expect(page.host.querySelector<HTMLElement>(".storage-code-button:not(.storage-import-button)")!.hidden).toBe(
			true,
		);
		expect(page.download().hidden).toBe(false);
		expect(page.download().querySelector("span")!.textContent).toBe("Download");
		await page.press();
		await page.zip();
		expect(saved[0]!.name).toBe("shop.zip");
	});

	it("writes a name that is . or .. as _, so nothing in the zip walks out of its top folder", async () => {
		expect(zipSegment(".")).toBe("_");
		expect(zipSegment("..")).toBe("_");
		expect(zipSegment("...")).toBe("...");
		expect(zipSegment(".env")).toBe(".env");
		expect(zipSegment("a\\b")).toBe("a_b");
		const fake = folderFake();
		fake.file("Work/../escape.txt", "x");
		fake.file("Work/./here.txt", "y");
		const page = await storage(fake);
		await page.go("Work");
		await page.press();
		const entries = await page.zip();
		expect(entries.map((entry) => entry.name)).toEqual([
			"Work/",
			"Work/_/",
			"Work/_/",
			"Work/_/here.txt",
			"Work/_/escape.txt",
		]);
		expect(entries.every((entry) => entry.name.split("/").every((part) => part !== "." && part !== ".."))).toBe(true);
	});

	it("leaves each project's internals out when a folder above the code is downloaded", async () => {
		const fake = folderFake();
		fake.file("code/qorpera/shop/main/README.md", "# Shop\n");
		fake.file("code/qorpera/shop/repo.git/HEAD", "ref\n");
		fake.file("code/qorpera/notes.md", "n\n");
		const page = await storage(fake);
		await page.go("code");
		await page.press();
		const entries = await page.zip();
		expect(entries.map((entry) => entry.name)).toEqual([
			"code/",
			"code/qorpera/",
			"code/qorpera/notes.md",
			"code/qorpera/shop/",
			"code/qorpera/shop/main/",
			"code/qorpera/shop/main/README.md",
		]);
	});

	it("says it in Danish", async () => {
		setLanguagePreference("da");
		const fake = folderFake();
		fake.sized("Film/en.mov", 300 * MIB);
		const page = await storage(fake);
		await page.go("Film");
		expect(page.download().querySelector("span")!.textContent).toBe("Hent");
		expect(page.download().getAttribute("aria-label")).toBe("Hent denne mappe");
		await page.press();
		await until(() => !page.line().querySelector(".spinner-dot") && page.line().textContent !== "");
		expect(page.line().textContent).toBe("Film fylder 300 MiB, mere end en hentning her kan rumme (256 MiB).");
	});

	it("offers no download where Storage only picks", async () => {
		const fake = folderFake();
		fake.file("a.txt", "a");
		const stop = new AbortController();
		const host = document.createElement("section");
		document.body.append(host);
		const browser = new CompanyFolderBrowser(
			host,
			{
				signal: stop.signal,
				current: () => {},
				folder: () => fake.client,
				folderHints: () => ({ close: async () => {} }),
			},
			() => ({ me: id(1), members: [], staff: [] }),
			{ embedded: true, search: document.createElement("input"), choose: () => {} },
		);
		disposers.push(() => browser.dispose());
		await browser.open();
		expect(host.querySelector(".storage-download-button")).toBeNull();
	});

	it("stops reading and saves nothing when Storage closes while it reads", async () => {
		const fake = folderFake();
		fake.file("Work/a.txt", "aaaa", "aaaa");
		fake.holding.set("Work/a.txt", { after: 1, signals: [] });
		const page = await storage(fake);
		await page.go("Work");
		await page.press();
		await until(() => fake.holding.get("Work/a.txt")!.signals.length === 1);
		for (const dispose of disposers.splice(0)) dispose();
		await settle();
		expect(fake.holding.get("Work/a.txt")!.signals[0]!.aborted).toBe(true);
		expect(saved).toEqual([]);
	});
});
