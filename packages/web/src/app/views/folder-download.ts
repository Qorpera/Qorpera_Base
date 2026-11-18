import {
	CLOUD_MEMBER_FOLDER_PAGE,
	type CloudMemberFolderClient,
	type CloudMemberFolderEntry,
	type CloudMemberFolderFile,
} from "@qorpera/cloud-client/cloud-member-folder";
import { button, fmtBytes, h, icon, replace } from "../../ui/dom.ts";
import { presentationLocale, t } from "../../ui/preferences.ts";
import { StoredZip, storedZipBytes, zipEntryBytes } from "./folder-zip.ts";

type Folder = Pick<CloudMemberFolderClient, "list" | "readFilePieces">;

export interface FolderDownloadHost {
	readonly signal: AbortSignal;
	live(): void;
	folder(): Folder;
	shown(path: string): boolean;
	offer(name: string, pieces: readonly Blob[], bytes: number): void;
	menu(): HTMLElement | null;
	busy(): boolean;
	changed(): void;
}

export const FOLDER_DOWNLOAD_MAX_BYTES = 256 * 1024 * 1024;
export const FOLDER_DOWNLOAD_MAX_FILES = 2000;
export const FOLDER_DOWNLOAD_MAX_LISTINGS = 400;

const PROJECT_INTERNALS = new Set(["repo.git", "worktrees", "downloads"]);

export function projectInternal(path: string): boolean {
	const [top, owner, name, part, below] = path.split("/");
	return (
		top === "code" && !!owner && !!name && part !== undefined && PROJECT_INTERNALS.has(part) && below === undefined
	);
}

export function zipSegment(name: string): string {
	const safe = name.replace(/[\u0000-\u001f\u007f\\/]/gu, "_");
	return safe === "." || safe === ".." ? "_" : safe;
}

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"];

export function sizeBeside(bytes: number, limit: number): string {
	const size = fmtBytes(bytes);
	if (size !== fmtBytes(limit) || bytes <= limit) return size;
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
		value /= 1024;
		unit++;
	}
	const digits = value >= 100 ? 1 : 2;
	const scale = 10 ** digits;
	return `${(Math.ceil(value * scale) / scale).toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

type Item =
	| { readonly kind: "folder"; readonly name: string; readonly modified: Date }
	| {
			readonly kind: "file";
			readonly name: string;
			readonly path: string;
			readonly modified: Date;
			readonly file: CloudMemberFolderFile;
	  };

interface Walk {
	readonly items: Item[];
	files: number;
	fileBytes: number;
	zipBytes: number;
	links: number;
	listings: number;
	complete: boolean;
}

export class FolderDownload {
	readonly button: HTMLButtonElement;
	readonly line = h("div", { class: "storage-download-line", role: "status" });
	readonly #host: FolderDownloadHost;
	#dir = "";
	#name = "";
	#job: AbortController | null = null;
	#ended: string | null = null;

	constructor(host: FolderDownloadHost) {
		this.#host = host;
		this.button = h(
			"button",
			{
				type: "button",
				class: "storage-download-button",
				title: t("Download this folder"),
				"aria-label": t("Download this folder"),
				onclick: () => this.start(),
			},
			icon("download"),
			h("span", null, t("Download")),
		);
	}

	get running(): boolean {
		return this.#job !== null;
	}

	start(): void {
		void this.#download(this.#dir, this.#name);
	}

	redraw(): void {
		this.button.hidden = this.#host.menu() !== null;
		if (this.#job || this.#host.busy()) this.button.setAttribute("aria-disabled", "true");
		else this.button.removeAttribute("aria-disabled");
		if (this.#job) this.button.setAttribute("aria-busy", "true");
		else this.button.removeAttribute("aria-busy");
	}

	enter(dir: string, name: string): void {
		if (dir !== this.#dir) this.#ended = null;
		this.#dir = dir;
		this.#name = name;
		this.#draw();
	}

	#draw(): void {
		this.redraw();
		if (!this.#job) replace(this.line, this.#ended ? h("span", null, this.#ended) : null);
	}

	#working(words: string): (part: number) => void {
		const percent = h("span", { class: "storage-download-percent", "aria-hidden": "true" });
		replace(
			this.line,
			h("span", { class: "spinner-dot", "aria-hidden": "true" }),
			h("span", null, words),
			percent,
			button(t("Cancel"), () => this.#job?.abort(), { small: true }),
		);
		return (part) => {
			percent.textContent = t("{percent}%", { percent: Math.floor(part * 100) });
		};
	}

	async #download(dir: string, name: string): Promise<void> {
		if (this.#job || this.#host.busy() || this.#host.signal.aborted) return;
		const job = new AbortController();
		this.#job = job;
		this.#ended = null;
		this.#draw();
		this.#host.changed();
		const signal = AbortSignal.any([this.#host.signal, job.signal]);
		const inLine = () => this.line.contains(document.activeElement);
		let ending: string | null = null;
		try {
			ending = await this.#make(dir, name, signal);
		} catch {
			if (!signal.aborted) ending = t("{name} could not be read just now. Try again.", { name });
		}
		const focused = inLine();
		this.#job = null;
		if (this.#host.signal.aborted) return;
		this.#ended = ending;
		this.#draw();
		this.#host.changed();
		if (focused && !inLine()) (this.#host.menu() ?? this.button).focus();
	}

	async #make(dir: string, name: string, signal: AbortSignal): Promise<string> {
		this.#working(t("Getting {name} ready…", { name }));
		const top = zipSegment(name) || t("Folder");
		const walk = await this.#walk(dir, top, signal);
		const refusal = this.#refusal(name, walk);
		if (refusal) return refusal;
		const far = this.#working(t("Downloading {name}…", { name }));
		const zip = new StoredZip();
		const folder = this.#host.folder();
		let read = 0;
		for (const item of walk.items) {
			if (item.kind === "folder") {
				zip.folder(item.name, item.modified);
				continue;
			}
			const entry = zip.file(item.name, item.modified, item.file.executable);
			try {
				await folder.readFilePieces(item.file, signal, (piece) => {
					entry.add(piece);
					read += piece.byteLength;
					if (walk.fileBytes > 0) far(read / walk.fileBytes);
				});
			} catch (error) {
				if (signal.aborted) throw error;
				return t("{path} could not be read, so nothing was downloaded. Try again.", {
					path: item.path.slice(dir ? dir.length + 1 : 0),
				});
			}
			entry.end();
			this.#host.live();
		}
		const made = zip.finish();
		const file = `${top}.zip`;
		this.#host.live();
		signal.throwIfAborted();
		this.#host.offer(file, made.parts, made.bytes);
		const ready = t("{name} is ready: your browser saves it in your downloads.", { name: file });
		return walk.links ? `${ready} ${t("The folder's links are not in it.")}` : ready;
	}

	#refusal(name: string, walk: Walk): string | null {
		const locale = presentationLocale();
		const size = fmtBytes(walk.zipBytes);
		if (walk.files > FOLDER_DOWNLOAD_MAX_FILES) {
			const words = {
				name,
				size,
				count: walk.files.toLocaleString(locale),
				files: FOLDER_DOWNLOAD_MAX_FILES.toLocaleString(locale),
			};
			return walk.complete
				? t("{name} has {count} files ({size}), more than a download here can hold ({files} files).", words)
				: t(
						"{name} has over {count} files (over {size}), more than a download here can hold ({files} files).",
						words,
					);
		}
		if (walk.zipBytes > FOLDER_DOWNLOAD_MAX_BYTES) {
			const words = {
				name,
				size: sizeBeside(walk.zipBytes, FOLDER_DOWNLOAD_MAX_BYTES),
				limit: fmtBytes(FOLDER_DOWNLOAD_MAX_BYTES),
			};
			return walk.complete
				? t("{name} is {size}, more than a download here can hold ({limit}).", words)
				: t("{name} is over {size}, more than a download here can hold ({limit}).", words);
		}
		if (!walk.complete)
			return t("{name} has more than {count} folders, more than a download here can go through.", {
				name,
				count: FOLDER_DOWNLOAD_MAX_LISTINGS.toLocaleString(locale),
			});
		return null;
	}

	async #walk(root: string, top: string, signal: AbortSignal): Promise<Walk> {
		const folder = this.#host.folder();
		const walk: Walk = {
			items: [{ kind: "folder", name: top, modified: new Date() }],
			files: 0,
			fileBytes: 0,
			zipBytes: storedZipBytes([{ name: `${top}/`, bytes: 0 }]),
			links: 0,
			listings: 0,
			complete: false,
		};
		const waiting = [{ path: root, name: top }];
		for (let next = waiting.shift(); next; next = waiting.shift()) {
			let after: string | null = null;
			do {
				if (walk.listings === FOLDER_DOWNLOAD_MAX_LISTINGS) return walk;
				walk.listings++;
				const page = await folder.list(next.path || null, after, CLOUD_MEMBER_FOLDER_PAGE, signal);
				this.#host.live();
				for (const entry of page.entries) {
					const child = this.#take(walk, entry, next.name);
					if (child) waiting.push(child);
				}
				after = page.next;
			} while (after !== null);
		}
		walk.complete = true;
		return walk;
	}

	#take(walk: Walk, entry: CloudMemberFolderEntry, parent: string): { path: string; name: string } | null {
		if (!this.#host.shown(entry.path) || projectInternal(entry.path)) return null;
		if (entry.kind === "symlink") {
			walk.links++;
			return null;
		}
		const name = `${parent}/${zipSegment(entry.path.slice(entry.path.lastIndexOf("/") + 1))}`;
		const modified = new Date(entry.updatedAt);
		const keep = walk.files <= FOLDER_DOWNLOAD_MAX_FILES && walk.zipBytes <= FOLDER_DOWNLOAD_MAX_BYTES;
		if (entry.kind === "folder") {
			walk.zipBytes += zipEntryBytes({ name: `${name}/`, bytes: 0 });
			if (keep) walk.items.push({ kind: "folder", name, modified });
			return { path: entry.path, name };
		}
		if (!entry.file) return null;
		walk.files++;
		walk.fileBytes += entry.file.bytes;
		walk.zipBytes += zipEntryBytes({ name, bytes: entry.file.bytes });
		if (keep) walk.items.push({ kind: "file", name, path: entry.path, modified, file: entry.file });
		return null;
	}
}
