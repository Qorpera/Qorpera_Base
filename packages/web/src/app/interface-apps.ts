import {
	APP_ICON_MAX_BYTES,
	APP_ICONS_FOLDER,
	APP_ICONS_MAX,
	type AppIcon,
	appIconIdOf,
	parseAppIcon,
} from "@qorpera/cloud-client/app-icons";
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
	APP_FILE_MAX_BYTES,
	APP_FILE_TYPES,
	APP_MANIFEST,
	APP_MANIFEST_MAX_BYTES,
	APP_MAX_BYTES,
	APP_MAX_FILES,
	APP_MEDIA_KINDS,
	APP_VIDEO_FILE_MAX_BYTES,
	APP_VIDEO_KINDS,
	APP_VIDEOS_MAX_BYTES,
	APP_WRITE_ANSWERS,
	APPS_FOLDER,
	type AppManifest,
	type AppProblem,
	type AppRead,
	appFileKind,
	appLinkName,
	appRelativePath,
	parseAppManifest,
} from "@qorpera/cloud-client/interface-apps";
import { isInterfaceName, parseTableFile, parseTableRows } from "@qorpera/cloud-client/interfaces";
import { APP_GROUPS_MAX_BYTES, APP_GROUPS_PATH, type AppTreeNode, parseAppGroups } from "../cloud/app-groups.ts";
import type { WebMemberFolder } from "../cloud/company-folder-writes.ts";
import type { AppAnswer, AppCall } from "../ui/app-frame.ts";
import { folderLinkPath } from "../ui/folder-links.ts";
import { webHref } from "../ui/markdown.ts";
import { framePage } from "../ui/page-frame.ts";
import {
	AppActionRefused,
	type AppGate,
	type AppGateOutcome,
	type AppQuestionSource,
	type AppTellSource,
	appQuestions,
	type PreparedAsk,
	prepareAnswer,
	prepareRow,
	prepareTell,
} from "./app-actions.ts";
import { type AppLook, type AppScheme, appBaseStyle, appScheme, readAppBrand } from "./interface-app-style.ts";

/* Interface apps on the web (deploy/first-node/RUNTIME-INTERFACE-APPS.md §2, §4 and §5; Jonas, 5 November 2026): the
 * company's apps as their manifests say (`readApps`, for the apps drawer and the cards), one app's page put together
 * from its files for the locked frame (`assembleApp`), and the answers to its live-data calls (`AppBridge`). Every read
 * is the member's own, through the member's folder client.
 * - A page is put together as a string and handed only to the frame (ui/app-frame.ts): never parsed into, or shown in,
 *   this app's own page. Relative stylesheets and scripts become inline, pictures and media `data:` URLs with a fixed
 *   type for their kind; only paths inside the app's folder are read, and the app's limits (64 files, 4 MiB) hold for
 *   what is read here too, since a machine's mounted folder can write past the write tools.
 * - The bridge reads only what the manifest's `reads` names, and only what an agent of the company reads too: the app's
 *   own folder always; with `files`, the company's own work (never QorperaOS/ or what the platform writes: mail, bank,
 *   members, events, digital post); with `tables`, a table's rows; with `agents` and `todos`, plain lines about them;
 *   with `questions`, the agents' open question cards that point at this app.
 *   It never hands over who the member is, a token, or anything of this app's own state.
 * - The bridge changes nothing by itself. A page may ask for what the manifest's `writes` names (an answer to such a
 *   question, a row of a named table): the request is checked (app/app-actions.ts), put to the member on the bar outside
 *   the frame (views/app-ask-bar.ts), and made as the member's own change only when they allow it there. Any app may
 *   ask the same way to send a note to the agent that owns it (`tell`), which the member writes on the bar.
 * - A link the member clicks in the page comes over the bridge too (`open`): checked here (`appLink`), it opens another
 *   app, a file of the company's own work or a web page, and nothing else. The page learns nothing from it.
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
	Partial<Pick<CloudMemberFolderClient, "readMany">>;

const LIST_PAGE = 50;
/** Apps a company lists, at most. */
const MAX_APPS = 200;
const TEXT = new TextDecoder("utf-8", { fatal: true });
/** Every read here reads a file's entry live, as the member, just before its bytes: those may come from the member's
 * file cache (company-files.ts). */
const LIVE = { cached: true } as const;

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
	await Promise.all(
		files.map(async (entry) => {
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
		}),
	);
	return { icons: [...byFile.values()].sort((a, b) => b.seq - a.seq), byFile };
}

/** The company's groups of apps, from `apps/groups.md` (cloud/app-groups.ts); undefined when it has none. */
export async function readAppGroups(folder: Folder, signal: AbortSignal): Promise<AppTreeNode[] | undefined> {
	const entry = (await folder.read(APP_GROUPS_PATH, signal)).entry;
	// A bigger file is read too (up to a mebibyte): the reader keeps its first 64 KiB, as the agents' tool does.
	const text = entry ? await readText(folder, entry, signal, 16 * APP_GROUPS_MAX_BYTES) : null;
	return text === null ? undefined : parseAppGroups(text);
}

/** The company's apps, in name order: every folder of `apps/` with its manifest read. */
export async function readApps(folder: Folder, signal: AbortSignal): Promise<CompanyApp[]> {
	const top = await folder.read(APPS_FOLDER, signal);
	if (top.entry?.kind !== "folder") return [];
	const folders = (await listAll(folder, APPS_FOLDER, signal, MAX_APPS)).filter((entry) => entry.kind === "folder");
	const apps = await Promise.all(
		folders.map(async (entry): Promise<CompanyApp | null> => {
			const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
			if (!isInterfaceName(name)) return null;
			const manifest = (await folder.read(`${entry.path}/${APP_MANIFEST}`, signal)).entry;
			const text = manifest ? await readText(folder, manifest, signal, APP_MANIFEST_MAX_BYTES) : null;
			const changed = Math.max(entry.seq, manifest?.seq ?? 0);
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
		}),
	);
	return apps.filter((app): app is CompanyApp => app !== null);
}

/* ---- Putting a page together ----------------------------------------------------------------------------------- */

export type AssembledApp =
	| {
			readonly ok: true;
			readonly page: string;
			readonly files: number;
			readonly bytes: number;
			/** The scheme of the base style the page starts from; undefined for a page given none. */
			readonly scheme?: AppScheme;
	  }
	| { readonly ok: false; readonly reason: "missing" | "too_large" | "not_shown"; readonly message: string };

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

function base64(bytes: Uint8Array): string {
	let text = "";
	for (let index = 0; index < bytes.length; index += 0x8000)
		text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
	return btoa(text);
}

/** An app's files read at once, at most, while its page is put together. */
const FILES_AT_ONCE = 8;

/** What a round of reading ahead (`warmApps`) may still read, in bytes, across all the apps. */
interface WarmBudget {
	left: number;
}

/** Folders whose database has no qorpera_member_folder_read_many yet (it answered 404): each path is read alone there. */
const NO_READ_MANY = new WeakSet<object>();

/** Reads the files of one app's page, once each, a few at once, within the app's limits. The entries of the files the
 * page names together are read as the member in one call (`readMany`), each file's bytes then a few at once. Reading ahead (`warm`), it
 * reads no video past WARM_VIDEO_MAX_BYTES and nothing past the round's bytes, and makes no `data:` URLs: only the
 * bytes are wanted, for the member's file cache. */
class AppFiles {
	readonly #folder: Folder;
	readonly #root: string;
	readonly #signal: AbortSignal;
	readonly #atOnce: number;
	readonly #warm: WarmBudget | undefined;
	readonly #read = new Map<string, Promise<Uint8Array | null>>();
	/** Reads under way, and the ones waiting for a turn. */
	#active = 0;
	readonly #waiting: (() => void)[] = [];
	#bytes = 0;
	#videoBytes = 0;
	/** Entries asked for since the last call went out: they go in the next one, a moment later. */
	#asked: {
		readonly path: string;
		readonly resolve: (entry: CloudMemberFolderEntry | null) => void;
		readonly reject: (error: unknown) => void;
	}[] = [];
	tooLarge = false;

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

	get count(): number {
		return this.#read.size;
	}

	get bytes(): number {
		return this.#bytes;
	}

	/** A file's bytes, or null when it is not there, not a kind a page loads, or past the limits. */
	bytesOf(path: string): Promise<Uint8Array | null> {
		const key = path.toLowerCase();
		const known = this.#read.get(key);
		if (known) return known;
		if (!APP_FILE_TYPES[appFileKind(path)] || this.#read.size >= APP_MAX_FILES) {
			if (this.#read.size >= APP_MAX_FILES) this.tooLarge = true;
			return Promise.resolve(null);
		}
		const reading = (async () => {
			const entry = await this.#entry(`${this.#root}/${path}`);
			const file: CloudMemberFolderFile | null | undefined = entry?.kind === "file" ? entry.file : null;
			if (!file) return null;
			const video = APP_MEDIA_KINDS.has(appFileKind(path));
			const most = video ? APP_VIDEO_FILE_MAX_BYTES : APP_FILE_MAX_BYTES;
			if (
				file.bytes > most ||
				(video ? this.#videoBytes + file.bytes > APP_VIDEOS_MAX_BYTES : this.#bytes + file.bytes > APP_MAX_BYTES)
			) {
				this.tooLarge = true;
				return null;
			}
			if (this.#warm) {
				if (
					file.bytes > this.#warm.left ||
					(APP_VIDEO_KINDS.has(appFileKind(path)) && file.bytes > WARM_VIDEO_MAX_BYTES)
				)
					return null;
				this.#warm.left -= file.bytes;
			}
			if (video) this.#videoBytes += file.bytes;
			else this.#bytes += file.bytes;
			return this.#turn(() => this.#folder.readFile(file, this.#signal, most, LIVE));
		})();
		// Reading ahead, a file that fails is left for the open: the page waits for all its other reads, so a round
		// never has more under way than it says.
		if (this.#warm) {
			const settled = reading.catch(() => null);
			this.#read.set(key, settled);
			return settled;
		}
		this.#read.set(key, reading);
		return reading;
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

	async text(path: string): Promise<string | null> {
		const bytes = await this.bytesOf(path);
		if (bytes === null) return null;
		try {
			return TEXT.decode(bytes);
		} catch {
			return null;
		}
	}

	async dataUrl(path: string): Promise<string | null> {
		const bytes = await this.bytesOf(path);
		const type = APP_FILE_TYPES[appFileKind(path)];
		return bytes === null || !type || this.#warm ? null : `data:${type};base64,${base64(bytes)}`;
	}
}

const MEDIA_KINDS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);

/** A stylesheet's `url(...)`s that name pictures of the app, as `data:` URLs, the pictures read side by side. */
async function inlineCssUrls(files: AppFiles, css: string, base: string): Promise<string> {
	const found = [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)];
	const urls = await Promise.all(
		found.map((match) => {
			const path = resolveAppPath(base, match[2] ?? "");
			return path === null || !MEDIA_KINDS.has(appFileKind(path)) ? null : files.dataUrl(path);
		}),
	);
	let out = css;
	for (const [index, match] of found.entries()) {
		const url = urls[index];
		if (url) out = out.split(match[0]).join(`url("${url}")`);
	}
	return out;
}

/** One app's page as the frame is handed it: its entry with the app's own stylesheets, scripts and pictures put in,
 * then through framePage (ui/page-frame.ts). With `look`, the page starts from Qorpera's base style
 * (app/interface-app-style.ts), first in its head, in the look's colours and in the scheme the page supports. */
export async function assembleApp(
	folder: Folder,
	app: Pick<CompanyApp, "path"> & { readonly entry: string },
	signal: AbortSignal,
	look?: AppLook,
): Promise<AssembledApp> {
	const files = new AppFiles(folder, app.path, signal);
	const page = await readPage(files, app.entry);
	if (page === null)
		return files.tooLarge
			? {
					ok: false,
					reason: "too_large",
					message: "The app is larger than 4 MiB of pages and code, 48 MiB of pictures and videos, or 64 files.",
				}
			: { ok: false, reason: "missing", message: `The app's page, ${app.entry}, is not in its folder.` };
	if (files.tooLarge)
		return {
			ok: false,
			reason: "too_large",
			message: "The app is larger than 4 MiB of pages and code, 48 MiB of pictures and videos, or 64 files.",
		};
	// Before every style of the page, and in a layer of its own: whatever the page's styles say wins.
	let scheme: AppScheme | undefined;
	if (look) {
		scheme = appScheme(page, look.scheme);
		const base = page.createElement("style");
		base.setAttribute("data-qorpera-base", "");
		base.textContent = appBaseStyle(scheme, look.brand);
		page.head.prepend(base);
	}
	const written = `${page.doctype ? new XMLSerializer().serializeToString(page.doctype) : "<!doctype html>"}${page.documentElement.outerHTML}`;
	const handed = framePage(written);
	return handed === null
		? { ok: false, reason: "not_shown", message: "This app can't be shown live." }
		: { ok: true, page: handed, files: files.count, bytes: files.bytes, ...(scheme ? { scheme } : {}) };
}

/** An app's entry page with the files it names put in, or null when the entry can't be read. */
async function readPage(files: AppFiles, entry: string): Promise<Document | null> {
	const html = await files.text(entry);
	if (html === null) return null;
	// An inert parse: nothing here runs or loads, and it is only ever written out again for the frame.
	const page = new DOMParser().parseFromString(html, "text/html");
	const base = dirOf(entry);
	// Every file the page names is read side by side (a file named twice once), then put in where it is named, in the
	// page's order. The app's limits hold whatever the order the reads end in: past them, the whole app is refused.
	const changes: Promise<(() => void) | null>[] = [];
	for (const link of [...page.querySelectorAll<HTMLLinkElement>("link[rel~='stylesheet' i][href]")]) {
		const path = resolveAppPath(base, link.getAttribute("href") ?? "");
		if (path === null || appFileKind(path) !== "css") continue;
		changes.push(
			files.text(path).then(async (css) => {
				if (css === null) return null;
				const inlined = (await inlineCssUrls(files, css, dirOf(path))).replace(/<\/style/gi, "<\\/style");
				return () => {
					const style = page.createElement("style");
					style.textContent = inlined;
					link.replaceWith(style);
				};
			}),
		);
	}
	for (const style of [...page.querySelectorAll("style")])
		changes.push(
			inlineCssUrls(files, style.textContent ?? "", base).then((css) => () => {
				style.textContent = css;
			}),
		);
	for (const script of [...page.querySelectorAll<HTMLScriptElement>("script[src]")]) {
		const path = resolveAppPath(base, script.getAttribute("src") ?? "");
		if (path === null || !["js", "mjs"].includes(appFileKind(path))) continue;
		changes.push(
			files.text(path).then((js) =>
				js === null
					? null
					: () => {
							script.removeAttribute("src");
							script.textContent = js.replace(/<\/script/gi, "<\\/script");
						},
			),
		);
	}
	for (const media of [...page.querySelectorAll("img[src], source[src], video[poster], image[href]")]) {
		const attribute = media.localName === "video" ? "poster" : media.localName === "image" ? "href" : "src";
		const path = resolveAppPath(base, media.getAttribute(attribute) ?? "");
		if (path === null || !MEDIA_KINDS.has(appFileKind(path))) continue;
		changes.push(files.dataUrl(path).then((url) => (url ? () => media.setAttribute(attribute, url) : null)));
	}
	for (const media of [...page.querySelectorAll("video[src], source[src]")]) {
		const path = resolveAppPath(base, media.getAttribute("src") ?? "");
		if (path === null || !APP_VIDEO_KINDS.has(appFileKind(path))) continue;
		changes.push(files.dataUrl(path).then((url) => (url ? () => media.setAttribute("src", url) : null)));
	}
	for (const change of await Promise.all(changes)) change?.();
	return page;
}

/* ---- The bridge --------------------------------------------------------------------------------------------- */

/** What the bridge needs from the open company besides the member's folder. */
export interface AppBridgeHost {
	readonly folder: () => Folder;
	readonly agents: () => readonly { readonly name: string; readonly role: string; readonly working: boolean }[];
	/** The agents' open questions and an agent by its id, for an app that shows or answers them; absent where the
	 * company has none to show. */
	readonly questions?: AppQuestionSource & {
		readonly agent: (agentId: string) => { readonly displayName: string } | undefined;
	};
	/** The member's own client for a change they allowed, and the check that the company is still the one on screen
	 * (it throws when it is not). Absent where nothing can be changed. */
	readonly writer?: () => WebMemberFolder;
	readonly current?: () => void;
	/** Who hears a note from an app, and the send (app/tell-agent.ts); absent where no note can be sent. */
	readonly tell?: AppTellSource;
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
/** What a call spends of the minute's budget, when it is more than one: todos reads every agent's todos folder, a
 * request for a change reads the table or the questions before anything is shown, and a note costs as a change. */
const CALL_COST: Readonly<Record<string, number>> = { todos: 10, answer: 5, setRow: 5, addRow: 5, tell: 5 };
/** What a page is told when its request did not become a change. */
const GATE_SAYS: Readonly<Record<Exclude<AppGateOutcome["outcome"], "saved" | "told" | "failed">, string>> = {
	declined: "The member said not now",
	busy: "Another request is waiting for the member's answer",
	quiet: "The member said not now three times: this page asks again after the member reloads it",
	gone: "The page was put away, or what it may ask for changed, before the member answered",
};
const TODO_FILES = 200;
/** The budget of an app in this tab, kept across its frames, so a Reload starts no new one. */
const budgets = new Map<string, { inFlight: number; minute: number; calls: number }>();
/** After the member sent a note from an app, its next note is refused this long: the bar comes back no sooner. */
export const TELL_AGAIN_MS = 10_000;
/** When each app in this tab last had a note sent (by its budget's key), kept across its frames as the budget is. */
const told = new Map<string, number>();

function budget(key: string): { inFlight: number; minute: number; calls: number } {
	const now = Math.floor(Date.now() / 60_000);
	let entry = budgets.get(key);
	if (!entry || entry.minute !== now) {
		entry = { inFlight: entry?.inFlight ?? 0, minute: now, calls: 0 };
		budgets.set(key, entry);
	}
	return entry;
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

	/** `gate`: where a request for a change is put to the member; without one the app only reads. `follow` opens a
	 * link the member clicked in the page, once it is checked; without it no link opens. */
	constructor(
		host: AppBridgeHost,
		app: CompanyApp & { readonly manifest: AppManifest },
		key: string,
		signal: AbortSignal,
		gate?: AppGate,
		follow?: (link: AppLink) => void,
	) {
		this.#host = host;
		this.#app = app;
		this.#key = key;
		this.#signal = signal;
		this.#gate = gate;
		this.#follow = follow;
	}

	#may(read: AppRead): boolean {
		return this.#app.manifest.reads.includes(read);
	}

	async answer(call: AppCall): Promise<AppAnswer> {
		// A call is a method and a few short values (a row's cells may be longer): anything larger is no call this bridge
		// takes.
		const row = call.method === "setRow" || call.method === "addRow";
		if (
			call.method.length > 32 ||
			JSON.stringify(call.params).length > (row ? MAX_ROW_PARAMS_CHARS : MAX_PARAMS_CHARS)
		)
			return refuse("Not a call the app answers");
		const spent = budget(this.#key);
		if (spent.inFlight >= MAX_IN_FLIGHT || spent.calls >= MAX_PER_MINUTE)
			return refuse("Too many calls: wait a moment and try again");
		spent.calls += CALL_COST[call.method] ?? 1;
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
			case "open": {
				// A link the member clicked (the frame document sends it; the page's `qorpera` object has no such call). It
				// needs nothing in `reads`: nothing is read for it, and the answer is the same whether or not what it names
				// is there, so a page learns nothing by it.
				const link = appLink(call.params.href);
				if (link === null || !this.#follow)
					return refuse("A link opens an app (app:name), a company file (folder:path) or a web page (https://…)");
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
		const closed = gate.closed();
		if (closed) return refuse(GATE_SAYS[closed]);
		let prepared: PreparedAsk;
		try {
			prepared = await prepare();
		} catch (error) {
			if (error instanceof AppActionRefused) return refuse(error.message);
			throw error;
		}
		const result = await gate.ask(prepared.ask, prepared.perform);
		if ("message" in result) return refuse(result.message);
		if (result.outcome === "told") {
			told.set(this.#key, Date.now());
			return { ok: true, value: result.sent ? { sent: true } : { sent: false, waiting: true } };
		}
		return result.outcome === "saved" ? { ok: true, value: { saved: true } } : refuse(GATE_SAYS[result.outcome]);
	}

	/** Each agent's todos, as their files' first heading and status say. */
	async #todos(folder: Folder) {
		const agents = (await listAll(folder, "QorperaOS/agents", this.#signal, 200)).filter(
			(entry) => entry.kind === "folder",
		);
		const todos: { agent: string; title: string; status: string; updatedAt: string }[] = [];
		for (const agent of agents) {
			if (todos.length >= TODO_FILES) break;
			const files = await listAll(folder, `${agent.path}/todos`, this.#signal, TODO_FILES - todos.length).catch(
				() => [],
			);
			for (const file of files) {
				if (file.kind !== "file" || appFileKind(file.path) !== "md") continue;
				const text = await readText(folder, file, this.#signal, 16 * 1024);
				const parsed = text === null ? null : parseCompanyStateFile(file.path, text);
				if (parsed?.ok !== true || parsed.file.kind !== "todo") continue;
				todos.push({
					agent: agent.path.slice(agent.path.lastIndexOf("/") + 1),
					title: parsed.file.title,
					status: parsed.file.status,
					updatedAt: file.updatedAt,
				});
			}
		}
		return todos;
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
/** A video read ahead, at most: a short clip on an app's page is read ahead as its pictures are, a long one waits for
 * the open (Fjeldtur's brand page, 11 Nov 2026: three clips of 110 to 180 KiB were all its first open still fetched). */
const WARM_VIDEO_MAX_BYTES = 2 * 1024 * 1024;

/** Reads ahead what opening an app reads (the company's colours, and each app's page with every file it names, as
 * `assembleApp` reads them, but no video past WARM_VIDEO_MAX_BYTES), so the member's first open of each app finds them
 * in the member's file cache (company-files.ts). The most recently changed apps go first, and a round stops reading at
 * WARM_BYTES. Only what is not read yet costs a fetch; a read that fails is left for the open to try. */
export async function warmApps(folder: Folder, apps: readonly CompanyApp[], signal: AbortSignal): Promise<void> {
	const budget: WarmBudget = { left: WARM_BYTES };
	const reads: (() => Promise<unknown>)[] = [() => readAppBrand(folder, signal)];
	for (const app of [...apps].sort((a, b) => (b.changed ?? 0) - (a.changed ?? 0))) {
		const entry = app.manifest?.entry;
		if (entry === undefined || resolveAppPath("", entry) === null) continue;
		reads.push(() =>
			readPage(new AppFiles(folder, app.path, signal, { atOnce: WARM_FILES_AT_ONCE, warm: budget }), entry),
		);
	}
	let next = 0;
	const worker = async () => {
		while (next < reads.length && !signal.aborted) await reads[next++]!().catch(() => undefined);
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
	) {
		this.#source = source;
		this.#publish = publish;
		this.#publishGroups = publishGroups;
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

	/** Reads the apps now, and publishes them when they changed. */
	async read(): Promise<readonly CompanyApp[]> {
		if (this.#stop.signal.aborted) return this.#last;
		try {
			const folder = this.#source.folder();
			const [apps, groups] = await Promise.all([
				readApps(folder, this.#stop.signal),
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
		return this.#last;
	}

	/** Reads the apps' pages ahead (`warmApps`), a moment after they changed, so the company's own first reads go
	 * first; one round at a time, and the latest apps when it starts. */
	#warm(): void {
		if (this.#stop.signal.aborted) return;
		if (this.#warming !== undefined) {
			this.#warmAgain = true;
			return;
		}
		// A company with no app that reads has nothing to read ahead.
		if (!this.#last.some((app) => app.manifest)) return;
		this.#warming = setTimeout(() => {
			if (this.#stop.signal.aborted) return;
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
				for (const listener of [...this.#listeners]) listener();
			});
		}, APPS_HINT_MS);
	}
}
