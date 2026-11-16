// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import type {
	CloudMemberFolderChangesPage,
	CloudMemberFolderEntry,
	CloudMemberFolderFile,
	CloudMemberFolderListPage,
} from "@qorpera/cloud-client/cloud-member-folder";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebFileDownloads } from "../../member-web/src/files.ts";
import { CompanyFolderBrowser, type CompanyFolderSource } from "../src/app/views/company-folder.ts";
import { type Cloud, CloudRpcError } from "../src/cloud/client.ts";
import {
	type CodeDownload,
	type CodeDownloadCalls,
	type CodeImportAnswer,
	type CodeRepositories,
	codeDownloadCalls,
	parseCodeDownload,
	parseCodeRepositories,
} from "../src/cloud/code-downloads.ts";
import { WebCompanyFiles } from "../src/cloud/company-files.ts";
import { CloudShapeError } from "../src/cloud/parse.ts";
import { openMenu } from "../src/ui/context-menu.ts";
import { setLanguagePreference } from "../src/ui/preferences.ts";
import { deferred, id, profileA, settle, visibleText } from "./fixtures.ts";

/* "Download the code" (own code storage, step 2b): the member's three calls as the web reads them
 * (cloud/code-downloads.ts, migration 20260930720000), and the button on a repository's folder in Storage
 * (app/views/code-download.ts) with its menu, its wait and each way it ends. */

const MIB = 1024 * 1024;
const at = "2026-11-10T09:12:33.000000+00:00";
const request = id(700);
const zip = "code/qorpera/shop/downloads/shop-2026-11-10.zip";
const history = "code/qorpera/shop/downloads/shop-2026-11-10.bundle";
const ready = (path = zip, bytes = 20 * MIB): CodeDownload => ({
	state: "ready",
	requestId: request,
	file: path.endsWith(".zip") ? "files" : "history",
	path,
	bytes,
});
const queued: CodeDownload = { state: "queued", requestId: request, file: "files" };
const running: CodeDownload = { state: "running", requestId: request, file: "files" };
const missing = (rpc: string) => new CloudRpcError(rpc, { message: "missing", code: "PGRST202" }, 404);

describe("the member's code calls (cloud/code-downloads.ts)", () => {
	const view = (fields: Record<string, unknown>) => ({
		schema: "qorpera.code-download/v1",
		requestId: request,
		file: "files",
		state: "queued",
		reason: null,
		path: null,
		bytes: null,
		...fields,
	});

	it("reads the company's repositories and whether the member may download", () => {
		const answer = {
			schema: "qorpera.code-repositories/v1",
			canDownload: true,
			repositories: [
				{ owner: "qorpera", name: "shop", changes: 14, downloads: [] },
				{
					owner: "brooks",
					name: "core",
					changes: 8,
					downloads: [
						{
							requestId: request,
							file: "files",
							state: "ready",
							path: "code/brooks/core/downloads/core-2026-11-10.zip",
							bytes: 9,
							madeAt: at,
							expiresAt: at,
						},
					],
				},
			],
		};
		expect(parseCodeRepositories(answer)).toEqual({
			canDownload: true,
			repositories: [
				{ owner: "qorpera", name: "shop" },
				{ owner: "brooks", name: "core" },
			],
			githubCopies: [],
		});
		expect(parseCodeRepositories({ ...answer, canDownload: false, repositories: [] })).toEqual({
			canDownload: false,
			repositories: [],
			githubCopies: [],
		});
		for (const bad of [
			null,
			{ ...answer, schema: "qorpera.code-repositories/v2" },
			{ ...answer, canDownload: "yes" },
			{ ...answer, repositories: {} },
			{ ...answer, repositories: [{ owner: "qorpera" }] },
			{ ...answer, repositories: [{ owner: "", name: "shop" }] },
		])
			expect(() => parseCodeRepositories(bad)).toThrow(CloudShapeError);
	});

	it("reads the company's GitHub copies, and none when the key is missing or not as expected", () => {
		const answer = {
			schema: "qorpera.code-repositories/v1",
			canDownload: true,
			repositories: [{ owner: "qorpera", name: "shop", changes: 14, downloads: [] }],
		};
		const kept = { canDownload: true, repositories: [{ owner: "qorpera", name: "shop" }] };
		const storefront = { owner: "qorpera", name: "saml-storefront", github: "Qorpera/saml-storefront" };
		// The folder is the project's name in lower case; the project keeps GitHub's spelling. Keys not known are left.
		expect(
			parseCodeRepositories({
				...answer,
				githubCopies: [
					{ ...storefront, since: at },
					{ owner: "acme", name: "web.site_2", github: "ACME/Web.Site_2" },
				],
			}),
		).toEqual({
			...kept,
			githubCopies: [storefront, { owner: "acme", name: "web.site_2", github: "ACME/Web.Site_2" }],
		});
		expect(parseCodeRepositories({ ...answer, githubCopies: [] })).toEqual({ ...kept, githubCopies: [] });
		// A cloud from before the key, and a key that is not as this version reads it: the rest is read as before, and no
		// copy is named, not even the ones that are well formed.
		expect(parseCodeRepositories(answer)).toEqual({ ...kept, githubCopies: [] });
		for (const githubCopies of [
			null,
			{},
			"Qorpera/saml-storefront",
			[null],
			[[storefront.owner, storefront.name, storefront.github]],
			[storefront, { owner: "qorpera", name: "storefront" }],
			[{ ...storefront, github: null }],
			[{ ...storefront, owner: null, github: "null/saml-storefront" }],
			[{ ...storefront, github: "github.com/Qorpera/saml-storefront" }],
			[{ ...storefront, github: "Qorpera/saml-storefront/main" }],
			[{ ...storefront, github: "Qorpera/other-project" }],
			[{ ...storefront, owner: "Qorpera" }],
			[{ ...storefront, github: "-Qorpera/saml-storefront" }],
			[{ ...storefront, github: "Qorpera/.saml-storefront", name: ".saml-storefront" }],
			[{ ...storefront, github: `Qorpera/${"s".repeat(101)}`, name: "s".repeat(101) }],
		])
			expect(parseCodeRepositories({ ...answer, githubCopies })).toEqual({ ...kept, githubCopies: [] });
	});

	it("reads how a download stands: waiting, ready with its file, refused or failed with why", () => {
		expect(parseCodeDownload(view({}))).toEqual(queued);
		expect(parseCodeDownload(view({ state: "running" }))).toEqual(running);
		expect(parseCodeDownload(view({ state: "ready", path: zip, bytes: 20 * MIB }))).toEqual(ready());
		expect(parseCodeDownload(view({ file: "history", state: "ready", path: history, bytes: 0 }))).toEqual(
			ready(history, 0),
		);
		// A refusal has no request; a reason this version does not know reads as it came, and none reads as failed.
		expect(parseCodeDownload(view({ requestId: null, state: "refused", reason: "too_many" }))).toEqual({
			state: "refused",
			file: "files",
			reason: "too_many",
		});
		for (const reason of ["too_large", "busy", "failed", "later_word"])
			expect(parseCodeDownload(view({ state: "failed", reason }))).toEqual({
				state: "failed",
				file: "files",
				reason,
			});
		expect(parseCodeDownload(view({ state: "failed" }))).toEqual({
			state: "failed",
			file: "files",
			reason: "failed",
		});
		for (const bad of [
			null,
			view({ schema: "qorpera.code-download/v2" }),
			view({ file: "everything" }),
			view({ state: "done" }),
			view({ requestId: "not-an-id" }),
			view({ requestId: null }),
			view({ state: "ready", path: null, bytes: 9 }),
			view({ state: "ready", path: zip, bytes: null }),
			view({ state: "ready", path: zip, bytes: -1 }),
			view({ state: "ready", path: zip, bytes: 257 * MIB }),
		])
			expect(() => parseCodeDownload(bad)).toThrow(CloudShapeError);
	});

	it("calls the three member functions for the company, and Storage's source hands them out", async () => {
		const rpc = vi.fn(
			async (name: string): Promise<unknown> =>
				name === "qorpera_list_code_repositories"
					? { schema: "qorpera.code-repositories/v1", canDownload: true, repositories: [] }
					: view({}),
		);
		const cloud = {
			rpc,
			config: { projectUrl: "https://cloud.test", publishableKey: "k", objectGatewayUrl: "https://objects.test" },
		} as unknown as Cloud;
		const signal = new AbortController().signal;
		const calls = codeDownloadCalls(cloud, profileA.profileId);
		expect(await calls.list(signal)).toEqual({ canDownload: true, repositories: [], githubCopies: [] });
		expect(await calls.request("qorpera", "shop", "history", signal)).toEqual(queued);
		expect(await calls.read(request, signal)).toEqual(queued);
		expect(rpc.mock.calls).toEqual([
			["qorpera_list_code_repositories", { p_profile_id: profileA.profileId }],
			[
				"qorpera_request_code_download",
				{ p_profile_id: profileA.profileId, p_owner: "qorpera", p_name: "shop", p_file: "history" },
			],
			["qorpera_code_download", { p_profile_id: profileA.profileId, p_request_id: request }],
		]);
		// A cloud from before the migration says the function is missing, and the caller can tell.
		rpc.mockRejectedValueOnce(missing("qorpera_list_code_repositories"));
		await expect(calls.list(signal)).rejects.toMatchObject({ missing: true });
		// A call ends with its caller.
		const stop = new AbortController();
		rpc.mockReturnValueOnce(new Promise(() => {}));
		const hung = calls.read(request, stop.signal);
		await settle();
		stop.abort(new Error("closed"));
		await expect(hung).rejects.toThrow("closed");
		const files = new WebCompanyFiles(cloud, profileA, id(1), "owner", signal, () => {});
		rpc.mockClear();
		await files.codeDownloads().list(signal);
		expect(rpc).toHaveBeenCalledWith("qorpera_list_code_repositories", { p_profile_id: profileA.profileId });
	});
});

/** A company folder with one repository kept in Qorpera (code/qorpera/shop), copies that are not (code/github/copy,
 * and a GitHub project's working copy at code/qorpera/saml-storefront) and a folder beside the code. A download's file
 * is added to the repository's downloads folder as its pieces. */
function folderFake() {
	const folders = new Set([
		"notes",
		"code",
		"code/qorpera",
		"code/qorpera/shop",
		"code/qorpera/shop/main",
		"code/qorpera/shop/main/src",
		"code/qorpera/shop/changes",
		"code/qorpera/saml-storefront",
		"code/qorpera/saml-storefront/repo.git",
		"code/github",
		"code/github/copy",
	]);
	const files = new Map<string, { file: CloudMemberFolderFile; pieces: Uint8Array[] }>();
	const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
	const entry = (path: string): CloudMemberFolderEntry | null => {
		const held = files.get(path);
		if (!held && !folders.has(path)) return null;
		return {
			path,
			kind: held ? "file" : "folder",
			version: id(100),
			seq: 1,
			updatedAt: at,
			file: held?.file ?? null,
			target: null,
		};
	};
	const client = {
		list: vi.fn(
			async (parent: string | null): Promise<CloudMemberFolderListPage> => ({
				asOfSeq: 4,
				entries: [...folders, ...files.keys()]
					.filter((path) => parentOf(path) === (parent ?? ""))
					.map((path) => entry(path)!),
				next: null,
			}),
		),
		read: vi.fn(async (path: string) => ({ asOfSeq: 4, entry: entry(path) })),
		readFile: vi.fn(async () => new Uint8Array()),
		readFilePieces: vi.fn(
			async (
				reference: CloudMemberFolderFile,
				_signal: AbortSignal,
				onPiece: (piece: Uint8Array, index: number, count: number) => void,
			): Promise<void> => {
				const held = [...files.values()].find((each) => each.file.fileSha256 === reference.fileSha256)!;
				for (const [index, piece] of held.pieces.entries()) onPiece(piece, index, held.pieces.length);
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
		/** Puts a made download in the folder: pieces of 4 MiB, each filled with its own number. */
		made(path: string, megabytes: number) {
			const pieces = Array.from({ length: Math.ceil(megabytes / 4) }, (_, index) =>
				new Uint8Array(Math.min(4, megabytes - index * 4) * MIB).fill(index + 1),
			);
			folders.add(parentOf(path));
			const hash = (files.size + 1).toString(16).padStart(64, "0");
			files.set(path, {
				file: {
					manifestSha256: hash,
					fileSha256: hash,
					bytes: megabytes * MIB,
					mediaType: "application/zip",
					executable: false,
				},
				pieces,
			});
		},
	};
}

function callsFake(
	list: CodeRepositories = { canDownload: true, repositories: [{ owner: "qorpera", name: "shop" }], githubCopies: [] },
) {
	return {
		list: vi.fn(async (_signal: AbortSignal): Promise<CodeRepositories> => list),
		request: vi.fn(
			async (
				_owner: string,
				_name: string,
				file: "files" | "history",
				_signal: AbortSignal,
			): Promise<CodeDownload> => ready(file === "files" ? zip : history),
		),
		read: vi.fn(async (_requestId: string, _signal: AbortSignal): Promise<CodeDownload> => ready()),
		bringIn: vi.fn(
			async (_owner: string, _name: string, _github: string, _signal: AbortSignal): Promise<CodeImportAnswer> => ({
				state: "refused",
				reason: "failed",
			}),
		),
	};
}

/** A Blob's bytes (jsdom's Blob has no arrayBuffer()). */
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
	// jsdom has no native dialog methods (Storage's file window) and hands out no object URLs.
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
	// The browser is handed a file through a hidden link's click: what it was named, and the Blob behind it.
	vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
		saved.push({ name: this.download, blob: blobs[Number(this.href.split("-").at(-1)) - 1]! });
	});
});
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	saved.length = 0;
	openMenu()?.close();
	HTMLDialogElement.prototype.showModal = showModal;
	HTMLDialogElement.prototype.close = close;
	setLanguagePreference("system");
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});

/** Storage with the fake folder, as Settings embeds it. `calls`: false for a product without the code calls. */
async function storage(calls: CodeDownloadCalls | false = callsFake()) {
	const fake = folderFake();
	const stop = new AbortController();
	const source: CompanyFolderSource = {
		signal: stop.signal,
		current: () => stop.signal.throwIfAborted(),
		folder: () => fake.client,
		folderHints: () => ({ close: async () => {} }),
		...(calls ? { codeDownloads: () => calls } : {}),
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
	const go = async (path: string) => {
		browser.reveal(path);
		await settle();
		await settle();
	};
	const button = () => host.querySelector<HTMLButtonElement>(".storage-code-button:not(.storage-import-button)");
	const line = () => host.querySelector<HTMLElement>(".storage-code-line:not(.storage-import-line)")!;
	/** What the folder is, the line the import draws above the download's (code-import.ts). */
	const importLine = () => host.querySelector<HTMLElement>(".storage-import-line")!;
	/** Opens the menu and takes a choice by its label. */
	const choose = async (label: string) => {
		button()!.click();
		[...document.querySelectorAll<HTMLElement>(".context-menu [role=menuitem]")]
			.find((item) => item.querySelector(".context-menu-label")?.textContent === label)!
			.click();
		await settle();
	};
	return { fake, stop, host, browser, go, button, line, importLine, choose };
}

describe("handing the browser a file as its pieces (member-web's WebFileDownloads)", () => {
	const downloads = (signal = new AbortController().signal) => new WebFileDownloads({ current: () => {}, signal });

	it("makes one Blob of the pieces, under the path's last name, and lets its URL go after a minute", () => {
		vi.useFakeTimers();
		const pieces = [new Blob([new Uint8Array(3).fill(1)]), new Blob([new Uint8Array(2).fill(2)])];
		downloads().offerPieces("code/qorpera/shop/downloads/shop-2026-11-10.zip", pieces, 5);
		expect(saved.map(({ name, blob }) => [name, blob.size, blob.type])).toEqual([
			["shop-2026-11-10.zip", 5, "application/octet-stream"],
		]);
		// The link is gone again at once; the URL stays for the browser to read, then goes.
		expect(document.querySelector("a[download]")).toBeNull();
		expect(URL.revokeObjectURL).not.toHaveBeenCalled();
		vi.advanceTimersByTime(60_000);
		expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fixture-1");
	});

	it("refuses pieces that are not the file, a file past a folder file's most, and a name that is no file name", () => {
		const some = [new Blob([new Uint8Array(4)])];
		const files = downloads();
		for (const refuse of [
			() => files.offerPieces("a.zip", some, 5),
			() => files.offerPieces("a.zip", some, -4),
			() => files.offerPieces("a.zip", [{ size: 257 * MIB } as Blob], 257 * MIB),
			() => files.offerPieces("folder/", some, 4),
			() => files.offerPieces("a\\b.zip", some, 4),
			() => files.offerPieces("a\nb.zip", some, 4),
			// A file held whole keeps its own limit.
			() => files.offer("a.zip", { length: 8 * MIB + 1 } as Uint8Array),
		])
			expect(refuse).toThrow("Invalid browser download");
		expect(saved).toEqual([]);
		expect(URL.createObjectURL).not.toHaveBeenCalled();
		// 256 MiB itself is taken, and nothing is handed out once the page that asked is gone.
		files.offerPieces("a.zip", [{ size: 256 * MIB } as Blob], 256 * MIB);
		expect(saved.map(({ name }) => name)).toEqual(["a.zip"]);
		const stop = new AbortController();
		const gone = downloads(stop.signal);
		stop.abort();
		expect(() => gone.offerPieces("a.zip", some, 4)).toThrow();
		expect(saved).toHaveLength(1);
	});
});

describe("Download the code, on a repository's folder in Storage", () => {
	it("shows on the folder of a repository kept in Qorpera and below it, and nowhere else", async () => {
		const calls = callsFake();
		const { go, button, host } = await storage(calls);
		// The top line holds it between the folder's name and the list's own controls, hidden until there is a use.
		expect(button()?.parentElement?.classList.contains("storage-toolbar")).toBe(true);
		expect(button()?.previousElementSibling).toBe(host.querySelector(".storage-title"));
		expect(button()?.hidden).toBe(true);
		await go("notes");
		expect(button()?.hidden).toBe(true);
		// Nothing was asked beside the code; the code's own folder asks once, for "Bring code in" (code-import.ts).
		expect(calls.list).not.toHaveBeenCalled();
		for (const path of ["code", "code/qorpera"]) {
			await go(path);
			expect(button()?.hidden).toBe(true);
		}
		expect(calls.list).toHaveBeenCalledTimes(1);
		await go("code/qorpera/shop");
		expect(calls.list).toHaveBeenCalledTimes(1);
		expect(button()?.hidden).toBe(false);
		expect(visibleText(button())).toBe("Download the code");
		expect(button()?.getAttribute("aria-haspopup")).toBe("menu");
		// Below it too, with what is known already.
		await go("code/qorpera/shop/main/src");
		expect(button()?.hidden).toBe(false);
		expect(calls.list).toHaveBeenCalledTimes(1);
		await go("notes");
		expect(button()?.hidden).toBe(true);
	});

	it("is not offered to a member who may not download, or on a folder that is not the company's repository", async () => {
		vi.useFakeTimers();
		const viewer = await storage(
			callsFake({ canDownload: false, repositories: [{ owner: "qorpera", name: "shop" }], githubCopies: [] }),
		);
		await viewer.go("code/qorpera/shop");
		expect(viewer.button()?.hidden).toBe(true);
		const calls = callsFake();
		const { go, button } = await storage(calls);
		// A copy from elsewhere lies under code/ too: it is asked about, and again only after a minute.
		await go("code/github/copy");
		expect(button()?.hidden).toBe(true);
		expect(calls.list).toHaveBeenCalledTimes(1);
		await go("code/github");
		await go("code/github/copy");
		expect(calls.list).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(61_000);
		await go("code/github");
		await go("code/github/copy");
		expect(calls.list).toHaveBeenCalledTimes(2);
		expect(button()?.hidden).toBe(true);
	});

	it("stays hidden for good on a cloud without the calls, and asks again after a read that only failed", async () => {
		const old = callsFake();
		old.list.mockRejectedValue(missing("qorpera_list_code_repositories"));
		const before = await storage(old);
		await before.go("code/qorpera/shop");
		await before.go("code/qorpera/shop/main");
		await before.go("code/qorpera/shop");
		expect(before.button()?.hidden).toBe(true);
		expect(old.list).toHaveBeenCalledTimes(1);
		const flaky = callsFake();
		flaky.list.mockRejectedValueOnce(new Error("offline"));
		const { go, button } = await storage(flaky);
		await go("code/qorpera/shop");
		expect(button()?.hidden).toBe(true);
		await go("code/qorpera/shop/main");
		expect(flaky.list).toHaveBeenCalledTimes(2);
		expect(button()?.hidden).toBe(false);
		// A product without the calls draws no button at all.
		const none = await storage(false);
		await none.go("code/qorpera/shop");
		expect(none.button()).toBeNull();
		expect(none.host.querySelector(".storage-code-line")).toBeNull();
	});

	it("opens the app's own menu under it: the files first, then the full history for a developer", async () => {
		const { go, button } = await storage();
		await go("code/qorpera/shop");
		button()!.click();
		const menu = document.querySelector<HTMLElement>(".context-menu")!;
		expect(menu.getAttribute("aria-label")).toBe("Download the code");
		expect(button()?.getAttribute("aria-expanded")).toBe("true");
		const rows = [...menu.querySelectorAll<HTMLElement>("[role=menuitem]")];
		expect(
			rows.map((row) => [
				row.querySelector(".context-menu-label")?.textContent,
				row.querySelector(".context-menu-hint")?.textContent,
			]),
		).toEqual([
			["The files", "Everything as it is now, in one file"],
			["With full history", "For a developer"],
		]);
		// The files are the choice a key press takes.
		expect(document.activeElement).toBe(rows[0]);
		// A founder reads this: none of git's words, on the button or in the menu.
		expect(`${button()?.textContent} ${menu.textContent}`).not.toMatch(
			/git|branch|commit|bundle|repositor|pull request|zip|main/i,
		);
		menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		expect(document.querySelector(".context-menu")).toBeNull();
		expect(button()?.getAttribute("aria-expanded")).toBe("false");
	});

	it("gets a file that is ready at once: read from the repository's downloads folder in pieces, handed over as one file", async () => {
		const calls = callsFake();
		const { fake, go, button, line, choose } = await storage(calls);
		fake.made(zip, 20);
		await go("code/qorpera/shop");
		const reading = deferred<void>();
		const pieces = fake.client.readFilePieces.getMockImplementation()!;
		const said: string[] = [];
		fake.client.readFilePieces.mockImplementationOnce(async (reference, signal, onPiece) => {
			await pieces(reference, signal, (piece, index, count) => {
				onPiece(piece, index, count);
				said.push(visibleText(line()));
			});
			await reading.promise;
		});
		await choose("The files");
		expect(calls.request).toHaveBeenCalledWith("qorpera", "shop", "files", expect.any(AbortSignal));
		expect(calls.read).not.toHaveBeenCalled();
		expect(fake.client.read).toHaveBeenLastCalledWith(zip, expect.any(AbortSignal));
		// While it is read the line says so and how far it is, the button rests, and Cancel is in reach.
		expect(said).toEqual([20, 40, 60, 80, 100].map((percent) => `Downloading the code…${percent}%Cancel`));
		expect(line().getAttribute("role")).toBe("status");
		expect(line().querySelector(".storage-code-percent")?.getAttribute("aria-hidden")).toBe("true");
		expect(button()?.getAttribute("aria-disabled")).toBe("true");
		button()!.click();
		expect(document.querySelector(".context-menu")).toBeNull();
		expect(saved).toEqual([]);
		reading.resolve();
		await settle();
		// One file for the browser, under the name the folder gives it: one Blob of the five pieces, in order.
		expect(saved.map(({ name, blob }) => [name, blob.size])).toEqual([["shop-2026-11-10.zip", 20 * MIB]]);
		expect(await bytesOf(saved[0]!.blob.slice(8 * MIB - 1, 8 * MIB + 1))).toEqual(Uint8Array.of(2, 3));
		// Handed over, the file is ready: the page cannot know when the browser has saved it, so it says no more.
		expect(visibleText(line())).toBe("shop-2026-11-10.zip is ready: your browser saves it in your downloads.");
		expect(line().querySelector("button, .spinner-dot")).toBeNull();
		expect(button()?.hasAttribute("aria-disabled")).toBe(false);
	});

	it("waits while the file is made, asking every two seconds, and takes the history copy when that is chosen", async () => {
		vi.useFakeTimers();
		const calls = callsFake();
		calls.request.mockResolvedValueOnce({ ...queued, file: "history" });
		calls.read
			.mockResolvedValueOnce({ ...running, file: "history" })
			.mockResolvedValueOnce({ ...running, file: "history" })
			.mockResolvedValueOnce(ready(history, 4 * MIB));
		const { fake, go, line, choose } = await storage(calls);
		fake.made(history, 4);
		await go("code/qorpera/shop");
		await choose("With full history");
		expect(calls.request).toHaveBeenCalledWith("qorpera", "shop", "history", expect.any(AbortSignal));
		expect(visibleText(line())).toBe("Getting the code ready…Cancel");
		expect(calls.read).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1999);
		expect(calls.read).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(calls.read).toHaveBeenCalledTimes(1);
		expect(calls.read).toHaveBeenLastCalledWith(request, expect.any(AbortSignal));
		await vi.advanceTimersByTimeAsync(2000);
		expect(visibleText(line())).toBe("Getting the code ready…Cancel");
		expect(saved).toEqual([]);
		await vi.advanceTimersByTimeAsync(2000);
		await settle();
		expect(calls.read).toHaveBeenCalledTimes(3);
		expect(saved.map(({ name, blob }) => [name, blob.size])).toEqual([["shop-2026-11-10.bundle", 4 * MIB]]);
		expect(visibleText(line())).toBe("shop-2026-11-10.bundle is ready: your browser saves it in your downloads.");
	});

	it("says each way it can end in plain words, and lets the member try again", async () => {
		vi.useFakeTimers();
		const calls = callsFake();
		const { fake, go, button, line, choose } = await storage(calls);
		await go("code/qorpera/shop");
		const endings: [CodeDownload, string][] = [
			[
				{ state: "failed", file: "files", reason: "too_large" },
				"This code is too large to download here (over 200 MB). Write to Qorpera and we will send it.",
			],
			[
				{ state: "failed", file: "files", reason: "busy" },
				"The agents are working on the code right now. Try again in a little while.",
			],
			[
				{ state: "failed", file: "files", reason: "failed" },
				"The code could not be made ready just now. Try again.",
			],
			[
				{ state: "refused", file: "files", reason: "too_many" },
				"The code has been downloaded many times today. Try again tomorrow.",
			],
			[
				{ state: "refused", file: "files", reason: "no_executor" },
				"The code could not be made ready just now. Try again.",
			],
			[
				{ state: "failed", file: "files", reason: "later_word" },
				"The code could not be made ready just now. Try again.",
			],
		];
		for (const [ending, words] of endings) {
			// Half of them end at the request, half while the web waits.
			if (ending.state === "refused") calls.request.mockResolvedValueOnce(ending);
			else {
				calls.request.mockResolvedValueOnce(queued);
				calls.read.mockResolvedValueOnce(ending);
			}
			await choose("The files");
			await vi.advanceTimersByTimeAsync(2000);
			await settle();
			expect(visibleText(line())).toBe(words);
			expect(line().querySelector("button")).toBeNull();
			expect(button()?.hasAttribute("aria-disabled")).toBe(false);
		}
		// A file the folder does not hold after all, one outside the repository's downloads, and one that cannot be read.
		calls.request.mockResolvedValueOnce(ready());
		await choose("The files");
		expect(visibleText(line())).toBe("The code could not be made ready just now. Try again.");
		const reads = fake.client.read.mock.calls.length;
		calls.request.mockResolvedValueOnce(ready("QorperaOS/secrets.zip"));
		await choose("The files");
		expect(visibleText(line())).toBe("The code could not be made ready just now. Try again.");
		expect(fake.client.read).toHaveBeenCalledTimes(reads);
		fake.made(zip, 20);
		fake.client.readFilePieces.mockRejectedValueOnce(
			new Error("Company folder object failed integrity verification"),
		);
		calls.request.mockResolvedValueOnce(ready());
		await choose("The files");
		expect(visibleText(line())).toBe("The code could not be downloaded just now. Try again.");
		expect(saved).toEqual([]);
		// Nothing of it is a word about how it went wrong inside.
		calls.request.mockRejectedValueOnce(
			new CloudRpcError("qorpera_request_code_download", { message: "No such repository", code: "P0002" }, 404),
		);
		await choose("The files");
		expect(visibleText(line())).toBe("The code could not be made ready just now. Try again.");
		// And the same press works once the file is there.
		await choose("The files");
		expect(saved.map(({ name }) => name)).toEqual(["shop-2026-11-10.zip"]);
		expect(visibleText(line())).toBe("shop-2026-11-10.zip is ready: your browser saves it in your downloads.");
	});

	it("gives up the wait after ten minutes, in words that say to come back", async () => {
		vi.useFakeTimers();
		const calls = callsFake();
		calls.request.mockResolvedValue(queued);
		calls.read.mockResolvedValue(running);
		const { go, line, choose } = await storage(calls);
		await go("code/qorpera/shop");
		await choose("The files");
		await vi.advanceTimersByTimeAsync(9 * 60_000);
		expect(visibleText(line())).toBe("Getting the code ready…Cancel");
		await vi.advanceTimersByTimeAsync(60_000 + 2000);
		await settle();
		expect(visibleText(line())).toBe("The code is not ready yet. Try again in a little while.");
		const asked = calls.read.mock.calls.length;
		expect(asked).toBeGreaterThanOrEqual(298);
		expect(asked).toBeLessThanOrEqual(300);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(calls.read).toHaveBeenCalledTimes(asked);
	});

	it("waits through a lost answer, ends after three in a row, and ends at once when it is refused", async () => {
		vi.useFakeTimers();
		const calls = callsFake();
		const { fake, go, line, choose } = await storage(calls);
		fake.made(zip, 4);
		await go("code/qorpera/shop");
		calls.request.mockResolvedValue(queued);
		calls.read
			.mockRejectedValueOnce(new Error("offline"))
			.mockRejectedValueOnce(new CloudRpcError("qorpera_code_download", { message: "Failed to fetch" }, 0))
			.mockResolvedValueOnce(running)
			.mockRejectedValueOnce(new Error("offline"))
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce(ready(zip, 4 * MIB));
		await choose("The files");
		await vi.advanceTimersByTimeAsync(6 * 2000);
		await settle();
		expect(calls.read).toHaveBeenCalledTimes(6);
		expect(saved.map(({ name }) => name)).toEqual(["shop-2026-11-10.zip"]);
		calls.read.mockReset().mockRejectedValue(new Error("offline"));
		await choose("The files");
		await vi.advanceTimersByTimeAsync(4 * 2000);
		await settle();
		expect(calls.read).toHaveBeenCalledTimes(3);
		expect(visibleText(line())).toBe("The code could not be made ready just now. Try again.");
		calls.read
			.mockReset()
			.mockRejectedValue(
				new CloudRpcError("qorpera_code_download", { message: "Code unavailable", code: "42501" }, 403),
			);
		await choose("The files");
		await vi.advanceTimersByTimeAsync(4 * 2000);
		await settle();
		expect(calls.read).toHaveBeenCalledTimes(1);
		expect(visibleText(line())).toBe("The code could not be made ready just now. Try again.");
	});

	it("stops on Cancel and when Storage closes, and says nothing then", async () => {
		vi.useFakeTimers();
		const calls = callsFake();
		calls.request.mockResolvedValue(queued);
		calls.read.mockResolvedValue(running);
		const { go, button, line, choose, browser } = await storage(calls);
		await go("code/qorpera/shop");
		await choose("The files");
		await vi.advanceTimersByTimeAsync(2000);
		expect(calls.read).toHaveBeenCalledTimes(1);
		const cancel = line().querySelector<HTMLButtonElement>("button")!;
		expect(cancel.textContent).toBe("Cancel");
		cancel.click();
		await settle();
		expect(visibleText(line())).toBe("");
		expect(button()?.hasAttribute("aria-disabled")).toBe(false);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(calls.read).toHaveBeenCalledTimes(1);
		// The file is still being made in the cloud: the same press finds it again.
		await choose("The files");
		expect(visibleText(line())).toBe("Getting the code ready…Cancel");
		await vi.advanceTimersByTimeAsync(2000);
		expect(calls.read).toHaveBeenCalledTimes(2);
		browser.dispose();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(calls.read).toHaveBeenCalledTimes(2);
		expect(saved).toEqual([]);
	});

	it("keeps the wait in sight in other folders, and how it ended until a folder outside the repository is opened", async () => {
		vi.useFakeTimers();
		const calls = callsFake({
			canDownload: true,
			repositories: [
				{ owner: "qorpera", name: "shop" },
				{ owner: "github", name: "copy" },
			],
			githubCopies: [],
		});
		calls.request.mockResolvedValueOnce(queued);
		calls.read
			.mockResolvedValueOnce(running)
			.mockResolvedValueOnce({ state: "failed", file: "files", reason: "busy" });
		const { go, button, line, choose } = await storage(calls);
		await go("code/qorpera/shop");
		await choose("The files");
		// Elsewhere the member still sees it is being made; another repository's button rests meanwhile.
		await go("notes");
		expect(button()?.hidden).toBe(true);
		expect(visibleText(line())).toBe("Getting the code ready…Cancel");
		await go("code/github/copy");
		expect(button()?.hidden).toBe(false);
		expect(button()?.getAttribute("aria-disabled")).toBe("true");
		await vi.advanceTimersByTimeAsync(4000);
		await settle();
		// How it ended is said where the member is then, and reading that folder again leaves it there.
		const busy = "The agents are working on the code right now. Try again in a little while.";
		expect(button()?.hasAttribute("aria-disabled")).toBe(false);
		expect(visibleText(line())).toBe(busy);
		await go("code/github/copy");
		expect(visibleText(line())).toBe(busy);
		// It stays in the repository's own folders, and goes once a folder outside them is opened.
		await go("code/qorpera/shop/main");
		expect(visibleText(line())).toBe(busy);
		await go("code/qorpera/shop/changes");
		expect(visibleText(line())).toBe(busy);
		await go("notes");
		expect(visibleText(line())).toBe("");
		await go("code/qorpera/shop");
		expect(visibleText(line())).toBe("");
	});

	it("hides the button for good when the cloud turns out to lack the request call", async () => {
		const calls = callsFake();
		calls.request.mockRejectedValueOnce(missing("qorpera_request_code_download"));
		const { go, button, line, choose } = await storage(calls);
		await go("code/qorpera/shop");
		await choose("The files");
		expect(button()?.hidden).toBe(true);
		expect(visibleText(line())).toBe("");
		await go("code/qorpera/shop/main");
		expect(button()?.hidden).toBe(true);
		expect(calls.list).toHaveBeenCalledTimes(1);
	});

	it("says it all in Danish too", async () => {
		vi.useFakeTimers();
		setLanguagePreference("da");
		const calls = callsFake();
		calls.request.mockResolvedValueOnce(queued).mockResolvedValueOnce(queued).mockResolvedValueOnce(queued);
		calls.read
			.mockResolvedValueOnce({ state: "failed", file: "files", reason: "too_large" })
			.mockResolvedValueOnce({ state: "failed", file: "files", reason: "busy" })
			.mockResolvedValueOnce(ready());
		const { fake, go, button, line } = await storage(calls);
		fake.made(zip, 20);
		await go("code/qorpera/shop");
		expect(visibleText(button())).toBe("Hent koden");
		const pick = async (label: string) => {
			button()!.click();
			const rows = [...document.querySelectorAll<HTMLElement>(".context-menu [role=menuitem]")];
			expect(rows.map((row) => row.textContent)).toEqual([
				"FilerneAlt, som det er nu, i én fil",
				"Med hele historikkenTil en udvikler",
			]);
			rows.find((row) => row.textContent?.startsWith(label))!.click();
			await settle();
		};
		await pick("Filerne");
		expect(visibleText(line())).toBe("Gør koden klar…Annuller");
		await vi.advanceTimersByTimeAsync(2000);
		await settle();
		expect(visibleText(line())).toBe(
			"Koden er for stor til at hente her (over 200 MB). Skriv til Qorpera, så sender vi den.",
		);
		await pick("Med hele");
		await vi.advanceTimersByTimeAsync(2000);
		await settle();
		expect(visibleText(line())).toBe("Agenterne arbejder på koden lige nu. Prøv igen om lidt.");
		await pick("Filerne");
		await vi.advanceTimersByTimeAsync(2000);
		await settle();
		expect(visibleText(line())).toBe("shop-2026-11-10.zip er klar: din browser gemmer den i dine overførsler.");
	});

	/** Every state the line can be in, as the member reads it, in each language. */
	const STATES = {
		en: {
			waiting: "Getting the code ready…Cancel",
			reading: "Downloading the code…20%Cancel",
			handed: "shop-2026-11-10.zip is ready: your browser saves it in your downloads.",
			late: "The code is not ready yet. Try again in a little while.",
			tooLarge: "This code is too large to download here (over 200 MB). Write to Qorpera and we will send it.",
			busy: "The agents are working on the code right now. Try again in a little while.",
			tooMany: "The code has been downloaded many times today. Try again tomorrow.",
			other: "The code could not be made ready just now. Try again.",
			unread: "The code could not be downloaded just now. Try again.",
		},
		da: {
			waiting: "Gør koden klar…Annuller",
			reading: "Henter koden…20%Annuller",
			handed: "shop-2026-11-10.zip er klar: din browser gemmer den i dine overførsler.",
			late: "Koden er ikke klar endnu. Prøv igen om lidt.",
			tooLarge: "Koden er for stor til at hente her (over 200 MB). Skriv til Qorpera, så sender vi den.",
			busy: "Agenterne arbejder på koden lige nu. Prøv igen om lidt.",
			tooMany: "Koden er hentet mange gange i dag. Prøv igen i morgen.",
			other: "Koden kunne ikke gøres klar lige nu. Prøv igen.",
			unread: "Koden kunne ikke hentes lige nu. Prøv igen.",
		},
	} as const;

	for (const language of ["en", "da"] as const)
		it(`says every state of a download in its own words (${language})`, async () => {
			vi.useFakeTimers();
			setLanguagePreference(language);
			const words = STATES[language];
			const calls = callsFake();
			const { fake, go, button, line } = await storage(calls);
			fake.made(zip, 20);
			await go("code/qorpera/shop");
			/** The menu's first choice, the files, whatever the language. */
			const pick = async () => {
				button()!.click();
				document.querySelector<HTMLElement>(".context-menu [role=menuitem]")!.click();
				await settle();
			};
			// Asked for and being made; then read from the folder, saying how far; then handed to the browser.
			calls.request.mockResolvedValueOnce(queued);
			calls.read.mockResolvedValueOnce(ready());
			const pieces = fake.client.readFilePieces.getMockImplementation()!;
			const read: string[] = [];
			fake.client.readFilePieces.mockImplementationOnce(async (reference, signal, onPiece) =>
				pieces(reference, signal, (piece, index, count) => {
					onPiece(piece, index, count);
					read.push(visibleText(line()));
				}),
			);
			await pick();
			expect(visibleText(line())).toBe(words.waiting);
			await vi.advanceTimersByTimeAsync(2000);
			await settle();
			expect(read[0]).toBe(words.reading);
			expect(visibleText(line())).toBe(words.handed);
			expect(saved.map(({ name }) => name)).toEqual(["shop-2026-11-10.zip"]);
			// Each way it ends without a file.
			const ends: [CodeDownload, string][] = [
				[{ state: "failed", file: "files", reason: "too_large" }, words.tooLarge],
				[{ state: "failed", file: "files", reason: "busy" }, words.busy],
				[{ state: "refused", file: "files", reason: "too_many" }, words.tooMany],
				[{ state: "refused", file: "files", reason: "no_executor" }, words.other],
				[{ state: "failed", file: "files", reason: "failed" }, words.other],
				[{ state: "failed", file: "files", reason: "later_word" }, words.other],
			];
			for (const [end, said] of ends) {
				calls.request.mockResolvedValueOnce(end);
				await pick();
				expect(visibleText(line())).toBe(said);
			}
			// The file could not be read from the folder.
			fake.client.readFilePieces.mockRejectedValueOnce(new Error("offline"));
			calls.request.mockResolvedValueOnce(ready());
			await pick();
			expect(visibleText(line())).toBe(words.unread);
			// Still being made after ten minutes.
			calls.request.mockResolvedValueOnce(queued);
			calls.read.mockResolvedValue(running);
			await pick();
			await vi.advanceTimersByTimeAsync(10 * 60_000 + 2000);
			await settle();
			expect(visibleText(line())).toBe(words.late);
			// Cancelled: nothing is said.
			calls.request.mockResolvedValueOnce(queued);
			await pick();
			line().querySelector<HTMLButtonElement>("button")!.click();
			await settle();
			expect(visibleText(line())).toBe("");
		});
});

describe("a GitHub project's working copy, named on its folder in Storage", () => {
	const storefront = { owner: "qorpera", name: "saml-storefront", github: "Qorpera/saml-storefront" };
	const withCopies = (canDownload = true, githubCopies = [storefront]): CodeRepositories => ({
		canDownload,
		repositories: [{ owner: "qorpera", name: "shop" }],
		githubCopies,
	});

	it("says what the folder is in one quiet line under the top line, to every member, there and below it", async () => {
		for (const canDownload of [true, false]) {
			const calls = callsFake(withCopies(canDownload));
			const { go, button, importLine: line, line: downloads, host } = await storage(calls);
			await go("code/qorpera/saml-storefront");
			expect(visibleText(line())).toBe("Copy of the GitHub project saml-storefront");
			// The kept repository's own line, as it is: the status line under the top line, with no button in it, and
			// no download to offer here.
			expect(line().previousElementSibling?.classList.contains("storage-toolbar")).toBe(true);
			expect(line().classList.contains("storage-code-line")).toBe(true);
			expect(line().getAttribute("role")).toBe("status");
			expect(line().querySelectorAll("*")).toHaveLength(1);
			expect(visibleText(downloads())).toBe("");
			expect(
				host.querySelectorAll(".storage-toolbar > button:not([hidden], .storage-download-button)"),
			).toHaveLength(0);
			expect(button()?.hidden).toBe(true);
			// A founder reads it: no path, branch, commit or repository.
			expect(line().textContent).not.toMatch(/\/|branch|commit|repositor|git(?!hub)/i);
			await go("code/qorpera/saml-storefront/repo.git");
			expect(visibleText(line())).toBe("Copy of the GitHub project saml-storefront");
			expect(calls.list).toHaveBeenCalledTimes(1);
			// Nowhere else: not beside it, not on the code kept in Qorpera, not outside the code.
			for (const path of ["code/qorpera", "code/qorpera/shop", "code/github/copy", "code", "notes"]) {
				await go(path);
				expect(visibleText(line()), path).toBe("");
			}
			expect(button()?.hidden).toBe(true);
			for (const dispose of disposers.splice(0)) dispose();
			document.body.replaceChildren();
		}
	});

	it("names the project as GitHub spells it, and says it in Danish", async () => {
		const spelled = { ...storefront, github: "Qorpera/SAML-Storefront" };
		const english = await storage(callsFake(withCopies(true, [spelled])));
		await english.go("code/qorpera/saml-storefront");
		expect(visibleText(english.importLine())).toBe("Copy of the GitHub project SAML-Storefront");
		setLanguagePreference("da");
		const danish = await storage(callsFake(withCopies()));
		await danish.go("code/qorpera/saml-storefront");
		expect(visibleText(danish.importLine())).toBe("Kopi af GitHub-projektet saml-storefront");
	});

	it("leaves the code kept in Qorpera as it is, should the list name it both ways", async () => {
		const calls = callsFake({
			canDownload: true,
			repositories: [{ owner: "qorpera", name: "shop" }],
			githubCopies: [{ owner: "qorpera", name: "shop", github: "Qorpera/shop" }],
		});
		const { go, button, importLine } = await storage(calls);
		await go("code/qorpera/shop");
		expect(button()?.hidden).toBe(false);
		expect(visibleText(importLine())).toBe("");
	});

	it("keeps saying what the folder is while a download's end is said under it, which goes in the next folder", async () => {
		vi.useFakeTimers();
		const calls = callsFake(withCopies());
		calls.request.mockResolvedValueOnce(queued);
		calls.read.mockResolvedValueOnce({ state: "failed", file: "files", reason: "busy" });
		const { go, line, importLine, choose } = await storage(calls);
		await go("code/qorpera/shop");
		await choose("The files");
		await go("code/qorpera/saml-storefront");
		expect(visibleText(importLine())).toBe("Copy of the GitHub project saml-storefront");
		expect(visibleText(line())).toBe("Getting the code ready…Cancel");
		await vi.advanceTimersByTimeAsync(2000);
		await settle();
		expect(visibleText(importLine())).toBe("Copy of the GitHub project saml-storefront");
		expect(visibleText(line())).toBe("The agents are working on the code right now. Try again in a little while.");
		// The folder's line first, then the download's.
		expect(importLine().nextElementSibling).toBe(line());
		await go("code/qorpera/saml-storefront/repo.git");
		expect(visibleText(importLine())).toBe("Copy of the GitHub project saml-storefront");
		expect(visibleText(line())).toBe("");
	});

	it("leaves Storage exactly as it was when the list has no such key, or one it cannot read", async () => {
		const answer = {
			schema: "qorpera.code-repositories/v1",
			canDownload: true,
			repositories: [{ owner: "qorpera", name: "shop", changes: 3, downloads: [] }],
		};
		/** Storage, through the real calls and their parse, over a cloud that answers the list with `list`: what it draws
		 * on the copy's folder and on the kept code's. */
		const drawn = async (list: unknown) => {
			const rpc = vi.fn(async (name: string): Promise<unknown> => {
				if (name === "qorpera_list_code_repositories") return list;
				throw new Error(`unexpected ${name}`);
			});
			const cloud = { rpc } as unknown as Cloud;
			const { go, host, line, button } = await storage(codeDownloadCalls(cloud, profileA.profileId));
			const seen: string[] = [];
			for (const path of ["code/qorpera/saml-storefront", "code/qorpera/shop"]) {
				await go(path);
				seen.push(host.querySelector(".storage-documents")!.innerHTML);
			}
			const result = { seen, line: visibleText(line()), shown: button()?.hidden === false };
			for (const dispose of disposers.splice(0)) dispose();
			document.body.replaceChildren();
			return result;
		};
		const before = await drawn(answer);
		expect(before.line).toBe("");
		expect(before.shown).toBe(true);
		expect(before.seen[0]).not.toContain("GitHub");
		for (const githubCopies of [
			null,
			"Qorpera/saml-storefront",
			{ "qorpera/saml-storefront": "Qorpera/saml-storefront" },
			[storefront, { owner: "qorpera", name: "storefront" }],
			[{ ...storefront, github: "github.com/Qorpera/saml-storefront" }],
			[{ ...storefront, owner: "Qorpera" }],
		])
			expect(await drawn({ ...answer, githubCopies }), JSON.stringify(githubCopies)).toEqual(before);
		// And with the key as it comes, the copy's folder alone has its line.
		const after = await drawn({ ...answer, githubCopies: [storefront] });
		expect(after.seen[0]).not.toBe(before.seen[0]);
		expect(after.seen[1]).toBe(before.seen[1]);
	});
});
