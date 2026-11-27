import {
	APP_ICON_MAX_BYTES,
	APP_ICONS_FOLDER,
	APP_ICONS_MAX,
	type AppIcon,
	appIconIdOf,
	parseAppIcon,
} from "@qorpera/cloud-client/app-icons";
import {
	CLOUD_MEMBER_DATA_DATABASE,
	CLOUD_MEMBER_DATA_QUESTION,
	CLOUD_MEMBER_DATA_WATCHES,
	type CloudMemberDataAnswer,
	type CloudMemberDataChanged,
	type CloudMemberDataChangePreview,
	type CloudMemberDataChangeRequest,
	CloudMemberDataError,
	type CloudMemberDataParamValue,
	type CloudMemberDataQuestion,
	type CloudMemberDataWatch,
	type CloudMemberDataWatchAnswer,
} from "@qorpera/cloud-client/cloud-member-data";
import {
	CLOUD_MEMBER_FOLDER_READ_MANY,
	type CloudMemberFolderClient,
	type CloudMemberFolderEntry,
	CloudMemberFolderError,
	type CloudMemberFolderFile,
} from "@qorpera/cloud-client/cloud-member-folder";
import { companyPathKey, parseCompanyStateFile } from "@qorpera/cloud-client/company-state-files";
import {
	APP_CLOSED_FOLDERS,
	APP_MANIFEST,
	APP_MANIFEST_MAX_BYTES,
	APP_NUMBERS_DATABASE,
	APP_WRITE_ANSWERS,
	APP_WRITE_DATA,
	APPS_FOLDER,
	type AppManifest,
	type AppProblem,
	type AppRead,
	appFileKind,
	appLinkName,
	appMediaType,
	appNumbersRead,
	appRelativePath,
	parseAppManifest,
} from "@qorpera/cloud-client/interface-apps";
import { isInterfaceName, parseTableFile, parseTableRows } from "@qorpera/cloud-client/interfaces";
import { withAbortScopes } from "../cloud/abort-scope.ts";
import { APP_GROUPS_MAX_BYTES, APP_GROUPS_PATH, type AppTreeNode, parseAppGroups } from "../cloud/app-groups.ts";
import type { WebMemberFolder } from "../cloud/company-folder-writes.ts";
import type { AppAnswer, AppCall, FramedPage } from "../ui/app-frame.ts";
import { folderLinkPath } from "../ui/folder-links.ts";
import { webHref } from "../ui/markdown.ts";
import {
	framePage,
	type InertHtmlParse,
	PAGE_FRAME_URL,
	parseHtmlInert,
	serializeHtmlInert,
} from "../ui/page-frame.ts";
import { hasBrowserCompositor, yieldToMain } from "../ui/time-slice.ts";
import {
	AppActionRefused,
	type AppGate,
	type AppGateOutcome,
	type AppQuestionSource,
	type AppTellSource,
	appQuestions,
	noteKept,
	type PreparedAsk,
	type PreparedDataAsk,
	prepareAnswer,
	prepareDataChange,
	prepareRow,
	prepareTell,
	restoreTell,
} from "./app-actions.ts";
import type { AppReadingAnswer, CompanyReading } from "./company-reading.ts";
import { type AppLook, type AppScheme, appBaseStyle, appScheme, readAppBrand } from "./interface-app-style.ts";

/* Interface apps on the web (deploy/first-node/RUNTIME-INTERFACE-APPS.md §2, §4 and §5; Jonas, 5 November 2026): the
 * company's apps as their manifests say (`readApps`, for the apps drawer and the cards), one app's page put together
 * from its files for the locked frame (`assembleApp`), and the answers to its live-data calls (`AppBridge`). Every read
 * is the member's own, through the member's folder client.
 * - The bridge reads only what the manifest's `reads` names, and only what an agent of the company reads too: the app's
 *   own folder always; with `files`, the company's own work (never QorperaOS/ or what the platform writes: mail, bank,
 *   members, events, digital post); with `tables`, a table's rows; with `agents` and `todos`, plain lines about them;
 *   with `reading`, the company's reading of itself, its agents and whether it can run, as plain names
 *   (app/company-reading.ts);
 *   with `questions`, the agents' open question cards that point at this app; with `data`, the answers of the company
 *   databases' named questions (`query`), and the same kept live (`watch`: CompanyData below); with `money` and `site`,
 *   the platform's own numbers of the company, asked the same way as questions of the reserved database `qorpera`
 *   (`qorpera/money-now`, `qorpera/site-now`) and kept live by asking again (CompanyNumbers below).
 *   It never hands over who the member is, a token, or anything of this app's own state.
 * - The bridge changes nothing by itself. A page may ask for what the manifest's `writes` names (an answer to such a
 *   question, a row of a named table): the request is checked (app/app-actions.ts), put to the member on the bar outside
 *   the frame (views/app-ask-bar.ts), and made as the member's own change only when they allow it there. Any app may
 *   ask the same way to send a note to the agent that owns it (`tell`), which the member writes on the bar.
 * - A link the member clicks in the page comes over the bridge too (`open`): checked here (`appLink`), it opens another
 *   app, a file of the company's own work or a web page, and nothing else. A web page is a request like the others: it
 *   opens only once the member has seen its whole address on the bar and pressed Open (Jonas, 13 November 2026: "Show
 *   the address first"), since a page can put what the member typed into an address. The page learns nothing from it.
 * - An app's page starts from Qorpera's base style (app/interface-app-style.ts), put first in its head when it is put
 *   together: the company's colours, the scheme, the system font and plain defaults, all of which the page's own
 *   styles override. */

/** One app of the company, as its folder and manifest say. */
export interface CompanyApp {
	readonly name: string;
	readonly path: string;
	/** Null when the manifest is missing or has problems. */
	readonly manifest: AppManifest | null;
	readonly problems: readonly AppProblem[];
	/** The manifest's version, so a change shows. */
	readonly version: string | null;
	/** When its folder or manifest last changed, as the folder's change number: the larger, the later. */
	readonly changed?: number;
}

/** The company's concepts of its product (`concept = true`, with a manifest that reads), the most recently changed
 * first, for the Concepts viewer. */
export function companyConcepts(apps: readonly CompanyApp[]): (CompanyApp & { readonly manifest: AppManifest })[] {
	return apps
		.filter((app): app is CompanyApp & { readonly manifest: AppManifest } => app.manifest?.concept === true)
		.sort((a, b) => (b.changed ?? 0) - (a.changed ?? 0) || a.name.localeCompare(b.name));
}

type Folder = Pick<CloudMemberFolderClient, "read" | "list" | "readFile"> &
	Partial<Pick<CloudMemberFolderClient, "readMany" | "readFilePieces">>;

const LIST_PAGE = 50;
/** Apps a company lists, at most. */
const MAX_APPS = 200;
const APP_READ_CONCURRENCY = 8;
const NO_READ_MANY = new WeakSet<object>();
const TEXT = new TextDecoder("utf-8", { fatal: true });
/** Every read here reads a file's entry live, as the member, just before its bytes: those may come from the member's
 * file cache (company-files.ts). */
const LIVE = { cached: true } as const;

async function mapLimited<T, R>(
	items: readonly T[],
	limit: number,
	signal: AbortSignal,
	run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	signal.throwIfAborted();
	const out = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (!signal.aborted) {
			const index = next++;
			if (index >= items.length) return;
			out[index] = await run(items[index]!, index);
		}
	});
	await Promise.all(workers);
	signal.throwIfAborted();
	return out;
}

async function listAll(
	folder: Folder,
	parent: string,
	signal: AbortSignal,
	max: number,
): Promise<CloudMemberFolderEntry[]> {
	const entries: CloudMemberFolderEntry[] = [];
	let after: string | null = null;
	for (;;) {
		const page = await folder.list(parent, after, LIST_PAGE, signal);
		entries.push(...page.entries);
		if (page.next === null || entries.length >= max) return entries.slice(0, max);
		after = page.next;
	}
}

async function readText(folder: Folder, entry: CloudMemberFolderEntry, signal: AbortSignal, max: number) {
	if (entry.kind !== "file" || !entry.file || entry.file.bytes > max) return null;
	try {
		return TEXT.decode(await folder.readFile(entry.file, signal, max, LIVE));
	} catch {
		return null;
	}
}

/** One of an app's own icons (`apps/<name>/icons/<id>.svg`), drawn by its agent on a member's ask. */
export interface CompanyAppIcon {
	readonly id: string;
	readonly icon: AppIcon;
	/** When it was saved, as the folder counts: the newest first. */
	readonly seq: number;
}

/** An app's own icons, newest first: each file of its `icons/` folder the shared reader can draw, at most 48; a file it
 * cannot read or draw is left out. With `known` (the last read, by file and its version), files that did not change are
 * not read again. */
export async function readAppIcons(
	folder: Folder,
	app: string,
	signal: AbortSignal,
	known: ReadonlyMap<string, CompanyAppIcon> = new Map(),
): Promise<{ icons: CompanyAppIcon[]; byFile: Map<string, CompanyAppIcon> }> {
	const path = `${APPS_FOLDER}/${app}/${APP_ICONS_FOLDER}`;
	const top = isInterfaceName(app) ? (await folder.read(path, signal)).entry : null;
	const byFile = new Map<string, CompanyAppIcon>();
	if (top?.kind !== "folder") return { icons: [], byFile };
	const files = (await listAll(folder, path, signal, 4 * APP_ICONS_MAX))
		.filter((entry) => entry.kind === "file" && appIconIdOf(entry.path.slice(entry.path.lastIndexOf("/") + 1)))
		.sort((a, b) => b.seq - a.seq)
		// More than 12 can stand (two saves at once, a file written another way): every one is read, so a member's pick
		// is still drawn; the panel shows the newest 12 and the picked one (review F4 on #1696).
		.slice(0, 4 * APP_ICONS_MAX);
	await mapLimited(files, APP_READ_CONCURRENCY, signal, async (entry) => {
		const key = `${entry.path}@${entry.seq}`;
		const kept = known.get(key);
		if (kept) {
			byFile.set(key, kept);
			return;
		}
		const text = await readText(folder, entry, signal, APP_ICON_MAX_BYTES);
		const read = text === null ? null : parseAppIcon(text);
		const id = appIconIdOf(entry.path.slice(entry.path.lastIndexOf("/") + 1));
		if (read?.ok && id) byFile.set(key, { id, icon: read.icon, seq: entry.seq });
	});
	return { icons: [...byFile.values()].sort((a, b) => b.seq - a.seq), byFile };
}

/** The company's groups of apps, from `apps/groups.md` (cloud/app-groups.ts); undefined when it has none. */
export async function readAppGroups(folder: Folder, signal: AbortSignal): Promise<AppTreeNode[] | undefined> {
	const entry = (await folder.read(APP_GROUPS_PATH, signal)).entry;
	// A bigger file is read too (up to a mebibyte): the reader keeps its first 64 KiB, as the agents' tool does.
	const text = entry ? await readText(folder, entry, signal, 16 * APP_GROUPS_MAX_BYTES) : null;
	return text === null ? undefined : parseAppGroups(text);
}

async function readManifestEntries(
	folder: Folder,
	paths: readonly string[],
	signal: AbortSignal,
): Promise<(CloudMemberFolderEntry | null)[]> {
	if (!paths.length) return [];
	if (folder.readMany && !NO_READ_MANY.has(folder)) {
		const out: (CloudMemberFolderEntry | null)[] = [];
		let fallback = false;
		for (let start = 0; start < paths.length; start += CLOUD_MEMBER_FOLDER_READ_MANY) {
			signal.throwIfAborted();
			const chunk = paths.slice(start, start + CLOUD_MEMBER_FOLDER_READ_MANY);
			try {
				const reads = await folder.readMany(chunk, signal);
				for (let i = 0; i < chunk.length; i++) out.push(reads[i]?.entry ?? null);
			} catch (error: unknown) {
				if (signal.aborted) throw error;
				if (error instanceof CloudMemberFolderError && error.status === 404) NO_READ_MANY.add(folder);
				const rest = await mapLimited(paths.slice(start), APP_READ_CONCURRENCY, signal, async (path) => {
					return (await folder.read(path, signal)).entry;
				});
				out.push(...rest);
				fallback = true;
				break;
			}
		}
		if (!fallback) signal.throwIfAborted();
		return out;
	}
	return mapLimited(paths, APP_READ_CONCURRENCY, signal, async (path) => (await folder.read(path, signal)).entry);
}

/** The company's apps, in name order: every folder of `apps/` with its manifest read. */
export async function readApps(
	folder: Folder,
	signal: AbortSignal,
	previous: readonly CompanyApp[] = [],
): Promise<CompanyApp[]> {
	const top = await folder.read(APPS_FOLDER, signal);
	if (top.entry?.kind !== "folder") return [];
	const folders = (await listAll(folder, APPS_FOLDER, signal, MAX_APPS)).filter((entry) => entry.kind === "folder");
	const candidates: { entry: CloudMemberFolderEntry; name: string; manifestPath: string }[] = [];
	for (const entry of folders) {
		const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
		if (!isInterfaceName(name)) continue;
		candidates.push({ entry, name, manifestPath: `${entry.path}/${APP_MANIFEST}` });
	}
	if (!candidates.length) return [];
	const known = new Map(previous.map((app) => [app.name, app]));
	const manifests = await readManifestEntries(
		folder,
		candidates.map((item) => item.manifestPath),
		signal,
	);
	return mapLimited(candidates, APP_READ_CONCURRENCY, signal, async ({ entry, name }, index): Promise<CompanyApp> => {
		const manifest = manifests[index] ?? null;
		const changed = Math.max(entry.seq, manifest?.seq ?? 0);
		const prev = known.get(name);
		// WHY: skip re-fetching manifest bytes when a valid manifest keeps the same server version.
		if (
			prev?.manifest !== null &&
			prev?.manifest !== undefined &&
			prev.version !== null &&
			prev.version === manifest?.version
		) {
			return prev.changed === changed ? prev : { ...prev, changed };
		}
		const text = manifest ? await readText(folder, manifest, signal, APP_MANIFEST_MAX_BYTES) : null;
		if (text === null)
			return {
				name,
				path: entry.path,
				manifest: null,
				problems: [{ line: null, message: manifest ? "app.toml is not text" : "app.toml is missing" }],
				version: manifest?.version ?? null,
				changed,
			};
		const parsed = parseAppManifest(text);
		return {
			name,
			path: entry.path,
			manifest: parsed.ok ? parsed.manifest : null,
			problems: parsed.ok ? [] : parsed.problems,
			version: manifest?.version ?? null,
			changed,
		};
	});
}

/* ---- Putting a page together ----------------------------------------------------------------------------------- */

export type AssembledApp =
	| {
			readonly ok: true;
			readonly page: string;
			readonly framed: FramedPage;
			readonly key: string;
			readonly files: number;
			readonly bytes: number;
			/** The scheme of the base style the page starts from; undefined for a page given none. */
			readonly scheme?: AppScheme;
	  }
	| { readonly ok: false; readonly reason: "missing" | "not_shown"; readonly message: string };

/** A path a page names, resolved against the folder of the file that names it (`base`, relative to the app's folder):
 * a plain relative path that stays inside the app's folder, or null. Query and fragment are dropped; percent-escapes
 * are decoded once, and an escaped slash, backslash or NUL is refused. */
export function resolveAppPath(base: string, reference: string): string | null {
	const raw = reference.trim().split(/[?#]/, 1)[0] ?? "";
	if (raw === "" || /%(?:2f|5c|00)/i.test(raw)) return null;
	let decoded: string;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		return null;
	}
	if (/^[a-z][a-z0-9+.-]*:/i.test(decoded) || decoded.startsWith("/") || decoded.includes("\\")) return null;
	const parts = base === "" ? [] : base.split("/");
	for (const part of decoded.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (parts.length === 0) return null;
			parts.pop();
		} else parts.push(part);
	}
	return parts.length === 0 ? null : appRelativePath(parts.join("/"));
}

const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** An app's files read at once, at most, while its page is put together. */
const FILES_AT_ONCE = 8;
export const PAGE_TEXT_INLINE_BYTES = 128 * 1024;
export const PAGE_MEDIA_FILE_BYTES = 2 * 1024 * 1024;
export const PAGE_MEDIA_BYTES = 16 * 1024 * 1024;
export const PAGE_MEDIA_FILES = 24;
const WHOLE_READ_BYTES = 8 * 1024 * 1024;

/** What a round of reading ahead (`warmApps`) may still read, in bytes, across all the apps. */
interface WarmBudget {
	left: number;
}

class AppFiles {
	readonly #folder: Folder;
	readonly #root: string;
	readonly #signal: AbortSignal;
	readonly #atOnce: number;
	readonly #warm: WarmBudget | undefined;
	readonly #files = new Map<string, Promise<CloudMemberFolderFile | null>>();
	readonly #read = new Map<string, Promise<Uint8Array | null>>();
	readonly #large = new Map<string, Promise<Blob>>();
	#active = 0;
	readonly #waiting: (() => void)[] = [];
	#asked: {
		readonly path: string;
		readonly resolve: (entry: CloudMemberFolderEntry | null) => void;
		readonly reject: (error: unknown) => void;
	}[] = [];
	bytes = 0;
	planned = 0;
	onProgress: (() => void) | undefined;

	constructor(
		folder: Folder,
		root: string,
		signal: AbortSignal,
		options: { readonly atOnce?: number; readonly warm?: WarmBudget } = {},
	) {
		this.#folder = folder;
		this.#root = root;
		this.#signal = signal;
		this.#atOnce = options.atOnce ?? FILES_AT_ONCE;
		this.#warm = options.warm;
	}

	get warm(): boolean {
		return this.#warm !== undefined;
	}

	get count(): number {
		return this.#read.size + this.#large.size;
	}

	#full(path: string): string | null {
		const full = appReadablePath(this.#root === "" ? path : `${this.#root}/${path}`);
		return full === null || full === "" ? null : full;
	}

	file(path: string): Promise<CloudMemberFolderFile | null> {
		const key = path.toLowerCase();
		const known = this.#files.get(key);
		if (known) return known;
		const full = this.#full(path);
		const found =
			full === null
				? Promise.resolve(null)
				: this.#entry(full).then((entry) => (entry?.kind === "file" ? entry.file : null));
		this.#files.set(key, found);
		return found;
	}

	bytesOf(path: string): Promise<Uint8Array | null> {
		const key = path.toLowerCase();
		const known = this.#read.get(key);
		if (known) return known;
		const reading = (async () => {
			const file = await this.file(path);
			if (!file) return null;
			if (this.#warm) {
				if (file.bytes > this.#warm.left) return null;
				this.#warm.left -= file.bytes;
			}
			this.planned += file.bytes;
			this.onProgress?.();
			const bytes = await this.#turn(() => this.#folder.readFile(file, this.#signal, file.bytes, LIVE));
			this.bytes += file.bytes;
			this.onProgress?.();
			return bytes;
		})();
		// Reading ahead, a file that fails is left for the open: the page waits for all its other reads, so a round
		// never has more under way than it says.
		const settled = this.#warm ? reading.catch(() => null) : reading;
		this.#read.set(key, settled);
		return settled;
	}

	async text(path: string): Promise<string | null> {
		const bytes = await this.bytesOf(path);
		try {
			return bytes === null ? null : TEXT.decode(bytes);
		} catch {
			return null;
		}
	}

	async moduleText(path: string): Promise<string | null> {
		const file = await this.file(path);
		if (file === null) return null;
		if (this.#warm || !this.#inPieces(file)) return this.text(path);
		const folder = this.#folder;
		const decoder = new TextDecoder("utf-8", { fatal: true });
		const parts: string[] = [];
		this.planned += file.bytes;
		this.onProgress?.();
		await this.#turn(() =>
			folder.readFilePieces!(
				file,
				this.#signal,
				(piece) => {
					parts.push(decoder.decode(piece, { stream: true }));
				},
				LIVE,
			),
		);
		parts.push(decoder.decode());
		this.bytes += file.bytes;
		this.onProgress?.();
		return parts.join("");
	}

	async pageBlob(path: string, type: string): Promise<Blob | null> {
		const file = await this.file(path);
		if (!file || !this.#inPieces(file)) {
			const bytes = await this.bytesOf(path);
			return bytes === null ? null : new Blob(this.#warm ? [] : [bytes as BlobPart], { type });
		}
		if (this.#warm) return null;
		const key = path.toLowerCase();
		const known = this.#large.get(key);
		if (known) return known;
		const reading = (async () => {
			this.planned += file.bytes;
			this.onProgress?.();
			const blob = await this.#pieces(file, type);
			this.bytes += file.bytes;
			this.onProgress?.();
			return blob;
		})();
		this.#large.set(key, reading);
		return reading;
	}

	async blob(path: string): Promise<Blob | null> {
		const full = this.#full(path);
		if (full === null) return null;
		const entry = await this.#entry(full);
		const file = entry?.kind === "file" ? entry.file : null;
		if (!file) return null;
		const type = appMediaType(path);
		if (this.#inPieces(file)) return this.#pieces(file, type);
		const bytes = await this.#turn(() => this.#folder.readFile(file, this.#signal, file.bytes, LIVE));
		return new Blob([bytes as BlobPart], { type });
	}

	#inPieces(file: CloudMemberFolderFile): boolean {
		return file.bytes > WHOLE_READ_BYTES && this.#folder.readFilePieces !== undefined;
	}

	async #pieces(file: CloudMemberFolderFile, type: string): Promise<Blob> {
		const folder = this.#folder;
		const parts: BlobPart[] = [];
		await this.#turn(() =>
			folder.readFilePieces!(
				file,
				this.#signal,
				(piece) => {
					parts.push(piece as BlobPart);
				},
				LIVE,
			),
		);
		return new Blob(parts, { type });
	}

	/** A path's entry, read live as the member: with the other paths asked for in the same moment, in one call. */
	#entry(path: string): Promise<CloudMemberFolderEntry | null> {
		if (!this.#folder.readMany || NO_READ_MANY.has(this.#folder)) return this.#readAlone(path);
		return new Promise((resolve, reject) => {
			if (this.#asked.push({ path, resolve, reject }) === 1) queueMicrotask(() => this.#readAsked());
		});
	}

	#readAlone(path: string): Promise<CloudMemberFolderEntry | null> {
		return this.#turn(async () => (await this.#folder.read(path, this.#signal)).entry);
	}

	/** Reads the entries asked for, up to CLOUD_MEMBER_FOLDER_READ_MANY a call. A call that fails reads each of its paths
	 * alone, so each answers or fails as its own read would; a database without the call is not asked again. */
	#readAsked(): void {
		const asked = this.#asked.splice(0);
		const folder = this.#folder;
		for (let start = 0; start < asked.length; start += CLOUD_MEMBER_FOLDER_READ_MANY) {
			const part = asked.slice(start, start + CLOUD_MEMBER_FOLDER_READ_MANY);
			folder.readMany!(
				part.map((item) => item.path),
				this.#signal,
			).then(
				(reads) => {
					for (const [index, item] of part.entries()) item.resolve(reads[index]?.entry ?? null);
				},
				(error: unknown) => {
					if (error instanceof CloudMemberFolderError && error.status === 404) NO_READ_MANY.add(folder);
					for (const item of part) this.#readAlone(item.path).then(item.resolve, item.reject);
				},
			);
		}
	}

	/** Runs `read` once fewer than its share of reads are under way; a read that ends hands its turn to the next. */
	async #turn<T>(read: () => Promise<T>): Promise<T> {
		if (this.#active >= this.#atOnce) await new Promise<void>((resolve) => this.#waiting.push(resolve));
		else this.#active++;
		try {
			return await read();
		} finally {
			const next = this.#waiting.shift();
			if (next) next();
			else this.#active--;
		}
	}
}

const URL_IN_CSS = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

function tokenOf(path: string, file: CloudMemberFolderFile): string {
	return `qorpera-file-${file.fileSha256.slice(0, 32)}-${appFileKind(path)
		.replace(/[^a-z0-9]/g, "")
		.slice(0, 16)}`;
}

interface PageRead {
	readonly page: Document;
	readonly inert: Pick<InertHtmlParse, "tagAttr" | "styleAttr" | "endNoframesToken">;
	readonly files: ReadonlyMap<string, Blob>;
	readonly missing: readonly string[];
	readonly said: readonly string[];
	readonly later: readonly string[];
}

/** One app's page as the frame is handed it: its entry with the app's own stylesheets, scripts and pictures put in,
 * then through framePage (ui/page-frame.ts). With `look`, the page starts from Qorpera's base style
 * (app/interface-app-style.ts), first in its head, in the look's colours and in the scheme the page supports. */
export async function assembleApp(
	folder: Folder,
	app: Pick<CompanyApp, "path"> & { readonly entry: string },
	signal: AbortSignal,
	look?: AppLook,
	progress?: (read: number, of: number) => void,
): Promise<AssembledApp> {
	const files = new AppFiles(folder, app.path, signal);
	if (progress) files.onProgress = () => progress(files.bytes, files.planned);
	const read = await readPage(files, app.entry);
	if (read === null)
		return { ok: false, reason: "missing", message: `The app's page, ${app.entry}, is not in its folder.` };
	const page = read.page;
	// Before every style of the page, and in a layer of its own: whatever the page's styles say wins.
	let scheme: AppScheme | undefined;
	if (look) {
		scheme = appScheme(page, look.scheme);
		const base = page.createElement("noframes");
		base.setAttribute(read.inert.tagAttr, "");
		base.setAttribute("data-qorpera-base", "");
		base.textContent = appBaseStyle(scheme, look.brand).replace(/<\/noframes/gi, read.inert.endNoframesToken);
		page.head.prepend(base);
	}
	const written = serializeHtmlInert(page, read.inert);
	const handed = framePage(page.doctype ? written : `<!doctype html>${written}`);
	if (handed === null) return { ok: false, reason: "not_shown", message: "This app can't be shown live." };
	return {
		ok: true,
		page: handed,
		framed: {
			html: handed,
			files: [...read.files],
			missing: read.missing,
			...(read.said.length > 0 ? { said: read.said } : {}),
			base: dirOf(app.entry),
		},
		key: [handed, ...read.later].join("\n"),
		files: files.count,
		bytes: files.bytes,
		...(scheme ? { scheme } : {}),
	};
}

async function readPage(files: AppFiles, entry: string): Promise<PageRead | null> {
	const html = await files.text(entry);
	if (html === null) return null;
	// WHY: Parse with <style>/style= neutralized so Chromium never logs style-src CSP errors on detached DOMParser docs.
	const parsed = parseHtmlInert(html, files.warm ? { fixedStyleAttr: "data-qorpera-style" } : undefined);
	const page = parsed.doc;
	const styleSelector = `noframes[${parsed.tagAttr}]`;
	const styleAttribute = parsed.styleAttr;
	const base = dirOf(entry);
	const handed = new Map<string, Blob>();
	const missing = new Set<string>();
	const later: string[] = [];
	const miss = (path: string) => {
		if (!files.warm) missing.add(path);
	};
	const fileOf = (path: string) => files.file(path).catch(() => null);
	const hand = async (path: string, type = appMediaType(path)): Promise<string | null> => {
		const blob = await files.pageBlob(path, type).catch(() => null);
		const file = await fileOf(path);
		if (blob === null || file === null) {
			miss(path);
			return null;
		}
		const token = tokenOf(path, file);
		if (!files.warm && !handed.has(token)) handed.set(token, blob);
		return token;
	};
	const css = async (text: string, from: string): Promise<string> => {
		const found = [...text.matchAll(URL_IN_CSS)];
		const tokens = await Promise.all(
			found.map((match) => {
				const path = resolveAppPath(from, match[2] ?? "");
				return path === null ? null : hand(path);
			}),
		);
		let out = text;
		for (const [index, match] of found.entries()) {
			const token = tokens[index];
			if (token) out = out.split(match[0]).join(`url("${token}")`);
		}
		return out;
	};
	const changes: Promise<(() => void) | null>[] = [];
	for (const link of [...page.querySelectorAll<HTMLLinkElement>("link[rel~='stylesheet' i][href]")]) {
		const path = resolveAppPath(base, link.getAttribute("href") ?? "");
		if (path === null) continue;
		changes.push(
			files
				.text(path)
				.catch(() => null)
				.then(async (text) => {
					if (text === null) {
						miss(path);
						return () => link.remove();
					}
					const inlined = (await css(text, dirOf(path)))
						.replace(/<\/style/gi, "<\\/style")
						.replace(/<\/noframes/gi, parsed.endNoframesToken);
					return () => {
						const style = page.createElement("noframes");
						style.setAttribute(parsed.tagAttr, "");
						style.textContent = inlined;
						link.replaceWith(style);
					};
				}),
		);
	}
	for (const style of [...page.querySelectorAll(styleSelector)])
		changes.push(
			css(style.textContent ?? "", base).then((text) => () => {
				style.textContent = text;
			}),
		);
	for (const element of [...page.querySelectorAll(`[${styleAttribute}]`)]) {
		const value = element.getAttribute(styleAttribute) ?? "";
		if (value.includes("url("))
			changes.push(css(value, base).then((text) => () => element.setAttribute(styleAttribute, text)));
	}
	for (const script of [...page.querySelectorAll<HTMLScriptElement>("script[src]:not([type='module' i])")]) {
		const path = resolveAppPath(base, script.getAttribute("src") ?? "");
		if (path === null) continue;
		changes.push(
			fileOf(path).then(async (file) => {
				const js =
					file !== null && file.bytes <= PAGE_TEXT_INLINE_BYTES ? await files.text(path).catch(() => null) : null;
				if (js !== null)
					return () => {
						script.removeAttribute("src");
						script.textContent = js.replace(/<\/script/gi, "<\\/script");
					};
				const token = file === null ? null : await hand(path, "text/javascript");
				if (file === null) miss(path);
				return () => {
					if (token) script.setAttribute("src", token);
					else {
						script.removeAttribute("src");
						script.textContent = "";
					}
				};
			}),
		);
	}
	const named: { readonly element: Element; readonly attribute: string; readonly path: string }[] = [];
	for (const element of page.querySelectorAll(
		"img[src], image[href], video[src], video[poster], audio[src], source[src], track[src]",
	)) {
		const attributes =
			element.localName === "video" ? ["poster", "src"] : element.localName === "image" ? ["href"] : ["src"];
		for (const attribute of attributes) {
			const value = element.getAttribute(attribute);
			const path = value === null ? null : resolveAppPath(base, value);
			if (path !== null) named.push({ element, attribute, path });
		}
	}
	const found = Promise.all(named.map((item) => fileOf(item.path)));
	let inPage = 0;
	let filesInPage = 0;
	for (const [index, file] of (await found).entries()) {
		const { element, attribute, path } = named[index]!;
		if (file === null) {
			miss(path);
			changes.push(Promise.resolve(() => element.removeAttribute(attribute)));
			continue;
		}
		const picture = attribute !== "src" || element.localName === "img";
		const hidden = picture && element.closest("[hidden]") !== null;
		if (
			hidden ||
			(file.bytes <= PAGE_MEDIA_FILE_BYTES &&
				inPage + file.bytes <= PAGE_MEDIA_BYTES &&
				filesInPage < PAGE_MEDIA_FILES)
		) {
			if (!hidden) {
				inPage += file.bytes;
				filesInPage++;
			}
			changes.push(
				hand(path).then((token) => () => {
					if (token) element.setAttribute(attribute, token);
					else element.removeAttribute(attribute);
				}),
			);
		} else {
			later.push(`${path} ${file.fileSha256}`);
			changes.push(
				Promise.resolve(() => {
					element.removeAttribute(attribute);
					element.setAttribute(`data-qorpera-${attribute}`, path);
				}),
			);
		}
	}
	const ready = await Promise.all(changes);
	if (!files.warm) for (const change of ready) change?.();
	const modules =
		page.querySelector("script[type='module' i], script[type='importmap' i]") !== null
			? await (await import("./app-modules.ts")).bindModules(
					page,
					{ warm: files.warm, text: (path) => files.moduleText(path), resolve: resolveAppPath },
					base,
					new URL(PAGE_FRAME_URL, document.baseURI).href,
				)
			: null;
	if (modules && !files.warm) for (const [token, blob] of modules.files) handed.set(token, blob);
	return { page, inert: parsed, files: handed, missing: [...missing], said: [...(modules?.said ?? [])], later };
}

export class PageFiles {
	readonly #files: AppFiles;

	constructor(folder: Folder, root: string, signal: AbortSignal) {
		this.#files = new AppFiles(folder, root, signal);
	}

	async answer(call: AppCall): Promise<AppAnswer> {
		if (call.method !== "file") return refuse("Only an app in apps/ reads the company's data");
		return this.file(call.params);
	}

	async file(params: Record<string, unknown>): Promise<AppAnswer> {
		const base =
			typeof params.base === "string" && (params.base === "" || appRelativePath(params.base)) ? params.base : null;
		const path =
			base !== null && typeof params.path === "string" && params.path.length <= MAX_PATH_CHARS
				? resolveAppPath(base, params.path)
				: null;
		if (path === null) return refuse("A page reads only the files in its own folder");
		try {
			const blob = await this.#files.blob(path);
			return blob ? { ok: true, value: blob } : refuse(`${path} is not in the page's folder`);
		} catch (error) {
			if (error instanceof CloudMemberFolderError) return refuse(`${path} could not be read now`);
			throw error;
		}
	}
}

/* ---- The bridge --------------------------------------------------------------------------------------------- */

/** What the bridge needs from the open company besides the member's folder. */
export interface AppBridgeHost {
	readonly folder: () => Folder;
	readonly agents: () => readonly { readonly name: string; readonly role: string; readonly working: boolean }[];
	/** The company's reading of itself, for an app that reads `reading`; absent where it can't be read. */
	readonly reading?: Pick<CompanyReading, "read" | "watch">;
	/** The agents' open questions and an agent by its id, for an app that shows or answers them; absent where the
	 * company has none to show. */
	readonly questions?: AppQuestionSource & {
		readonly agent: (agentId: string) => { readonly displayName: string } | undefined;
	};
	/** The member's own client for a change they allowed, and the check that the company is still the one on screen
	 * (it throws when it is not). Absent where nothing can be changed. */
	readonly writer?: () => WebMemberFolder;
	readonly current?: () => void;
	/** The company's databases, asked and watched as the member; absent where the company has no member gateway
	 * configured. */
	readonly data?: CompanyData;
	/** The platform's own numbers of the company (`qorpera/*`), asked and watched as the member; absent where none can
	 * be asked. */
	readonly numbers?: CompanyNumbers;
	/** Who hears a note from an app, and the send (app/tell-agent.ts); absent where no note can be sent. */
	readonly tell?: AppTellSource;
}

/** One app page's live values: the page they are sent to, and its lifetime. Its watches end when `signal` does. */
export interface AppDataPage {
	readonly signal: AbortSignal;
	/** Sends a watch's new answer to the page. */
	readonly send: (watch: number, value: unknown) => void;
}

/** Calls in flight, and calls a minute, for one app in this tab. */
const MAX_IN_FLIGHT = 8;
const MAX_PER_MINUTE = 120;
/** An answer the page is handed, at most, as JSON. */
const MAX_ANSWER_BYTES = 1024 * 1024;
const MAX_PATH_CHARS = 1024;
const MAX_PARAMS_CHARS = 4096;
/** A row's cells may be longer than a read's few short values. */
const MAX_ROW_PARAMS_CHARS = 16 * 1024;
/** What a request put to the member on the bar spends of the minute's budget: a change, a note, or a web page to open. */
const REQUEST_COST = 5;
/** What a call spends of the minute's budget, when it is more than one: todos reads every agent's todos folder, a
 * request for a change reads the table or the questions before anything is shown, and a note costs as a change. A link
 * (`open`) costs one, and a link to a web page, which is put on the bar, what a request costs (`answer`). A question of
 * the company's databases (`query`) and the start of a watch (`watch`) cost one; what a watch sends later costs nothing.
 * Ending a watch (`unwatch`) is answered before the budget (`answer`). */
const CALL_COST: Readonly<Record<string, number>> = {
	todos: 10,
	answer: REQUEST_COST,
	setRow: REQUEST_COST,
	addRow: REQUEST_COST,
	act: REQUEST_COST,
	tell: REQUEST_COST,
};
const MAX_DATA_PARAMS = 64;
const MAX_DATA_PARAM_BYTES = 64 * 1024;
const MAX_DATA_CALL_PARAMS_CHARS = MAX_DATA_PARAM_BYTES + 4096;
const DATA_PARAM = /^[a-z_][a-z0-9_]{0,39}$/;
const NO_DATA_READ = 'Add "data" to reads in app.toml to ask the company\'s databases';
/** A question of the platform's numbers that is not one, in the cloud's own words for it. */
const noNumbersQuestion = (question: string) => `No question ${APP_NUMBERS_DATABASE}/${question} that you may read`;
/** What a page is told when its request did not become a change. */
const GATE_SAYS: Readonly<Record<Exclude<AppGateOutcome["outcome"], "saved" | "opened" | "told" | "failed">, string>> =
	{
		declined: "The member said not now",
		busy: "Another request is waiting for the member's answer",
		quiet: "The member said not now three times: this page asks again after the member reloads it",
		gone: "The page was put away, or what it may ask for changed, before the member answered",
	};
const TODO_FILES = 200;
/** What `reading` answers where the company's reading can't be read from here: none yet, no team, no standing. */
const NO_READING: AppReadingAnswer = { reading: null, team: [], standing: null };
/** The budget of an app in this tab, kept across its frames, so a Reload starts no new one. */
const budgets = new Map<string, { inFlight: number; minute: number; calls: number }>();
/** After the member sent a note from an app, its next note is refused this long: the bar comes back no sooner. */
export const TELL_AGAIN_MS = 10_000;
/** When each app in this tab last had a note sent (by its budget's key), kept across its frames as the budget is. */
const told = new Map<string, number>();

function budget(key: string): { inFlight: number; minute: number; calls: number } {
	const now = Math.floor(Date.now() / 60_000);
	let entry = budgets.get(key);
	if (!entry) {
		entry = { inFlight: 0, minute: now, calls: 0 };
		budgets.set(key, entry);
	} else if (entry.minute !== now) {
		entry.minute = now;
		entry.calls = 0;
	}
	return entry;
}

function withinParamBudget(
	value: unknown,
	maxChars: number,
	state: { nodes: number; chars: number; seen: Set<object> },
	depth = 0,
): boolean {
	if (depth > 16 || ++state.nodes > 4_096) return false;
	if (value === null || value === undefined) {
		state.chars += 4;
		return state.chars <= maxChars;
	}
	const kind = typeof value;
	if (kind === "boolean") {
		state.chars += 5;
		return state.chars <= maxChars;
	}
	if (kind === "number") {
		state.chars += Number.isFinite(value) ? String(value).length : 4;
		return state.chars <= maxChars;
	}
	if (kind === "string") {
		state.chars += (value as string).length + 2;
		return state.chars <= maxChars;
	}
	if (kind !== "object") return false;
	const obj = value as object;
	if (state.seen.has(obj)) return false;
	state.seen.add(obj);
	if (Array.isArray(obj)) {
		state.chars += 2;
		for (let i = 0; i < obj.length; i++) {
			if (!withinParamBudget(obj[i], maxChars, state, depth + 1)) return false;
			state.chars += 1;
		}
		return state.chars <= maxChars;
	}
	const proto = Object.getPrototypeOf(obj);
	if (proto !== Object.prototype && proto !== null) return false;
	state.chars += 2;
	for (const [k, v] of Object.entries(obj)) {
		state.chars += k.length + 4;
		if (state.chars > maxChars) return false;
		if (!withinParamBudget(v, maxChars, state, depth + 1)) return false;
	}
	return state.chars <= maxChars;
}

const refuse = (error: string): AppAnswer => ({ ok: false, error });

/** A company path a page asked for, checked: plain, company-relative, outside the platform's folders. Null otherwise. */
export function appReadablePath(value: unknown): string | null {
	if (typeof value !== "string" || value.length > MAX_PATH_CHARS) return null;
	const path = value.replace(/^\/+|\/+$/g, "");
	if (path === "") return "";
	const plain = appRelativePath(path);
	if (plain === null || /%/.test(plain)) return null;
	const top = companyPathKey(plain).split("/")[0] ?? "";
	return APP_CLOSED_FOLDERS.includes(top) ? null : plain;
}

/** Where a link in an app's page leads, once checked. */
export type AppLink =
	| { readonly kind: "app"; readonly name: string }
	| { readonly kind: "file"; readonly path: string }
	| { readonly kind: "web"; readonly href: string };

const MAX_LINK_CHARS = 2048;

/** A link's address as an app's page gave it, which is anything a page can write, checked. It leads to an app of the
 * company (`app:<name>`, as in a message), to a file or folder of the company's own work (`folder:<path>`, as in a
 * message, and under the rules a read is under: `appReadablePath`), or to a web page (`http:` or `https:`, checked as a
 * link in a message is). Null for anything else: a relative address, another scheme, a platform folder. */
export function appLink(value: unknown): AppLink | null {
	if (typeof value !== "string" || value.length > MAX_LINK_CHARS) return null;
	const href = value.trim();
	const name = appLinkName(href);
	if (name !== undefined) return { kind: "app", name };
	if (href.startsWith("folder:")) {
		const path = appReadablePath(folderLinkPath(href));
		return path === null || path === "" ? null : { kind: "file", path };
	}
	const web = webHref(href);
	return web !== undefined && /^https?:/.test(web) ? { kind: "web", href: web } : null;
}

/** The answers to one app's live-data calls, with the member's own reads. */
export class AppBridge {
	readonly #host: AppBridgeHost;
	readonly #app: CompanyApp & { readonly manifest: AppManifest };
	readonly #key: string;
	readonly #signal: AbortSignal;
	readonly #gate: AppGate | undefined;
	readonly #follow: ((link: AppLink) => void) | undefined;
	readonly #page: (() => AppDataPage | undefined) | undefined;
	#files: PageFiles | undefined;
	#preparing = false;

	/** `gate`: where a request for a change is put to the member; without one the app only reads. `follow` opens a
	 * link the member clicked in the page, once it is checked; without it no link opens. `page`: the page the calls come
	 * from now, which a watch's later answers are sent to; without it nothing is watched. */
	constructor(
		host: AppBridgeHost,
		app: CompanyApp & { readonly manifest: AppManifest },
		key: string,
		signal: AbortSignal,
		gate?: AppGate,
		follow?: (link: AppLink) => void,
		page?: () => AppDataPage | undefined,
	) {
		this.#host = host;
		this.#app = app;
		this.#key = key;
		this.#signal = signal;
		this.#gate = gate;
		this.#follow = follow;
		this.#page = page;
	}

	#may(read: AppRead): boolean {
		return this.#app.manifest.reads.includes(read);
	}

	async answer(call: AppCall): Promise<AppAnswer> {
		// A call is a method and a few short values (a row's cells may be longer): anything larger is no call this bridge
		// takes.
		const maxParams =
			call.method === "query" || call.method === "watch" || call.method === "act"
				? MAX_DATA_CALL_PARAMS_CHARS
				: call.method === "setRow" || call.method === "addRow"
					? MAX_ROW_PARAMS_CHARS
					: MAX_PARAMS_CHARS;
		if (
			call.method.length > 32 ||
			!withinParamBudget(call.params, maxParams, { nodes: 0, chars: 0, seen: new Set() })
		)
			return refuse("Not a call the app answers");
		let serializedParams: string;
		try {
			serializedParams = JSON.stringify(call.params);
		} catch {
			return refuse("Not a call the app answers");
		}
		if (serializedParams.length > maxParams) return refuse("Not a call the app answers");
		// Ending a watch goes first, outside the budget and the calls in flight: it only takes work away, and a refused
		// one would keep the watch's place taken until the page reloads, since the page's stop runs once.
		if (call.method === "unwatch") return this.#unwatch(call);
		if (call.method === "file") {
			this.#files ??= new PageFiles(this.#host.folder(), this.#app.path, this.#signal);
			return this.#files.file(call.params);
		}
		// The call's whole cost is known before anything is spent, and checked and charged in one step: a call that does
		// not fit in the minute is refused and spends nothing (a note at 117 calls was let through to 122, and a web
		// link refused there kept its first call; review r1 of #1770, F2).
		const spent = budget(this.#key);
		const cost =
			call.method === "open" && appLink(call.params.href)?.kind === "web"
				? REQUEST_COST
				: (CALL_COST[call.method] ?? 1);
		if (spent.inFlight >= MAX_IN_FLIGHT || spent.calls + cost > MAX_PER_MINUTE)
			return refuse("Too many calls: wait a moment and try again");
		spent.calls += cost;
		spent.inFlight++;
		try {
			const value = await this.#value(call);
			if (!value.ok) return value;
			if (JSON.stringify(value.value).length > MAX_ANSWER_BYTES) return refuse("The answer is larger than 1 MiB");
			return value;
		} finally {
			spent.inFlight--;
		}
	}

	async #value(call: AppCall): Promise<AppAnswer> {
		const folder = this.#host.folder();
		switch (call.method) {
			case "read":
			case "list": {
				const asked = appReadablePath(call.params.path);
				if (asked === null) return refuse("An app reads only the company's own files");
				// The app's own files are always its to read; anything else only with `files`.
				const root = companyPathKey(this.#app.path);
				const inside =
					asked !== "" && (companyPathKey(asked) === root || companyPathKey(asked).startsWith(`${root}/`));
				if (!inside && !this.#may("files"))
					return refuse('Add "files" to reads in app.toml to read the company\'s other files');
				const target = asked;
				if (call.method === "list") {
					const entries = await listAll(folder, target, this.#signal, 500);
					return {
						ok: true,
						value: entries
							.filter((entry) => appReadablePath(entry.path) !== null)
							.map((entry) => ({
								name: entry.path.slice(entry.path.lastIndexOf("/") + 1),
								path: entry.path,
								kind: entry.kind,
								bytes: entry.file?.bytes ?? null,
								updatedAt: entry.updatedAt,
							})),
					};
				}
				const entry = (await folder.read(target, this.#signal)).entry;
				if (!entry || entry.kind !== "file") return refuse("No file is at that path");
				const text = await readText(folder, entry, this.#signal, MAX_ANSWER_BYTES);
				return text === null ? refuse("That file is not text, or larger than 1 MiB") : { ok: true, value: text };
			}
			case "table": {
				if (!this.#may("tables")) return refuse('Add "tables" to reads in app.toml to read tables');
				const name = call.params.name;
				if (typeof name !== "string" || !isInterfaceName(name)) return refuse("No table has that name");
				const definition = (await folder.read(`QorperaOS/tables/${name}/table.toml`, this.#signal)).entry;
				const definitionText = definition ? await readText(folder, definition, this.#signal, 64 * 1024) : null;
				if (definitionText === null) return refuse("No table has that name");
				const parsed = parseTableFile(definitionText);
				if (!parsed.ok) return refuse("That table's definition has problems");
				const rowsEntry = (await folder.read(`QorperaOS/tables/${name}/rows.csv`, this.#signal)).entry;
				const rowsText = rowsEntry ? await readText(folder, rowsEntry, this.#signal, 64 * 1024) : "";
				const rows = rowsText === null ? { rows: [] } : parseTableRows(parsed.file, rowsText);
				return {
					ok: true,
					value: {
						name: parsed.file.name,
						columns: parsed.file.columns.map((column) => column.name),
						rows: rows.rows,
					},
				};
			}
			case "agents":
				if (!this.#may("agents")) return refuse('Add "agents" to reads in app.toml to read the agents');
				return { ok: true, value: this.#host.agents().map((agent) => ({ ...agent })) };
			case "todos": {
				if (!this.#may("todos")) return refuse('Add "todos" to reads in app.toml to read the todos');
				return { ok: true, value: await this.#todos(folder) };
			}
			case "reading": {
				if (!this.#may("reading"))
					return refuse('Add "reading" to reads in app.toml to read the company\'s reading of itself');
				const reading = this.#host.reading;
				return { ok: true, value: reading ? await reading.read(this.#signal) : NO_READING };
			}
			case "questions": {
				if (!this.#may("questions"))
					return refuse('Add "questions" to reads in app.toml to read the open questions');
				const source = this.#host.questions;
				if (!source) return { ok: true, value: [] };
				return {
					ok: true,
					value: await appQuestions(source, this.#app.name, (id) => source.agent(id)?.displayName ?? ""),
				};
			}
			case "answer":
			case "setRow":
			case "addRow":
			case "tell":
				return this.#change(call);
			case "act":
				return this.#act(call);
			case "query":
			case "watch":
				return this.#data(call);
			case "open": {
				// A link the member clicked (the frame document sends it; the page's `qorpera` object has no such call). It
				// needs nothing in `reads`: nothing is read for it, and the answer is the same whether or not what it names
				// is there, so a page learns nothing by it.
				const link = appLink(call.params.href);
				if (link === null || !this.#follow)
					return refuse("A link opens an app (app:name), a company file (folder:path) or a web page (https://…)");
				if (link.kind === "web") return this.#web(link, this.#follow);
				this.#follow(link);
				return { ok: true, value: null };
			}
			default:
				return refuse("Not a call the app answers");
		}
	}

	/** A request for a change: only what the manifest's `writes` names, checked, then put to the member; or a note to the
	 * app's owner, which any app may ask for, since the page chooses neither who hears it nor the words that go. The page
	 * is answered once the member chose and, when they allowed it, the change is saved or refused, or the note went
	 * (`{sent: true}`) or waits in the agent's thread (`{sent: false, waiting: true}`). */
	async #change(call: AppCall): Promise<AppAnswer> {
		const writes = this.#app.manifest.writes;
		const gate = this.#gate;
		let prepare: () => Promise<PreparedAsk>;
		if (call.method === "tell") {
			const tell = this.#host.tell;
			if (!gate || !tell) return refuse("Nothing can be sent from this page");
			// The app's one note is kept still (on its way, or waiting for the member): the page waits, and a kept note no
			// bar shows is on the bar again (one the bar shows already stays as it is).
			const kept = noteKept(tell, this.#app.name);
			if (kept) {
				void this.restore();
				return refuse(kept);
			}
			// A sent note leaves the page a pause before its next: no bar on the heels of the last.
			if (Date.now() - (told.get(this.#key) ?? Number.NEGATIVE_INFINITY) < TELL_AGAIN_MS)
				return refuse("A note was sent from this app a moment ago: ask again in a few seconds");
			prepare = async () => prepareTell(tell, this.#app, call.params);
		} else if (call.method === "answer") {
			if (!writes.includes(APP_WRITE_ANSWERS))
				return refuse('Add "answers" to writes in app.toml to answer a question from the page');
			const questions = this.#host.questions;
			if (!gate || !questions) return refuse("Nothing can be changed from this page");
			prepare = () => prepareAnswer(questions, this.#app.name, call.params);
		} else {
			const table = call.params.table;
			if (typeof table !== "string" || !isInterfaceName(table) || !writes.includes(`table:${table}`))
				return refuse('Add "table:<name>" to writes in app.toml to change rows of that table');
			const { writer, current } = this.#host;
			if (!gate || !writer || !current) return refuse("Nothing can be changed from this page");
			prepare = () => prepareRow(writer(), call.method === "addRow", call.params, this.#signal, current);
		}
		// One request at a time: while one waits for the member, another is refused before anything is read.
		if (this.#preparing) return refuse(GATE_SAYS.busy);
		const closed = gate.closed();
		if (closed) return refuse(GATE_SAYS[closed]);
		this.#preparing = true;
		try {
			let prepared: PreparedAsk;
			try {
				prepared = await prepare();
			} catch (error) {
				if (error instanceof AppActionRefused) return refuse(error.message);
				throw error;
			}
			const result = await gate.ask(
				prepared.ask,
				call.method === "tell" ? this.#told(prepared.perform) : prepared.perform,
				prepared.keep,
			);
			if ("message" in result) return refuse(result.message);
			if (result.outcome === "told")
				return { ok: true, value: result.sent ? { sent: true } : { sent: false, waiting: true } };
			if (result.outcome === "saved") return { ok: true, value: { saved: true } };
			// Only a web page's request is opened; a change never is.
			return refuse(result.outcome === "opened" ? "Not a change" : GATE_SAYS[result.outcome]);
		} finally {
			this.#preparing = false;
		}
	}

	async #act(call: AppCall): Promise<AppAnswer> {
		const asked = appDataChange(call.params);
		if (typeof asked === "string") return refuse(asked);
		const required = `${APP_WRITE_DATA}${asked.database}/${asked.change}`;
		if (!this.#app.manifest.writes.includes(required as AppManifest["writes"][number]))
			return refuse(`Add "${required}" to writes in app.toml to run ${asked.database}/${asked.change}`);
		const gate = this.#gate;
		const data = this.#host.data;
		if (!gate?.askData || !data) return refuse("Database changes can't be run from this page");
		if (this.#preparing) return refuse(GATE_SAYS.busy);
		const closed = gate.closed();
		if (closed) return refuse(GATE_SAYS[closed]);
		this.#preparing = true;
		try {
			let prepared: PreparedDataAsk;
			try {
				prepared = await prepareDataChange(data, asked, this.#signal);
			} catch (error) {
				if (error instanceof AppActionRefused || error instanceof CloudMemberDataError)
					return refuse(error.message);
				return refuse(error instanceof Error ? error.message : "Database change preview failed");
			}
			const result = await gate.askData(prepared.ask, prepared.perform);
			if ("message" in result) return refuse(result.message);
			if (result.outcome !== "saved") return refuse(GATE_SAYS[result.outcome]);
			return { ok: true, value: fittedChangeResult(result.result) };
		} finally {
			this.#preparing = false;
		}
	}

	/** A web page the member clicked a link to (Jonas, 13 November 2026: "Show the address first"): put on the bar, its
	 * whole address shown, and opened in a new tab only by the member's press on Open there, which also lets the browser
	 * open the tab. Like any request it costs a request's share of the budget, waits alone (a second while one waits is
	 * refused) and is quiet after three Not now in a row. */
	async #web(link: Extract<AppLink, { kind: "web" }>, follow: (link: AppLink) => void): Promise<AppAnswer> {
		const gate = this.#gate;
		if (!gate) return refuse("No web page opens from this page");
		const closed = gate.closed();
		if (closed) return refuse(GATE_SAYS[closed]);
		// The tab opens in the press itself: `follow` runs before the first await of the bar's perform.
		const result = await gate.ask({ kind: "link", href: link.href }, async () => {
			follow(link);
			return undefined;
		});
		if (result.outcome === "opened") return { ok: true, value: null };
		if (
			result.outcome === "declined" ||
			result.outcome === "busy" ||
			result.outcome === "quiet" ||
			result.outcome === "gone"
		)
			return refuse(GATE_SAYS[result.outcome]);
		return refuse("message" in result ? result.message : "No web page opened");
	}

	/** A named question of the company's databases: asked once (`query`), or asked and kept live (`watch`), whose later
	 * answers go to the page as `qorpera-app-data` messages. A page gets each answer as `pageAnswer` makes it. A question
	 * of the reserved database `qorpera` is one of the platform's own numbers: it needs `money` or `site` in `reads`
	 * (`data` reads none of them, and they need no `data`), and goes to CompanyNumbers. */
	async #data(call: AppCall): Promise<AppAnswer> {
		const asked = appDataQuestion(call.params);
		let source: CompanyLiveSource | undefined;
		if (typeof asked !== "string" && asked.database === APP_NUMBERS_DATABASE) {
			const read = appNumbersRead(asked.question);
			if (read === null) return refuse(noNumbersQuestion(asked.question));
			if (!this.#may(read))
				return refuse(`Add "${read}" to reads in app.toml to ask ${APP_NUMBERS_DATABASE}/${asked.question}`);
			source = this.#host.numbers;
			if (!source) return refuse("The company's numbers can't be asked from here");
		} else {
			// A name of another shape from an app that asks only the platform's numbers is told what is wrong with it.
			if (!this.#may("data"))
				return refuse(
					typeof asked === "string" && (this.#may("money") || this.#may("site")) ? asked : NO_DATA_READ,
				);
			source = this.#host.data;
			if (!source) return refuse("This company's databases can't be asked from here");
			if (typeof asked === "string") return refuse(asked);
		}
		const live = source;
		try {
			if (call.method === "query") {
				const shown = fittedAnswer(await live.query(asked, this.#signal));
				return shown ? { ok: true, value: shown } : refuse(ANSWER_TOO_LARGE);
			}
			const page = this.#page?.();
			if (!page || page.signal.aborted) return refuse("This page can't watch the company's databases");
			// A later answer too large for the page is not sent: the watch ends there, its place is given back, and the
			// page keeps the last answer it was sent.
			const started = await live.watch(page.signal, asked, (watch, answer) => {
				const shown = fittedAnswer(answer);
				if (shown) page.send(watch, shown);
				else live.unwatch(page.signal, watch);
			});
			const shown = fittedAnswer(started.answer);
			if (shown) return { ok: true, value: { watch: started.watch, answer: shown } };
			// A first answer too large: no watch is kept, and the page is told why.
			live.unwatch(page.signal, started.watch);
			return refuse(ANSWER_TOO_LARGE);
		} catch (error) {
			if (error instanceof CloudMemberDataError || error instanceof AppDataRefused) return refuse(error.message);
			throw error;
		}
	}

	#unwatch(call: AppCall): AppAnswer {
		const page = this.#page?.();
		const watch = call.params.watch;
		// The databases' watches count up from 1 and the numbers' down from -1, so a watch is one source's alone.
		return page &&
			typeof watch === "number" &&
			(this.#host.data?.unwatch(page.signal, watch) || this.#host.numbers?.unwatch(page.signal, watch))
			? { ok: true, value: null }
			: refuse("No such watch");
	}

	/** A note's send, with the app's pause after it counted from when the note went or was left waiting in its thread:
	 * there, not when the bar hears of it, as the bar may be put away (the member left the app) while the note goes. */
	#told(perform: PreparedAsk["perform"]): PreparedAsk["perform"] {
		return async (words) => {
			const went = await perform(words);
			if (went && !went.held) told.set(this.#key, Date.now());
			return went;
		};
	}

	/** A note held for this app while its thread could not take it (app/app-actions.ts `HeldNote`), on the bar again
	 * when the app's page is shown: the member's words as they left them, sent as any note is. Nothing when none is
	 * held, or when the bar has a request already. */
	async restore(): Promise<void> {
		const tell = this.#host.tell;
		const gate = this.#gate;
		if (!tell || !gate || gate.closed()) return;
		const prepared = restoreTell(tell, this.#app);
		if (prepared) await gate.ask(prepared.ask, this.#told(prepared.perform), prepared.keep);
	}

	/** Each agent's todos, as their files' first heading and status say. */
	async #todos(folder: Folder) {
		const agents = (await listAll(folder, "QorperaOS/agents", this.#signal, 200)).filter(
			(entry) => entry.kind === "folder",
		);
		const todos: { agent: string; title: string; status: string; updatedAt: string }[] = [];
		const batchSize = APP_READ_CONCURRENCY * 2;
		for (
			let agentStart = 0;
			agentStart < agents.length && todos.length < TODO_FILES;
			agentStart += APP_READ_CONCURRENCY
		) {
			const remaining = TODO_FILES - todos.length;
			const agentChunk = agents.slice(agentStart, agentStart + APP_READ_CONCURRENCY);
			const listed = await mapLimited(agentChunk, APP_READ_CONCURRENCY, this.#signal, async (agent) => ({
				agent: agent.path.slice(agent.path.lastIndexOf("/") + 1),
				files: await listAll(folder, `${agent.path}/todos`, this.#signal, remaining).catch(() => []),
			}));
			const candidates: { agent: string; file: CloudMemberFolderEntry }[] = [];
			for (const group of listed) {
				for (const file of group.files) {
					if (file.kind !== "file" || appFileKind(file.path) !== "md") continue;
					candidates.push({ agent: group.agent, file });
				}
			}
			for (let start = 0; start < candidates.length && todos.length < TODO_FILES; start += batchSize) {
				const slice = candidates.slice(start, start + batchSize);
				const read = await mapLimited(slice, APP_READ_CONCURRENCY, this.#signal, async ({ agent, file }) => {
					const text = await readText(folder, file, this.#signal, 16 * 1024);
					const parsed = text === null ? null : parseCompanyStateFile(file.path, text);
					if (parsed?.ok !== true || parsed.file.kind !== "todo") return null;
					return {
						agent,
						title: parsed.file.title,
						status: parsed.file.status,
						updatedAt: file.updatedAt,
					};
				});
				for (const item of read) {
					if (!item) continue;
					todos.push(item);
					if (todos.length >= TODO_FILES) break;
				}
			}
		}
		return todos;
	}
}

/* ---- The company's databases ------------------------------------------------------------------------------- */

/** A refusal of the company's watches, in words for the page. */
export class AppDataRefused extends Error {}

/** A page's question, checked: `name` is `<database>/<question>`, `params` at most 16 named short values (text, a
 * finite number, true, false or null), never `viewer`, which the gateway fills with the member looking. Otherwise the
 * words of the refusal. */
function isDataParamValue(
	value: unknown,
	state: { nodes: number; seen: Set<object> } = { nodes: 0, seen: new Set() },
	depth = 0,
): value is CloudMemberDataParamValue {
	if (depth > 16 || ++state.nodes > 4_096) return false;
	if (value === null || typeof value === "boolean" || typeof value === "string") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value === "object") {
		if (state.seen.has(value)) return false;
		state.seen.add(value);
		if (Array.isArray(value)) return value.every((item) => isDataParamValue(item, state, depth + 1));
		const proto = Object.getPrototypeOf(value);
		if (proto !== Object.prototype && proto !== null) return false;
		return Object.values(value).every((item) => isDataParamValue(item, state, depth + 1));
	}
	return false;
}

export function appDataQuestion(params: Record<string, unknown>): CloudMemberDataQuestion | string {
	const name = params.name;
	const parts = typeof name === "string" ? name.split("/") : [];
	const [database = "", question = ""] = parts;
	if (parts.length !== 2 || !CLOUD_MEMBER_DATA_DATABASE.test(database) || !CLOUD_MEMBER_DATA_QUESTION.test(question))
		return "Name a question as <database>/<question>";
	const given = params.params ?? {};
	if (typeof given !== "object" || given === null || Array.isArray(given))
		return "A question's parameters are named values";
	const values: [string, CloudMemberDataParamValue][] = [];
	const entries = Object.entries(given);
	if (entries.length > MAX_DATA_PARAMS) return `A question takes at most ${MAX_DATA_PARAMS} parameters`;
	for (const [key, value] of entries) {
		if (key === "viewer") return ":viewer is filled by Qorpera with the member looking";
		if (!DATA_PARAM.test(key)) return "A parameter's name is a-z, 0-9 and _";
		if (!isDataParamValue(value)) return `:${key} must be a JSON value`;
		values.push([key, value]);
	}
	const built = Object.fromEntries(values);
	if (UTF8.encode(JSON.stringify(built)).byteLength > MAX_DATA_PARAM_BYTES)
		return "A question's parameters take at most 64 KiB together";
	return { database, question, params: built };
}

export function appDataChange(params: Record<string, unknown>): CloudMemberDataChangeRequest | string {
	const name = params.name;
	const parts = typeof name === "string" ? name.split("/") : [];
	const [database = "", change = ""] = parts;
	if (
		parts.length !== 2 ||
		database === APP_NUMBERS_DATABASE ||
		!CLOUD_MEMBER_DATA_DATABASE.test(database) ||
		!CLOUD_MEMBER_DATA_QUESTION.test(change)
	)
		return "Name a change as <database>/<change>";
	const given = params.params ?? {};
	if (typeof given !== "object" || given === null || Array.isArray(given))
		return "A change's parameters are named values";
	const values: [string, CloudMemberDataParamValue][] = [];
	const entries = Object.entries(given);
	if (entries.length > MAX_DATA_PARAMS) return `A change takes at most ${MAX_DATA_PARAMS} parameters`;
	for (const [key, value] of entries) {
		if (key === "viewer") return ":viewer is filled by Qorpera with the member acting";
		if (!DATA_PARAM.test(key)) return "A parameter's name is a-z, 0-9 and _";
		if (!isDataParamValue(value)) return `:${key} must be a JSON value`;
		values.push([key, value]);
	}
	const built = Object.fromEntries(values);
	if (UTF8.encode(JSON.stringify(built)).byteLength > MAX_DATA_PARAM_BYTES)
		return "A change's parameters take at most 64 KiB together";
	return { database, change, params: built };
}

export interface PageDataChangeResult {
	readonly changed?: number;
	readonly columns?: string[];
	readonly rows?: Record<string, unknown>[];
	readonly more?: boolean;
	readonly asOf: string;
}

export function fittedChangeResult(changed: CloudMemberDataChanged): PageDataChangeResult {
	const base: PageDataChangeResult = {
		...(changed.changed === undefined ? {} : { changed: changed.changed }),
		asOf: changed.asOf,
	};
	if (changed.columns === undefined || changed.rows === undefined) return base;
	const columns = [...changed.columns];
	const rows = changed.rows.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
	const full: PageDataChangeResult = { ...base, columns, rows, more: changed.more ?? false };
	if (UTF8.encode(JSON.stringify(full)).byteLength <= DATA_ANSWER_BYTES) return full;
	const kept: Record<string, unknown>[] = [];
	const shellBytes = UTF8.encode(JSON.stringify({ ...base, columns, rows: [], more: true })).byteLength;
	if (shellBytes > DATA_ANSWER_BYTES) return { ...base, more: true };
	let bytes = shellBytes;
	for (const row of rows) {
		const rowBytes = UTF8.encode(JSON.stringify(row)).byteLength + (kept.length > 0 ? 1 : 0);
		if (bytes + rowBytes > DATA_ANSWER_BYTES) break;
		kept.push(row);
		bytes += rowBytes;
	}
	return { ...base, columns, rows: kept, more: true };
}

/** An answer as a page gets it, rows as objects by column name as `table` gives them: `{ columns, rows, more, asOf }`.
 * The etag stays here. Two columns of one name: the later one's value stands in the row, and `columns` names both.
 * `Object.fromEntries` makes each name an own property, so a column named `__proto__` or `constructor` is a plain key
 * and changes no prototype; the page gets a copy of it anyway. */
export function pageAnswer(answer: CloudMemberDataAnswer): PageDataAnswer {
	return {
		columns: [...answer.columns],
		rows: answer.rows.map((row) => Object.fromEntries(answer.columns.map((column, index) => [column, row[index]]))),
		more: answer.more,
		asOf: answer.asOf,
	};
}

export interface PageDataAnswer {
	columns: string[];
	rows: Record<string, unknown>[];
	more: boolean;
	asOf: string;
}

/** An answer a page may be handed, at most, in UTF-8 bytes of JSON in the shape the page gets (rows as objects, each
 * repeating its column names): under the bridge's 1 MiB for any answer, with room for a watch's id around it. */
const DATA_ANSWER_BYTES = MAX_ANSWER_BYTES - 1024;
const UTF8 = new TextEncoder();
const ANSWER_TOO_LARGE =
	"The answer is larger than a page may be handed (1 MiB as rows of named columns): ask for fewer rows or columns";

/** The answer as the page gets it, or null when that is too large: the one check for a question's answer, a watch's
 * first answer and each later one. */
export function fittedAnswer(answer: CloudMemberDataAnswer): PageDataAnswer | null {
	const shown = pageAnswer(answer);
	// Bytes, not characters: a column name in another script takes up to three bytes a character.
	return UTF8.encode(JSON.stringify(shown)).byteLength > DATA_ANSWER_BYTES ? null : shown;
}

/** What a page's `query` and `watch` ask: the company's databases (CompanyData) or the platform's numbers
 * (CompanyNumbers). A watch's id is unique among both in a tab. */
export interface CompanyLiveSource {
	query(asked: CloudMemberDataQuestion, signal: AbortSignal): Promise<CloudMemberDataAnswer>;
	watch(
		page: AbortSignal,
		asked: CloudMemberDataQuestion,
		push: (watch: number, answer: CloudMemberDataAnswer) => void,
	): Promise<{ watch: number; answer: CloudMemberDataAnswer }>;
	unwatch(page: AbortSignal, watch: number): boolean;
	/** Ends the page's watches whose question `keep` does not keep (every one without it): the page may no longer ask
	 * them, and keeps what it shows. */
	release(page: AbortSignal, keep?: (asked: CloudMemberDataQuestion) => boolean): void;
}

/** What the company's watches need of the member's client of its databases (CloudMemberData). */
export interface CompanyDataClient {
	query(asked: CloudMemberDataQuestion, signal: AbortSignal): Promise<CloudMemberDataAnswer>;
	watch(watches: readonly CloudMemberDataWatch[], signal: AbortSignal): Promise<CloudMemberDataWatchAnswer>;
	previewChange?(asked: CloudMemberDataChangeRequest, signal: AbortSignal): Promise<CloudMemberDataChangePreview>;
	change?(asked: CloudMemberDataChangeRequest, signal: AbortSignal): Promise<CloudMemberDataChanged>;
}

/** Watches one page holds, at most. */
const PAGE_WATCHES = 8;
/** After a watch call failed: the waits before the next, the last one repeated. */
const DATA_RETRY_MS = [2000, 5000, 10_000] as const;
/** A watch call starts at most this soon after the one before, so a gateway that answers at once is not asked in a
 * loop. */
const DATA_CALL_GAP_MS = 500;

/** One question with its parameters, as the held call carries it, and who watches it. */
interface DataEntry {
	readonly key: string;
	readonly asked: CloudMemberDataQuestion;
	/** The answer as last read; undefined until the first one is there, and not in the call until then. */
	answer: CloudMemberDataAnswer | undefined;
	readonly first: Promise<CloudMemberDataAnswer>;
	readonly watchers: Set<DataWatcher>;
}

interface DataWatcher {
	readonly watch: number;
	readonly entry: DataEntry;
	readonly page: AbortSignal;
	readonly push: (watch: number, answer: CloudMemberDataAnswer) => void;
}

/** The open company's databases, asked as the member (deploy/first-node/RUNTIME-COMPANY-DATABASES.md §5): one per open
 * company, shared by every app's page. Every watch of every page travels in ONE held watch call at a time, at most
 * CLOUD_MEMBER_DATA_WATCHES questions; two watches of the same question and parameters are one question in it.
 * - When the set of questions changes, the call in flight ends and a new one starts. A call that answers `changed`
 *   takes the new answers' etags, sends each to the pages that watch it, and calls again; `same` calls again.
 * - A call that fails tells no page anything (each keeps what it shows); the next waits 2 s, then 5 s, then 10 s, and
 *   10 s from then on until one answers.
 * - It stops when no watch is left, when the company is put away (`signal`) and while the tab is hidden, and starts
 *   again when the tab is shown. A page's watches end when its own signal does (the app closed, or reloaded).
 * - Every call is the member's own, and `current` checks before and after it that the company is still the one on
 *   screen. */
export class CompanyData implements CompanyLiveSource {
	readonly #client: () => CompanyDataClient;
	readonly #signal: AbortSignal;
	readonly #current: () => void;
	readonly #entries = new Map<string, DataEntry>();
	readonly #pages = new Map<AbortSignal, Map<number, DataWatcher>>();
	#next = 0;
	#call: AbortController | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#scheduled = false;
	#paused = false;
	#failures = 0;
	#started = Number.NEGATIVE_INFINITY;

	constructor(client: () => CompanyDataClient, signal: AbortSignal, current: () => void = () => {}) {
		this.#client = client;
		this.#signal = signal;
		this.#current = current;
		signal.addEventListener(
			"abort",
			() => {
				this.#halt();
				this.#entries.clear();
				this.#pages.clear();
			},
			{ once: true },
		);
		document.addEventListener(
			"visibilitychange",
			() => {
				if (document.visibilityState === "hidden") this.#halt();
				else if (!this.#paused) this.#again();
			},
			{ signal },
		);
	}

	pause(): void {
		if (this.#paused) return;
		this.#paused = true;
		this.#halt();
	}

	resume(): void {
		if (!this.#paused || this.#signal.aborted) return;
		this.#paused = false;
		if (document.visibilityState !== "hidden") this.#again();
	}

	/** The questions the held call carries now (each once, however many pages watch it). */
	get questions(): number {
		return this.#entries.size;
	}

	/** One question's answer, as the member. */
	async query(asked: CloudMemberDataQuestion, signal: AbortSignal): Promise<CloudMemberDataAnswer> {
		this.#current();
		const answer = await withAbortScopes([signal, this.#signal], (scoped) => this.#client().query(asked, scoped));
		this.#current();
		return answer;
	}

	async previewChange(
		asked: CloudMemberDataChangeRequest,
		signal: AbortSignal,
	): Promise<CloudMemberDataChangePreview> {
		this.#current();
		const client = this.#client();
		if (!client.previewChange) throw new CloudMemberDataError("Database changes are not available here");
		const preview = await withAbortScopes([signal, this.#signal], (scoped) => client.previewChange!(asked, scoped));
		this.#current();
		return preview;
	}

	async change(asked: CloudMemberDataChangeRequest, signal: AbortSignal): Promise<CloudMemberDataChanged> {
		this.#current();
		const client = this.#client();
		if (!client.change) throw new CloudMemberDataError("Database changes are not available here");
		const result = await withAbortScopes([signal, this.#signal], (scoped) => client.change!(asked, scoped));
		this.#current();
		return result;
	}

	/** Starts a watch for the page whose lifetime `page` is: its first answer and its id. Later answers that differ go
	 * to `push`. */
	async watch(
		page: AbortSignal,
		asked: CloudMemberDataQuestion,
		push: (watch: number, answer: CloudMemberDataAnswer) => void,
	): Promise<{ watch: number; answer: CloudMemberDataAnswer }> {
		if (this.#signal.aborted || page.aborted) throw new AppDataRefused("This page was put away");
		// Own keys in a fixed order: `{a, b}` and `{b, a}` are one question.
		const key = JSON.stringify([
			asked.database,
			asked.question,
			Object.keys(asked.params)
				.sort()
				.map((name) => [name, asked.params[name]]),
		]);
		let watchers = this.#pages.get(page);
		if ((watchers?.size ?? 0) >= PAGE_WATCHES)
			throw new AppDataRefused(`A page watches at most ${PAGE_WATCHES} questions at once`);
		let entry = this.#entries.get(key);
		if (!entry) {
			if (this.#entries.size >= CLOUD_MEMBER_DATA_WATCHES)
				throw new AppDataRefused(
					`The company's open apps watch at most ${CLOUD_MEMBER_DATA_WATCHES} questions together`,
				);
			const first = this.query(asked, this.#signal);
			const made: DataEntry = { key, asked, answer: undefined, first, watchers: new Set() };
			entry = made;
			this.#entries.set(key, made);
			// Its first answer puts it into the held call. One that fails ends it with its watchers, below.
			first.then(
				(answer) => {
					made.answer ??= answer;
					if (this.#entries.get(key) === made) this.#again();
				},
				() => undefined,
			);
		}
		if (!watchers) {
			const made = new Map<number, DataWatcher>();
			watchers = made;
			this.#pages.set(page, made);
			page.addEventListener(
				"abort",
				() => {
					for (const watch of [...made.keys()]) this.unwatch(page, watch);
					this.#pages.delete(page);
				},
				{ once: true },
			);
		}
		const watcher: DataWatcher = { watch: ++this.#next, entry, page, push };
		entry.watchers.add(watcher);
		watchers.set(watcher.watch, watcher);
		let answer: CloudMemberDataAnswer;
		try {
			answer = entry.answer ?? (await entry.first);
		} catch (error) {
			this.unwatch(page, watcher.watch);
			throw error;
		}
		if (!watchers.has(watcher.watch)) throw new AppDataRefused("This page was put away");
		return { watch: watcher.watch, answer: entry.answer ?? answer };
	}

	/** Ends a watch of the page's; false when the page has no such watch. */
	unwatch(page: AbortSignal, watch: number): boolean {
		const watcher = this.#pages.get(page)?.get(watch);
		if (!watcher) return false;
		this.#pages.get(page)?.delete(watch);
		const entry = watcher.entry;
		entry.watchers.delete(watcher);
		if (entry.watchers.size === 0 && this.#entries.get(entry.key) === entry) {
			this.#entries.delete(entry.key);
			// Only a question in the call changes the call.
			if (entry.answer !== undefined) this.#again();
		}
		return true;
	}

	/** Ends the page's watches whose question `keep` does not keep (every one without it). */
	release(page: AbortSignal, keep: (asked: CloudMemberDataQuestion) => boolean = () => false): void {
		const watchers = this.#pages.get(page);
		if (!watchers) return;
		for (const [watch, watcher] of [...watchers]) if (!keep(watcher.entry.asked)) this.unwatch(page, watch);
	}

	/** Ends the call in flight and any wait, and starts the next call in a moment, once the set has settled. */
	#again(): void {
		this.#call?.abort();
		this.#call = undefined;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		if (this.#scheduled) return;
		this.#scheduled = true;
		queueMicrotask(() => {
			this.#scheduled = false;
			this.#run();
		});
	}

	#halt(): void {
		this.#call?.abort();
		this.#call = undefined;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	#run(): void {
		if (
			this.#paused ||
			this.#signal.aborted ||
			document.visibilityState === "hidden" ||
			this.#call ||
			this.#timer !== undefined
		)
			return;
		const held = [...this.#entries.values()].filter((entry) => entry.answer !== undefined);
		if (held.length === 0) return;
		const gap = this.#started + DATA_CALL_GAP_MS - Date.now();
		if (gap > 0) {
			this.#timer = setTimeout(() => {
				this.#timer = undefined;
				this.#run();
			}, gap);
			return;
		}
		this.#started = Date.now();
		const call = new AbortController();
		this.#call = call;
		void (async () => {
			let answer: CloudMemberDataWatchAnswer;
			try {
				this.#current();
				answer = await withAbortScopes([call.signal, this.#signal], (scoped) =>
					this.#client().watch(
						held.map((entry) => ({ ...entry.asked, etag: entry.answer!.etag })),
						scoped,
					),
				);
				this.#current();
			} catch {
				// Ended for a new set, a hidden tab or the company put away: whoever ended it starts what follows.
				if (this.#call !== call) return;
				this.#call = undefined;
				const wait = DATA_RETRY_MS[Math.min(this.#failures, DATA_RETRY_MS.length - 1)];
				this.#failures++;
				this.#timer = setTimeout(() => {
					this.#timer = undefined;
					this.#run();
				}, wait);
				return;
			}
			if (this.#call !== call) return;
			this.#call = undefined;
			this.#failures = 0;
			if ("changed" in answer)
				for (const { index, answer: fresh } of answer.changed) {
					const entry = held[index];
					// A question no page watches any more is told to no one.
					if (!entry || this.#entries.get(entry.key) !== entry) continue;
					entry.answer = fresh;
					for (const watcher of [...entry.watchers])
						try {
							watcher.push(watcher.watch, fresh);
						} catch {
							/* One page's trouble is not another's. */
						}
				}
			this.#run();
		})();
	}
}

/* ---- The platform's numbers of the company ------------------------------------------------------------------ */

/** How often a watched question of the platform's numbers is asked again while the tab is shown: who is on a site now
 * every 15 s, a site's other numbers every minute, money every 5 minutes (the vault fetches the bank at most every six
 * hours). */
export function numbersPollMs(question: string): number {
	if (question === "site-now") return 15_000;
	return appNumbersRead(question) === "site" ? 60_000 : 300_000;
}

/** One question of the platform's numbers, asked as the member (cloud/company-numbers.ts). */
export type CompanyNumbersClient = (asked: CloudMemberDataQuestion) => Promise<CloudMemberDataAnswer>;

interface NumbersEntry {
	readonly key: string;
	readonly asked: CloudMemberDataQuestion;
	/** The answer as last read; undefined until the first one is there. */
	answer: CloudMemberDataAnswer | undefined;
	readonly first: Promise<CloudMemberDataAnswer>;
	readonly watchers: Set<NumbersWatcher>;
	/** When it is asked again, and the timer that asks it while the tab is shown. */
	due: number;
	timer: ReturnType<typeof setTimeout> | undefined;
	asking: boolean;
}

interface NumbersWatcher {
	readonly watch: number;
	readonly entry: NumbersEntry;
	readonly push: (watch: number, answer: CloudMemberDataAnswer) => void;
}

/** The open company's platform numbers (`qorpera/money-now` and the like), asked as the member: one per open company,
 * shared by every app's page. They are not held by any gateway: a watched question is asked again on its own clock
 * (`numbersPollMs`), and its watchers hear only an answer whose etag differs from the last.
 * - Two watches of the same question and parameters are one question; at most 8 watches a page and 24 questions a
 *   company, as for the databases.
 * - A question asked again that fails tells no page anything: it is asked again on its clock.
 * - Nothing is asked while the tab is hidden; when it is shown, a question whose time passed is asked at once.
 * - It stops when the company is put away (`signal`); a page's watches end when its own signal does.
 * - A watch's id counts down from -1, so it is never one of CompanyData's, which count up from 1. */
export class CompanyNumbers implements CompanyLiveSource {
	readonly #client: CompanyNumbersClient;
	readonly #signal: AbortSignal;
	readonly #current: () => void;
	readonly #entries = new Map<string, NumbersEntry>();
	readonly #pages = new Map<AbortSignal, Map<number, NumbersWatcher>>();
	#next = 0;
	#paused = false;

	constructor(client: CompanyNumbersClient, signal: AbortSignal, current: () => void = () => {}) {
		this.#client = client;
		this.#signal = signal;
		this.#current = current;
		signal.addEventListener(
			"abort",
			() => {
				for (const entry of this.#entries.values()) clearTimeout(entry.timer);
				this.#entries.clear();
				this.#pages.clear();
			},
			{ once: true },
		);
		document.addEventListener(
			"visibilitychange",
			() => {
				if (this.#paused) return;
				for (const entry of this.#entries.values()) this.#schedule(entry);
			},
			{ signal },
		);
	}

	pause(): void {
		if (this.#paused) return;
		this.#paused = true;
		for (const entry of this.#entries.values()) {
			clearTimeout(entry.timer);
			entry.timer = undefined;
		}
	}

	resume(): void {
		if (!this.#paused || this.#signal.aborted) return;
		this.#paused = false;
		for (const entry of this.#entries.values()) this.#schedule(entry);
	}

	/** The questions watched now (each once, however many pages watch it). */
	get questions(): number {
		return this.#entries.size;
	}

	/** One question's answer, as the member. */
	async query(asked: CloudMemberDataQuestion, signal: AbortSignal): Promise<CloudMemberDataAnswer> {
		this.#current();
		const answer = await this.#client(asked);
		signal.throwIfAborted();
		this.#signal.throwIfAborted();
		this.#current();
		return answer;
	}

	/** Starts a watch for the page whose lifetime `page` is: its first answer and its id. Later answers that differ go
	 * to `push`. */
	async watch(
		page: AbortSignal,
		asked: CloudMemberDataQuestion,
		push: (watch: number, answer: CloudMemberDataAnswer) => void,
	): Promise<{ watch: number; answer: CloudMemberDataAnswer }> {
		if (this.#signal.aborted || page.aborted) throw new AppDataRefused("This page was put away");
		const key = JSON.stringify([
			asked.question,
			Object.keys(asked.params)
				.sort()
				.map((name) => [name, asked.params[name]]),
		]);
		let watchers = this.#pages.get(page);
		if ((watchers?.size ?? 0) >= PAGE_WATCHES)
			throw new AppDataRefused(`A page watches at most ${PAGE_WATCHES} questions at once`);
		let entry = this.#entries.get(key);
		if (!entry) {
			if (this.#entries.size >= CLOUD_MEMBER_DATA_WATCHES)
				throw new AppDataRefused(
					`The company's open apps watch at most ${CLOUD_MEMBER_DATA_WATCHES} of its numbers together`,
				);
			const first = this.query(asked, this.#signal);
			const made: NumbersEntry = {
				key,
				asked,
				answer: undefined,
				first,
				watchers: new Set(),
				due: Number.POSITIVE_INFINITY,
				timer: undefined,
				asking: false,
			};
			entry = made;
			this.#entries.set(key, made);
			// Its first answer starts its clock. One that fails ends it with its watchers, below.
			first.then(
				(answer) => {
					made.answer ??= answer;
					made.due = Date.now() + numbersPollMs(asked.question);
					if (this.#entries.get(key) === made) this.#schedule(made);
				},
				() => undefined,
			);
		}
		if (!watchers) {
			const made = new Map<number, NumbersWatcher>();
			watchers = made;
			this.#pages.set(page, made);
			page.addEventListener(
				"abort",
				() => {
					for (const watch of [...made.keys()]) this.unwatch(page, watch);
					this.#pages.delete(page);
				},
				{ once: true },
			);
		}
		const watcher: NumbersWatcher = { watch: --this.#next, entry, push };
		entry.watchers.add(watcher);
		watchers.set(watcher.watch, watcher);
		let answer: CloudMemberDataAnswer;
		try {
			answer = entry.answer ?? (await entry.first);
		} catch (error) {
			this.unwatch(page, watcher.watch);
			throw error;
		}
		if (!watchers.has(watcher.watch)) throw new AppDataRefused("This page was put away");
		return { watch: watcher.watch, answer: entry.answer ?? answer };
	}

	/** Ends a watch of the page's; false when the page has no such watch. */
	unwatch(page: AbortSignal, watch: number): boolean {
		const watcher = this.#pages.get(page)?.get(watch);
		if (!watcher) return false;
		this.#pages.get(page)?.delete(watch);
		const entry = watcher.entry;
		entry.watchers.delete(watcher);
		if (entry.watchers.size === 0 && this.#entries.get(entry.key) === entry) {
			this.#entries.delete(entry.key);
			clearTimeout(entry.timer);
			entry.timer = undefined;
		}
		return true;
	}

	/** Ends the page's watches whose question `keep` does not keep (every one without it). */
	release(page: AbortSignal, keep: (asked: CloudMemberDataQuestion) => boolean = () => false): void {
		const watchers = this.#pages.get(page);
		if (!watchers) return;
		for (const [watch, watcher] of [...watchers]) if (!keep(watcher.entry.asked)) this.unwatch(page, watch);
	}

	/** Sets the question's timer for its next ask, or none while the tab is hidden, its first answer is not there yet or
	 * it is being asked. */
	#schedule(entry: NumbersEntry): void {
		clearTimeout(entry.timer);
		entry.timer = undefined;
		if (
			this.#paused ||
			this.#signal.aborted ||
			document.visibilityState === "hidden" ||
			entry.answer === undefined ||
			entry.asking ||
			this.#entries.get(entry.key) !== entry
		)
			return;
		entry.timer = setTimeout(
			() => {
				entry.timer = undefined;
				void this.#ask(entry);
			},
			Math.max(0, entry.due - Date.now()),
		);
	}

	async #ask(entry: NumbersEntry): Promise<void> {
		if (this.#paused || this.#entries.get(entry.key) !== entry || document.visibilityState === "hidden") return;
		entry.asking = true;
		let fresh: CloudMemberDataAnswer | undefined;
		try {
			fresh = await this.query(entry.asked, this.#signal);
		} catch {
			// The page keeps what it shows; the question is asked again on its clock.
		}
		entry.asking = false;
		entry.due = Date.now() + numbersPollMs(entry.asked.question);
		if (this.#entries.get(entry.key) !== entry) return;
		if (fresh && fresh.etag !== entry.answer?.etag) {
			entry.answer = fresh;
			for (const watcher of [...entry.watchers])
				try {
					watcher.push(watcher.watch, fresh);
				} catch {
					/* One page's trouble is not another's. */
				}
		}
		this.#schedule(entry);
	}
}

/* ---- Following the company's apps ---------------------------------------------------------------------------- */

/** What the reader needs: the member's folder, its hint, and the company's lifetime (as app/interface-folder.ts). */
export interface CompanyAppsSource {
	readonly signal: AbortSignal;
	folder(): Folder;
	/** `onState`: whether the hint's channel is subscribed, each time that changes. */
	folderHints(onHint: (seq: number) => void, onState?: (connected: boolean) => void): { close(): Promise<void> };
}

/** One folder hint shared by every reader of the open company (its pages' and its apps'): one channel, each reader's
 * hint passed on, closed when the last reader closes it. */
export function sharedFolderHints<T extends CompanyAppsSource>(
	source: T,
): (onHint: (seq: number) => void, onState?: (connected: boolean) => void) => { close(): Promise<void> } {
	const listeners = new Set<(seq: number) => void>();
	const states = new Set<(connected: boolean) => void>();
	let connected = false;
	let channel: { close(): Promise<void> } | undefined;
	return (onHint, onState) => {
		listeners.add(onHint);
		if (onState) {
			states.add(onState);
			onState(connected);
		}
		channel ??= source.folderHints(
			(seq) => {
				for (const listener of [...listeners]) listener(seq);
			},
			(now) => {
				connected = now;
				for (const state of [...states]) state(now);
			},
		);
		return {
			close: async () => {
				listeners.delete(onHint);
				if (onState) states.delete(onState);
				if (listeners.size > 0 || !channel) return;
				const closing = channel;
				channel = undefined;
				connected = false;
				await closing.close();
			},
		};
	};
}

const APPS_POLL_MS = 60_000;
const APPS_HINT_MS = 1000;
/** After the apps are read, how long their pages wait before they are read ahead; how many apps are read at once, and
 * how many of each app's files; and the bytes a round reads at most (the member's file cache keeps 64 MiB). */
const WARM_MS = 1500;
const WARM_AT_ONCE = 2;
const WARM_FILES_AT_ONCE = 4;
const WARM_BYTES = 24 * 1024 * 1024;

export async function warmApps(folder: Folder, apps: readonly CompanyApp[], signal: AbortSignal): Promise<void> {
	const budget: WarmBudget = { left: WARM_BYTES };
	const reads: (() => Promise<unknown>)[] = [() => readAppBrand(folder, signal)];
	for (const app of [...apps].sort((a, b) => (b.changed ?? 0) - (a.changed ?? 0))) {
		const entry = app.manifest?.entry;
		if (entry === undefined || app.manifest?.kit === "program" || resolveAppPath("", entry) === null) continue;
		reads.push(() =>
			readPage(new AppFiles(folder, app.path, signal, { atOnce: WARM_FILES_AT_ONCE, warm: budget }), entry),
		);
	}
	let next = 0;
	const yieldBetween = hasBrowserCompositor();
	const worker = async () => {
		while (next < reads.length && !signal.aborted) {
			if (yieldBetween) {
				await yieldToMain(signal);
				if (signal.aborted) return;
			}
			await reads[next++]!().catch(() => undefined);
		}
	};
	await Promise.all(Array.from({ length: WARM_AT_ONCE }, worker));
}

/** The company's apps, read when the company opens, after each folder hint (at most once a second) and each minute
 * (in a hidden tab only while the hint's channel is down), published when they change; and every hint passed on to the
 * open panels (`onChange`), which read their own app's files again. A read that fails keeps what was read before. */
export class CompanyApps {
	readonly #source: CompanyAppsSource;
	readonly #publish: (apps: readonly CompanyApp[]) => void;
	readonly #publishGroups: ((groups: readonly AppTreeNode[] | undefined) => void) | undefined;
	readonly #shouldWarm: () => boolean;
	#shownGroups: string | undefined;
	readonly #stop = new AbortController();
	readonly #listeners = new Set<() => void>();
	readonly #readers = new Set<() => void>();
	#hints?: { close(): Promise<void> };
	#poll?: ReturnType<typeof setInterval>;
	#timer?: ReturnType<typeof setTimeout>;
	#warming?: ReturnType<typeof setTimeout>;
	/** The apps changed while a round was waiting or under way: another follows it. */
	#warmAgain = false;
	#shown: string | undefined;
	#last: readonly CompanyApp[] = [];
	/** The hint's channel is subscribed. */
	#hintsLive = false;

	constructor(
		source: CompanyAppsSource,
		publish: (apps: readonly CompanyApp[]) => void,
		/** The company's groups of apps, read with the apps (apps/groups.md), when they change. */
		publishGroups?: (groups: readonly AppTreeNode[] | undefined) => void,
		shouldWarm: () => boolean = () => true,
	) {
		this.#source = source;
		this.#publish = publish;
		this.#publishGroups = publishGroups;
		this.#shouldWarm = shouldWarm;
		source.signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#stop.signal });
	}

	open(): void {
		if (this.#stop.signal.aborted || this.#poll) return;
		// A hidden tab whose hints work reads on no clock (a list, each app's manifest and its bytes, every minute all
		// night); a hint still reads at once. Its first moment back reads, if the clock came due or it was away a whole
		// period (a frozen tab's timers never fired, so no skip was noted).
		let skipped = false;
		let hiddenAt = document.visibilityState === "hidden" ? Date.now() : undefined;
		this.#poll = setInterval(() => {
			if (document.visibilityState === "hidden" && this.#hintsLive) skipped = true;
			else void this.read();
		}, APPS_POLL_MS);
		document.addEventListener(
			"visibilitychange",
			() => {
				if (document.visibilityState === "hidden") {
					hiddenAt ??= Date.now();
					return;
				}
				const away = hiddenAt !== undefined && Date.now() - hiddenAt >= APPS_POLL_MS;
				hiddenAt = undefined;
				if (!away && !skipped) return;
				skipped = false;
				void this.read();
			},
			{ signal: this.#stop.signal },
		);
		try {
			this.#hints = this.#source.folderHints(
				() => this.#hinted(),
				(connected) => {
					this.#hintsLive = connected;
				},
			);
		} catch {
			/* The minute's poll still reads. */
		}
		void this.read();
	}

	dispose(): void {
		if (this.#stop.signal.aborted) return;
		this.#stop.abort();
		clearInterval(this.#poll);
		clearTimeout(this.#timer);
		clearTimeout(this.#warming);
		void this.#hints?.close().catch(() => undefined);
		this.#listeners.clear();
		this.#readers.clear();
		this.#icons.clear();
	}

	/** The apps as last read. */
	get apps(): readonly CompanyApp[] {
		return this.#last;
	}

	readonly #icons = new Map<string, ReadonlyMap<string, CompanyAppIcon>>();

	/** An app's own icons, newest first, read now; files that did not change since its last read are not read again. */
	async icons(app: string): Promise<CompanyAppIcon[]> {
		const { icons, byFile } = await readAppIcons(this.#source.folder(), app, this.#stop.signal, this.#icons.get(app));
		this.#icons.set(app, byFile);
		return icons;
	}

	/** Called after each read of the apps that worked, changed or not. */
	onRead(listener: () => void): () => void {
		this.#readers.add(listener);
		return () => this.#readers.delete(listener);
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#reading: Promise<readonly CompanyApp[]> | undefined;
	#readAgain = false;

	/** Reads the apps now, and publishes them when they changed. */
	async read(): Promise<readonly CompanyApp[]> {
		if (this.#stop.signal.aborted) return this.#last;
		if (this.#reading) {
			this.#readAgain = true;
			return this.#reading;
		}
		let settled = false;
		let run: Promise<readonly CompanyApp[]> | undefined;
		run = (async (): Promise<readonly CompanyApp[]> => {
			try {
				do {
					this.#readAgain = false;
					try {
						const folder = this.#source.folder();
						const [apps, groups] = await Promise.all([
							readApps(folder, this.#stop.signal, this.#last),
							this.#publishGroups ? readAppGroups(folder, this.#stop.signal).catch(() => null) : null,
						]);
						// A failed read of the groups keeps what was read before.
						if (groups !== null) {
							const shownGroups = JSON.stringify(groups ?? null);
							if (shownGroups !== this.#shownGroups && !this.#stop.signal.aborted) {
								this.#shownGroups = shownGroups;
								this.#publishGroups?.(groups);
							}
						}
						const shown = JSON.stringify(apps);
						this.#last = apps;
						if (shown !== this.#shown && !this.#stop.signal.aborted) {
							this.#shown = shown;
							this.#publish(apps);
							this.#warm();
						}
						// After every read that worked, whatever woke it (a hint, the minute's clock, the tab coming back): what reads
						// beside the apps (their icons) reads again too, as a change of those changes no manifest.
						if (!this.#stop.signal.aborted) for (const reader of [...this.#readers]) reader();
					} catch {
						/* What was read before stands. */
					}
				} while (this.#readAgain && !this.#stop.signal.aborted);
				return this.#last;
			} finally {
				settled = true;
				if (this.#reading === run) this.#reading = undefined;
			}
		})();
		if (!settled) this.#reading = run;
		return run;
	}

	/** Reads the apps' pages ahead (`warmApps`), a moment after they changed, so the company's own first reads go
	 * first; one round at a time, and the latest apps when it starts. */
	warmIfNeeded(): void {
		this.#warm(true);
	}

	#warm(force = false): void {
		if (this.#stop.signal.aborted) return;
		if (!force && !this.#shouldWarm()) return;
		if (this.#warming !== undefined) {
			this.#warmAgain = true;
			return;
		}
		// A company with no app that reads has nothing to read ahead.
		if (!this.#last.some((app) => app.manifest)) return;
		this.#warming = setTimeout(() => {
			if (this.#stop.signal.aborted) return;
			if (typeof document !== "undefined" && document.hidden) {
				this.#warming = undefined;
				return;
			}
			void Promise.resolve()
				.then(() => warmApps(this.#source.folder(), this.#last, this.#stop.signal))
				.catch(() => undefined)
				.finally(() => {
					this.#warming = undefined;
					if (!this.#warmAgain) return;
					this.#warmAgain = false;
					this.#warm();
				});
		}, WARM_MS);
	}

	#hinted(): void {
		if (this.#timer !== undefined || this.#stop.signal.aborted) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.read().then(() => {
				if (this.#stop.signal.aborted) return;
				for (const listener of [...this.#listeners]) listener();
			});
		}, APPS_HINT_MS);
	}
}
