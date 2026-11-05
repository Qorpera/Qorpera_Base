import type {
	CloudMemberFolderClient,
	CloudMemberFolderEntry,
	CloudMemberFolderFile,
} from "@qorpera/cloud-client/cloud-member-folder";
import { companyPathKey, parseCompanyStateFile } from "@qorpera/cloud-client/company-state-files";
import {
	APP_FILE_MAX_BYTES,
	APP_FILE_TYPES,
	APP_MANIFEST,
	APP_MANIFEST_MAX_BYTES,
	APP_MAX_BYTES,
	APP_MAX_FILES,
	APPS_FOLDER,
	type AppManifest,
	type AppProblem,
	type AppRead,
	appFileKind,
	appRelativePath,
	parseAppManifest,
} from "@qorpera/cloud-client/interface-apps";
import { isInterfaceName, parseTableFile, parseTableRows } from "@qorpera/cloud-client/interfaces";
import type { AppAnswer, AppCall } from "../ui/app-frame.ts";
import { framePage } from "../ui/page-frame.ts";

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
 *   members, events, digital post); with `tables`, a table's rows; with `agents` and `todos`, plain lines about them.
 *   It never hands over who the member is, a token, or anything of this app's own state. */

/** One app of the company, as its folder and manifest say. */
export interface CompanyApp {
	readonly name: string;
	readonly path: string;
	/** Null when the manifest is missing or has problems. */
	readonly manifest: AppManifest | null;
	readonly problems: readonly AppProblem[];
	/** The manifest's version, so a change shows. */
	readonly version: string | null;
}

type Folder = Pick<CloudMemberFolderClient, "read" | "list" | "readFile">;

const LIST_PAGE = 50;
/** Apps a company lists, at most. */
const MAX_APPS = 200;
/** Folders the platform writes or keeps, whose files an app never reads (the agents' prompt: "the platform writes
 * digital-post/, bank/, members/ and hooks/"). */
const PLATFORM_FOLDERS = ["qorperaos", "hooks", "digital-post", "bank", "members", "code"];
const TEXT = new TextDecoder("utf-8", { fatal: true });

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
		return TEXT.decode(await folder.readFile(entry.file, signal, max));
	} catch {
		return null;
	}
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
			if (text === null)
				return {
					name,
					path: entry.path,
					manifest: null,
					problems: [{ line: null, message: manifest ? "app.toml is not text" : "app.toml is missing" }],
					version: manifest?.version ?? null,
				};
			const parsed = parseAppManifest(text);
			return {
				name,
				path: entry.path,
				manifest: parsed.ok ? parsed.manifest : null,
				problems: parsed.ok ? [] : parsed.problems,
				version: manifest?.version ?? null,
			};
		}),
	);
	return apps.filter((app): app is CompanyApp => app !== null);
}

/* ---- Putting a page together ----------------------------------------------------------------------------------- */

export type AssembledApp =
	| { readonly ok: true; readonly page: string; readonly files: number; readonly bytes: number }
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

/** Reads the files of one app's page, once each, within the app's limits. */
class AppFiles {
	readonly #folder: Folder;
	readonly #root: string;
	readonly #signal: AbortSignal;
	readonly #read = new Map<string, Promise<Uint8Array | null>>();
	#bytes = 0;
	tooLarge = false;

	constructor(folder: Folder, root: string, signal: AbortSignal) {
		this.#folder = folder;
		this.#root = root;
		this.#signal = signal;
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
			const entry = (await this.#folder.read(`${this.#root}/${path}`, this.#signal)).entry;
			const file: CloudMemberFolderFile | null | undefined = entry?.kind === "file" ? entry.file : null;
			if (!file) return null;
			if (file.bytes > APP_FILE_MAX_BYTES || this.#bytes + file.bytes > APP_MAX_BYTES) {
				this.tooLarge = true;
				return null;
			}
			this.#bytes += file.bytes;
			return this.#folder.readFile(file, this.#signal, APP_FILE_MAX_BYTES);
		})();
		this.#read.set(key, reading);
		return reading;
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
		return bytes === null || !type ? null : `data:${type};base64,${base64(bytes)}`;
	}
}

const MEDIA_KINDS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);

/** A stylesheet's `url(...)`s that name pictures of the app, as `data:` URLs. */
async function inlineCssUrls(files: AppFiles, css: string, base: string): Promise<string> {
	const found = [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)];
	let out = css;
	for (const match of found) {
		const path = resolveAppPath(base, match[2] ?? "");
		if (path === null || !MEDIA_KINDS.has(appFileKind(path))) continue;
		const url = await files.dataUrl(path);
		if (url) out = out.split(match[0]).join(`url("${url}")`);
	}
	return out;
}

/** One app's page as the frame is handed it: its entry with the app's own stylesheets, scripts and pictures put in,
 * then through framePage (ui/page-frame.ts). */
export async function assembleApp(
	folder: Folder,
	app: Pick<CompanyApp, "path"> & { readonly entry: string },
	signal: AbortSignal,
): Promise<AssembledApp> {
	const files = new AppFiles(folder, app.path, signal);
	const html = await files.text(app.entry);
	if (html === null)
		return files.tooLarge
			? { ok: false, reason: "too_large", message: "The app is larger than 4 MiB or 64 files." }
			: { ok: false, reason: "missing", message: `The app's page, ${app.entry}, is not in its folder.` };
	// An inert parse: nothing here runs or loads, and it is only ever written out again for the frame.
	const page = new DOMParser().parseFromString(html, "text/html");
	const base = dirOf(app.entry);
	for (const link of [...page.querySelectorAll<HTMLLinkElement>("link[rel~='stylesheet' i][href]")]) {
		const path = resolveAppPath(base, link.getAttribute("href") ?? "");
		if (path === null || appFileKind(path) !== "css") continue;
		const css = await files.text(path);
		if (css === null) continue;
		const style = page.createElement("style");
		style.textContent = (await inlineCssUrls(files, css, dirOf(path))).replace(/<\/style/gi, "<\\/style");
		link.replaceWith(style);
	}
	for (const style of [...page.querySelectorAll("style")])
		style.textContent = await inlineCssUrls(files, style.textContent ?? "", base);
	for (const script of [...page.querySelectorAll<HTMLScriptElement>("script[src]")]) {
		const path = resolveAppPath(base, script.getAttribute("src") ?? "");
		if (path === null || !["js", "mjs"].includes(appFileKind(path))) continue;
		const js = await files.text(path);
		if (js === null) continue;
		script.removeAttribute("src");
		script.textContent = js.replace(/<\/script/gi, "<\\/script");
	}
	for (const media of [...page.querySelectorAll("img[src], source[src], video[poster], image[href]")]) {
		const attribute = media.localName === "video" ? "poster" : media.localName === "image" ? "href" : "src";
		const path = resolveAppPath(base, media.getAttribute(attribute) ?? "");
		if (path === null || !MEDIA_KINDS.has(appFileKind(path))) continue;
		const url = await files.dataUrl(path);
		if (url) media.setAttribute(attribute, url);
	}
	if (files.tooLarge) return { ok: false, reason: "too_large", message: "The app is larger than 4 MiB or 64 files." };
	const written = `${page.doctype ? new XMLSerializer().serializeToString(page.doctype) : "<!doctype html>"}${page.documentElement.outerHTML}`;
	const handed = framePage(written);
	return handed === null
		? { ok: false, reason: "not_shown", message: "This app can't be shown live." }
		: { ok: true, page: handed, files: files.count, bytes: files.bytes };
}

/* ---- The bridge --------------------------------------------------------------------------------------------- */

/** What the bridge needs from the open company besides the member's folder. */
export interface AppBridgeHost {
	readonly folder: () => Folder;
	readonly agents: () => readonly { readonly name: string; readonly role: string; readonly working: boolean }[];
}

/** Calls in flight, and calls a minute, for one app in this tab. */
const MAX_IN_FLIGHT = 8;
const MAX_PER_MINUTE = 120;
/** An answer the page is handed, at most, as JSON. */
const MAX_ANSWER_BYTES = 1024 * 1024;
const MAX_PATH_CHARS = 1024;
const MAX_PARAMS_CHARS = 4096;
const TODO_FILES = 200;
/** The budget of an app in this tab, kept across its frames, so a Reload starts no new one. */
const budgets = new Map<string, { inFlight: number; minute: number; calls: number }>();

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
	return PLATFORM_FOLDERS.includes(top) ? null : plain;
}

/** The answers to one app's live-data calls, with the member's own reads. */
export class AppBridge {
	readonly #host: AppBridgeHost;
	readonly #app: CompanyApp & { readonly manifest: AppManifest };
	readonly #key: string;
	readonly #signal: AbortSignal;

	constructor(
		host: AppBridgeHost,
		app: CompanyApp & { readonly manifest: AppManifest },
		key: string,
		signal: AbortSignal,
	) {
		this.#host = host;
		this.#app = app;
		this.#key = key;
		this.#signal = signal;
	}

	#may(read: AppRead): boolean {
		return this.#app.manifest.reads.includes(read);
	}

	async answer(call: AppCall): Promise<AppAnswer> {
		// A call is a method and a few short values: anything larger is no call this bridge takes.
		if (call.method.length > 32 || JSON.stringify(call.params).length > MAX_PARAMS_CHARS)
			return refuse("Not a call the app answers");
		const spent = budget(this.#key);
		if (spent.inFlight >= MAX_IN_FLIGHT || spent.calls >= MAX_PER_MINUTE)
			return refuse("Too many calls: wait a moment and try again");
		spent.calls++;
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
			default:
				return refuse("Not a call the app answers");
		}
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
	folderHints(onHint: (seq: number) => void): { close(): Promise<void> };
}

/** One folder hint shared by every reader of the open company (its pages' and its apps'): one channel, each reader's
 * hint passed on, closed when the last reader closes it. */
export function sharedFolderHints<T extends CompanyAppsSource>(
	source: T,
): (onHint: (seq: number) => void) => { close(): Promise<void> } {
	const listeners = new Set<(seq: number) => void>();
	let channel: { close(): Promise<void> } | undefined;
	return (onHint) => {
		listeners.add(onHint);
		channel ??= source.folderHints((seq) => {
			for (const listener of [...listeners]) listener(seq);
		});
		return {
			close: async () => {
				listeners.delete(onHint);
				if (listeners.size > 0 || !channel) return;
				const closing = channel;
				channel = undefined;
				await closing.close();
			},
		};
	};
}

const APPS_POLL_MS = 60_000;
const APPS_HINT_MS = 1000;

/** The company's apps, read when the company opens, after each folder hint (at most once a second) and each minute,
 * published when they change; and every hint passed on to the open panels (`onChange`), which read their own app's
 * files again. A read that fails keeps what was read before. */
export class CompanyApps {
	readonly #source: CompanyAppsSource;
	readonly #publish: (apps: readonly CompanyApp[]) => void;
	readonly #stop = new AbortController();
	readonly #listeners = new Set<() => void>();
	#hints?: { close(): Promise<void> };
	#poll?: ReturnType<typeof setInterval>;
	#timer?: ReturnType<typeof setTimeout>;
	#shown: string | undefined;
	#last: readonly CompanyApp[] = [];

	constructor(source: CompanyAppsSource, publish: (apps: readonly CompanyApp[]) => void) {
		this.#source = source;
		this.#publish = publish;
		source.signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#stop.signal });
	}

	open(): void {
		if (this.#stop.signal.aborted || this.#poll) return;
		this.#poll = setInterval(() => void this.read(), APPS_POLL_MS);
		try {
			this.#hints = this.#source.folderHints(() => this.#hinted());
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
		void this.#hints?.close().catch(() => undefined);
		this.#listeners.clear();
	}

	/** The apps as last read. */
	get apps(): readonly CompanyApp[] {
		return this.#last;
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Reads the apps now, and publishes them when they changed. */
	async read(): Promise<readonly CompanyApp[]> {
		if (this.#stop.signal.aborted) return this.#last;
		try {
			const apps = await readApps(this.#source.folder(), this.#stop.signal);
			const shown = JSON.stringify(apps);
			this.#last = apps;
			if (shown !== this.#shown && !this.#stop.signal.aborted) {
				this.#shown = shown;
				this.#publish(apps);
			}
		} catch {
			/* What was read before stands. */
		}
		return this.#last;
	}

	#hinted(): void {
		if (this.#timer !== undefined || this.#stop.signal.aborted) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.read();
			for (const listener of [...this.#listeners]) listener();
		}, APPS_HINT_MS);
	}
}
