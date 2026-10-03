import type {
	CloudMemberFolderBy,
	CloudMemberFolderChangeSet,
	CloudMemberFolderClient,
	CloudMemberFolderEntry,
	CloudMemberFolderFeedPosition,
	CloudMemberFolderFile,
	CloudMemberFolderVersion,
} from "@qorpera/cloud-client/cloud-member-folder";
import { WebFileDownloads } from "../../../../member-web/src/files.ts";
import { button, fmtBytes, h, icon, replace } from "../../ui/dom.ts";
import { markdown } from "../../ui/markdown.ts";
import { presentationLocale, t } from "../../ui/preferences.ts";
import { listSkeleton } from "../../ui/skeleton.ts";

/* A folder-v2 company's Company File (folder core C4, P33; deploy/first-node/RUNTIME-COMPANY-FOLDER-C4-MEMBERS.md):
 * the file browser Jonas approved for #386, read only until member writes (P31). A breadcrumb, one list of folders
 * and files, and a preview beside it with the file's history; the company's recent changes on the clock button. The
 * folder's hint (P30) nudges a sync from the feed, and a slow poll backs it up. */

type Client = Pick<CloudMemberFolderClient, "list" | "read" | "readFile" | "pathHistory" | "history" | "changes">;

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

/** An open file: its text or a picture's object URL when it has a preview, at the latest version or an older one. */
interface Opened {
	readonly path: string;
	readonly file: CloudMemberFolderFile;
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
	readonly #stop: AbortController;
	readonly #locale = presentationLocale();
	readonly #when: Intl.DateTimeFormat;
	readonly #root = h("div", { class: "files-root" });
	readonly #status = h("div", { class: "files-status", role: "status" });
	readonly #crumbs = h("nav", { class: "files-crumbs", "aria-label": t("Folder path") });
	readonly #list = h("ul", { class: "files-list", "aria-label": t("Files") });
	readonly #more = button(t("More files"), () => void this.#run(() => this.#load(this.#dir, true)), { small: true });
	readonly #preview = h("aside", { class: "files-preview" });
	readonly #search = h("input", {
		type: "search",
		class: "files-search-input",
		placeholder: t("Search this folder"),
		"aria-label": t("Search this folder"),
		autocomplete: "off",
		spellcheck: "false",
	});
	#client?: Client;
	#downloads?: WebFileDownloads;
	#hints?: { close(): Promise<void> };
	#poll?: ReturnType<typeof setInterval>;
	#syncTimer?: ReturnType<typeof setTimeout>;
	#dir = "";
	#items: CloudMemberFolderEntry[] = [];
	#next: string | null = null;
	/** Where the feed is followed from: everything up to it is on screen. */
	#position: CloudMemberFolderFeedPosition | null = null;
	#opened: Opened | null = null;
	#busy = false;
	#disposed = false;

	constructor(host: HTMLElement, source: CompanyFolderSource, people: () => CompanyFolderPeople) {
		this.#host = host;
		this.#source = source;
		this.#people = people;
		this.#stop = new AbortController();
		this.#when = new Intl.DateTimeFormat(this.#locale, { dateStyle: "medium", timeStyle: "short" });
		source.signal.addEventListener("abort", () => this.dispose(), { once: true });
		this.#search.addEventListener("input", () => this.#drawList(false));
		this.#search.addEventListener("keydown", (event) => {
			if (event.key === "Escape" && this.#search.value) {
				event.preventDefault();
				event.stopPropagation();
				this.#search.value = "";
				this.#drawList(false);
			}
		});
		this.#more.hidden = true;
		this.#preview.hidden = true;
		host.classList.add("files-page", "folder-page");
		replace(
			host,
			h(
				"header",
				{ class: "files-head" },
				h("h1", null, t("Company File")),
				h(
					"div",
					{ class: "files-tools" },
					h("label", { class: "files-search" }, icon("search"), this.#search),
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
			this.#root,
			this.#crumbs,
			h(
				"div",
				{ class: "files-body" },
				h("div", { class: "files-main" }, this.#list, h("div", { class: "files-list-more" }, this.#more)),
				this.#preview,
			),
		);
		await this.#load("");
		replace(this.#status);
		try {
			this.#hints ??= this.#source.folderHints(() => this.#scheduleSync());
		} catch {
			/* The hint is a nudge; the slow poll keeps the page current without it. */
		}
		this.#poll ??= setInterval(() => this.#scheduleSync(), POLL_MS);
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
	async #run(action: () => Promise<void>): Promise<void> {
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
					button(t("Try again"), () => void this.#run(() => this.#load(this.#dir)), { small: true }),
				);
		} finally {
			this.#busy = false;
			this.#root.inert = false;
			if (focus instanceof HTMLElement && focus.isConnected && !this.#host.contains(document.activeElement))
				focus.focus();
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
		this.#drawList(!append);
		if (jumped) await this.#refreshOpened();
	}

	async #enter(dir: string): Promise<void> {
		this.#close();
		await this.#load(dir);
		this.#list.querySelector<HTMLElement>(".files-row-main")?.focus();
	}

	#sorted(): CloudMemberFolderEntry[] {
		const collator = new Intl.Collator(this.#locale, { numeric: true, sensitivity: "base" });
		const query = this.#search.value.trim().toLocaleLowerCase(this.#locale);
		return this.#items
			.filter((item) => !query || baseName(item.path).toLocaleLowerCase(this.#locale).includes(query))
			.sort(
				(a, b) =>
					(a.kind === b.kind ? 0 : a.kind === "folder" ? -1 : 1) ||
					collator.compare(baseName(a.path), baseName(b.path)),
			);
	}

	#drawCrumbs(): void {
		const parts = this.#dir ? this.#dir.split("/") : [];
		const steps: HTMLElement[] = [
			parts.length
				? h(
						"button",
						{ type: "button", class: "files-crumb", onclick: () => void this.#run(() => this.#enter("")) },
						t("Company"),
					)
				: h("span", { class: "files-crumb is-current", "aria-current": "page" }, t("Company")),
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
		this.#list.classList.toggle("is-fresh", fresh);
		const rows = items.map((item, index) => {
			const name = baseName(item.path),
				folder = item.kind === "folder";
			const row = h(
				"li",
				{ class: `files-row${this.#opened?.path === item.path ? " is-open" : ""}` },
				h(
					"button",
					{
						type: "button",
						class: "files-row-main",
						"data-path": item.path,
						onclick: () => void this.#run(() => (folder ? this.#enter(item.path) : this.#open(item))),
					},
					h("span", { class: `files-kind ${folder ? "is-folder" : "is-file"}` }, icon(folder ? "folder" : "file")),
					h("span", { class: "files-name" }, name),
					h("span", { class: "files-size" }, item.file ? fmtBytes(item.file.bytes) : ""),
				),
			);
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
						: t("This folder is empty."),
				),
			);
		replace(this.#list, ...rows);
		this.#more.hidden = this.#next === null;
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
			reset = false;
		for (let pages = 0; ; pages++) {
			// At most five pages a sync: past that, reading the folder again is cheaper than following.
			if (pages === 5) {
				reset = true;
				break;
			}
			const page = await this.#client!.changes(position, 500, this.#signal());
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
	}

	/** Reads the open folder and the open file again, from a fresh position. */
	async #reload(): Promise<void> {
		await this.#reloadFolder();
		await this.#refreshOpened();
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

	/** The open file at its latest version, when it changed; an earlier version on screen stays. */
	async #refreshOpened(): Promise<void> {
		const opened = this.#opened;
		if (!opened || opened.version) return;
		const read = await this.#client!.read(opened.path, this.#signal());
		this.#live();
		if (!read.entry?.file) {
			this.#close();
			this.#say(t("{name} is no longer in this folder.", { name: baseName(opened.path) }));
			return;
		}
		if (read.entry.file.fileSha256 !== opened.file.fileSha256 || read.entry.file.bytes !== opened.file.bytes)
			await this.#open(read.entry, true);
	}

	// ---- the preview ------------------------------------------------------------

	async #open(entry: CloudMemberFolderEntry, refresh = false): Promise<void> {
		if (!entry.file) return;
		if (!refresh && this.#opened?.path === entry.path && !this.#opened.version) return;
		await this.#show({ path: entry.path, file: entry.file });
	}

	/** Reads what has a preview, and draws the preview. */
	async #show(opened: Opened): Promise<void> {
		const type = IMAGE_TYPES[extension(opened.path)];
		if (
			type
				? opened.file.bytes <= MAX_PREVIEW_IMAGE_BYTES
				: opened.file.bytes <= MAX_PREVIEW_TEXT_BYTES && !BINARY.has(extension(opened.path))
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
		let body: HTMLElement;
		if (opened.image) body = h("img", { class: "files-image", src: opened.image, alt: name });
		else if (opened.text !== undefined)
			body = MARKDOWN.has(extension(opened.path))
				? h("div", { class: "files-doc" }, markdown(opened.text))
				: h("pre", { class: "files-text" }, opened.text);
		else
			body = h(
				"div",
				{ class: "files-blank" },
				icon("file"),
				h("span", null, t("There's no preview for this file.")),
				h("small", null, fmtBytes(opened.file.bytes)),
			);
		const actions: HTMLElement[] = [
			opened.file.bytes <= MAX_DOWNLOAD_BYTES
				? button(
						[icon("download"), t("Download")],
						() => void this.#run(() => this.#download(opened.path, opened.file)),
					)
				: h(
						"span",
						{ class: "files-note" },
						t("{size}: too large to download here.", { size: fmtBytes(opened.file.bytes) }),
					),
			button([icon("clock"), t("History")], () => void this.#run(() => this.#showHistory(opened.path))),
		];
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
						t("An earlier version, from {when}.", { when: this.#when.format(new Date(opened.version.at)) }),
					)
				: null,
			h("div", { class: "files-preview-body" }, body),
			h("div", { class: "files-preview-actions" }, ...actions),
		);
	}

	async #reopen(path: string): Promise<void> {
		const read = await this.#client!.read(path, this.#signal());
		this.#live();
		if (!read.entry?.file) {
			this.#close();
			this.#say(t("{name} is no longer in this folder.", { name: baseName(path) }));
			return;
		}
		await this.#show({ path, file: read.entry.file });
	}

	async #download(path: string, file: CloudMemberFolderFile): Promise<void> {
		const bytes = await this.#client!.readFile(file, this.#signal(), MAX_DOWNLOAD_BYTES);
		this.#live();
		this.#downloads!.offer(path, bytes);
		this.#say(t("Downloading {name}.", { name: baseName(path) }));
	}

	// ---- history ----------------------------------------------------------------

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
				return t("Changed");
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

	/** A file's versions, newest first, each with who and when; an older one opens in place of the latest. */
	async #showHistory(
		path: string,
		before: string | null = null,
		shown: CloudMemberFolderVersion[] = [],
	): Promise<void> {
		const page = await this.#client!.pathHistory(path, before, HISTORY_PAGE, this.#signal());
		this.#live();
		const versions = [...shown, ...page.items];
		const rows = versions.map((version) =>
			h(
				"li",
				{ class: "folder-history-row" },
				h(
					"div",
					{ class: "folder-history-what" },
					h("span", null, this.#what(version)),
					h("small", null, `${this.#who(version.by)} · ${this.#when.format(new Date(version.at))}`),
				),
				version.file ? this.#viewButton(path, version, version.file) : null,
			),
		);
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
	#viewButton(path: string, version: CloudMemberFolderVersion, file: CloudMemberFolderFile): HTMLButtonElement {
		const control = button(t("View"), () => void this.#run(() => this.#show({ path, file, version })), {
			small: true,
		});
		control.setAttribute(
			"aria-label",
			t("View the version from {when}", { when: this.#when.format(new Date(version.at)) }),
		);
		return control;
	}

	/** The company's change sets, newest first, with the files in each this member may read. */
	async #showChanges(before: number | null = null, shown: CloudMemberFolderChangeSet[] = []): Promise<void> {
		const page = await this.#client!.history(before, 20, this.#signal());
		this.#live();
		const sets = [...shown, ...page.items];
		const title = t("Recent changes");
		const rows = sets.map((set) =>
			h(
				"li",
				{ class: "folder-history-row is-set" },
				h(
					"div",
					{ class: "folder-history-what" },
					h("small", null, `${this.#who(set.by)} · ${this.#when.format(new Date(set.at))}`),
					h(
						"ul",
						{ class: "folder-history-paths" },
						...set.paths.map((item) =>
							h(
								"li",
								null,
								item.kind === "file" && item.op !== "delete" && item.op !== "move_out"
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

	/** Opens a file's folder and the file, when it is still there. */
	async #goTo(path: string): Promise<void> {
		const read = await this.#client!.read(path, this.#signal());
		this.#live();
		if (!read.entry?.file) {
			this.#say(t("{name} is no longer in this folder.", { name: baseName(path) }));
			return;
		}
		if (parentOf(path) !== this.#dir) await this.#load(parentOf(path));
		await this.#show({ path, file: read.entry.file });
	}
}
