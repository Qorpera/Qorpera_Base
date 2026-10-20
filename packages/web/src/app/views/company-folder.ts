import {
	CLOUD_MEMBER_FOLDER_PAGE,
	type CloudMemberFolderBy,
	type CloudMemberFolderChangeSet,
	type CloudMemberFolderClient,
	type CloudMemberFolderCommit,
	type CloudMemberFolderEntry,
	type CloudMemberFolderFeedPosition,
	type CloudMemberFolderFile,
	type CloudMemberFolderUnit,
	type CloudMemberFolderVersion,
} from "@qorpera/cloud-client/cloud-member-folder";
import { WebFileDownloads } from "../../../../member-web/src/files.ts";
import { withProblems } from "../../cloud/company-folder-writes.ts";
import { button, fmtBytes, fmtTime, h, icon, replace } from "../../ui/dom.ts";
import { markdown } from "../../ui/markdown.ts";
import { presentationDay, presentationLocale, previousDay, t, timeZoneOption } from "../../ui/preferences.ts";
import { listSkeleton } from "../../ui/skeleton.ts";

/* A folder-v2 company's Company File (folder core C4, P33; deploy/first-node/RUNTIME-COMPANY-FOLDER-C4-MEMBERS.md):
 * the file browser Jonas approved for #386. A breadcrumb, one list of folders, files and links, and a preview beside it
 * with the path's history, where an earlier version of a file or a link is restored (RUNTIME-FOLDER-LINKS.md, LK6);
 * the company's recent changes on the clock button. The folder's hint (P30) nudges a sync from the feed, and a slow
 * poll backs it up. */

type Client = Pick<
	CloudMemberFolderClient,
	"list" | "read" | "readFile" | "pathHistory" | "history" | "changes" | "commit"
>;

/** What the page needs from the product: the folder, its hint, and the company's lifetime. */
export interface CompanyFolderSource {
	readonly signal: AbortSignal;
	current(): void;
	folder(): Client;
	folderHints(onHint: (seq: number) => void): { close(): Promise<void> };
}

/** The names a change's author is shown by. */
export interface CompanyFolderPeople {
	readonly me: string;
	readonly members: readonly { readonly userId: string; readonly displayName: string }[];
	readonly staff: readonly { readonly id: string; readonly displayName: string }[];
}

/** Settings supplies its shared search field and navigation; the standalone browser supplies its own. */
export interface CompanyFolderBrowserOptions {
	readonly search?: HTMLInputElement;
	readonly embedded?: boolean;
	readonly onSectionChange?: (section: "documents" | "recents") => void;
}

type FileCategory = "folder" | "document" | "spreadsheet" | "image" | "pdf" | "link" | "other";

function fileCategory(item: Pick<CloudMemberFolderEntry, "kind" | "path">): FileCategory {
	if (item.kind === "folder") return "folder";
	if (item.kind === "symlink") return "link";
	const ext = extension(item.path);
	if (IMAGE_TYPES[ext] || ["svg", "heic", "ico"].includes(ext)) return "image";
	if (["csv", "tsv", "xls", "xlsx", "numbers"].includes(ext)) return "spreadsheet";
	if (ext === "pdf") return "pdf";
	if (MARKDOWN.has(ext) || ["txt", "rtf", "doc", "docx", "odt", "pages"].includes(ext)) return "document";
	return "other";
}

function fileKind(item: Pick<CloudMemberFolderEntry, "kind" | "path">): string {
	const category = fileCategory(item);
	if (category === "folder") return t("Folder");
	if (category === "link") return t("Link");
	const ext = extension(item.path);
	if (MARKDOWN.has(ext)) return t("Markdown");
	if (ext === "txt") return t("Text document");
	return ext ? ext.toUpperCase() : t("File");
}

const SVG = "http://www.w3.org/2000/svg";

function svgNode(name: string, attributes: Record<string, string | number>, text?: string): SVGElement {
	const node = document.createElementNS(SVG, name);
	for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
	if (text) node.textContent = text;
	return node;
}

/** The icon view's large glyphs, drawn as one family: a two-tone folder, and a page with a folded corner whose coloured
 * tag names the file's type, the way a desktop file manager draws them. Colours come from the category's CSS. */
function tileGlyph(item: CloudMemberFolderEntry, category: FileCategory): SVGSVGElement {
	const svg = svgNode("svg", { class: "storage-glyph", viewBox: "0 0 64 64", "aria-hidden": "true" }) as SVGSVGElement;
	if (category === "folder") {
		svg.append(
			svgNode("path", {
				class: "storage-glyph-back",
				d: "M6 16a4 4 0 0 1 4-4h14l5 5h25a4 4 0 0 1 4 4v29a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4Z",
			}),
			svgNode("path", {
				class: "storage-glyph-front",
				d: "M6 24a4 4 0 0 1 4-4h44a4 4 0 0 1 4 4v26a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4Z",
			}),
		);
		return svg;
	}
	svg.append(
		svgNode("path", {
			class: "storage-glyph-page",
			d: "M15 5h24l13 13v38a3 3 0 0 1-3 3H15a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3Z",
		}),
		svgNode("path", { class: "storage-glyph-fold", d: "M39 5v10a3 3 0 0 0 3 3h10" }),
	);
	if (category === "image")
		svg.append(
			svgNode("path", { class: "storage-glyph-mark", d: "M19 44l7-8 5 5 4-4 9 7Z" }),
			svgNode("circle", { class: "storage-glyph-mark", cx: 36, cy: 29, r: 3 }),
		);
	else if (category === "link")
		svg.append(
			svgNode("path", {
				class: "storage-glyph-line",
				d: "M27 38h-2a5 5 0 0 1 0-10h2M37 28h2a5 5 0 0 1 0 10h-2M27 33h10",
			}),
		);
	else svg.append(svgNode("path", { class: "storage-glyph-line", d: "M20 26h18M20 32h24M20 38h14" }));
	const tag = category === "link" ? "" : extension(item.path).slice(0, 4).toUpperCase();
	if (tag) {
		const width = Math.max(22, tag.length * 7 + 10);
		svg.append(
			svgNode("rect", { class: "storage-glyph-tag", x: 32 - width / 2, y: 46, width, height: 12, rx: 3 }),
			svgNode("text", { class: "storage-glyph-tag-text", x: 32, y: 54.6, "text-anchor": "middle" }, tag),
		);
	}
	return svg;
}

/** An open file, with its text or a picture's object URL when it has a preview, or an open link, which shows its target
 * and is never followed; at the latest version or an older one. */
interface Opened {
	readonly path: string;
	/** A file's content; null for a link. */
	readonly file: CloudMemberFolderFile | null;
	/** A link's target; null for a file. */
	readonly target: string | null;
	/** Set when an older version is shown instead of the latest. */
	readonly version?: CloudMemberFolderVersion;
	text?: string;
	image?: string;
}

const PAGE = 200;
const HISTORY_PAGE = 50;
/** Text larger than this only downloads. */
const MAX_PREVIEW_TEXT_BYTES = 1024 * 1024;
const MAX_PREVIEW_IMAGE_BYTES = 8 * 1024 * 1024;
/** The browser hands out at most this much in one download (member-web's WebFileDownloads). */
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;
const POLL_MS = 60_000;
const SYNC_DELAY_MS = 1000;
/** How many newest Recents pages a refresh reads to reach the changes already shown. */
const RECENTS_CATCH_UP_PAGES = 5;
const IMAGE_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
};
const MARKDOWN = new Set(["md", "markdown", "mdown"]);
/** Kinds that are never text: no read is spent finding that out. */
const BINARY = new Set(
	"pdf zip gz tgz 7z rar doc docx xls xlsx ppt pptx key numbers pages mp3 m4a wav ogg mp4 mov webm avi heic ico woff woff2 ttf otf exe dmg svg".split(
		" ",
	),
);

function baseName(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}
function parentOf(path: string): string {
	return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}
function extension(path: string): string {
	const name = baseName(path);
	return name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
}
/** UTF-8 text without NUL, or undefined for anything else. */
function decodeText(bytes: Uint8Array): string | undefined {
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return text.includes("\0") ? undefined : text;
	} catch {
		return undefined;
	}
}

export class CompanyFolderBrowser {
	readonly #host: HTMLElement;
	readonly #source: CompanyFolderSource;
	readonly #people: () => CompanyFolderPeople;
	readonly #options: CompanyFolderBrowserOptions;
	readonly #stop: AbortController;
	readonly #locale = presentationLocale();
	readonly #root = h("div", { class: "files-root" });
	readonly #status = h("div", { class: "files-status", role: "status" });
	/** The restores whose answer was lost, each with its Try again; no other message or sync clears them. */
	readonly #retries = h("div", { class: "files-retries", role: "status" });
	readonly #crumbs = h("nav", { class: "files-crumbs", "aria-label": t("Folder path") });
	readonly #list = h("ul", { class: "files-list", "aria-label": t("Files") });
	readonly #documents = h("div", { class: "storage-documents" });
	readonly #recents = h("section", { class: "storage-recents", hidden: true });
	readonly #title = h("h2", { class: "storage-title" });
	readonly #columns = h(
		"div",
		{ class: "storage-columns", "aria-hidden": "true" },
		h("span", null, t("Name")),
		h("span", null, t("Date modified")),
		h("span", null, t("Size")),
		h("span", null, t("Kind")),
	);
	readonly #count = h("p", { class: "storage-count", role: "status" });
	readonly #filter = h("select", { class: "storage-select", "aria-label": t("File type") });
	readonly #sort = h("select", { class: "storage-select", "aria-label": t("Sort files") });
	readonly #views = h("div", { class: "storage-view-toggle", role: "group", "aria-label": t("File view") });
	readonly #more = button(t("More files"), () => void this.#run(() => this.#load(this.#dir, true)), { small: true });
	readonly #preview = h("aside", { class: "files-preview" });
	readonly #search: HTMLInputElement;
	#client?: Client;
	#downloads?: WebFileDownloads;
	#hints?: { close(): Promise<void> };
	#poll?: ReturnType<typeof setInterval>;
	#syncTimer?: ReturnType<typeof setTimeout>;
	#dir = "";
	#section: "documents" | "recents" = "documents";
	#view: "grid" | "list";
	#recentSets: CloudMemberFolderChangeSet[] = [];
	#recentNext: number | null = null;
	#ready = false;
	#pendingSection: "documents" | "recents" | null = null;
	#revealPreview = false;
	#items: CloudMemberFolderEntry[] = [];
	#next: string | null = null;
	/** Where the feed is followed from: everything up to it is on screen. */
	#position: CloudMemberFolderFeedPosition | null = null;
	#opened: Opened | null = null;
	/** A restore whose answer was lost, by path, until it or another restore there has an answer. */
	readonly #lost = new Map<string, { key: string; unit: CloudMemberFolderUnit; version: string }>();
	#busy = false;
	#disposed = false;

	constructor(
		host: HTMLElement,
		source: CompanyFolderSource,
		people: () => CompanyFolderPeople,
		options: CompanyFolderBrowserOptions = {},
	) {
		this.#host = host;
		this.#source = source;
		this.#people = people;
		this.#options = options;
		this.#view = options.embedded ? "grid" : "list";
		this.#search =
			options.search ??
			h("input", {
				type: "search",
				class: "files-search-input",
				placeholder: t("Search this folder"),
				"aria-label": t("Search this folder"),
				autocomplete: "off",
				spellcheck: "false",
			});
		this.#stop = new AbortController();
		source.signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#stop.signal });
		this.#search.addEventListener(
			"input",
			() => (this.#section === "recents" ? this.#drawRecents() : this.#drawList(false)),
			{ signal: this.#stop.signal },
		);
		this.#search.addEventListener(
			"keydown",
			(event) => {
				if (event.key === "Escape" && this.#search.value) {
					event.preventDefault();
					event.stopPropagation();
					this.#search.value = "";
					if (this.#section === "recents") this.#drawRecents();
					else this.#drawList(false);
				}
			},
			{ signal: this.#stop.signal },
		);
		for (const [value, label] of [
			["all", t("All types")],
			["folder", t("Folders")],
			["document", t("Documents")],
			["spreadsheet", t("Spreadsheets")],
			["image", t("Images")],
			["pdf", t("PDFs")],
			["link", t("Links")],
			["other", t("Other files")],
		])
			this.#filter.append(h("option", { value }, label));
		for (const [value, label] of [
			["name", t("Name")],
			["modified", t("Date modified")],
			["size", t("Size")],
			["kind", t("Kind")],
		])
			this.#sort.append(h("option", { value }, label));
		this.#filter.addEventListener("change", () => this.#drawList(false), { signal: this.#stop.signal });
		this.#sort.addEventListener("change", () => this.#drawList(false), { signal: this.#stop.signal });
		for (const view of ["grid", "list"] as const) {
			const label = view === "grid" ? t("Icon view") : t("List view");
			this.#views.append(
				h(
					"button",
					{
						type: "button",
						class: "storage-view-button",
						"aria-label": label,
						title: label,
						"data-view": view,
						"aria-pressed": String(this.#view === view),
						onclick: () => {
							this.#view = view;
							this.#drawList(false);
						},
					},
					icon(view),
				),
			);
		}
		this.#more.hidden = true;
		this.#preview.hidden = true;
		host.classList.add("files-page", "folder-page", "storage-browser");
		host.classList.toggle("is-embedded", options.embedded === true);
		replace(
			host,
			options.embedded
				? null
				: h(
						"header",
						{ class: "files-head" },
						h("h1", null, t("Company File")),
						h(
							"div",
							{ class: "files-tools" },
							options.search ? null : h("label", { class: "files-search" }, icon("search"), this.#search),
							h(
								"button",
								{
									type: "button",
									class: "files-tool",
									title: t("Recent changes"),
									"aria-label": t("Recent changes"),
									onclick: () => void this.#run(() => this.#showChanges()),
								},
								icon("clock"),
							),
						),
					),
			this.#status,
			this.#retries,
			this.#root,
		);
		host.addEventListener(
			"keydown",
			(event) => {
				if (event.key !== "Escape" || this.#preview.hidden || this.#busy || event.defaultPrevented) return;
				if (!this.#preview.contains(event.target as Node) && !this.#list.contains(event.target as Node)) return;
				event.preventDefault();
				this.#close();
			},
			{ signal: this.#stop.signal },
		);
	}

	/** Opens the top of the folder, then follows its hint. */
	async open(): Promise<void> {
		replace(this.#status, h("span", { class: "visually-hidden" }, t("Opening Company File")));
		replace(this.#root, listSkeleton(t("Opening Company File"), 4));
		this.#client = this.#source.folder();
		this.#downloads ??= new WebFileDownloads({ signal: this.#signal(), current: () => this.#live() });
		replace(
			this.#documents,
			this.#crumbs,
			h(
				"div",
				{ class: "storage-toolbar" },
				this.#title,
				h("div", { class: "storage-controls" }, this.#filter, this.#sort, this.#views),
			),
			h(
				"div",
				{ class: "files-body" },
				h(
					"div",
					{ class: "files-main" },
					this.#columns,
					this.#list,
					h("div", { class: "files-list-more" }, this.#more),
					this.#count,
				),
				this.#preview,
			),
		);
		replace(this.#root, this.#documents, this.#recents);
		await this.#load("");
		replace(this.#status);
		try {
			this.#hints ??= this.#source.folderHints(() => this.#scheduleSync());
		} catch {
			/* The hint is a nudge; the slow poll keeps the page current without it. */
		}
		this.#poll ??= setInterval(() => this.#scheduleSync(), POLL_MS);
		this.#ready = true;
		this.#navigate();
	}

	/** Settings' Documents navigation returns to the top of the company folder. */
	showDocuments(): void {
		this.#pendingSection = "documents";
		this.#navigate();
	}

	/** Recents is the existing company change feed, rendered as the main storage section. */
	showRecents(): void {
		this.#pendingSection = "recents";
		this.#navigate();
	}

	/** Keep the last navigation request while opening or another folder action is still in flight. */
	#navigate(): void {
		if (!this.#ready || this.#busy || this.#disposed || !this.#pendingSection) return;
		const section = this.#pendingSection;
		this.#pendingSection = null;
		void this.#run(
			async () => {
				this.#close();
				this.#search.value = "";
				this.#setSection(section);
				if (section === "documents") {
					this.#filter.value = "all";
					await this.#enter("");
				} else {
					replace(this.#recents, listSkeleton(t("Loading"), 4));
					await this.#loadRecents();
				}
			},
			() => (section === "documents" ? this.#enter("") : this.#loadRecents()),
		);
	}

	/** Draws the shown dates again, in the time zone and language chosen now, without reading anything. */
	redraw(): void {
		if (!this.#ready || this.#disposed) return;
		this.#drawList(false);
		if (this.#section === "recents") this.#drawRecents();
	}

	#setSection(section: "documents" | "recents"): void {
		this.#section = section;
		this.#documents.hidden = section !== "documents";
		this.#recents.hidden = section !== "recents";
		this.#options.onSectionChange?.(section);
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#stop.abort();
		clearInterval(this.#poll);
		clearTimeout(this.#syncTimer);
		void this.#hints?.close();
		this.#downloads?.close();
		this.#forget(this.#opened);
		this.#opened = null;
		this.#host.classList.remove("files-page", "folder-page", "has-preview", "storage-browser", "is-embedded");
	}

	// ---- lifetime -------------------------------------------------------------

	#signal(): AbortSignal {
		return AbortSignal.any([this.#stop.signal, this.#source.signal]);
	}

	#live(): void {
		this.#stop.signal.throwIfAborted();
		this.#source.current();
	}

	/** One action at a time; the list and preview stay still while it runs, and focus comes back to where it was. */
	async #run(action: () => Promise<void>, retry?: () => Promise<void>): Promise<void> {
		if (this.#busy || this.#disposed) return;
		this.#busy = true;
		const focus = document.activeElement;
		this.#root.inert = true;
		this.#say("");
		try {
			this.#live();
			await action();
			this.#live();
		} catch {
			if (!this.#disposed)
				this.#say(
					t("The Company File could not be read just now."),
					button(
						t("Try again"),
						() =>
							void this.#run(
								retry ?? (() => (this.#section === "recents" ? this.#loadRecents() : this.#load(this.#dir))),
								retry,
							),
						{ small: true },
					),
				);
		} finally {
			this.#busy = false;
			this.#root.inert = false;
			if (
				focus instanceof HTMLElement &&
				focus.isConnected &&
				(!document.activeElement || document.activeElement === document.body)
			)
				focus.focus();
			if (this.#revealPreview) {
				this.#revealPreview = false;
				if (!this.#disposed && !this.#pendingSection && !this.#preview.hidden)
					this.#preview.scrollIntoView?.({ block: "nearest", inline: "nearest" });
			}
			this.#navigate();
		}
	}

	#say(message: string, ...actions: HTMLElement[]): void {
		replace(this.#status, message ? h("span", null, message) : null, ...actions);
	}

	// ---- the folder -------------------------------------------------------------

	async #load(dir: string, append = false): Promise<void> {
		const page = await this.#client!.list(dir || null, append ? this.#next : null, PAGE, this.#signal());
		this.#live();
		const moved = dir !== this.#dir;
		this.#dir = dir;
		this.#items = append ? [...this.#items, ...page.entries] : [...page.entries];
		this.#next = page.next;
		// The listing is current as of asOfSeq: the feed is followed from there. Changes in between are not examined,
		// so an open file is read again when the position moves.
		const jumped =
			!append && this.#position !== null && page.asOfSeq > this.#position.afterSeq && this.#opened !== null;
		if (!append && (this.#position === null || page.asOfSeq > this.#position.afterSeq))
			this.#position = { afterSeq: page.asOfSeq, cursor: null };
		if (moved) this.#search.value = "";
		this.#drawCrumbs();
		this.#title.textContent = dir ? baseName(dir) : t("Documents");
		this.#drawList(!append);
		if (jumped) await this.#refreshOpened();
	}

	async #enter(dir: string): Promise<void> {
		this.#close();
		await this.#load(dir);
		this.#setSection("documents");
		this.#list.querySelector<HTMLElement>("button.files-row-main")?.focus();
	}

	#sorted(): CloudMemberFolderEntry[] {
		const collator = new Intl.Collator(this.#locale, { numeric: true, sensitivity: "base" });
		const query = this.#search.value.trim().toLocaleLowerCase(this.#locale);
		return this.#items
			.filter(
				(item) =>
					(!query || baseName(item.path).toLocaleLowerCase(this.#locale).includes(query)) &&
					(this.#filter.value === "all" || fileCategory(item) === this.#filter.value),
			)
			.sort((a, b) => {
				const folders = Number(a.kind !== "folder") - Number(b.kind !== "folder");
				if (folders) return folders;
				let order = 0;
				if (this.#sort.value === "modified")
					order = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
				else if (this.#sort.value === "size") order = (b.file?.bytes ?? 0) - (a.file?.bytes ?? 0);
				else if (this.#sort.value === "kind") order = collator.compare(fileKind(a), fileKind(b));
				return order || collator.compare(baseName(a.path), baseName(b.path));
			});
	}

	#drawCrumbs(): void {
		const parts = this.#dir ? this.#dir.split("/") : [];
		// The title already names the top folder, so the trail is drawn only below it.
		this.#crumbs.hidden = this.#options.embedded === true && parts.length === 0;
		const steps: HTMLElement[] = [
			parts.length
				? h(
						"button",
						{ type: "button", class: "files-crumb", onclick: () => void this.#run(() => this.#enter("")) },
						t("Documents"),
					)
				: h("span", { class: "files-crumb is-current", "aria-current": "page" }, t("Documents")),
		];
		parts.forEach((part, index) => {
			const path = parts.slice(0, index + 1).join("/");
			steps.push(
				h("span", { class: "files-crumb-sep", "aria-hidden": "true" }, icon("chevron")),
				index === parts.length - 1
					? h("span", { class: "files-crumb is-current", "aria-current": "page" }, part)
					: h(
							"button",
							{ type: "button", class: "files-crumb", onclick: () => void this.#run(() => this.#enter(path)) },
							part,
						),
			);
		});
		replace(this.#crumbs, h("div", { class: "files-crumb-trail" }, ...steps));
	}

	#drawList(fresh: boolean): void {
		const items = this.#sorted();
		this.#list.classList.toggle("is-grid", this.#view === "grid");
		this.#list.classList.toggle("is-list", this.#view === "list");
		this.#columns.hidden = this.#view !== "list";
		for (const control of this.#views.querySelectorAll<HTMLButtonElement>("button"))
			control.setAttribute("aria-pressed", String(control.dataset.view === this.#view));
		this.#list.classList.toggle("is-fresh", fresh);
		const rows = items.map((item, index) => {
			const row = this.#entryRow(item);
			row.style.setProperty("--row", String(Math.min(index, 14)));
			return row;
		});
		if (rows.length === 0)
			rows.push(
				h(
					"li",
					{ class: "files-empty" },
					this.#search.value.trim()
						? t("Nothing in this folder matches “{query}”.", { query: this.#search.value.trim() })
						: this.#filter.value !== "all"
							? t("No files of this type in this folder.")
							: t("This folder is empty."),
				),
			);
		replace(this.#list, ...rows);
		this.#more.hidden = this.#next === null;
		this.#count.textContent =
			this.#next !== null
				? t("{shown} of {count} loaded items", { shown: items.length, count: this.#items.length })
				: items.length === this.#items.length
					? t("{count} items", { count: items.length })
					: t("{shown} of {count} items", { shown: items.length, count: this.#items.length });
	}

	/** A folder's row opens it in the list; a file's or a link's opens it in the preview. A link names its target and
	 * is never followed: its row shows where it points. */
	#entryRow(item: CloudMemberFolderEntry): HTMLElement {
		const folder = item.kind === "folder";
		const category = fileCategory(item);
		const kind = folder
			? "folder"
			: category === "link"
				? "link"
				: category === "image"
					? "image"
					: category === "spreadsheet"
						? "table"
						: "file";
		const label = fileKind(item);
		return h(
			"li",
			{
				class: `files-row${item.target !== null ? " is-link" : ""}${this.#opened?.path === item.path ? " is-open" : ""}`,
			},
			h(
				"button",
				{
					type: "button",
					class: "files-row-main",
					"data-path": item.path,
					onclick: () => void this.#run(() => (folder ? this.#enter(item.path) : this.#open(item))),
				},
				h(
					"span",
					{ class: `files-kind is-${category}`, "aria-hidden": "true" },
					this.#view === "grid" && this.#options.embedded ? tileGlyph(item, category) : icon(kind),
				),
				h(
					"span",
					{ class: "storage-name-cell" },
					h("span", { class: "files-name", title: baseName(item.path) }, baseName(item.path)),
					item.target !== null
						? h(
								"span",
								{ class: "files-target", title: t("Link to {target}", { target: item.target }) },
								`→ ${item.target}`,
							)
						: null,
					item.file ? h("span", { class: "storage-grid-meta" }, fmtBytes(item.file.bytes)) : null,
				),
				h(
					"time",
					{
						class: "storage-modified",
						datetime: item.updatedAt,
						title: this.#format(item.updatedAt),
					},
					this.#modified(item.updatedAt),
				),
				h("span", { class: "files-size" }, item.file ? fmtBytes(item.file.bytes) : "—"),
				h("span", { class: "storage-kind-label" }, label),
			),
		);
	}

	// ---- following changes ------------------------------------------------------

	#scheduleSync(): void {
		if (this.#disposed || this.#syncTimer) return;
		this.#syncTimer = setTimeout(() => {
			this.#syncTimer = undefined;
			if (this.#busy) {
				this.#scheduleSync();
				return;
			}
			void this.#run(() => this.#sync());
		}, SYNC_DELAY_MS);
	}

	/** Asks the feed what changed since the page was read, and redraws what it touched. */
	async #sync(): Promise<void> {
		let position = this.#position;
		// No position: the last reset's reload failed. Reading the folder again sets one.
		if (!position) {
			await this.#reload();
			return;
		}
		let touchedFolder = false,
			touchedFile = false,
			authority = false,
			reset = false;
		for (let pages = 0; ; pages++) {
			// At most five pages a sync: past that, reading the folder again is cheaper than following.
			if (pages === 5) {
				reset = true;
				break;
			}
			const page = await this.#client!.changes(position, CLOUD_MEMBER_FOLDER_PAGE, this.#signal());
			this.#live();
			if (page.resync || !page.next) {
				reset = true;
				break;
			}
			for (const event of page.events) {
				// An authority change may change what this member may read anywhere.
				if (event.kind === "authority") {
					touchedFolder = true;
					touchedFile = this.#opened !== null;
					authority = true;
					continue;
				}
				for (const change of event.changes) {
					if (parentOf(change.path) === this.#dir || change.path === this.#dir) touchedFolder = true;
					if (change.path === this.#opened?.path) touchedFile = true;
				}
			}
			position = page.next;
			this.#position = position;
			if (!page.more) break;
		}
		if (reset) {
			this.#position = null;
			await this.#reload();
			return;
		}
		if (touchedFolder) await this.#reloadFolder();
		if (touchedFile) await this.#refreshOpened();
		// What this member may read may have changed: older Recents pages read before are not kept unchecked.
		if (authority) this.#forgetRecents();
		if (this.#section === "recents") await this.#loadRecents(authority ? "fresh" : "refresh");
	}

	/** Reads the open folder and the open file again, from a fresh position. Recents starts again from its newest
	 * page too: after a feed reset nothing read before is known to still be readable. */
	async #reload(): Promise<void> {
		await this.#reloadFolder();
		await this.#refreshOpened();
		this.#forgetRecents();
		if (this.#section === "recents") await this.#loadRecents("fresh");
	}

	#forgetRecents(): void {
		this.#recentSets = [];
		this.#recentNext = null;
	}

	/** The open folder again, or its nearest folder that is still there when it was deleted or moved. */
	async #reloadFolder(): Promise<void> {
		let dir = this.#dir;
		while (dir) {
			const read = await this.#client!.read(dir, this.#signal());
			this.#live();
			if (read.entry?.kind === "folder") break;
			dir = parentOf(dir);
		}
		if (dir !== this.#dir) this.#close();
		await this.#load(dir);
	}

	/** The open file or link at its latest version, when it changed; an earlier version on screen stays. */
	async #refreshOpened(): Promise<void> {
		const opened = this.#opened;
		if (!opened || opened.version) return;
		const read = await this.#client!.read(opened.path, this.#signal());
		this.#live();
		const entry = read.entry;
		if (!entry || (!entry.file && entry.target === null)) {
			this.#close();
			this.#say(t("{name} is no longer in this folder.", { name: baseName(opened.path) }));
			return;
		}
		if (
			entry.target !== opened.target ||
			entry.file?.fileSha256 !== opened.file?.fileSha256 ||
			entry.file?.bytes !== opened.file?.bytes
		)
			await this.#open(entry, true);
	}

	// ---- the preview ------------------------------------------------------------

	async #open(entry: CloudMemberFolderEntry, refresh = false): Promise<void> {
		if (!entry.file && entry.target === null) return;
		if (refresh || this.#opened?.path !== entry.path || this.#opened?.version)
			await this.#show({ path: entry.path, file: entry.file, target: entry.target });
		if (!refresh && this.#options.embedded) this.#revealPreview = true;
	}

	/** Reads what has a preview, and draws the preview. A link's is its target: nothing is read. */
	async #show(opened: Opened): Promise<void> {
		const type = IMAGE_TYPES[extension(opened.path)];
		if (
			opened.file &&
			(type
				? opened.file.bytes <= MAX_PREVIEW_IMAGE_BYTES
				: opened.file.bytes <= MAX_PREVIEW_TEXT_BYTES && !BINARY.has(extension(opened.path)))
		) {
			const bytes = await this.#client!.readFile(opened.file, this.#signal());
			this.#live();
			if (type) opened.image = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type }));
			else opened.text = decodeText(bytes);
		}
		this.#forget(this.#opened);
		this.#opened = opened;
		this.#drawFile();
	}

	#close(): void {
		this.#revealPreview = false;
		this.#forget(this.#opened);
		this.#opened = null;
		this.#preview.hidden = true;
		this.#preview.replaceChildren();
		this.#host.classList.remove("has-preview");
		for (const row of this.#list.querySelectorAll(".files-row.is-open")) row.classList.remove("is-open");
	}

	#forget(opened: Opened | null): void {
		if (opened?.image) URL.revokeObjectURL(opened.image);
	}

	#iconButton(name: string, label: string, action: () => void): HTMLButtonElement {
		return h(
			"button",
			{ type: "button", class: "files-icon-button", title: label, "aria-label": label, onclick: action },
			icon(name),
		);
	}

	#panel(title: string, ...children: (HTMLElement | null)[]): void {
		replace(
			this.#preview,
			h(
				"header",
				{ class: "files-preview-head" },
				h("h2", { title }, title),
				this.#iconButton("close", t("Close {name}", { name: title }), () => {
					if (!this.#busy) this.#close();
				}),
			),
			...children,
		);
		this.#preview.setAttribute("aria-label", title);
		this.#preview.hidden = false;
		this.#host.classList.add("has-preview");
	}

	#drawFile(): void {
		const opened = this.#opened;
		if (!opened) {
			this.#close();
			return;
		}
		const name = baseName(opened.path);
		for (const row of this.#list.querySelectorAll<HTMLElement>(".files-row"))
			row.classList.toggle(
				"is-open",
				row.querySelector<HTMLElement>(".files-row-main")?.dataset.path === opened.path,
			);
		const file = opened.file;
		let body: HTMLElement;
		if (opened.image) body = h("img", { class: "files-image", src: opened.image, alt: name });
		else if (opened.text !== undefined)
			body = MARKDOWN.has(extension(opened.path))
				? h("div", { class: "files-doc" }, markdown(opened.text))
				: h("pre", { class: "files-text" }, opened.text);
		else if (!file)
			body = h(
				"div",
				{ class: "files-blank" },
				icon("link"),
				h("span", { class: "files-link-target" }, t("Link to {target}", { target: opened.target ?? "" })),
			);
		else
			body = h(
				"div",
				{ class: "files-blank" },
				icon("file"),
				h("span", null, t("There's no preview for this file.")),
				h("small", null, fmtBytes(file.bytes)),
			);
		const actions: HTMLElement[] = [
			button([icon("clock"), t("History")], () => void this.#run(() => this.#showHistory(opened.path))),
		];
		if (file)
			actions.unshift(
				file.bytes <= MAX_DOWNLOAD_BYTES
					? button(
							[icon("download"), t("Download")],
							() => void this.#run(() => this.#download(opened.path, file)),
						)
					: h(
							"span",
							{ class: "files-note" },
							t("{size}: too large to download here.", { size: fmtBytes(file.bytes) }),
						),
			);
		if (opened.version) {
			const path = opened.path;
			actions.unshift(
				button(t("Show the latest"), () => void this.#run(() => this.#reopen(path)), { primary: true }),
			);
		}
		this.#panel(
			name,
			opened.version
				? h(
						"p",
						{ class: "files-note" },
						t("An earlier version, from {when}.", { when: this.#format(opened.version.at) }),
					)
				: null,
			h("div", { class: "files-preview-body" }, body),
			h("div", { class: "files-preview-actions" }, ...actions),
		);
	}

	async #reopen(path: string): Promise<void> {
		const read = await this.#client!.read(path, this.#signal());
		this.#live();
		const entry = read.entry;
		if (!entry || (!entry.file && entry.target === null)) {
			this.#close();
			this.#say(t("{name} is no longer in this folder.", { name: baseName(path) }));
			return;
		}
		await this.#show({ path, file: entry.file, target: entry.target });
	}

	async #download(path: string, file: CloudMemberFolderFile): Promise<void> {
		const bytes = await this.#client!.readFile(file, this.#signal(), MAX_DOWNLOAD_BYTES);
		this.#live();
		this.#downloads!.offer(path, bytes);
		this.#say(t("Downloading {name}.", { name: baseName(path) }));
	}

	// ---- history ----------------------------------------------------------------

	/** A moment in full, in the time zone chosen now: Settings can change the zone while this browser stays open. */
	#format(iso: string): string {
		return new Date(iso).toLocaleString(this.#locale, {
			dateStyle: "medium",
			timeStyle: "short",
			...timeZoneOption(),
		});
	}

	/** A file's modified time, the way a file manager says it: today and yesterday by name, then the date. */
	#modified(iso: string): string {
		const date = new Date(iso);
		if (Number.isNaN(date.getTime())) return "";
		const zone = timeZoneOption();
		const day = presentationDay(date, zone.timeZone);
		const today = presentationDay(new Date(), zone.timeZone);
		const time = date.toLocaleTimeString(this.#locale, { hour: "2-digit", minute: "2-digit", ...zone });
		if (day === today) return t("Today {time}", { time });
		if (day === previousDay(today)) return t("Yesterday {time}", { time });
		return fmtTime(iso);
	}

	#who(by: CloudMemberFolderBy): string {
		const people = this.#people();
		if (by.kind === "platform") return "Qorpera";
		if (by.kind === "agent")
			return people.staff.find((agent) => agent.id === by.staffAgentId)?.displayName ?? t("An agent");
		if (by.userId === people.me) return t("You");
		return people.members.find((member) => member.userId === by.userId)?.displayName ?? t("A member");
	}

	#what(version: CloudMemberFolderVersion): string {
		switch (version.op) {
			case "write":
				return version.target !== null ? t("Link to {target}", { target: version.target }) : t("Changed");
			case "mkdir":
				return t("Created");
			case "delete":
				return t("Deleted");
			case "copy":
				return t("Copied here");
			case "move_in":
				return version.from ? t("Moved here from {path}", { path: version.from }) : t("Moved here");
			case "move_out":
				return version.to ? t("Moved to {path}", { path: version.to }) : t("Moved away");
		}
	}

	/** A path's versions, newest first, each with who and when; an older one opens in place of the latest, and any but
	 * the one there now is restored. A file's and a link's versions on one path list together. */
	async #showHistory(
		path: string,
		before: string | null = null,
		shown: CloudMemberFolderVersion[] = [],
	): Promise<void> {
		const page = await this.#client!.pathHistory(path, before, HISTORY_PAGE, this.#signal());
		this.#live();
		const versions = [...shown, ...page.items];
		// The newest version is what the path holds now, unless it was deleted or moved away.
		const latest = versions[0];
		const current = latest && ["write", "copy", "move_in"].includes(latest.op) ? latest.version : null;
		const rows = versions.map((version) => {
			const held = version.file !== null || version.target !== null;
			return h(
				"li",
				{ class: "folder-history-row" },
				h(
					"div",
					{ class: "folder-history-what" },
					h("span", null, this.#what(version)),
					h("small", null, `${this.#who(version.by)} · ${this.#format(version.at)}`),
				),
				held ? this.#viewButton(path, version) : null,
				held && version.version !== current ? this.#restoreButton(path, version) : null,
			);
		});
		const title = t("History of {name}", { name: baseName(path) });
		this.#panel(
			title,
			rows.length
				? h("ul", { class: "folder-history" }, ...rows)
				: h("p", { class: "files-note" }, t("No history to show.")),
			page.next
				? button(t("Show older"), () => void this.#run(() => this.#showHistory(path, page.next, versions)), {
						small: true,
					})
				: null,
		);
	}

	/** Opens an earlier version in place of the latest; its name says which. */
	#viewButton(path: string, version: CloudMemberFolderVersion): HTMLButtonElement {
		const control = button(
			t("View"),
			() => void this.#run(() => this.#show({ path, file: version.file, target: version.target, version })),
			{ small: true },
		);
		control.setAttribute("aria-label", t("View the version from {when}", { when: this.#format(version.at) }));
		return control;
	}

	#restoreButton(path: string, version: CloudMemberFolderVersion): HTMLButtonElement {
		const control = button(t("Restore"), () => void this.#run(() => this.#restore(path, version)), { small: true });
		control.setAttribute("aria-label", t("Restore the version from {when}", { when: this.#format(version.at) }));
		return control;
	}

	/** Saves an earlier version as the path's latest, through the member commit route (RUNTIME-FOLDER-LINKS.md, LK6): a
	 * file's as a write of its reference, a link's as a link to its target. It replaces what the path holds now at the
	 * version just read, a file or a link; a folder there now is left alone. */
	async #restore(path: string, version: CloudMemberFolderVersion): Promise<void> {
		// This version's restore whose answer was lost is sent again as it was, not as a new change set.
		const lost = this.#lost.get(path);
		if (lost?.version === version.version) {
			await this.#commitRestore(path, lost.key, lost.unit, lost.version);
			return;
		}
		const read = await this.#client!.read(path, this.#signal());
		this.#live();
		const now = read.entry;
		if (now?.kind === "folder") {
			this.#say(t("{name} is a folder now, so this version can't be restored.", { name: baseName(path) }));
			return;
		}
		const expected = now ? { expectedVersion: now.version } : {};
		const unit: CloudMemberFolderUnit = version.file
			? { op: "write", path, file: version.file, ...expected }
			: { op: "symlink", path, target: version.target ?? "", ...expected };
		await this.#commitRestore(path, `web:folder-restore:${crypto.randomUUID()}`, unit, version.version);
	}

	/** Sends a restore; when its answer is lost, trying again sends the same change set, which the core answers once. */
	async #commitRestore(path: string, key: string, unit: CloudMemberFolderUnit, version: string): Promise<void> {
		const name = baseName(path);
		let answer: CloudMemberFolderCommit;
		try {
			answer = await this.#client!.commit(key, [unit], this.#signal());
		} catch {
			this.#live();
			this.#lost.set(path, { key, unit, version });
			this.#drawRetries();
			return;
		}
		this.#live();
		this.#lost.delete(path);
		this.#drawRetries();
		const result = answer.units[0];
		if (result?.outcome === "saved") {
			this.#say(t("Restored {name}.", { name }));
			await this.#reopen(path);
		} else if (result?.outcome === "conflict") {
			this.#say(t("{name} changed in the meantime, so it was not restored.", { name }));
			await this.#showHistory(path);
		} else if (result?.outcome === "denied") this.#say(t("You may not change {name}.", { name }));
		else
			this.#say(
				withProblems(
					t("{name} could not be restored.", { name }),
					(result?.problems ?? []).map((problem) => problem.message),
				),
			);
	}

	#drawRetries(): void {
		replace(
			this.#retries,
			...[...this.#lost].flatMap(([path, { key, unit, version }]) => [
				h("span", null, t("{name} could not be restored just now.", { name: baseName(path) })),
				button(t("Try again"), () => void this.#run(() => this.#commitRestore(path, key, unit, version)), {
					small: true,
				}),
			]),
		);
	}

	#changeRows(sets: readonly CloudMemberFolderChangeSet[]): HTMLElement[] {
		return sets.map((set) =>
			h(
				"li",
				{ class: "folder-history-row is-set" },
				h(
					"div",
					{ class: "folder-history-what" },
					h("small", null, `${this.#who(set.by)} · ${this.#format(set.at)}`),
					h(
						"ul",
						{ class: "folder-history-paths" },
						...set.paths.map((item) =>
							h(
								"li",
								null,
								item.kind !== "folder" && item.op !== "delete" && item.op !== "move_out"
									? h(
											"button",
											{
												type: "button",
												class: "folder-history-path",
												onclick: () => void this.#run(() => this.#goTo(item.path)),
											},
											item.path,
										)
									: h("span", { class: "folder-history-path is-gone" }, item.path),
							),
						),
						set.more ? h("li", { class: "folder-history-more" }, t("and more")) : null,
					),
				),
			),
		);
	}

	/** Recents' newest page ("fresh"), the page below what is shown ("older"), or the newest pages again on a sync
	 * ("refresh"). A refresh keeps the older pages already shown, so "Show older" is not undone by a poll: it reads
	 * newest pages until they reach the newest change shown, so nothing between the two is skipped. When that is more
	 * than a few pages away, it shows only what it read, and "Show older" goes on from there. */
	async #loadRecents(mode: "fresh" | "older" | "refresh" = "fresh"): Promise<void> {
		if (mode === "older") {
			const page = await this.#client!.history(this.#recentNext, 20, this.#signal());
			this.#live();
			this.#recentSets = [...this.#recentSets, ...page.items];
			this.#recentNext = page.next;
			this.#drawRecents();
			return;
		}
		const shownNewest = mode === "refresh" ? this.#recentSets[0]?.seq : undefined;
		const read: CloudMemberFolderChangeSet[] = [];
		let next: number | null = null;
		let met = false;
		for (let pages = 0; pages < RECENTS_CATCH_UP_PAGES; pages++) {
			const page = await this.#client!.history(next, 20, this.#signal());
			this.#live();
			read.push(...page.items);
			next = page.next;
			const oldest = page.items.at(-1)?.seq;
			met = shownNewest !== undefined && oldest !== undefined && oldest <= shownNewest;
			if (shownNewest === undefined || next === null || met) break;
		}
		const oldestRead = read.at(-1)?.seq;
		const kept =
			met && next !== null && oldestRead !== undefined ? this.#recentSets.filter((set) => set.seq < oldestRead) : [];
		this.#recentSets = [...read, ...kept];
		if (kept.length === 0) this.#recentNext = next;
		this.#drawRecents();
	}

	#drawRecents(): void {
		const query = this.#search.value.trim().toLocaleLowerCase(this.#locale);
		const sets = this.#recentSets
			.map((set) => ({
				...set,
				paths: set.paths.filter((item) => !query || item.path.toLocaleLowerCase(this.#locale).includes(query)),
			}))
			.filter((set) => set.paths.length > 0);
		replace(
			this.#recents,
			h("div", { class: "storage-toolbar" }, h("h2", { class: "storage-title" }, t("Recents"))),
			sets.length
				? h("ul", { class: "folder-history storage-recent-list" }, ...this.#recentRows(sets))
				: h(
						"p",
						{ class: "files-empty" },
						query ? t("No recent changes match your search.") : t("Nothing has changed yet."),
					),
			this.#recentNext !== null
				? h(
						"div",
						{ class: "files-list-more" },
						button(t("Show older"), () => void this.#run(() => this.#loadRecents("older")), { small: true }),
					)
				: null,
		);
	}

	/** Recents' change sets under a heading for each day: today, yesterday, then the date. */
	#recentRows(sets: readonly CloudMemberFolderChangeSet[]): HTMLElement[] {
		const zone = timeZoneOption();
		const today = presentationDay(new Date(), zone.timeZone);
		const yesterday = previousDay(today);
		const rows: HTMLElement[] = [];
		let shownDay = "";
		for (const set of sets) {
			const at = new Date(set.at);
			const day = presentationDay(at, zone.timeZone);
			if (day !== shownDay) {
				shownDay = day;
				rows.push(
					h(
						"li",
						{ class: "storage-recent-day", role: "presentation" },
						day === today
							? t("Today")
							: day === yesterday
								? t("Yesterday")
								: at.toLocaleDateString(this.#locale, { dateStyle: "full", ...zone }),
					),
				);
			}
			const first = set.paths[0]!;
			const category = fileCategory({ kind: first.kind, path: first.path });
			rows.push(
				h(
					"li",
					{ class: "folder-history-row is-set storage-recent-row" },
					h(
						"span",
						{ class: `files-kind is-${category}`, "aria-hidden": "true" },
						icon(
							category === "folder"
								? "folder"
								: category === "image"
									? "image"
									: category === "spreadsheet"
										? "table"
										: category === "link"
											? "link"
											: "file",
						),
					),
					h(
						"div",
						{ class: "folder-history-what" },
						h(
							"ul",
							{ class: "folder-history-paths" },
							...set.paths.map((item) => {
								const parent = parentOf(item.path);
								const label = [
									parent ? h("span", { class: "storage-recent-folder" }, `${parent}/`) : null,
									h("span", { class: "storage-recent-name" }, baseName(item.path)),
								];
								return h(
									"li",
									null,
									item.kind !== "folder" && item.op !== "delete" && item.op !== "move_out"
										? h(
												"button",
												{
													type: "button",
													class: "folder-history-path",
													title: item.path,
													onclick: () => void this.#run(() => this.#goTo(item.path)),
												},
												...label,
											)
										: h("span", { class: "folder-history-path is-gone", title: item.path }, ...label),
								);
							}),
							set.more ? h("li", { class: "folder-history-more" }, t("and more")) : null,
						),
					),
					h(
						"small",
						{ class: "storage-recent-when", title: this.#format(set.at) },
						`${this.#who(set.by)} · ${at.toLocaleTimeString(this.#locale, { hour: "2-digit", minute: "2-digit", ...zone })}`,
					),
				),
			);
		}
		return rows;
	}

	/** The standalone browser keeps its existing recent-changes panel. */
	async #showChanges(before: number | null = null, shown: CloudMemberFolderChangeSet[] = []): Promise<void> {
		const page = await this.#client!.history(before, 20, this.#signal());
		this.#live();
		const sets = [...shown, ...page.items];
		const title = t("Recent changes");
		const rows = this.#changeRows(sets);
		this.#panel(
			title,
			rows.length
				? h("ul", { class: "folder-history" }, ...rows)
				: h("p", { class: "files-note" }, t("Nothing has changed yet.")),
			page.next !== null
				? button(t("Show older"), () => void this.#run(() => this.#showChanges(page.next, sets)), { small: true })
				: null,
		);
	}

	/** Opens a file's or a link's folder and the file or link, when it is still there. */
	async #goTo(path: string): Promise<void> {
		const read = await this.#client!.read(path, this.#signal());
		this.#live();
		const entry = read.entry;
		if (!entry || (!entry.file && entry.target === null)) {
			this.#say(t("{name} is no longer in this folder.", { name: baseName(path) }));
			return;
		}
		if (parentOf(path) !== this.#dir) await this.#load(parentOf(path));
		this.#search.value = "";
		this.#filter.value = "all";
		this.#drawList(false);
		this.#setSection("documents");
		await this.#show({ path, file: entry.file, target: entry.target });
		if (this.#options.embedded) this.#revealPreview = true;
	}
}
