import type { CompanyComputerFileExportAsset } from "@qorpera/cloud-client/cloud-file-transfer";
import {
	type CloudMemberCompanyCommand,
	type CloudMemberCompanyEdit,
	type CloudMemberCompanyFileClient,
	type CloudMemberCompanyPage,
	type CloudMemberCompanyProposal,
	CloudMemberCompanyRefusal,
} from "@qorpera/cloud-client/cloud-member-company-editor";
import type { CloudMemberCompanyPresence } from "@qorpera/cloud-client/cloud-member-company-presence";
import type { CompanyPathPresenceView } from "@qorpera/cloud-client/company-path-presence";
import { parseCloudCompanyPath } from "@qorpera/cloud-client/company-path-schema";
import { WebFileDownloads, WebFileUpload } from "../../../../member-web/src/files.ts";
import type { WebCompanyFiles } from "../../cloud/company-files.ts";
import type { HostedStaffAgent } from "../../cloud/types.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { type MenuEntry, openContextMenu } from "../../ui/context-menu.ts";
import { button, confirmDialog, fmtBytes, h, icon, replace } from "../../ui/dom.ts";
import { markdown } from "../../ui/markdown.ts";
import { nameDialog } from "../../ui/name-dialog.ts";
import { presentationLocale, t } from "../../ui/preferences.ts";
import { listSkeleton } from "../../ui/skeleton.ts";

/* The Company File as a plain file browser: a breadcrumb, one list of folders
 * and files, and a preview beside it. Agents at work show as their figures on
 * the rows they read or write. Changes an agent proposes are decided in its
 * conversation, not here. Every write still names the exact version it was
 * made against, and an unconfirmed write is retried unchanged, never replayed
 * with new content. */

type Item = CloudMemberCompanyPage["items"][number];
type Settled = CloudMemberCompanyCommand | CloudMemberCompanyProposal;
/** How a change ended: applied now, approved to apply shortly, or not at all. */
type Outcome = "applied" | "approved" | false;

/** An open file: its text when it is text, a picture's object URL when it is one. */
interface Opened {
	path: string;
	/** null for a new file that is not saved yet. */
	version: string | null;
	bytes: number;
	text?: string;
	image?: string;
	editable: boolean;
	/** Why the text cannot be edited here, when it is text. */
	readOnly?: string;
}

/** A message meant for the member, shown as it is. */
class Refusal extends Error {}

const MAX_TEXT_BYTES = 32 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const PRESENCE_PATHS = 8;
const IMAGE_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	svg: "image/svg+xml",
};
const MARKDOWN = new Set(["md", "markdown", "mdown"]);
/** Larger text is shown, not edited; beyond this a file only downloads. */
const MAX_PREVIEW_TEXT_BYTES = 1024 * 1024;
/** Kinds that are never text: no read is spent finding that out. */
const BINARY = new Set(
	"pdf zip gz tgz 7z rar doc docx xls xlsx ppt pptx key numbers pages mp3 m4a wav ogg mp4 mov webm avi heic ico woff woff2 ttf otf exe dmg".split(
		" ",
	),
);

function baseName(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}
function extension(path: string): string {
	const name = baseName(path);
	return name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
}
function textBytes(text: string): number {
	return new TextEncoder().encode(text).length;
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

export class LiveCompanyFileView {
	readonly el = h("section", { class: "page files-page" });
	readonly routeHash: string;
	readonly role: string;
	readonly authorityKey: string;
	readonly #company: WebCompanyFiles;
	readonly #stop: AbortController;
	readonly #staff: () => readonly HostedStaffAgent[];
	readonly #reload?: () => void;
	readonly #canWrite: boolean;
	/** Deleting is always a protected change, which only owners and admins may make. */
	readonly #canDelete: boolean;
	readonly #locale = presentationLocale();
	readonly #root = h("div", { class: "files-root" });
	readonly #status = h("div", { class: "files-status", role: "status" });
	readonly #crumbs = h("nav", { class: "files-crumbs", "aria-label": t("Folder path") });
	readonly #here = h("span", { class: "files-here" });
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
	readonly #chooser = h("input", {
		type: "file",
		multiple: true,
		class: "visually-hidden",
		tabindex: "-1",
		"aria-label": t("Choose files to upload"),
	});
	readonly #drop = h("div", { class: "files-drop", "aria-hidden": "true" });
	#client?: CloudMemberCompanyFileClient;
	#downloads?: WebFileDownloads;
	#uploader?: WebFileUpload;
	#observer?: CloudMemberCompanyPresence;
	#activity?: CompanyPathPresenceView;
	#timer?: ReturnType<typeof setInterval>;
	#dir = "";
	#items: Item[] = [];
	#page: CloudMemberCompanyPage | null = null;
	#opened: Opened | null = null;
	#editing = false;
	#draft = "";
	#dirty = false;
	/** A save whose outcome is unknown: retried exactly as it was sent. */
	#pending: CloudMemberCompanyEdit | null = null;
	/** Where an upload with an unknown outcome was going. */
	#uploading: { path: string; expectedVersion: string | null; name: string } | null = null;
	/** A protected change whose approval has an unknown outcome. */
	#approving: { command: CloudMemberCompanyCommand; path: string; kind: "save" | "other" } | null = null;
	#observeTimer?: ReturnType<typeof setTimeout>;
	#shared: CompanyComputerFileExportAsset[] = [];
	#sharedAfter: string | null = null;
	#busy = false;
	#dragDepth = 0;
	#disposed = false;
	constructor(
		company: WebCompanyFiles,
		stop: AbortController,
		profileId: string,
		authorityKey: string,
		options: {
			reload?: () => void;
			/** The company's agents, for the figures of those at work. */
			staff?: () => readonly HostedStaffAgent[];
			/** Whether the member may approve protected changes (owners and admins). */
			authorize?: boolean;
		} = {},
	) {
		this.#company = company;
		this.#stop = stop;
		this.#staff = options.staff ?? (() => []);
		this.#reload = options.reload;
		this.routeHash = location.hash;
		this.role = company.company.role;
		this.authorityKey = authorityKey;
		this.#canWrite = company.company.role !== "viewer" && company.company.canWrite !== false;
		this.#canDelete = this.#canWrite && options.authorize === true;
		const signal = stop.signal;
		const newButton = button([icon("plus"), t("New")], (event) => this.#newMenu(event.currentTarget as HTMLElement));
		newButton.classList.add("files-new");
		newButton.hidden = !this.#canWrite;
		this.#search.addEventListener("input", () => {
			this.#drawList(false);
			// The watched rows follow the filter, once typing pauses.
			clearTimeout(this.#observeTimer);
			this.#observeTimer = setTimeout(() => this.#observe(), 400);
		});
		this.#search.addEventListener("keydown", (event) => {
			if (event.key === "Escape" && this.#search.value) {
				event.preventDefault();
				event.stopPropagation();
				this.#search.value = "";
				this.#drawList(false);
				this.#observe();
			}
		});
		this.#chooser.addEventListener("change", () => {
			const files = [...(this.#chooser.files ?? [])];
			this.#chooser.value = "";
			if (files.length) this.#uploadWhenFree(files);
		});
		this.#more.hidden = true;
		this.#preview.hidden = true;
		this.el.append(
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
							title: t("Files shared from the Company Computer"),
							"aria-label": t("Files shared from the Company Computer"),
							onclick: () => {
								if (this.#client) void this.#run(() => this.#showShared());
							},
						},
						icon("computer"),
					),
					h(
						"a",
						{
							class: "files-tool",
							href: `#/c/${profileId}/file/history`,
							title: t("Snapshots and history"),
							"aria-label": t("Snapshots and history"),
						},
						icon("clock"),
					),
					newButton,
				),
			),
			this.#status,
			this.#root,
			this.#chooser,
			this.#drop,
		);
		if (this.#canWrite) this.#listenForDrops(signal);
		this.el.addEventListener(
			"keydown",
			(event) => {
				if (event.key !== "Escape" || this.#preview.hidden || this.#editing || this.#busy || event.defaultPrevented)
					return;
				if (!this.#preview.contains(event.target as Node) && !this.#list.contains(event.target as Node)) return;
				event.preventDefault();
				this.#close();
			},
			{ signal },
		);
		window.addEventListener(
			"beforeunload",
			(event) => {
				if (this.leaveMessage()) {
					event.preventDefault();
					event.returnValue = "";
				}
			},
			{ signal },
		);
		company.signal.addEventListener("abort", () => this.dispose(), { once: true });
		if (company.signal.aborted) {
			this.dispose();
			return;
		}
		void this.#run(() => this.#initialize());
	}

	leaveMessage(): string | null {
		if (this.#unconfirmed()) return t("The last change may not have been saved. Leave this page anyway?");
		return this.#dirty ? t("Discard this unsaved text?") : null;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#stop.abort();
		if (this.#timer) clearInterval(this.#timer);
		clearTimeout(this.#observeTimer);
		void this.#observer?.close();
		this.#downloads?.close();
		this.#forget(this.#opened);
		this.#opened = null;
		this.#pending = null;
		this.#approving = null;
		this.#dirty = false;
		this.el.replaceChildren();
		this.el.remove();
	}

	// ---- lifetime -------------------------------------------------------------

	#live(): void {
		this.#stop.signal.throwIfAborted();
		this.#company.current();
	}

	/** One action at a time. The list and preview stay still while it runs;
	 * focus comes back to where it was. */
	async #run(action: () => Promise<void>): Promise<void> {
		if (this.#busy || this.#stop.signal.aborted) return;
		this.#busy = true;
		const focus = document.activeElement;
		this.#root.inert = true;
		this.#say("");
		try {
			this.#live();
			await action();
			this.#live();
		} catch (error) {
			if (!this.#stop.signal.aborted) this.#problem(error);
		} finally {
			this.#busy = false;
			this.#root.inert = false;
			// An unconfirmed change keeps its Retry in view, whatever ran since.
			if (!this.#stop.signal.aborted && this.#unconfirmed() && !this.#status.querySelector(".files-retry"))
				this.#status.append(...this.#retries());
			if (focus instanceof HTMLElement && focus.isConnected && !this.el.contains(document.activeElement))
				focus.focus();
		}
	}

	async #initialize(): Promise<void> {
		// The status line, outside the root that is inert while this runs, tells a
		// screen reader what is opening until the list has been read.
		replace(this.#status, h("span", { class: "visually-hidden" }, t("Opening Company File")));
		replace(this.#root, listSkeleton(t("Opening Company File"), 4));
		try {
			const client = await this.#company.files();
			this.#live();
			const signal = AbortSignal.any([this.#stop.signal, this.#company.signal]);
			const live = () => this.#live();
			this.#client = client;
			this.#downloads ??= new WebFileDownloads({ signal, current: live });
			this.#uploader ??= new WebFileUpload({ client, signal, current: live });
			replace(
				this.#root,
				this.#crumbs,
				h(
					"div",
					{ class: "files-body" },
					h("div", { class: "files-main" }, this.#list, h("div", { class: "files-list-more" }, this.#more)),
					this.#preview,
				),
				this.#canWrite
					? h(
							"p",
							{ class: "files-drop-hint" },
							icon("upload"),
							t("Drop files anywhere on this page to upload them here."),
						)
					: null,
			);
			await this.#load("");
			replace(this.#status);
			// Agents at work are watched only once the files are open, so a retried
			// opening never leaves a second watcher behind.
			try {
				this.#observer ??= this.#company.presence((view) => {
					if (signal.aborted) return;
					this.#activity = view;
					this.#drawActivity();
				});
			} catch {
				/* Activity is lossy and optional; the files work without it. */
			}
			this.#timer ??= setInterval(() => this.#drawActivity(), 2000);
			this.#observe();
		} catch (error) {
			if (this.#stop.signal.aborted) throw error;
			replace(
				this.#root,
				button(t("Retry opening Company File"), () => void this.#run(() => this.#initialize())),
			);
			throw error;
		}
	}

	// ---- status ---------------------------------------------------------------

	#say(message: string, ...actions: HTMLElement[]): void {
		replace(this.#status, message ? h("span", null, message) : null, ...actions);
		this.#status.classList.toggle("has-actions", actions.length > 0);
	}

	/** The Retry for whichever change has an unknown outcome. */
	#retries(): HTMLElement[] {
		const retry = (label: string, action: () => Promise<void>) => {
			const control = button(label, () => void this.#run(action), { small: true });
			control.classList.add("files-retry");
			return control;
		};
		if (this.#approving) return [retry(t("Retry"), () => this.#retryApproval())];
		if (this.#uploading && this.#uploader?.uncertain) return [retry(t("Retry upload"), () => this.#retryUpload())];
		return [];
	}

	#problem(error: unknown): void {
		const actions: HTMLElement[] = [...this.#retries()];
		if (this.#reload)
			actions.push(
				button(
					t("Reload"),
					() => {
						if (this.#stop.signal.aborted) return;
						if (
							this.leaveMessage() &&
							!window.confirm(
								t("Reload Company File and discard unsaved text? A change you sent may still apply."),
							)
						)
							return;
						this.#reload?.();
					},
					{ small: true },
				),
			);
		this.#say(
			error instanceof Refusal
				? error.message
				: t("The operation could not be confirmed. Check the current state before retrying."),
			...actions,
		);
	}

	/** Asks before leaving an edit. An unconfirmed change blocks it. */
	#leave(): boolean {
		this.#settled();
		return !this.#dirty || window.confirm(t("Discard this unsaved text?"));
	}

	// ---- the folder -------------------------------------------------------------

	async #load(dir: string, append = false): Promise<void> {
		const client = this.#client!;
		const next = await client.list(
			dir,
			this.#stop.signal,
			append ? (this.#page?.nextAfter ?? null) : null,
			append ? (this.#page?.snapshotId ?? null) : null,
		);
		this.#live();
		const moved = dir !== this.#dir;
		this.#dir = dir;
		this.#page = next;
		this.#items = append ? [...this.#items, ...next.items] : [...next.items];
		if (moved) this.#search.value = "";
		this.#drawCrumbs();
		this.#drawList(!append);
		this.#observe();
	}

	async #enter(dir: string): Promise<void> {
		if (!this.#leave()) return;
		this.#close();
		await this.#load(dir);
		this.#list.querySelector<HTMLElement>(".files-row-main")?.focus();
	}

	#sorted(): Item[] {
		const collator = new Intl.Collator(this.#locale, { numeric: true, sensitivity: "base" });
		const query = this.#search.value.trim().toLocaleLowerCase(this.#locale);
		return this.#items
			.filter((item) => !query || baseName(item.path).toLocaleLowerCase(this.#locale).includes(query))
			.sort(
				(a, b) =>
					(a.kind === b.kind ? 0 : a.kind === "directory" ? -1 : 1) ||
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
		replace(this.#crumbs, h("div", { class: "files-crumb-trail" }, ...steps), this.#here);
	}

	#drawList(fresh: boolean): void {
		const items = this.#sorted();
		this.#list.classList.toggle("is-fresh", fresh);
		const rows = items.map((item, index) => {
			const name = baseName(item.path),
				folder = item.kind === "directory";
			const main = h(
				"button",
				{
					type: "button",
					class: "files-row-main",
					"data-path": item.path,
					onclick: () => void this.#run(() => (folder ? this.#enter(item.path) : this.#open(item))),
					oncontextmenu: (event: MouseEvent) => this.#rowMenu(event, item, main),
				},
				h("span", { class: `files-kind ${folder ? "is-folder" : "is-file"}` }, icon(folder ? "folder" : "file")),
				h("span", { class: "files-name" }, name),
				h("span", { class: "files-activity", "data-path": item.path }),
				h("span", { class: "files-size" }, folder ? "" : fmtBytes(item.bytes ?? 0)),
			);
			const row = h(
				"li",
				{ class: `files-row${this.#opened?.path === item.path ? " is-open" : ""}` },
				main,
				folder
					? null
					: h(
							"span",
							{ class: "files-row-actions" },
							Object.assign(
								this.#iconButton(
									"download",
									t("Download {name}", { name }),
									() => void this.#run(() => this.#download(item.path, item.version)),
								),
								{ className: "files-icon-button files-row-download" },
							),
							this.#iconButton("more", t("More for {name}", { name }), (event) =>
								this.#rowMenu(event, item, main),
							),
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
						: this.#canWrite
							? t("This folder is empty. Drop files here or choose New.")
							: t("This folder is empty."),
				),
			);
		replace(this.#list, ...rows);
		this.#more.hidden = !this.#page?.hasMore;
		this.#drawActivity();
	}

	#iconButton(name: string, label: string, action: (event: MouseEvent) => void): HTMLButtonElement {
		return h(
			"button",
			{ type: "button", class: "files-icon-button", title: label, "aria-label": label, onclick: action },
			icon(name),
		);
	}

	#rowMenu(event: MouseEvent, item: Item, opener: HTMLElement): void {
		event.preventDefault();
		if (this.#busy) return;
		const name = baseName(item.path);
		const folder = item.kind === "directory";
		const items: MenuEntry[] = folder
			? [{ label: t("Open"), icon: "folder", select: () => void this.#run(() => this.#enter(item.path)) }]
			: [
					{ label: t("Open"), icon: "file", select: () => void this.#run(() => this.#open(item)) },
					{
						label: t("Download"),
						icon: "download",
						select: () => void this.#run(() => this.#download(item.path, item.version)),
					},
					...(this.#canDelete
						? ([
								{ kind: "separator" },
								{
									label: t("Delete"),
									icon: "trash",
									danger: true,
									select: () => void this.#run(() => this.#delete(item.path, item.version)),
								},
							] satisfies MenuEntry[])
						: []),
				];
		const from = event.currentTarget instanceof HTMLElement ? event.currentTarget : opener;
		const box = from.getBoundingClientRect();
		const pointer = event.type === "contextmenu" && (event.clientX > 0 || event.clientY > 0);
		openContextMenu({
			label: t("Actions for {name}", { name }),
			x: pointer ? event.clientX : box.left,
			y: pointer ? event.clientY : box.bottom + 4,
			items,
			opener: from,
		});
	}

	#newMenu(opener: HTMLElement): void {
		if (this.#busy || !this.#canWrite || !this.#client) return;
		const box = opener.getBoundingClientRect();
		openContextMenu({
			label: t("New"),
			x: box.left,
			y: box.bottom + 4,
			opener,
			items: [
				{ label: t("New folder"), icon: "folder", select: () => void this.#run(() => this.#newFolder()) },
				{ label: t("New text file"), icon: "file", select: () => void this.#run(() => this.#newFile()) },
				{ kind: "separator" },
				{ label: t("Upload files"), icon: "upload", select: () => this.#chooser.click() },
			],
		});
	}

	// ---- agents at work ---------------------------------------------------------

	/** The folder, the open file and the first rows: the most the cloud watches at once. */
	#observe(): void {
		if (!this.#observer) return;
		const paths = [this.#dir];
		if (this.#opened?.version) paths.push(this.#opened.path);
		for (const item of this.#sorted()) {
			if (paths.length >= PRESENCE_PATHS) break;
			if (!paths.includes(item.path)) paths.push(item.path);
		}
		this.#activity = undefined;
		try {
			this.#observer.select(paths);
		} catch {
			/* Lossy display only. */
		}
		this.#drawActivity();
	}

	/** Who is reading or writing at a path now, writers first. */
	#workers(path: string, subtree: boolean): { agent?: HostedStaffAgent; writing: boolean }[] {
		const view = this.#activity,
			now = Date.now();
		if (!view || view.state === "unavailable" || now - view.observedAt > 30000) return [];
		const row = view.paths.find((entry) => entry.path === path);
		const found = new Map<string, boolean>();
		for (const participant of row?.participants ?? []) {
			if (participant.expiresAt <= now) continue;
			if (participant.overlap === "ancestor_subtree") continue;
			if (participant.overlap === "within_subtree" && !subtree) continue;
			found.set(
				participant.staffAgentId,
				(found.get(participant.staffAgentId) ?? false) || participant.activity === "writing",
			);
		}
		const staff = this.#staff();
		return [...found]
			.map(([id, writing]) => ({ agent: staff.find((agent) => agent.id === id), writing }))
			.sort((a, b) => Number(b.writing) - Number(a.writing));
	}

	#figures(workers: { agent?: HostedStaffAgent }[]): HTMLElement {
		return h(
			"span",
			{ class: "files-figures" },
			...workers
				.slice(0, 3)
				.map((worker) =>
					agentFigure(worker.agent, t("An agent"), { size: 20, still: true, className: "files-figure" }),
				),
		);
	}

	#name(worker: { agent?: HostedStaffAgent }): string {
		return worker.agent?.displayName ?? t("An agent");
	}

	#key(workers: { agent?: HostedStaffAgent; writing: boolean }[]): string {
		return workers.map((worker) => `${worker.agent?.id}:${worker.writing}`).join();
	}

	#drawActivity(): void {
		if (this.#disposed) return;
		const here = this.#workers(this.#dir, true);
		const writing = here.some((worker) => worker.writing);
		// Redrawn only when who is at work changes, so figures and pulses run on undisturbed.
		const hereKey = `${this.#dir}|${this.#key(here)}`;
		if (this.#here.dataset.key !== hereKey) {
			this.#here.dataset.key = hereKey;
			replace(
				this.#here,
				here.length
					? [
							writing ? h("span", { class: "files-pulse", "aria-hidden": "true" }) : null,
							this.#figures(here),
							h(
								"span",
								null,
								here.length > 1
									? t("{count} agents are working in this folder", { count: here.length })
									: writing
										? t("{name} is writing in this folder", { name: this.#name(here[0]!) })
										: t("{name} is reading in this folder", { name: this.#name(here[0]!) }),
							),
						]
					: null,
			);
		}
		for (const slot of this.#list.querySelectorAll<HTMLElement>(".files-activity")) {
			const path = slot.dataset.path!;
			const item = this.#items.find((entry) => entry.path === path);
			const workers = this.#workers(path, item?.kind === "directory");
			const key = this.#key(workers);
			if (slot.dataset.key === key) continue;
			slot.dataset.key = key;
			const first = workers[0];
			replace(
				slot,
				first
					? [
							first.writing ? h("span", { class: "files-pulse", "aria-hidden": "true" }) : null,
							this.#figures(workers),
							h(
								"span",
								{ class: "files-activity-word" },
								first.writing
									? t("{name} is writing", { name: this.#name(first) })
									: t("{name} is reading", { name: this.#name(first) }),
							),
						]
					: null,
			);
		}
		const line = this.#preview.querySelector<HTMLElement>(".files-preview-activity");
		if (line && this.#opened) {
			const workers = this.#workers(this.#opened.path, false),
				first = workers[0];
			const key = this.#key(workers);
			if (line.dataset.key === key) return;
			line.dataset.key = key;
			replace(
				line,
				first
					? [
							first.writing ? h("span", { class: "files-pulse", "aria-hidden": "true" }) : null,
							this.#figures(workers),
							first.writing
								? t("{name} is writing this file", { name: this.#name(first) })
								: t("{name} is reading this file", { name: this.#name(first) }),
						]
					: null,
			);
		}
	}

	// ---- one file ---------------------------------------------------------------

	async #open(item: Item): Promise<void> {
		if (this.#opened?.path === item.path && !this.#editing) return;
		if (!this.#leave()) return;
		this.#close();
		const client = this.#client!,
			bytes = item.bytes ?? 0,
			type = IMAGE_TYPES[extension(item.path)];
		let opened: Opened | undefined;
		if (!type && bytes <= MAX_TEXT_BYTES && !BINARY.has(extension(item.path))) {
			try {
				const file = await client.read(item.path, this.#stop.signal);
				this.#live();
				if (file.kind === "directory") return this.#load(file.path);
				if (file.kind === "absent") {
					await this.#load(this.#dir);
					throw new Refusal(t("{name} is no longer in this folder.", { name: baseName(item.path) }));
				}
				opened = {
					path: file.path,
					version: file.version,
					bytes: textBytes(file.text),
					text: file.text,
					editable: !file.executable,
					...(file.executable ? { readOnly: t("This file is a program and can't be edited here.") } : {}),
				};
			} catch (error) {
				this.#live();
				if (!(error instanceof Error) || !/UTF-8/.test(error.message)) throw error;
			}
		}
		if (!opened) {
			opened = { path: item.path, version: item.version, bytes, editable: false };
			if (type ? bytes <= MAX_FILE_BYTES : bytes <= MAX_PREVIEW_TEXT_BYTES && !BINARY.has(extension(item.path))) {
				const file = await this.#fetch(item.path, item.version);
				if (type) opened.image = URL.createObjectURL(new Blob([Uint8Array.from(file)], { type }));
				else {
					const text = decodeText(file);
					if (text !== undefined) {
						opened.text = text;
						opened.readOnly = t("This file is too large to edit here.");
					}
				}
			}
		}
		this.#opened = opened;
		this.#editing = false;
		this.#draw();
		this.#observe();
	}

	/** Bytes at the listed version; a file that changed since is listed again. */
	async #fetch(path: string, version: string): Promise<Uint8Array> {
		try {
			const file = await this.#client!.download({ realm: "company_file", path, version }, this.#stop.signal);
			this.#live();
			return file.bytes;
		} catch (error) {
			this.#live();
			// The listed version is no longer the file's: list the folder again.
			if (
				!(error instanceof Error) ||
				!/^Selected Company File (version changed|is unavailable)$/.test(error.message)
			)
				throw error;
			await this.#load(this.#dir);
			throw new Refusal(t("{name} changed a moment ago. Open it again.", { name: baseName(path) }));
		}
	}

	async #download(path: string, version: string): Promise<void> {
		const bytes = await this.#fetch(path, version);
		this.#downloads!.offer(path, bytes);
		this.#say(t("Downloading {name}.", { name: baseName(path) }));
	}

	#close(): void {
		this.#forget(this.#opened);
		this.#opened = null;
		this.#editing = false;
		this.#draft = "";
		this.#dirty = false;
		this.#preview.hidden = true;
		this.#preview.replaceChildren();
		this.el.classList.remove("has-preview");
		for (const row of this.#list.querySelectorAll(".files-row.is-open")) row.classList.remove("is-open");
	}

	#forget(opened: Opened | null): void {
		if (opened?.image) URL.revokeObjectURL(opened.image);
	}

	#draw(): void {
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
		const closeButton = this.#iconButton("close", t("Close {name}", { name }), () => {
			if (this.#busy) return;
			try {
				if (!this.#leave()) return;
			} catch (error) {
				this.#problem(error);
				return;
			}
			this.#close();
			this.#observe();
		});
		let body: HTMLElement;
		const actions: HTMLElement[] = [];
		if (this.#editing) {
			const editor = h("textarea", {
				class: "files-editor",
				"aria-label": t("File content"),
				spellcheck: "false",
				// Locked while a save or its approval has an unknown outcome.
				disabled: Boolean(this.#pending || this.#approving),
			});
			editor.value = this.#pending?.operation === "write" ? this.#pending.text : this.#draft;
			const over = h("p", { class: "files-limit" });
			const save = button(this.#pending ? t("Retry save") : t("Save"), () => void this.#run(() => this.#save()), {
				primary: true,
			});
			const update = () => {
				const tooLong = textBytes(editor.value) > MAX_TEXT_BYTES;
				over.textContent = tooLong ? t("This is too long to save here. Keep it under 32 KB.") : "";
				save.disabled = tooLong && !this.#pending;
			};
			editor.addEventListener("input", () => {
				this.#draft = editor.value;
				this.#dirty = true;
				update();
			});
			update();
			body = h("div", { class: "files-edit" }, editor, over);
			// An approval with an unknown outcome is retried from the status line.
			if (!this.#approving)
				actions.push(
					save,
					button(t("Cancel"), () => {
						if (this.#busy || this.#pending) return;
						if (this.#dirty && !window.confirm(t("Discard this unsaved text?"))) return;
						this.#dirty = false;
						if (opened.version === null) {
							this.#close();
							this.#observe();
							return;
						}
						this.#editing = false;
						this.#draw();
					}),
				);
			queueMicrotask(() => {
				if (editor.isConnected && !editor.disabled && !this.#busy) editor.focus();
			});
		} else {
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
					h("small", null, fmtBytes(opened.bytes)),
				);
			if (opened.text !== undefined && opened.editable && !opened.readOnly && this.#canWrite)
				actions.push(
					button([icon("edit"), t("Edit")], () => {
						if (this.#busy) return;
						this.#draft = opened.text ?? "";
						this.#dirty = false;
						this.#editing = true;
						this.#draw();
					}),
				);
			if (opened.version !== null) {
				const version = opened.version;
				actions.push(
					button(
						[icon("download"), t("Download")],
						() => void this.#run(() => this.#download(opened.path, version)),
					),
				);
				if (this.#canDelete) {
					const remove = this.#iconButton(
						"trash",
						t("Delete {name}", { name }),
						() => void this.#run(() => this.#delete(opened.path, version)),
					);
					remove.classList.add("files-delete");
					actions.push(remove);
				}
			}
		}
		replace(
			this.#preview,
			h(
				"header",
				{ class: "files-preview-head" },
				h("h2", { title: opened.path }, name),
				opened.version === null ? h("span", { class: "files-new-badge" }, t("New")) : null,
				closeButton,
			),
			h("p", { class: "files-preview-activity" }),
			opened.readOnly && opened.text !== undefined ? h("p", { class: "files-note" }, opened.readOnly) : null,
			h("div", { class: "files-preview-body" }, body),
			h("div", { class: "files-preview-actions" }, ...actions),
		);
		this.#preview.setAttribute("aria-label", name);
		this.#preview.hidden = false;
		this.el.classList.add("has-preview");
		this.#drawActivity();
	}

	// ---- files shared from the Company Computer ----------------------------------

	/** What agents handed out from the Company Computer: downloads only, beside the list. */
	async #showShared(append = false): Promise<void> {
		if (!append) {
			if (!this.#leave()) return;
			this.#close();
			this.#shared = [];
		}
		const page = await this.#client!.exports.list(this.#stop.signal, append ? this.#sharedAfter : null);
		this.#live();
		this.#shared = [...this.#shared, ...page.items];
		this.#sharedAfter = page.nextAfter;
		const title = t("Shared from the Company Computer");
		const rows = this.#shared.map((asset) => {
			const name = baseName(asset.source.path);
			return h(
				"li",
				{ class: "files-row" },
				h(
					"span",
					{ class: "files-row-main files-shared-row", title: asset.source.path },
					h("span", { class: "files-kind is-file" }, icon("file")),
					h("span", { class: "files-name" }, name),
					h("span", { class: "files-size" }, fmtBytes(asset.bytes)),
				),
				h(
					"span",
					{ class: "files-row-actions is-shown" },
					this.#iconButton(
						"download",
						t("Download {name}", { name }),
						() => void this.#run(() => this.#downloadShared(asset)),
					),
				),
			);
		});
		replace(
			this.#preview,
			h(
				"header",
				{ class: "files-preview-head" },
				h("h2", null, title),
				this.#iconButton("close", t("Close {name}", { name: title }), () => {
					if (this.#busy) return;
					this.#close();
				}),
			),
			rows.length
				? h("ul", { class: "files-list files-shared" }, ...rows)
				: h("p", { class: "files-note" }, t("Nothing has been shared from the Company Computer yet.")),
			this.#sharedAfter
				? button(t("More files"), () => void this.#run(() => this.#showShared(true)), { small: true })
				: null,
		);
		this.#preview.setAttribute("aria-label", title);
		this.#preview.hidden = false;
		this.el.classList.add("has-preview");
	}

	async #downloadShared(asset: CompanyComputerFileExportAsset): Promise<void> {
		const file = await this.#client!.exports.download(
			{ realm: "object_storage", assetId: asset.assetId, sha256: asset.sha256 },
			this.#stop.signal,
		);
		this.#live();
		this.#downloads!.offer(asset.source.path, file.bytes);
		this.#say(t("Downloading {name}.", { name: baseName(asset.source.path) }));
	}

	// ---- changes ----------------------------------------------------------------

	/** A save, approval or upload whose outcome is unknown. */
	#unconfirmed(): boolean {
		return Boolean(this.#pending || this.#approving || this.#uploader?.uncertain);
	}

	/** No change starts while an earlier one is unconfirmed. */
	#settled(): void {
		if (this.#unconfirmed())
			throw new Refusal(t("The last change may not have been saved. Retry it before starting another."));
	}

	/** What a refused change means for the member. The cloud saved nothing and the
	 * same change can never apply, so the page lets go of it. */
	#refusal(error: unknown, path: string): Refusal | undefined {
		if (!(error instanceof CloudMemberCompanyRefusal)) return undefined;
		const name = baseName(path);
		if (error.status === 412)
			return new Refusal(t("{name} changed since it was opened, so nothing was saved.", { name }));
		if (error.status === 403) return new Refusal(t("You can't change {name}. Ask an owner or admin.", { name }));
		if (error.status === 401) return new Refusal(t("Sign in again, then try once more."));
		return new Refusal(t("The Company File did not accept this change to {name}.", { name }));
	}

	async #save(): Promise<void> {
		const opened = this.#opened;
		if (!this.#canWrite || !opened || !this.#editing) return;
		if (!this.#pending) {
			this.#settled();
			const text = this.#draft;
			if (text.includes("\0") || textBytes(text) > MAX_TEXT_BYTES)
				throw new Refusal(t("This is too long to save here. Keep it under 32 KB."));
			this.#pending = {
				operation: "write",
				operationKey: crypto.randomUUID(),
				path: opened.path,
				expectedVersion: opened.version,
				text,
			};
		}
		const pending = this.#pending;
		this.#draw();
		let result: CloudMemberCompanyCommand;
		try {
			result = await this.#client!.edit(pending, this.#stop.signal);
		} catch (error) {
			this.#live();
			const refusal = this.#refusal(error, opened.path);
			// Refused: the text stays in the editor for the member to keep or copy.
			if (refusal) this.#pending = null;
			this.#draw();
			throw refusal ?? error;
		}
		this.#live();
		this.#pending = null;
		let outcome: Outcome;
		try {
			outcome = await this.#settle(
				result,
				t("{name} is protected. Save your change anyway?", { name: baseName(opened.path) }),
				opened.path,
				"save",
			);
		} catch (error) {
			if (this.#opened === opened) this.#draw();
			throw error;
		}
		if (!outcome) {
			this.#draw();
			return;
		}
		await this.#finish(opened.path, outcome, "save");
	}

	async #delete(path: string, version: string): Promise<void> {
		if (!this.#canDelete) return;
		this.#settled();
		const name = baseName(path);
		if (this.#opened?.path === path && this.#dirty && !window.confirm(t("Discard this unsaved text?"))) return;
		if (
			!(await confirmDialog(
				t("Delete {name} from the Company File?", { name }),
				t("Delete"),
				true,
				undefined,
				this.#stop.signal,
			))
		)
			return;
		this.#live();
		let result: CloudMemberCompanyCommand;
		try {
			result = await this.#client!.edit(
				{ operation: "delete", operationKey: crypto.randomUUID(), path, expectedVersion: version },
				this.#stop.signal,
			);
		} catch (error) {
			this.#live();
			if (error instanceof CloudMemberCompanyRefusal && error.status === 412) {
				await this.#load(this.#dir);
				throw new Refusal(t("{name} changed a moment ago, so it was not deleted.", { name }));
			}
			throw this.#refusal(error, path) ?? error;
		}
		this.#live();
		// Deleting was confirmed just now; a protected delete needs no second question.
		const outcome = await this.#settle(result, null, path, "other");
		if (outcome) await this.#finish(path, outcome, "delete");
	}

	async #newFolder(): Promise<void> {
		if (!this.#canWrite) return;
		this.#settled();
		const name = await nameDialog({
			title: t("New folder"),
			label: t("Folder name"),
			confirm: t("Create"),
			maxLength: 255,
			signal: this.#stop.signal,
		});
		this.#live();
		if (!name) return;
		const path = await this.#vacant(name.normalize("NFC"));
		let result: CloudMemberCompanyCommand;
		try {
			result = await this.#client!.edit(
				{ operation: "mkdir", operationKey: crypto.randomUUID(), path, expectedVersion: null },
				this.#stop.signal,
			);
		} catch (error) {
			this.#live();
			throw this.#refusal(error, path) ?? error;
		}
		this.#live();
		const outcome = await this.#settle(result, t("Create the folder {name}?", { name }), path, "other");
		if (outcome) await this.#finish(path, outcome, "folder");
	}

	async #newFile(): Promise<void> {
		if (!this.#canWrite || !this.#leave()) return;
		const name = await nameDialog({
			title: t("New text file"),
			label: t("File name"),
			confirm: t("Create"),
			maxLength: 255,
			signal: this.#stop.signal,
		});
		this.#live();
		if (!name) return;
		const normal = name.normalize("NFC");
		const path = await this.#vacant(normal.includes(".") ? normal : `${normal}.md`);
		this.#close();
		this.#opened = { path, version: null, bytes: 0, text: "", editable: true };
		this.#draft = "";
		this.#dirty = false;
		this.#editing = true;
		this.#draw();
		this.#observe();
	}

	/** The path for a new name in this folder, refused when it is taken or not a name. */
	async #vacant(name: string): Promise<string> {
		const path = this.#child(name);
		const target = await this.#client!.describe(path, this.#stop.signal);
		this.#live();
		if (target.entry) throw new Refusal(t("{name} already exists in this folder.", { name }));
		return path;
	}

	#child(name: string): string {
		const path = this.#dir ? `${this.#dir}/${name}` : name;
		if (/[/\\]/.test(name) || name === "." || name === "..") throw new Refusal(t("Use a name without slashes."));
		try {
			return parseCloudCompanyPath(path);
		} catch {
			throw new Refusal(t("{name} can't be used as a name here.", { name }));
		}
	}

	/** Uploads each file into the open folder. A file that cannot go is skipped
	 * and named at the end; an upload with an unknown outcome stops the rest. */
	async #upload(files: File[]): Promise<void> {
		if (!this.#canWrite) return;
		this.#settled();
		const uploader = this.#uploader!;
		const uploaded: string[] = [],
			skipped: string[] = [];
		let approved = false;
		for (const [index, picked] of files.entries()) {
			// macOS hands names over decomposed; the Company File keeps them composed.
			const name = picked.name.normalize("NFC");
			const file = name === picked.name ? picked : new File([picked], name, { type: picked.type });
			try {
				if (file.size > MAX_FILE_BYTES)
					throw new Refusal(t("{name} is larger than 8 MB and was not uploaded.", { name }));
				const path = this.#child(name);
				await uploader.select(file);
				this.#live();
				const target = await this.#client!.describe(path, this.#stop.signal);
				this.#live();
				if (target.entry?.kind === "directory" || (target.entry?.kind === "file" && target.entry.executable)) {
					uploader.clearSelection();
					throw new Refusal(t("{name} can't be replaced from here.", { name }));
				}
				if (
					target.entry &&
					!(await confirmDialog(
						t("Replace {name} in this folder?", { name }),
						t("Replace"),
						false,
						undefined,
						this.#stop.signal,
					))
				) {
					this.#live();
					uploader.clearSelection();
					continue;
				}
				this.#live();
				this.#uploading = { path, expectedVersion: target.version, name };
				const outcome = await this.#sendUpload();
				if (outcome) uploaded.push(name);
				if (outcome === "approved") approved = true;
			} catch (error) {
				this.#live();
				if (error instanceof Refusal && !uploader.uncertain && !this.#approving) {
					if (uploader.selected) uploader.clearSelection();
					skipped.push(name);
					continue;
				}
				const rest = files.slice(index + 1).map((item) => item.name.normalize("NFC"));
				await this.#load(this.#dir).catch(() => undefined);
				if (rest.length === 0) throw error;
				throw new Refusal(
					`${error instanceof Refusal ? error.message : t("The operation could not be confirmed. Check the current state before retrying.")} ${t("Not sent yet: {names}.", { names: rest.join(", ") })}`,
				);
			}
		}
		await this.#load(this.#dir);
		const lines = [
			uploaded.length === 1
				? t("Uploaded {name}.", { name: uploaded[0]! })
				: uploaded.length > 1
					? t("Uploaded {count} files.", { count: uploaded.length })
					: "",
			approved ? t("The change is approved and will apply shortly.") : "",
			skipped.length ? t("Not uploaded: {names}.", { names: skipped.join(", ") }) : "",
		];
		this.#say(lines.filter(Boolean).join(" "));
	}

	async #retryUpload(): Promise<void> {
		if (!this.#uploading || !this.#uploader?.uncertain) return;
		const name = this.#uploading.name;
		const outcome = await this.#sendUpload();
		await this.#load(this.#dir);
		if (outcome)
			this.#say(
				outcome === "applied"
					? t("Uploaded {name}.", { name })
					: t("The change is approved and will apply shortly."),
			);
	}

	async #sendUpload(): Promise<Outcome> {
		const target = this.#uploading!;
		let result: Awaited<ReturnType<WebFileUpload["submit"]>>;
		try {
			result = await this.#uploader!.submit(target.path, target.expectedVersion);
		} catch (error) {
			this.#live();
			const refusal = this.#refusal(error, target.path);
			if (refusal) this.#uploading = null;
			throw refusal ?? error;
		}
		this.#live();
		this.#uploading = null;
		return this.#settle(
			result.command,
			t("{name} goes to a protected place. Upload it anyway?", { name: target.name }),
			target.path,
			"other",
		);
	}

	/** Takes a change to its end. A protected change asks once (or not at all
	 * when the member just confirmed it) and is withdrawn when declined. */
	async #settle(command: Settled, question: string | null, path: string, kind: "save" | "other"): Promise<Outcome> {
		if (command.state === "applied") return "applied";
		if (command.state === "approved" || command.state === "ready") return "approved";
		if (command.state !== "review_required" || !("commandId" in command)) {
			this.#say(t("The change was not accepted."));
			return false;
		}
		const apply =
			question === null || (await confirmDialog(question, t("Apply change"), false, undefined, this.#stop.signal));
		this.#live();
		if (!apply) {
			await this.#client!.review(command, "skip", this.#stop.signal);
			this.#live();
			this.#say(t("Nothing was changed."));
			return false;
		}
		return this.#approve(command, path, kind);
	}

	/** Approves one reviewed change. An approval with an unknown outcome is kept
	 * and retried on the same change, never replaced by a new one. */
	async #approve(command: CloudMemberCompanyCommand, path: string, kind: "save" | "other"): Promise<Outcome> {
		this.#approving = { command, path, kind };
		let result: Settled;
		try {
			result = await this.#client!.review(command, "approve", this.#stop.signal);
		} catch (error) {
			this.#live();
			const refusal = this.#refusal(error, path);
			if (refusal) this.#approving = null;
			throw refusal ?? error;
		}
		this.#live();
		this.#approving = null;
		if (result.state === "applied") return "applied";
		if (result.state === "approved" || result.state === "ready") return "approved";
		this.#say(t("The change was not accepted."));
		return false;
	}

	async #retryApproval(): Promise<void> {
		const approving = this.#approving;
		if (!approving) return;
		const outcome = await this.#approve(approving.command, approving.path, approving.kind);
		if (outcome) await this.#finish(approving.path, outcome, approving.kind === "save" ? "save" : "change");
		else if (this.#opened?.path === approving.path) this.#draw();
	}

	/** After a change went through: the folder is read again and the member told. */
	async #finish(
		path: string,
		outcome: "applied" | "approved",
		kind: "save" | "delete" | "folder" | "change",
	): Promise<void> {
		const name = baseName(path);
		if (kind !== "folder") {
			this.#dirty = false;
			if (this.#opened?.path === path || kind === "save") this.#close();
		}
		await this.#load(this.#dir);
		if (kind === "save") {
			const item = this.#items.find((entry) => entry.path === path);
			if (item) await this.#open(item);
		}
		if (kind === "folder")
			[...this.#list.querySelectorAll<HTMLElement>(".files-row-main")]
				.find((row) => row.dataset.path === path)
				?.focus();
		this.#say(
			outcome === "approved"
				? t("The change is approved and will apply shortly.")
				: kind === "save"
					? t("Saved {name}.", { name })
					: kind === "delete"
						? t("Deleted {name}.", { name })
						: kind === "folder"
							? t("Created {name}.", { name })
							: t("Applied the change to {name}.", { name }),
		);
	}

	// ---- dropping files ---------------------------------------------------------

	/** Picked or dropped files upload at once, or are refused aloud while something else runs. */
	#uploadWhenFree(files: File[]): void {
		if (!this.#uploader) return;
		if (this.#busy) {
			this.#say(t("Wait for the current step to finish, then add the files again."));
			return;
		}
		void this.#run(() => this.#upload(files));
	}

	#listenForDrops(signal: AbortSignal): void {
		const carriesFiles = (event: DragEvent) => [...(event.dataTransfer?.types ?? [])].includes("Files");
		this.el.addEventListener(
			"dragenter",
			(event) => {
				if (!carriesFiles(event) || !this.#uploader) return;
				event.preventDefault();
				this.#dragDepth++;
				replace(
					this.#drop,
					h(
						"div",
						{ class: "files-drop-card" },
						icon("upload"),
						h(
							"span",
							null,
							t("Drop to upload to {folder}", { folder: this.#dir ? baseName(this.#dir) : t("Company") }),
						),
					),
				);
				this.el.classList.add("is-dropping");
			},
			{ signal },
		);
		this.el.addEventListener(
			"dragover",
			(event) => {
				if (!carriesFiles(event) || !this.#uploader) return;
				event.preventDefault();
				if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
			},
			{ signal },
		);
		this.el.addEventListener(
			"dragleave",
			() => {
				this.#dragDepth = Math.max(0, this.#dragDepth - 1);
				if (this.#dragDepth === 0) this.el.classList.remove("is-dropping");
			},
			{ signal },
		);
		this.el.addEventListener(
			"drop",
			(event) => {
				if (!carriesFiles(event)) return;
				event.preventDefault();
				this.#dragDepth = 0;
				this.el.classList.remove("is-dropping");
				const files = [...(event.dataTransfer?.files ?? [])];
				if (files.length) this.#uploadWhenFree(files);
			},
			{ signal },
		);
	}
}
