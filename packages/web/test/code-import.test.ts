// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import type {
	CloudMemberFolderChangesPage,
	CloudMemberFolderEntry,
	CloudMemberFolderHistory,
	CloudMemberFolderListPage,
} from "@qorpera/cloud-client/cloud-member-folder";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { githubAddress, importDoneWords, importStepWords, importWhy } from "../src/app/views/code-import.ts";
import { CompanyFolderBrowser, type CompanyFolderSource } from "../src/app/views/company-folder.ts";
import { type Cloud, CloudRpcError } from "../src/cloud/client.ts";
import {
	type CodeBringing,
	type CodeDownload,
	type CodeDownloadCalls,
	type CodeDownloadKind,
	type CodeImportAnswer,
	type CodeImportEnd,
	type CodeRepositories,
	type CodeRepository,
	codeDownloadCalls,
	parseCodeImportAnswer,
	parseCodeRepositories,
} from "../src/cloud/code-downloads.ts";
import { CloudShapeError } from "../src/cloud/parse.ts";
import { setLanguagePreference } from "../src/ui/preferences.ts";
import { deferred, id, profileA, settle, visibleText } from "./fixtures.ts";

/* "Bring code in" (own code storage, step 6, migration 20260930736000): the list's import keys and the ask as the web
 * reads them (cloud/code-downloads.ts), the address a member pastes, the words of every step and reason
 * (app/views/code-import.ts), and the button, its question and the line in Storage, before and after the SQL. */

const at = "2026-11-12T09:12:33.000000+00:00";
const storefront = { owner: "qorpera", name: "saml-storefront", github: "Qorpera/saml-storefront" };
const bringingShop = (step: string | null, waiting = false): CodeBringing => ({
	owner: "acme",
	name: "shop",
	github: "Acme/Shop",
	step,
	waiting,
});
const keptShop: CodeRepository = {
	owner: "acme",
	name: "shop",
	imported: { from: "github", at, earlierChanges: 1204 },
};
const lastShop = (reason: string, github: string | null = null): CodeImportEnd => ({
	owner: "acme",
	name: "shop",
	reason,
	github,
});

function codeList(
	options: {
		canDownload?: boolean;
		repositories?: CodeRepository[];
		bringing?: CodeBringing[];
		last?: CodeImportEnd | null;
		imports?: false;
	} = {},
): CodeRepositories {
	return {
		canDownload: options.canDownload ?? true,
		repositories: options.repositories ?? [{ owner: "qorpera", name: "notes" }],
		githubCopies: [storefront],
		...(options.imports === false
			? {}
			: { imports: { bringing: options.bringing ?? [], last: options.last ?? null } }),
	};
}

function callsFake(list: CodeRepositories = codeList()) {
	return {
		list: vi.fn(async (_signal: AbortSignal): Promise<CodeRepositories> => list),
		request: vi.fn(
			async (
				_owner: string,
				_name: string,
				_file: CodeDownloadKind,
				_signal: AbortSignal,
			): Promise<CodeDownload> => {
				throw new Error("no download here");
			},
		),
		read: vi.fn(async (_requestId: string, _signal: AbortSignal): Promise<CodeDownload> => {
			throw new Error("no download here");
		}),
		bringIn: vi.fn(
			async (_owner: string, _name: string, _github: string, _signal: AbortSignal): Promise<CodeImportAnswer> => ({
				state: "queued",
				requestId: id(900),
			}),
		),
	};
}

/** The company folder: the code kept in Qorpera at code/qorpera/notes, a GitHub copy at code/qorpera/saml-storefront,
 * the place code/acme/shop that an import fills, the platform's set-aside folder, and a folder beside the code. A test
 * changes `folders` and `files` (path → text) as the code host would, and moves the folder's sequence on (`seq`); no hint
 * or feed says so. Recents holds one change. */
function folderFake() {
	const files = new Map<string, string>();
	let asOfSeq = 4;
	const folders = new Set([
		"notes",
		"code",
		"code/_set-aside",
		"code/qorpera",
		"code/qorpera/notes",
		"code/qorpera/notes/main",
		"code/qorpera/saml-storefront",
		"code/qorpera/saml-storefront/repo.git",
		"code/acme",
		"code/acme/shop",
		"code/acme/shop/main",
	]);
	const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
	const entry = (path: string): CloudMemberFolderEntry | null => {
		const text = files.get(path);
		if (text !== undefined)
			return {
				path,
				kind: "file",
				version: id(101),
				seq: 1,
				updatedAt: at,
				file: {
					manifestSha256: "a".repeat(64),
					fileSha256: "b".repeat(64),
					bytes: text.length,
					mediaType: "application/json",
					executable: false,
				},
				target: null,
			};
		return folders.has(path)
			? { path, kind: "folder", version: id(100), seq: 1, updatedAt: at, file: null, target: null }
			: null;
	};
	return {
		folders,
		files,
		seq(next: number) {
			asOfSeq = next;
		},
		list: vi.fn(
			async (parent: string | null): Promise<CloudMemberFolderListPage> => ({
				asOfSeq,
				entries: [...folders, ...files.keys()]
					.filter((path) => parentOf(path) === (parent ?? ""))
					.map((path) => entry(path)!),
				next: null,
			}),
		),
		read: vi.fn(async (path: string) => ({ asOfSeq, entry: entry(path) })),
		readFile: vi.fn(async () => new Uint8Array()),
		readFilePieces: vi.fn(async () => {}),
		pathHistory: vi.fn(),
		history: vi.fn(
			async (): Promise<CloudMemberFolderHistory> => ({
				asOfSeq,
				items: [
					{
						seq: 3,
						at,
						by: { kind: "platform" },
						paths: [{ path: "notes/plan.md", op: "write", kind: "file", version: id(103) }],
						more: false,
					},
				],
				next: null,
			}),
		),
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
}

const disposers: (() => void)[] = [];
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
});
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	HTMLDialogElement.prototype.showModal = showModal;
	HTMLDialogElement.prototype.close = close;
	setLanguagePreference("system");
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});

/** Storage with the fake folder, as Settings embeds it. */
async function storage(calls: CodeDownloadCalls) {
	const folder = folderFake();
	const stop = new AbortController();
	const source: CompanyFolderSource = {
		signal: stop.signal,
		current: () => stop.signal.throwIfAborted(),
		folder: () => folder,
		folderHints: () => ({ close: async () => {} }),
		codeDownloads: () => calls,
	};
	const host = document.createElement("section");
	document.body.append(host);
	const browser = new CompanyFolderBrowser(host, source, () => ({ me: id(1), members: [], staff: [] }));
	disposers.push(() => browser.dispose());
	await browser.open();
	await settle();
	const go = async (path: string) => {
		browser.reveal(path);
		await settle();
		await settle();
	};
	const button = () => host.querySelector<HTMLButtonElement>(".storage-import-button")!;
	const line = () => host.querySelector<HTMLElement>(".storage-import-line")!;
	const question = () => document.querySelector<HTMLFormElement>(".code-import-question");
	const field = () => question()?.querySelector<HTMLInputElement>("input") ?? null;
	const pressed = (label: string) =>
		[...(question()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((each) => each.textContent === label);
	/** Types an address into the question and sends it. */
	const send = async (address: string) => {
		const input = field()!;
		input.value = address;
		question()!.requestSubmit();
		await settle();
	};
	/** The open folder's rows, by name, and its count. */
	const names = () =>
		[...host.querySelectorAll<HTMLElement>(".files-list > .files-row .files-name")].map((name) => name.textContent);
	const count = () => host.querySelector(".storage-count")?.textContent;
	/** How often the folder at `path` was listed. */
	const listed = (path: string) => folder.list.mock.calls.filter(([parent]) => parent === path).length;
	return { host, browser, stop, go, button, line, question, field, pressed, send, folder, names, count, listed };
}

describe("a GitHub address, as a member pastes it", () => {
	it("names the project, and the place it lands at in lower case", () => {
		const shop = { owner: "acme", name: "shop", github: "Acme/Shop", label: "Shop" };
		for (const form of [
			"github.com/Acme/Shop",
			"https://github.com/Acme/Shop",
			"http://github.com/Acme/Shop/",
			"https://www.github.com/Acme/Shop.git",
			"  Acme/Shop  ",
			"Acme/Shop",
			"Acme/Shop.git",
			"Acme/Shop/",
			"git@github.com:Acme/Shop.git",
			"ssh://git@github.com/Acme/Shop",
			"https://github.com/Acme/Shop/tree/main/src",
			"https://github.com/Acme/Shop/pulls",
			"https://github.com/Acme/Shop?tab=readme-ov-file",
			"https://github.com/Acme/Shop#readme",
			"GitHub.com/Acme/Shop",
		])
			expect(githubAddress(form), form).toEqual(shop);
		expect(githubAddress("github.com/acme-co/web.site_2")).toEqual({
			owner: "acme-co",
			name: "web.site_2",
			github: "acme-co/web.site_2",
			label: "web.site_2",
		});
		for (const wrong of [
			"",
			"shop",
			"github.com/acme",
			"https://github.com/",
			"https://gitlab.com/acme/shop",
			"ftp://github.com/acme/shop",
			"acme/shop/tree/main",
			"/acme/shop",
			"acme//shop",
			"-acme/shop",
			"acme-/shop",
			"acme/.shop",
			"acme/shop.",
			"a b/shop",
			"github.com/acme/shop name",
			`acme/${"s".repeat(101)}`,
			`${"a".repeat(40)}/shop`,
		])
			expect(githubAddress(wrong), wrong).toBeNull();
	});
});

describe("the words of an import", () => {
	const name = "Shop";
	const steps: [Pick<CodeBringing, "github" | "step" | "waiting">, string, string][] = [
		[
			{ github: "Acme/Shop", step: null, waiting: false },
			"Bringing in Shop: Getting it from GitHub…",
			"Henter Shop ind: Henter den fra GitHub…",
		],
		[
			{ github: "Acme/Shop", step: "fetch", waiting: false },
			"Bringing in Shop: Getting it from GitHub…",
			"Henter Shop ind: Henter den fra GitHub…",
		],
		[
			{ github: null, step: null, waiting: false },
			"Bringing in Shop: Reading the file…",
			"Henter Shop ind: Læser filen…",
		],
		[
			{ github: null, step: "read", waiting: false },
			"Bringing in Shop: Reading the file…",
			"Henter Shop ind: Læser filen…",
		],
		[
			{ github: "Acme/Shop", step: "look", waiting: false },
			"Bringing in Shop: Checking it…",
			"Henter Shop ind: Tjekker den…",
		],
		[
			{ github: "Acme/Shop", step: "look", waiting: true },
			"Bringing in Shop: Waiting for the agents to finish what they are doing…",
			"Henter Shop ind: Venter på, at agenterne bliver færdige med det, de er i gang med…",
		],
		...["close", "set-aside", "build", "open", "tidy", "a-later-step"].map(
			(step): [Pick<CodeBringing, "github" | "step" | "waiting">, string, string] => [
				{ github: "Acme/Shop", step, waiting: false },
				"Bringing in Shop: Putting it in place…",
				"Henter Shop ind: Lægger den på plads…",
			],
		),
	];

	it("says each step in plain words, and the wait for the agents", () => {
		for (const [bringing, english] of steps) expect(importStepWords(bringing, name)).toBe(english);
		setLanguagePreference("da");
		for (const [bringing, , danish] of steps) expect(importStepWords(bringing, name)).toBe(danish);
	});

	const reasons: [string[], string, string][] = [
		[
			["IMPORT_TOO_LARGE", "IMPORT_TOO_LARGE:PLACE_AS_BEFORE", "CODE_HOST_BUNDLE_TOO_LARGE"],
			"it is larger than 1 GB, the most Qorpera brings in",
			"den er større end 1 GB, som er det meste, Qorpera henter ind",
		],
		[
			["IMPORT_SOURCE_REFUSED"],
			"GitHub did not let Qorpera read it; check the address, and that the company's GitHub connection can see it",
			"GitHub lod ikke Qorpera læse den; tjek adressen, og at virksomhedens GitHub-forbindelse kan se den",
		],
		[
			["IMPORT_SOURCE_MOVED"],
			"GitHub says it has moved; use its new address",
			"GitHub siger, at den er flyttet; brug den nye adresse",
		],
		[
			["IMPORT_USES_LFS"],
			"it keeps large files outside the code, and Qorpera can't bring those in yet",
			"den gemmer store filer uden for koden, og dem kan Qorpera ikke hente ind endnu",
		],
		[
			["IMPORT_USES_SUBMODULES"],
			"it is made of other projects, and Qorpera can't bring those in yet",
			"den består af andre projekter, og dem kan Qorpera ikke hente ind endnu",
		],
		[
			// An error of git's check, alone or with its message id (the executor's codeImportHistoryCode).
			["IMPORT_HISTORY_DAMAGED", "IMPORT_HISTORY_DAMAGED_MISSING_TREE", "IMPORT_HISTORY_DAMAGED_BAD_OBJECT_SHA1"],
			"its history has damage Qorpera can't take in",
			"dens historik har skader, som Qorpera ikke kan tage ind",
		],
		[
			["IMPORT_HISTORY_ZERO_PADDED_FILEMODE", "IMPORT_HISTORY_MISSINGTAGGERENTRY"],
			"its history is stored in an old way Qorpera can't take in yet",
			"dens historik er gemt på en gammel måde, som Qorpera ikke kan tage ind endnu",
		],
		// The executor's refusals that trying again cannot help.
		[["IMPORT_SOURCE_EMPTY"], "there is nothing in it yet", "der er ikke noget i den endnu"],
		[
			["IMPORT_SHA256_REPOSITORY"],
			"it is stored in a new format Qorpera can't bring in yet",
			"den er gemt i et nyt format, som Qorpera ikke kan hente ind endnu",
		],
		[
			["CODE_HOST_FILE_TOO_LARGE"],
			"it has a file larger than Qorpera can keep",
			"den har en fil, der er større, end Qorpera kan gemme",
		],
		[
			["IMPORT_BRANCH_UNKNOWN"],
			"Qorpera could not tell which version of it is the main one",
			"Qorpera kunne ikke se, hvilken version af den der er hovedversionen",
		],
		[["IMPORT_FILE_NOT_WHOLE"], "the file was not complete", "filen var ikke komplet"],
		// An earlier import's half-done snapshot at the place (part C3).
		[
			["IMPORT_PLACE_HALF_DONE"],
			"an earlier bring-in stopped half way at this place; bring the same project in again to finish it",
			"en tidligere hentning stoppede halvvejs på denne plads; hent det samme projekt ind igen for at gøre den færdig",
		],
		[
			[
				"IMPORT_TOO_MANY_ENTRIES",
				"IMPORT_TOO_MANY_FILES",
				"IMPORT_TOO_MANY_REFS",
				"IMPORT_NAMES_REFUSED",
				"CODE_HOST_NAMES_NOT_NFC",
				// A path the company folder refuses where main will stand (part B).
				"CODE_HOST_NAMES_FOLDER_REFUSES",
				"IMPORT_BRANCH_NAME",
			],
			"it has more files, or names, than Qorpera can keep",
			"den har flere filer eller navne, end Qorpera kan gemme",
		],
		[
			["kept_here", "already_here"],
			"a project with that name is already kept here",
			"et projekt med det navn ligger her allerede",
		],
		[
			["busy"],
			"other code is being brought in right now; try again when it is done",
			"der hentes allerede anden kode ind; prøv igen, når det er færdigt",
		],
		[
			["sessions_open"],
			"agents are still working on it on GitHub; try again when they are done",
			"agenter arbejder stadig på den på GitHub; prøv igen, når de er færdige",
		],
		[
			[
				"failed",
				"no_executor",
				"deleting",
				"IMPORT_SOURCE_ERROR",
				"IMPORT_NO_SPACE",
				"CODE_HOST_RESTORE_FAILED:PLACE_AS_BEFORE",
				"DID_NOT_FINISH",
				"a_word_from_later",
				"",
			],
			"it could not be brought in just now; try again",
			"den kunne ikke hentes ind lige nu; prøv igen",
		],
	];

	it("says why it was not brought in, for every reason, and never shows a code", () => {
		// A member may not know git: no reason names it, nor a branch, a commit, a repository or a bundle.
		const gitWords = /\bgit\b|git-|branch|commit|repositor|bundle|\bgren/i;
		for (const [codes, english] of reasons)
			for (const code of codes) {
				expect(importWhy(code), code).toBe(english);
				expect(importWhy(code)).not.toMatch(/[A-Z]{2,}_|_[A-Z]|:/);
				expect(importWhy(code), code).not.toMatch(gitWords);
			}
		// A file (an agent's bundle) has its own bound, 256 MB: the same code says so.
		expect(importWhy("IMPORT_TOO_LARGE", true)).toBe(
			"it is larger than 256 MB, the most Qorpera brings in from a file",
		);
		expect(importWhy("IMPORT_TOO_LARGE:PLACE_AS_BEFORE", true)).toBe(
			"it is larger than 256 MB, the most Qorpera brings in from a file",
		);
		expect(importWhy("IMPORT_USES_LFS", true)).toBe(importWhy("IMPORT_USES_LFS"));
		setLanguagePreference("da");
		for (const [codes, , danish] of reasons)
			for (const code of codes) {
				expect(importWhy(code), code).toBe(danish);
				expect(importWhy(code), code).not.toMatch(gitWords);
			}
		expect(importWhy("IMPORT_TOO_LARGE", true)).toBe(
			"den er større end 256 MB, som er det meste, Qorpera henter ind fra en fil",
		);
	});

	it("says where brought-in code came from, when, and what came with it", () => {
		const github = { from: "github", at, earlierChanges: 1204 } as const;
		const file = { from: "file", at, earlierChanges: 1 } as const;
		const lines: [Parameters<typeof importDoneWords>[0], string, string][] = [
			[
				github,
				"Brought in from GitHub on November 12, 2026. 1,204 earlier changes came with it. The copy on GitHub stays as it is.",
				"Hentet ind fra GitHub den 12. november 2026. 1.204 tidligere ændringer kom med. Kopien på GitHub forbliver, som den er.",
			],
			[
				file,
				"Brought in from a file on November 12, 2026. 1 earlier change came with it.",
				"Hentet ind fra en fil den 12. november 2026. 1 tidligere ændring kom med.",
			],
			[
				{ ...github, earlierChanges: null },
				"Brought in from GitHub on November 12, 2026. The copy on GitHub stays as it is.",
				"Hentet ind fra GitHub den 12. november 2026. Kopien på GitHub forbliver, som den er.",
			],
		];
		setLanguagePreference("en");
		for (const [imported, english] of lines) expect(importDoneWords(imported)).toBe(english);
		setLanguagePreference("da");
		for (const [imported, , danish] of lines) expect(importDoneWords(imported)).toBe(danish);
	});

	it("says the other lines of work that came with it, and that an agent can bring them in only while nothing changed since", () => {
		const github = { from: "github", at, earlierChanges: 1, lastChange: 1 } as const;
		const brought = "Brought in from GitHub on November 12, 2026. 1 earlier change came with it.";
		const hentet = "Hentet ind fra GitHub den 12. november 2026. 1 tidligere ændring kom med.";
		const next = "An agent can bring that work into the main version.";
		const næste = "En agent kan føje det arbejde til hovedversionen.";
		const github2 = "The copy on GitHub stays as it is.";
		const github2da = "Kopien på GitHub forbliver, som den er.";
		const lines: [Parameters<typeof importDoneWords>[0], string, string][] = [
			[
				{ ...github, otherWork: { lines: 1, changes: 1 } },
				`${brought} It also brought 1 other line of work, with 1 change that was not in the main version. ${next} ${github2}`,
				`${hentet} Den havde også 1 andet arbejdsspor med, med 1 ændring, som ikke var i hovedversionen. ${næste} ${github2da}`,
			],
			[
				// saml-storefront's, as the plan reads it.
				{ ...github, otherWork: { lines: 1, changes: 2 } },
				`${brought} It also brought 1 other line of work, with 2 changes that were not in the main version. ${next} ${github2}`,
				`${hentet} Den havde også 1 andet arbejdsspor med, med 2 ændringer, som ikke var i hovedversionen. ${næste} ${github2da}`,
			],
			[
				{ ...github, otherWork: { lines: 3, changes: 1 } },
				`${brought} It also brought 3 other lines of work, with 1 change that was not in the main version. ${next} ${github2}`,
				`${hentet} Den havde også 3 andre arbejdsspor med, med 1 ændring, som ikke var i hovedversionen. ${næste} ${github2da}`,
			],
			[
				// In the member's numbers; and once the place has a change after change 1, no next step.
				{ ...github, otherWork: { lines: 1200, changes: 4321 }, lastChange: 2 },
				`${brought} It also brought 1,200 other lines of work, with 4,321 changes that were not in the main version. ${github2}`,
				`${hentet} Den havde også 1.200 andre arbejdsspor med, med 4.321 ændringer, som ikke var i hovedversionen. ${github2da}`,
			],
			[
				// The last change not known: no next step either.
				{ from: "file", at, earlierChanges: 1, otherWork: { lines: 2, changes: 5 } },
				"Brought in from a file on November 12, 2026. 1 earlier change came with it. It also brought 2 other lines of work, with 5 changes that were not in the main version.",
				"Hentet ind fra en fil den 12. november 2026. 1 tidligere ændring kom med. Den havde også 2 andre arbejdsspor med, med 5 ændringer, som ikke var i hovedversionen.",
			],
			[
				// No other work: as before, whatever the last change.
				github,
				`${brought} ${github2}`,
				`${hentet} ${github2da}`,
			],
		];
		// A member never reads git, a branch, a commit, a ref, a merge or a repository, in either language.
		const gitWords = /\bgit\b|git-|branch|commit|\bref|merge|repositor|bundle|\bgren|\bflet/i;
		setLanguagePreference("en");
		for (const [imported, english] of lines) {
			expect(importDoneWords(imported)).toBe(english);
			expect(importDoneWords(imported)).not.toMatch(gitWords);
		}
		setLanguagePreference("da");
		for (const [imported, , danish] of lines) {
			expect(importDoneWords(imported)).toBe(danish);
			expect(importDoneWords(imported)).not.toMatch(gitWords);
		}
	});
});

describe("the import's keys and its ask, as the web reads them (cloud/code-downloads.ts)", () => {
	const answer = {
		schema: "qorpera.code-repositories/v1",
		canDownload: true,
		repositories: [{ owner: "qorpera", name: "notes", changes: 3, downloads: [] }],
		githubCopies: [storefront],
	};
	const kept = {
		canDownload: true,
		repositories: [{ owner: "qorpera", name: "notes" }],
		githubCopies: [storefront],
	};

	it("reads what is being brought in, the last that was not, and where kept code came from", () => {
		const startedAt = at;
		expect(
			parseCodeRepositories({
				...answer,
				repositories: [
					{ owner: "qorpera", name: "notes", changes: 3, downloads: [], importedFrom: null, importedAt: null },
					{
						owner: "acme",
						name: "shop",
						changes: 1,
						downloads: [],
						importedFrom: {
							kind: "github",
							repository: "Acme/Shop",
							via: "public",
							branch: "main",
							commits: 1204,
						},
						importedAt: at,
						earlierChanges: 1204,
					},
					{
						owner: "acme",
						name: "zipped",
						importedFrom: { kind: "file", name: "zipped.bundle" },
						importedAt: at,
						earlierChanges: null,
					},
				],
				bringing: [
					{
						owner: "acme",
						name: "web",
						from: { github: "Acme/Web" },
						step: "look",
						waiting: "SESSIONS_OPEN",
						startedAt,
					},
				],
				lastImport: { owner: "acme", name: "old", state: "failed", reason: "IMPORT_TOO_LARGE" },
			}),
		).toEqual({
			...kept,
			repositories: [
				{ owner: "qorpera", name: "notes" },
				{ owner: "acme", name: "shop", imported: { from: "github", at, earlierChanges: 1204, lastChange: 1 } },
				{ owner: "acme", name: "zipped", imported: { from: "file", at, earlierChanges: null } },
			],
			imports: {
				bringing: [{ owner: "acme", name: "web", github: "Acme/Web", step: "look", waiting: true }],
				last: { owner: "acme", name: "old", reason: "IMPORT_TOO_LARGE", github: null },
			},
		});
		// Where the last one came from, should the list say: its GitHub spelling names it.
		expect(
			parseCodeRepositories({
				...answer,
				bringing: [],
				lastImport: { owner: "acme", name: "old", reason: "IMPORT_TOO_LARGE", from: { github: "Acme/Old" } },
			}).imports?.last,
		).toEqual({ owner: "acme", name: "old", reason: "IMPORT_TOO_LARGE", github: "Acme/Old" });
		// One from a file says so, by its file's name (A2 sends the bundle's name, never its path).
		expect(
			parseCodeRepositories({
				...answer,
				bringing: [],
				lastImport: { owner: "acme", name: "old", reason: "IMPORT_TOO_LARGE", from: { file: "old.bundle" } },
			}).imports?.last,
		).toEqual({ owner: "acme", name: "old", reason: "IMPORT_TOO_LARGE", github: null, file: true });
		expect(
			parseCodeRepositories({
				...answer,
				bringing: [
					{
						owner: "acme",
						name: "zipped",
						from: { file: "code/_incoming/z/zipped.bundle" },
						step: null,
						waiting: false,
					},
				],
				lastImport: null,
			}).imports,
		).toEqual({
			bringing: [{ owner: "acme", name: "zipped", github: null, step: null, waiting: false }],
			last: null,
		});
		expect(parseCodeRepositories({ ...answer, bringing: [] }).imports).toEqual({ bringing: [], last: null });
	});

	it("offers no import on a cloud without the bringing key, or with one it cannot read, and reads the rest as before", () => {
		expect(parseCodeRepositories(answer)).toEqual(kept);
		for (const bringing of [
			null,
			{},
			"Acme/Web",
			[null],
			[{ owner: "acme", name: "web" }],
			[{ owner: "acme", name: "web", from: { github: "github.com/Acme/Web" } }],
			[{ owner: "acme", name: "web", from: {} }],
			[{ owner: "", name: "web", from: { github: "Acme/Web" } }],
			[{ owner: "acme", name: "web", from: { github: "Acme/Web" }, step: 3 }],
		])
			expect(parseCodeRepositories({ ...answer, bringing }), JSON.stringify(bringing)).toEqual(kept);
		// A last import or a repository's origin that is not as expected is left out alone.
		for (const lastImport of [{}, { owner: "acme" }, { owner: "acme", name: "x", reason: 3 }, "IMPORT_TOO_LARGE"])
			expect(parseCodeRepositories({ ...answer, bringing: [], lastImport }).imports).toEqual({
				bringing: [],
				last: null,
			});
		for (const [importedFrom, importedAt] of [
			[{ kind: "github" }, "not a time"],
			[{ kind: "svn" }, at],
			["github", at],
			[{ kind: "github" }, null],
		])
			expect(
				parseCodeRepositories({
					...answer,
					repositories: [{ owner: "acme", name: "shop", importedFrom, importedAt }],
				}).repositories,
			).toEqual([{ owner: "acme", name: "shop" }]);
		expect(
			parseCodeRepositories({
				...answer,
				repositories: [
					{ owner: "acme", name: "shop", importedFrom: { kind: "github" }, importedAt: at, earlierChanges: -1 },
				],
			}).repositories,
		).toEqual([{ owner: "acme", name: "shop", imported: { from: "github", at, earlierChanges: null } }]);
	});

	it("reads the other work that came with brought-in code, and the last change's number, each leniently", () => {
		const shop = {
			owner: "acme",
			name: "shop",
			changes: 1,
			downloads: [],
			importedFrom: { kind: "github", repository: "Acme/Shop", via: "public", branch: "main", commits: 1 },
			importedAt: at,
			earlierChanges: 1,
		};
		const read = (repository: Record<string, unknown>) =>
			parseCodeRepositories({ ...answer, repositories: [repository] }).repositories[0];
		const imported = { from: "github", at, earlierChanges: 1 } as const;
		expect(read({ ...shop, otherWork: { lines: 1, changes: 2 } })).toEqual({
			owner: "acme",
			name: "shop",
			imported: { ...imported, otherWork: { lines: 1, changes: 2 }, lastChange: 1 },
		});
		// None, a cloud from before the key, or a key not as expected: left out alone, the rest as it comes.
		for (const otherWork of [
			undefined,
			null,
			{},
			{ lines: 1 },
			{ changes: 2 },
			{ lines: 0, changes: 2 },
			{ lines: 1, changes: 0 },
			{ lines: "1", changes: 2 },
			{ lines: 1, changes: "2" },
			{ lines: 1.5, changes: 2 },
			{ lines: -1, changes: 2 },
			{ lines: 1, changes: Number.MAX_SAFE_INTEGER + 2 },
			[1, 2],
			"1/2",
			true,
		])
			expect(read({ ...shop, otherWork }), JSON.stringify(otherWork)).toEqual({
				owner: "acme",
				name: "shop",
				imported: { ...imported, lastChange: 1 },
			});
		for (const changes of [undefined, null, 0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 2])
			expect(read({ ...shop, changes, otherWork: { lines: 1, changes: 2 } }), JSON.stringify(changes)).toEqual({
				owner: "acme",
				name: "shop",
				imported: { ...imported, otherWork: { lines: 1, changes: 2 } },
			});
		expect(read({ ...shop, changes: 7 })?.imported?.lastChange).toBe(7);
		// Code begun here has no origin, so nothing of it is read.
		expect(read({ owner: "acme", name: "shop", changes: 1, otherWork: { lines: 1, changes: 2 } })).toEqual({
			owner: "acme",
			name: "shop",
		});
	});

	it("reads the ask's answer: on its way, refused with why, or one it does not know", () => {
		const schema = "qorpera.code-import/v1";
		expect(parseCodeImportAnswer({ schema, state: "queued", requestId: id(900) })).toEqual({
			state: "queued",
			requestId: id(900),
		});
		expect(parseCodeImportAnswer({ schema, state: "refused", reason: "sessions_open" })).toEqual({
			state: "refused",
			reason: "sessions_open",
		});
		expect(parseCodeImportAnswer({ schema, state: "refused" })).toEqual({ state: "refused", reason: "failed" });
		expect(parseCodeImportAnswer({ schema, state: "done", change: 1 })).toEqual({ state: "other" });
		for (const bad of [
			null,
			"queued",
			{ schema: "qorpera.code-import/v2", state: "queued", requestId: id(900) },
			{ schema, state: "queued" },
			{ schema, state: "queued", requestId: "not-an-id" },
			{ schema },
		])
			expect(() => parseCodeImportAnswer(bad)).toThrow(CloudShapeError);
	});

	it("asks with the company, the place and the project", async () => {
		const rpc = vi.fn(
			async (): Promise<unknown> => ({ schema: "qorpera.code-import/v1", state: "queued", requestId: id(900) }),
		);
		const calls = codeDownloadCalls({ rpc } as unknown as Cloud, profileA.profileId);
		expect(await calls.bringIn("acme", "shop", "Acme/Shop", new AbortController().signal)).toEqual({
			state: "queued",
			requestId: id(900),
		});
		expect(rpc).toHaveBeenCalledWith("qorpera_request_code_import", {
			p_profile_id: profileA.profileId,
			p_owner: "acme",
			p_name: "shop",
			p_github: "Acme/Shop",
		});
	});
});

describe("Bring code in, in Storage", () => {
	it("offers nothing of it on a cloud whose list has no bringing key, and nothing else on the page changes", async () => {
		vi.useFakeTimers();
		const calls = callsFake(codeList({ imports: false }));
		const { go, button, line, host } = await storage(calls);
		for (const path of ["code", "code/qorpera", "code/qorpera/notes", "code/acme/shop"]) {
			await go(path);
			expect(button().hidden, path).toBe(true);
			expect(visibleText(line()), path).toBe("");
		}
		// The follow-up's line of a GitHub copy, as before; no button beside it.
		await go("code/qorpera/saml-storefront");
		expect(visibleText(line())).toBe("Copy of the GitHub project saml-storefront");
		expect(button().hidden).toBe(true);
		expect(host.querySelectorAll(".storage-toolbar > button:not([hidden])")).toHaveLength(0);
		// It asked once on the way into the code, and asks no more by itself: no polling, nothing sent.
		const asked = calls.list.mock.calls.length;
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		await go("code");
		await go("code/qorpera");
		expect(calls.list).toHaveBeenCalledTimes(asked);
		expect(calls.bringIn).not.toHaveBeenCalled();
	});

	it("leaves Storage exactly as it was when the bringing key cannot be read", async () => {
		const answer = {
			schema: "qorpera.code-repositories/v1",
			canDownload: true,
			repositories: [{ owner: "qorpera", name: "notes", changes: 3, downloads: [] }],
			githubCopies: [storefront],
		};
		const drawn = async (list: unknown) => {
			const rpc = vi.fn(async (name: string): Promise<unknown> => {
				if (name === "qorpera_list_code_repositories") return list;
				throw new Error(`unexpected ${name}`);
			});
			const { go, host } = await storage(codeDownloadCalls({ rpc } as unknown as Cloud, profileA.profileId));
			const seen: string[] = [];
			for (const path of ["code", "code/qorpera", "code/qorpera/saml-storefront", "code/qorpera/notes"]) {
				await go(path);
				seen.push(host.querySelector(".storage-documents")!.innerHTML);
			}
			for (const dispose of disposers.splice(0)) dispose();
			document.body.replaceChildren();
			return seen;
		};
		const before = await drawn(answer);
		for (const bringing of [null, {}, "Acme/Web", [{ owner: "acme", name: "web" }]])
			expect(await drawn({ ...answer, bringing }), JSON.stringify(bringing)).toEqual(before);
		// With the key as it comes, the code's folders have the button.
		const after = await drawn({ ...answer, bringing: [] });
		expect(after[0]).not.toBe(before[0]);
	});

	it("shows the button to owners and admins only, in the code's folder and each owner's, in the look of Download the code", async () => {
		const owner = await storage(callsFake());
		for (const path of ["code", "code/qorpera", "code/acme"]) {
			await owner.go(path);
			expect(owner.button().hidden, path).toBe(false);
			expect(visibleText(owner.button())).toBe("Bring code in");
		}
		expect(owner.button().classList.contains("storage-code-button")).toBe(true);
		expect(owner.button().parentElement?.classList.contains("storage-toolbar")).toBe(true);
		expect(owner.button().getAttribute("aria-haspopup")).toBe("dialog");
		// Not beside the code, not on the platform's own folder, not on code kept in Qorpera or a place being filled.
		for (const path of [
			"notes",
			"code/_set-aside",
			"code/qorpera/notes",
			"code/qorpera/notes/main",
			"code/acme/shop",
		]) {
			await owner.go(path);
			expect(owner.button().hidden, path).toBe(true);
		}
		for (const dispose of disposers.splice(0)) dispose();
		document.body.replaceChildren();
		const viewer = await storage(callsFake(codeList({ canDownload: false })));
		for (const path of ["code", "code/qorpera", "code/qorpera/saml-storefront"]) {
			await viewer.go(path);
			expect(viewer.button().hidden, path).toBe(true);
		}
	});

	it("asks one question, sends the project, and says each step until it is in, then its folder says so", async () => {
		vi.useFakeTimers();
		const calls = callsFake();
		const sent = deferred<CodeImportAnswer>();
		calls.bringIn.mockReturnValueOnce(sent.promise);
		const { go, button, line, question, field, pressed, send, browser, host } = await storage(calls);
		await go("code/qorpera");
		button().click();
		expect(question()?.querySelector("h2")?.textContent).toBe("Where is the code?");
		expect(question()?.querySelector("p")?.textContent).toBe(
			"Qorpera copies it with its history. Nothing changes on GitHub.",
		);
		expect(field()?.placeholder).toBe("A GitHub address, like github.com/acme/shop");
		expect(document.activeElement).toBe(field());
		expect([...question()!.querySelectorAll("button")].map((each) => each.textContent)).toEqual([
			"Cancel",
			"Bring it in",
		]);
		// Nothing that is a GitHub address is sent.
		await send("my shop");
		expect(visibleText(question()!.querySelector("[role=alert]"))).toBe("That is not a GitHub address.");
		expect(calls.bringIn).not.toHaveBeenCalled();
		await send("https://github.com/Acme/Shop.git");
		expect(calls.bringIn).toHaveBeenCalledWith("acme", "shop", "Acme/Shop", expect.any(AbortSignal));
		// While the ask is out the question stays, at rest.
		expect(pressed("Working…")?.disabled).toBe(true);
		expect(field()?.disabled).toBe(true);
		sent.resolve({ state: "queued", requestId: id(900) });
		await settle();
		expect(question()).toBeNull();
		expect(visibleText(line())).toBe("Bringing in Shop: Getting it from GitHub…");
		expect(button().getAttribute("aria-disabled")).toBe("true");
		// The list is read every few seconds while it runs, and the line follows it.
		const states: [CodeBringing, string][] = [
			[bringingShop("fetch"), "Bringing in Shop: Getting it from GitHub…"],
			[bringingShop("look"), "Bringing in Shop: Checking it…"],
			[bringingShop("look", true), "Bringing in Shop: Waiting for the agents to finish what they are doing…"],
			[bringingShop("build"), "Bringing in Shop: Putting it in place…"],
		];
		for (const [bringing, words] of states) {
			calls.list.mockResolvedValue(codeList({ bringing: [bringing] }));
			await vi.advanceTimersByTimeAsync(5000);
			expect(visibleText(line())).toBe(words);
			expect(line().querySelector(".spinner-dot, .storage-code-percent")).toBeNull();
		}
		// In: the code's folders say so once, with the way to it; the reads stop.
		calls.list.mockResolvedValue(codeList({ repositories: [{ owner: "qorpera", name: "notes" }, keptShop] }));
		await vi.advanceTimersByTimeAsync(5000);
		expect(visibleText(line())).toBe("Shop is brought in.Open");
		expect(button().hasAttribute("aria-disabled")).toBe(false);
		const reads = calls.list.mock.calls.length;
		await vi.advanceTimersByTimeAsync(30_000);
		expect(calls.list).toHaveBeenCalledTimes(reads);
		line().querySelector<HTMLButtonElement>("button")!.click();
		await settle();
		await settle();
		expect(host.querySelector(".storage-title")?.textContent).toBe("shop");
		expect(visibleText(line())).toBe(
			"Brought in from GitHub on November 12, 2026. 1,204 earlier changes came with it. The copy on GitHub stays as it is.",
		);
		// Below it too; and back in the code's folder the word is said.
		browser.reveal("code/acme/shop/main");
		await settle();
		await settle();
		expect(visibleText(line())).toContain("Brought in from GitHub on November 12, 2026.");
		await go("code/qorpera");
		expect(visibleText(line())).toBe("");
		// A founder reads it all: no path, branch, commit, repository, code or request.
		expect(line().textContent).not.toMatch(/\/|branch|commit|repositor|IMPORT|request/i);
	});

	it("says why the ask was refused in the question, keeping what was typed, and the line says it after", async () => {
		const calls = callsFake();
		calls.bringIn.mockResolvedValueOnce({ state: "refused", reason: "sessions_open" });
		const { go, button, line, question, field, send } = await storage(calls);
		await go("code");
		button().click();
		await send("github.com/Acme/Shop");
		expect(visibleText(question()!.querySelector("[role=alert]"))).toBe(
			"Shop was not brought in: agents are still working on it on GitHub; try again when they are done.",
		);
		expect(field()?.value).toBe("github.com/Acme/Shop");
		expect(field()?.disabled).toBe(false);
		expect(document.activeElement).toBe(field());
		question()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await settle();
		expect(question()).toBeNull();
		expect(document.activeElement).toBe(button());
		expect(visibleText(line())).toBe(
			"Shop was not brought in: agents are still working on it on GitHub; try again when they are done.",
		);
		// A refusal the database gave before it wrote says so too, in its plain line.
		calls.bringIn.mockRejectedValueOnce(
			new CloudRpcError("qorpera_request_code_import", { message: "Code unavailable", code: "42501" }, 403),
		);
		button().click();
		await send("Acme/Shop");
		expect(visibleText(question()!.querySelector("[role=alert]"))).toBe(
			"Shop was not brought in: it could not be brought in just now; try again.",
		);
	});

	it("says how one ended that was not brought in, from the list, to owners and admins in the code's folders", async () => {
		const calls = callsFake(codeList({ last: lastShop("IMPORT_USES_LFS") }));
		const { go, line } = await storage(calls);
		const words =
			"shop was not brought in: it keeps large files outside the code, and Qorpera can't bring those in yet.";
		for (const path of ["code", "code/qorpera", "code/acme/shop"]) {
			await go(path);
			expect(visibleText(line()), path).toBe(words);
		}
		await go("code/qorpera/notes");
		expect(visibleText(line())).toBe("");
		for (const dispose of disposers.splice(0)) dispose();
		document.body.replaceChildren();
		const spelled = await storage(callsFake(codeList({ last: lastShop("IMPORT_USES_LFS", "Acme/Shop") })));
		await spelled.go("code");
		expect(visibleText(spelled.line())).toBe(words.replace("shop", "Shop"));
		for (const dispose of disposers.splice(0)) dispose();
		document.body.replaceChildren();
		// A file too large says the file's bound, a project too large GitHub's.
		for (const [last, said] of [
			[
				{ ...lastShop("IMPORT_TOO_LARGE"), file: true as const },
				"it is larger than 256 MB, the most Qorpera brings in from a file",
			],
			[lastShop("IMPORT_TOO_LARGE", "Acme/Shop"), "it is larger than 1 GB, the most Qorpera brings in"],
		] as const) {
			const large = await storage(callsFake(codeList({ last })));
			await large.go("code");
			expect(visibleText(large.line())).toBe(`${last.github ? "Shop" : "shop"} was not brought in: ${said}.`);
			for (const dispose of disposers.splice(0)) dispose();
			document.body.replaceChildren();
		}
		// Not to others; not once it is in after all; not while it is being brought in again.
		for (const list of [
			codeList({ canDownload: false, last: lastShop("IMPORT_USES_LFS") }),
			codeList({ repositories: [keptShop], last: lastShop("IMPORT_USES_LFS") }),
			codeList({ bringing: [bringingShop("fetch")], last: lastShop("IMPORT_USES_LFS") }),
		]) {
			const other = await storage(callsFake(list));
			await other.go("code");
			expect(visibleText(other.line())).not.toContain("was not brought in");
			for (const dispose of disposers.splice(0)) dispose();
			document.body.replaceChildren();
		}
	});

	it("says it was not brought in when one it watched ends so, with why", async () => {
		vi.useFakeTimers();
		const calls = callsFake(codeList({ bringing: [bringingShop("look")] }));
		const { go, line } = await storage(calls);
		await go("code");
		expect(visibleText(line())).toBe("Bringing in Shop: Checking it…");
		calls.list.mockResolvedValue(codeList({ last: lastShop("IMPORT_HISTORY_BAD_TIMEZONE", "Acme/Shop") }));
		await vi.advanceTimersByTimeAsync(5000);
		expect(visibleText(line())).toBe(
			"Shop was not brought in: its history is stored in an old way Qorpera can't take in yet.",
		);
	});

	/** What the code's folder says of a failed import once the page is opened again with `list`. */
	const reloaded = async (list: CodeRepositories) => {
		for (const dispose of disposers.splice(0)) dispose();
		document.body.replaceChildren();
		const again = await storage(callsFake(list));
		await again.go("code");
		return visibleText(again.line());
	};

	it("says a watched import's failure as the page says it after a reload: a file's own bound, GitHub's 1 GB", async () => {
		vi.useFakeTimers();
		const fileShop: CodeBringing = { owner: "acme", name: "shop", github: null, step: "read", waiting: false };
		const watched: [CodeBringing, CodeImportEnd, string][] = [
			[
				fileShop,
				{ ...lastShop("IMPORT_TOO_LARGE"), file: true },
				"shop was not brought in: it is larger than 256 MB, the most Qorpera brings in from a file.",
			],
			[
				bringingShop("fetch"),
				lastShop("IMPORT_TOO_LARGE", "Acme/Shop"),
				"Shop was not brought in: it is larger than 1 GB, the most Qorpera brings in.",
			],
		];
		for (const [bringing, last, words] of watched) {
			const calls = callsFake(codeList({ bringing: [bringing] }));
			const { go, line } = await storage(calls);
			await go("code");
			expect(visibleText(line())).toContain("Bringing in");
			const failed = codeList({ last });
			calls.list.mockResolvedValue(failed);
			await vi.advanceTimersByTimeAsync(5000);
			expect(visibleText(line())).toBe(words);
			expect(await reloaded(failed)).toBe(words);
			for (const dispose of disposers.splice(0)) dispose();
			document.body.replaceChildren();
		}
	});

	it("names an import it asked for as the list names it, as the page does after a reload", async () => {
		vi.useFakeTimers();
		const calls = callsFake();
		const { go, button, line, send } = await storage(calls);
		await go("code");
		// Asked again in another spelling: the import that is open answers, under the spelling it was asked with first.
		button().click();
		await send("github.com/acme/shop");
		expect(calls.bringIn).toHaveBeenCalledWith("acme", "shop", "acme/shop", expect.any(AbortSignal));
		calls.list.mockResolvedValue(codeList({ bringing: [bringingShop("look")] }));
		await vi.advanceTimersByTimeAsync(5000);
		expect(visibleText(line())).toBe("Bringing in Shop: Checking it…");
		const failed = codeList({ last: lastShop("IMPORT_USES_LFS", "Acme/Shop") });
		calls.list.mockResolvedValue(failed);
		await vi.advanceTimersByTimeAsync(5000);
		const words =
			"Shop was not brought in: it keeps large files outside the code, and Qorpera can't bring those in yet.";
		expect(visibleText(line())).toBe(words);
		expect(await reloaded(failed)).toBe(words);
	});

	it("says an ask whose answer was lost was not brought in only when a failure ended since, as a reload says", async () => {
		vi.useFakeTimers();
		// No failure before the ask; the read after the lost answer shows one: it is this ask's.
		const calls = callsFake();
		const first = await storage(calls);
		await first.go("code");
		calls.bringIn.mockRejectedValueOnce(new TypeError("Failed to fetch"));
		const failed = codeList({ last: lastShop("IMPORT_SOURCE_REFUSED", "Acme/Shop") });
		calls.list.mockResolvedValue(failed);
		first.button().click();
		await first.send("Acme/Shop");
		await settle();
		const words =
			"Shop was not brought in: GitHub did not let Qorpera read it; check the address, and that the company's GitHub connection can see it.";
		expect(visibleText(first.line())).toBe(words);
		expect(await reloaded(failed)).toBe(words);
		for (const dispose of disposers.splice(0)) dispose();
		document.body.replaceChildren();
		// The same failure was there before the ask: it says nothing of this one.
		const older = callsFake(failed);
		const second = await storage(older);
		await second.go("code");
		expect(visibleText(second.line())).toBe(words);
		older.bringIn.mockRejectedValueOnce(new TypeError("Failed to fetch"));
		second.button().click();
		await second.send("Acme/Shop");
		await settle();
		expect(visibleText(second.line())).toBe("Shop may not have started.Try again");
	});

	it("no longer says it was not brought in once it is in after all, or being brought in again", async () => {
		vi.useFakeTimers();
		for (const after of [
			codeList({ repositories: [keptShop], last: lastShop("IMPORT_USES_LFS", "Acme/Shop") }),
			codeList({ bringing: [bringingShop("fetch")], last: lastShop("IMPORT_USES_LFS", "Acme/Shop") }),
		]) {
			const calls = callsFake(codeList({ bringing: [bringingShop("look")] }));
			const { go, line } = await storage(calls);
			await go("code");
			calls.list.mockResolvedValue(codeList({ last: lastShop("IMPORT_USES_LFS", "Acme/Shop") }));
			await vi.advanceTimersByTimeAsync(5000);
			expect(visibleText(line())).toContain("was not brought in");
			calls.list.mockResolvedValue(after);
			// The code's folders read the list again on the way in once a minute has gone.
			await go("code/qorpera");
			await vi.advanceTimersByTimeAsync(61_000);
			await go("code");
			const now = visibleText(line());
			expect(now).not.toContain("was not brought in");
			expect(await reloaded(after)).toBe(now);
			for (const dispose of disposers.splice(0)) dispose();
			document.body.replaceChildren();
		}
	});

	it("claims no outcome when the answer to the ask is lost: it reads the list until it shows one", async () => {
		vi.useFakeTimers();
		const calls = callsFake();
		const { go, button, line, question, send } = await storage(calls);
		await go("code");
		const notSaid = () => expect(visibleText(line())).not.toContain("was not brought in");
		// No answer at all; the next read shows it on its way.
		calls.bringIn.mockRejectedValueOnce(new TypeError("Failed to fetch"));
		const lost = deferred<CodeRepositories>();
		calls.list.mockReturnValueOnce(lost.promise);
		button().click();
		await send("Acme/Shop");
		expect(question()).toBeNull();
		expect(visibleText(line())).toBe("Checking whether Shop started…");
		expect(button().getAttribute("aria-disabled")).toBe("true");
		lost.resolve(codeList({ bringing: [bringingShop(null)] }));
		await settle();
		expect(visibleText(line())).toBe("Bringing in Shop: Getting it from GitHub…");
		for (const dispose of disposers.splice(0)) dispose();
		document.body.replaceChildren();

		// A gateway's answer with no word of the database's; the read shows nothing of it: Try again asks once more, and
		// that ask is answered with the import if it is open after all.
		const again = await storage(calls);
		calls.list.mockResolvedValue(codeList());
		await again.go("code");
		calls.bringIn.mockRejectedValueOnce(
			new CloudRpcError("qorpera_request_code_import", { message: "Bad Gateway" }, 502),
		);
		again.button().click();
		await again.send("Acme/Shop");
		expect(visibleText(again.line())).toBe("Shop may not have started.Try again");
		expect(visibleText(again.line())).not.toContain("was not brought in");
		calls.bringIn.mockResolvedValueOnce({ state: "queued", requestId: id(900) });
		again.line().querySelector<HTMLButtonElement>("button")!.click();
		await settle();
		expect(calls.bringIn).toHaveBeenLastCalledWith("acme", "shop", "Acme/Shop", expect.any(AbortSignal));
		expect(visibleText(again.line())).toBe("Bringing in Shop: Getting it from GitHub…");
		for (const dispose of disposers.splice(0)) dispose();
		document.body.replaceChildren();

		// An answer that is not as expected, and the reads fail too: it says so after two minutes, and a read that
		// answers later settles it.
		const third = await storage(calls);
		await third.go("code");
		calls.bringIn.mockRejectedValueOnce(new CloudShapeError("code import"));
		calls.list.mockRejectedValue(new TypeError("Failed to fetch"));
		third.button().click();
		await third.send("Acme/Shop");
		expect(visibleText(third.line())).toBe("Checking whether Shop started…");
		await vi.advanceTimersByTimeAsync(60_000);
		expect(visibleText(third.line())).toBe("Checking whether Shop started…");
		await vi.advanceTimersByTimeAsync(65_000);
		expect(visibleText(third.line())).toBe(
			"Qorpera could not be reached, so it is not known whether Shop started. Open this folder again in a moment.",
		);
		const reads = calls.list.mock.calls.length;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(calls.list).toHaveBeenCalledTimes(reads);
		calls.list.mockResolvedValue(codeList({ repositories: [keptShop] }));
		await third.go("code/qorpera");
		expect(visibleText(third.line())).toBe("Shop is brought in.Open");
		notSaid();
	});

	it("hides the button for good when the cloud turns out to lack the ask", async () => {
		const calls = callsFake();
		calls.bringIn.mockRejectedValueOnce(
			new CloudRpcError("qorpera_request_code_import", { message: "missing", code: "PGRST202" }, 404),
		);
		const { go, button, question, send } = await storage(calls);
		await go("code");
		button().click();
		await send("Acme/Shop");
		expect(visibleText(question()!.querySelector("[role=alert]"))).toBe(
			"Shop was not brought in: it could not be brought in just now; try again.",
		);
		expect(button().hidden).toBe(true);
	});

	it("brings a GitHub copy's own project in from its folder, after one question", async () => {
		vi.useFakeTimers();
		const calls = callsFake();
		const { go, button, line, question, pressed } = await storage(calls);
		await go("code/qorpera/saml-storefront");
		expect(visibleText(line())).toBe("Copy of the GitHub project saml-storefront");
		expect(button().hidden).toBe(false);
		expect(visibleText(button())).toBe("Bring it into Qorpera");
		button().click();
		expect(question()?.querySelector("h2")?.textContent).toBe("Bring saml-storefront into Qorpera?");
		expect(question()?.querySelector("p")?.textContent).toBe(
			"Qorpera copies it with its history. Nothing changes on GitHub. What this folder holds now is kept aside, not deleted.",
		);
		expect(question()?.querySelector("input")).toBeNull();
		expect(document.activeElement).toBe(pressed("Bring it into Qorpera"));
		calls.list.mockResolvedValue(
			codeList({
				bringing: [{ ...storefront, github: "Qorpera/saml-storefront", step: "close", waiting: false }],
			}),
		);
		pressed("Bring it into Qorpera")!.click();
		await settle();
		expect(calls.bringIn).toHaveBeenCalledWith(
			"qorpera",
			"saml-storefront",
			"Qorpera/saml-storefront",
			expect.any(AbortSignal),
		);
		expect(question()).toBeNull();
		expect(visibleText(line())).toBe("Bringing in saml-storefront: Putting it in place…");
		expect(button().hidden).toBe(true);
		// Elsewhere in the code the button rests while it runs.
		await go("code/qorpera");
		expect(visibleText(line())).toBe("Bringing in saml-storefront: Putting it in place…");
		expect(button().getAttribute("aria-disabled")).toBe("true");
		button().click();
		expect(question()).toBeNull();
	});

	it("shows the steps after a reload, read from the list, also of one that comes from a file", async () => {
		vi.useFakeTimers();
		const calls = callsFake(codeList({ bringing: [bringingShop("look")] }));
		const { go, line } = await storage(calls);
		await go("code/acme");
		expect(visibleText(line())).toBe("Bringing in Shop: Checking it…");
		await vi.advanceTimersByTimeAsync(5000);
		expect(calls.list).toHaveBeenCalledTimes(2);
		for (const dispose of disposers.splice(0)) dispose();
		document.body.replaceChildren();
		// A file has no GitHub name: the place's own.
		const file = await storage(
			callsFake(
				codeList({ bringing: [{ owner: "acme", name: "shop", github: null, step: "read", waiting: false }] }),
			),
		);
		await file.go("code");
		expect(visibleText(file.line())).toBe("Bringing in shop: Reading the file…");
	});

	it("says it in Danish too", async () => {
		setLanguagePreference("da");
		const calls = callsFake(codeList({ repositories: [keptShop] }));
		const { go, button, question, line } = await storage(calls);
		await go("code");
		expect(visibleText(button())).toBe("Hent kode ind");
		button().click();
		expect(question()?.querySelector("h2")?.textContent).toBe("Hvor ligger koden?");
		expect(question()?.querySelector("p")?.textContent).toBe(
			"Qorpera kopierer den med hele dens historik. Intet ændres på GitHub.",
		);
		expect([...question()!.querySelectorAll("button")].map((each) => each.textContent)).toEqual([
			"Annuller",
			"Hent den ind",
		]);
		question()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await go("code/acme/shop");
		expect(visibleText(line())).toBe(
			"Hentet ind fra GitHub den 12. november 2026. 1.204 tidligere ændringer kom med. Kopien på GitHub forbliver, som den er.",
		);
		await go("code/qorpera/saml-storefront");
		expect(visibleText(button())).toBe("Hent det ind i Qorpera");
		expect(visibleText(line())).toBe("Kopi af GitHub-projektet saml-storefront");
	});
});

describe("the place's folder while code is brought in", () => {
	/** The place after the set-aside: only its mark is left. */
	const setAside = (folder: ReturnType<typeof folderFake>) => {
		folder.folders.delete("code/acme/shop/main");
		folder.files.set("code/acme/shop/restoring.json", '{"main":null}');
	};

	it("reads the place's folder again when its import moves a step and when it is in, with no word from the folder", async () => {
		vi.useFakeTimers();
		const calls = callsFake(codeList({ bringing: [bringingShop("set-aside")] }));
		const { go, line, folder, names, count, listed } = await storage(calls);
		setAside(folder);
		await go("code/acme/shop");
		await settle();
		expect(visibleText(line())).toBe("Bringing in Shop: Putting it in place…");
		expect(names()).toEqual([]);
		expect(count()).toBe("0 items");
		// The build writes the place's history: the next read of the list shows the step, and the folder is read again.
		folder.folders.add("code/acme/shop/repo.git");
		calls.list.mockResolvedValue(codeList({ bringing: [bringingShop("build")] }));
		await vi.advanceTimersByTimeAsync(5000);
		expect(names()).toEqual(["repo.git"]);
		expect(count()).toBe("1 item");
		// The same step again: the folder is not read again.
		const atBuild = listed("code/acme/shop");
		await vi.advanceTimersByTimeAsync(5000);
		expect(listed("code/acme/shop")).toBe(atBuild);
		// In: the open puts the main version and the record in place, and the mark goes. Storage shows it at once, as it
		// does once the folder is opened again.
		folder.folders.add("code/acme/shop/main");
		folder.folders.add("code/acme/shop/changes");
		folder.files.delete("code/acme/shop/restoring.json");
		calls.list.mockResolvedValue(codeList({ repositories: [{ owner: "qorpera", name: "notes" }, keptShop] }));
		await vi.advanceTimersByTimeAsync(5000);
		expect(names()).toEqual(["changes", "main", "repo.git"]);
		expect(count()).toBe("3 items");
		expect(visibleText(line())).toBe(
			"Brought in from GitHub on November 12, 2026. 1,204 earlier changes came with it. The copy on GitHub stays as it is.",
		);
		// The folder's hint and feed said nothing of it.
		expect(folder.changes).not.toHaveBeenCalled();
	});

	it("reads a folder below the place again too, and goes up when the step took it away", async () => {
		vi.useFakeTimers();
		const calls = callsFake(codeList({ bringing: [bringingShop("close")] }));
		const { go, host, folder, names } = await storage(calls);
		await go("code/acme/shop/main");
		expect(host.querySelector(".storage-title")?.textContent).toBe("main");
		setAside(folder);
		calls.list.mockResolvedValue(codeList({ bringing: [bringingShop("set-aside")] }));
		await vi.advanceTimersByTimeAsync(5000);
		expect(host.querySelector(".storage-title")?.textContent).toBe("shop");
		expect(names()).toEqual([]);
	});

	it("reads it again when the import ends not brought in, and the mark shows again once it is not being brought in", async () => {
		vi.useFakeTimers();
		const calls = callsFake(codeList({ bringing: [bringingShop("build")] }));
		const { go, line, folder, names, count } = await storage(calls);
		setAside(folder);
		await go("code/acme/shop");
		await settle();
		expect(names()).toEqual([]);
		calls.list.mockResolvedValue(codeList({ last: lastShop("IMPORT_SOURCE_EMPTY", "Acme/Shop") }));
		await vi.advanceTimersByTimeAsync(5000);
		expect(visibleText(line())).toBe("Shop was not brought in: there is nothing in it yet.");
		expect(names()).toEqual(["restoring.json"]);
		expect(count()).toBe("1 item");
	});

	it("does not read another folder again when an import moves elsewhere", async () => {
		vi.useFakeTimers();
		const calls = callsFake(codeList({ bringing: [bringingShop("close")] }));
		const { go, line, listed } = await storage(calls);
		await go("code/qorpera");
		await go("code/acme");
		const before = { owner: listed("code/qorpera"), acme: listed("code/acme") };
		for (const step of ["set-aside", "build", "open"]) {
			calls.list.mockResolvedValue(codeList({ bringing: [bringingShop(step)] }));
			await vi.advanceTimersByTimeAsync(5000);
		}
		calls.list.mockResolvedValue(codeList({ repositories: [keptShop] }));
		await vi.advanceTimersByTimeAsync(5000);
		expect(visibleText(line())).toBe("Shop is brought in.Open");
		expect({ owner: listed("code/qorpera"), acme: listed("code/acme") }).toEqual(before);
	});

	it("keeps a step that came while the folder was being read, and reads the place again after", async () => {
		vi.useFakeTimers();
		const calls = callsFake(codeList({ bringing: [bringingShop("set-aside")] }));
		const { go, folder, names } = await storage(calls);
		setAside(folder);
		await go("code/acme/shop");
		await settle();
		// The build's read of the folder is slow, and answers what the place held when it was asked.
		folder.folders.add("code/acme/shop/repo.git");
		const slow = deferred<CloudMemberFolderListPage>();
		const atBuild = await folder.list("code/acme/shop");
		folder.list.mockReturnValueOnce(slow.promise);
		calls.list.mockResolvedValue(codeList({ bringing: [bringingShop("build")] }));
		await vi.advanceTimersByTimeAsync(5000);
		// The open, while that read is out.
		folder.folders.add("code/acme/shop/main");
		calls.list.mockResolvedValue(codeList({ bringing: [bringingShop("open")] }));
		await vi.advanceTimersByTimeAsync(5000);
		slow.resolve(atBuild);
		await settle();
		await settle();
		expect(names()).toEqual(["main", "repo.git"]);
	});

	it("reads the place again when its import ended before the page's first read of the list", async () => {
		// The place's folder is read while the import puts it in place; the list's first answer comes after it ended.
		type Folder = ReturnType<typeof folderFake>;
		const ends: [CodeRepositories, (folder: Folder) => void, string[], string][] = [
			[
				codeList({ repositories: [keptShop] }),
				(folder) => {
					folder.files.delete("code/acme/shop/restoring.json");
					folder.folders.add("code/acme/shop/main");
					folder.folders.add("code/acme/shop/changes");
				},
				["changes", "main", "repo.git"],
				"Brought in from GitHub on November 12, 2026. 1,204 earlier changes came with it. The copy on GitHub stays as it is.",
			],
			[
				// Not brought in: the place as it was before, here with its mark still there.
				codeList({ last: lastShop("IMPORT_SOURCE_EMPTY", "Acme/Shop") }),
				(folder) => {
					folder.folders.delete("code/acme/shop/repo.git");
					folder.folders.add("code/acme/shop/main");
				},
				["main", "restoring.json"],
				"Shop was not brought in: there is nothing in it yet.",
			],
		];
		for (const [after, end, shown, words] of ends) {
			const calls = callsFake();
			const first = deferred<CodeRepositories>();
			calls.list.mockReturnValueOnce(first.promise);
			const opened = await storage(calls);
			setAside(opened.folder);
			opened.folder.folders.add("code/acme/shop/repo.git");
			await opened.go("code/acme/shop");
			expect(opened.names()).toEqual(["repo.git", "restoring.json"]);
			end(opened.folder);
			first.resolve(after);
			await settle();
			await settle();
			expect(opened.names()).toEqual(shown);
			expect(visibleText(opened.line())).toBe(words);
			for (const dispose of disposers.splice(0)) dispose();
			document.body.replaceChildren();
		}
	});

	it("draws nothing again when a place read again for its import holds what is shown", async () => {
		// Code brought in long ago: the page's first read of the list reads its folder again, which is the same.
		const calls = callsFake(codeList({ repositories: [keptShop] }));
		const first = deferred<CodeRepositories>();
		calls.list.mockReturnValueOnce(first.promise);
		const { go, host, listed } = await storage(calls);
		await go("code/acme/shop");
		const row = host.querySelector<HTMLElement>(".files-row-main");
		expect(row?.dataset.path).toBe("code/acme/shop/main");
		expect(document.activeElement).toBe(row);
		first.resolve(codeList({ repositories: [keptShop] }));
		await settle();
		await settle();
		expect(listed("code/acme/shop")).toBe(2);
		expect(row?.isConnected).toBe(true);
		expect(document.activeElement).toBe(row);
		for (const dispose of disposers.splice(0)) dispose();
		document.body.replaceChildren();
		// The same rows, but now a page more: drawn again, with More files.
		const more = callsFake(codeList({ repositories: [keptShop] }));
		const answer = deferred<CodeRepositories>();
		more.list.mockReturnValueOnce(answer.promise);
		const again = await storage(more);
		await again.go("code/acme/shop");
		const shown = again.host.querySelector<HTMLElement>(".files-row-main");
		const page = await again.folder.list("code/acme/shop");
		again.folder.list.mockResolvedValueOnce({ ...page, next: "code/acme/shop/main" });
		answer.resolve(codeList({ repositories: [keptShop] }));
		await settle();
		await settle();
		expect(shown?.isConnected).toBe(false);
		expect(again.host.querySelector<HTMLElement>(".files-list-more button")?.hidden).toBe(false);
	});

	it("leaves Recents as it is while an import moves the place, and reads the place once Documents shows it again", async () => {
		vi.useFakeTimers();
		const calls = callsFake(codeList({ bringing: [bringingShop("set-aside")] }));
		const { go, browser, host, folder, names, listed } = await storage(calls);
		setAside(folder);
		await go("code/acme/shop");
		await settle();
		browser.showRecents();
		await settle();
		const recents = () => visibleText(host.querySelector(".storage-recents"));
		expect(recents()).toContain("plan.md");
		const before = listed("code/acme/shop");
		// The build writes the place, and the folder's sequence moves on past the feed's.
		folder.folders.add("code/acme/shop/repo.git");
		folder.seq(5);
		calls.list.mockResolvedValue(codeList({ bringing: [bringingShop("build")] }));
		await vi.advanceTimersByTimeAsync(5000);
		expect(recents()).toContain("plan.md");
		expect(listed("code/acme/shop")).toBe(before);
		// Back in Documents without a read of the folder (here the mark, opened by its path from Recents' window): the
		// place is read then.
		browser.reveal("code/acme/shop/restoring.json");
		await settle();
		await settle();
		expect(names()).toEqual(["repo.git"]);
	});

	it("leaves the mark out only while the list says that place is being brought in", async () => {
		vi.useFakeTimers();
		// Opened before the list was read: the first read that shows the import reads the folder again without it.
		const calls = callsFake(codeList({ bringing: [bringingShop("build")] }));
		const first = await storage(calls);
		first.folder.files.set("code/acme/shop/restoring.json", "{}");
		first.folder.files.set("code/acme/shop/main/restoring.json", "{}");
		first.folder.files.set("code/qorpera/notes/restoring.json", "{}");
		await first.go("code/acme/shop");
		await settle();
		expect(first.names()).toEqual(["main"]);
		expect(first.count()).toBe("1 item");
		// A file of that name further down, or outside the code, is not a mark; another place's mark (a restore there,
		// say) shows, under the same owner or with the same name too.
		await first.go("code/acme/shop/main");
		expect(first.names()).toEqual(["restoring.json"]);
		await first.go("code/qorpera/notes");
		expect(first.names()).toEqual(["main", "restoring.json"]);
		for (const place of ["code/acme/web", "code/qorpera/shop", "notes/acme/shop"]) {
			first.folder.folders.add(place);
			first.folder.files.set(`${place}/restoring.json`, "{}");
			await first.go(place);
			expect(first.names(), place).toEqual(["restoring.json"]);
		}
		for (const dispose of disposers.splice(0)) dispose();
		document.body.replaceChildren();
		// A cloud that cannot bring code in shows it as any file.
		const old = await storage(callsFake(codeList({ imports: false })));
		old.folder.files.set("code/acme/shop/restoring.json", "{}");
		await old.go("code/acme/shop");
		await settle();
		expect(old.names()).toEqual(["main", "restoring.json"]);
		expect(old.count()).toBe("2 items");
		for (const dispose of disposers.splice(0)) dispose();
		document.body.replaceChildren();
		// What is below a folder of that name is no mark either.
		const below = await storage(callsFake(codeList({ bringing: [bringingShop("build")] })));
		below.folder.folders.add("code/acme/shop/restoring.json");
		below.folder.files.set("code/acme/shop/restoring.json/restoring.json", "{}");
		await below.go("code/acme/shop/restoring.json");
		await settle();
		expect(below.names()).toEqual(["restoring.json"]);
	});
});

describe("the work that came along outside the main version, in Storage", () => {
	const shop = {
		owner: "acme",
		name: "shop",
		changes: 1,
		downloads: [],
		importedFrom: { kind: "github", repository: "Acme/Shop", via: "public", branch: "main", commits: 1204 },
		importedAt: at,
		earlierChanges: 1204,
	};
	/** The list as today's cloud answers it (migration 20260930736000): no otherWork key. */
	const today = {
		schema: "qorpera.code-repositories/v1",
		canDownload: true,
		repositories: [shop],
		githubCopies: [],
		bringing: [],
		lastImport: null,
	};
	/** The line in the place's folder, the list read through the real call and parse. */
	const said = async (repository: Record<string, unknown>) => {
		const rpc = vi.fn(async (name: string): Promise<unknown> => {
			if (name === "qorpera_list_code_repositories") return { ...today, repositories: [repository] };
			throw new Error(`unexpected ${name}`);
		});
		const { go, line } = await storage(codeDownloadCalls({ rpc } as unknown as Cloud, profileA.profileId));
		await go("code/acme/shop");
		const text = visibleText(line());
		for (const dispose of disposers.splice(0)) dispose();
		document.body.replaceChildren();
		return text;
	};

	it("reads exactly as before on a cloud whose list has no otherWork, or one it cannot read", async () => {
		const before =
			"Brought in from GitHub on November 12, 2026. 1,204 earlier changes came with it. The copy on GitHub stays as it is.";
		expect(await said(shop)).toBe(before);
		for (const otherWork of [null, {}, { lines: 0, changes: 0 }, { lines: 1 }, "1/2"])
			expect(await said({ ...shop, otherWork }), JSON.stringify(otherWork)).toBe(before);
		setLanguagePreference("da");
		expect(await said(shop)).toBe(
			"Hentet ind fra GitHub den 12. november 2026. 1.204 tidligere ændringer kom med. Kopien på GitHub forbliver, som den er.",
		);
	});

	it("says what came along, and the next step until the place changes", async () => {
		const storefront = { ...shop, earlierChanges: 1, otherWork: { lines: 1, changes: 2 } };
		expect(await said(storefront)).toBe(
			"Brought in from GitHub on November 12, 2026. 1 earlier change came with it. It also brought 1 other line of work, with 2 changes that were not in the main version. An agent can bring that work into the main version. The copy on GitHub stays as it is.",
		);
		expect(await said({ ...storefront, changes: 2 })).toBe(
			"Brought in from GitHub on November 12, 2026. 1 earlier change came with it. It also brought 1 other line of work, with 2 changes that were not in the main version. The copy on GitHub stays as it is.",
		);
		setLanguagePreference("da");
		expect(await said(storefront)).toBe(
			"Hentet ind fra GitHub den 12. november 2026. 1 tidligere ændring kom med. Den havde også 1 andet arbejdsspor med, med 2 ændringer, som ikke var i hovedversionen. En agent kan føje det arbejde til hovedversionen. Kopien på GitHub forbliver, som den er.",
		);
	});
});
