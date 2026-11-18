import {
	PROGRAM_FILE,
	PROGRAM_FILE_MAX_BYTES,
	PROGRAM_KINDS,
	type Program,
	type ProgramKeptForm,
	type ProgramKind,
	type ProgramVersion,
	parseProgram,
	programFilePath,
} from "@qorpera/cloud-client/app-program";
import type { CloudMemberFolderClient } from "@qorpera/cloud-client/cloud-member-folder";
import type { AppManifest } from "@qorpera/cloud-client/interface-apps";
import { WebFileDownloads } from "../../../../member-web/src/files.ts";
import { type MenuEntry, openContextMenu } from "../../ui/context-menu.ts";
import { fmtBytes, h, icon, replace } from "../../ui/dom.ts";
import { interfaceEmblem } from "../../ui/interface-emblem.ts";
import { presentationDay, t, timeZoneOption } from "../../ui/preferences.ts";
import { uiScale } from "../../ui/scale.ts";
import { dayLabel } from "../agent-line.ts";
import { folderImageReader, forgetPictureUrl, pictureUrl } from "../folder-images.ts";
import { downloadOffer, isPhoneSystem, memberSystem, PROGRAM_KIND_NAMES } from "../program-download.ts";
import { MAX_DOWNLOAD_BYTES } from "./company-folder.ts";

export type ProgramFolder = Pick<CloudMemberFolderClient, "read" | "readFile"> &
	Partial<Pick<CloudMemberFolderClient, "readFilePieces">>;

export interface ProgramPageHost {
	readonly folder: () => ProgramFolder;
	readonly current?: () => void;
	readonly system?: ProgramKind | null;
}

export interface ProgramApp {
	readonly name: string;
	readonly path: string;
	readonly manifest: AppManifest;
}

const TEXT = new TextDecoder("utf-8", { fatal: true });
const PHONE_SCREEN = 540 / 1170;
const DESKTOP_SCREEN = 380 / 600;
const FIT_MAX = 640;
const FIT_NARROW = 470;
const TILE_MAX = 420;

export async function readProgram(
	folder: ProgramFolder,
	appPath: string,
	signal: AbortSignal,
): Promise<
	| { readonly ok: true; readonly program: Program; readonly key: string }
	| { readonly ok: false; readonly message: string }
> {
	const entry = (await folder.read(`${appPath}/${PROGRAM_FILE}`, signal)).entry;
	if (!entry) return { ok: false, message: t("This program has no version yet.") };
	const unread = { ok: false as const, message: t("This program's program.json can't be read.") };
	if (entry.kind !== "file" || !entry.file || entry.file.bytes > PROGRAM_FILE_MAX_BYTES) return unread;
	let text: string;
	try {
		text = TEXT.decode(await folder.readFile(entry.file, signal, PROGRAM_FILE_MAX_BYTES, { cached: true }));
	} catch (error) {
		if (signal.aborted) throw error;
		return unread;
	}
	const program = parseProgram(text);
	return program ? { ok: true, program, key: entry.version } : unread;
}

const versionDay = (version: ProgramVersion) =>
	dayLabel(presentationDay(new Date(version.date), timeZoneOption().timeZone));

export class ProgramPage {
	readonly el: HTMLElement;
	readonly key: string;
	readonly #host: ProgramPageHost;
	readonly #app: ProgramApp;
	readonly #program: Program;
	readonly #system: ProgramKind | null;
	readonly #lifetime = new AbortController();
	readonly #state = h("p", { class: "program-state" });
	readonly #more: HTMLButtonElement;
	readonly #stage = h("div", { class: "program-stage" });
	readonly #thing = h("div", { class: "program-thing" }, this.#stage);
	readonly #get = h("div", { class: "program-get" });
	readonly #kinds = h("div", { class: "program-kinds" });
	readonly #back = h("p", { class: "program-back" });
	readonly #urls: string[] = [];
	readonly #ratios: { phone: number; desktop: number } = { phone: PHONE_SCREEN, desktop: DESKTOP_SCREEN };
	#shown: ProgramVersion;
	#downloads: WebFileDownloads | undefined;
	#busy = false;
	#said: HTMLElement | null = null;

	constructor(host: ProgramPageHost, app: ProgramApp, program: Program, key: string) {
		this.#host = host;
		this.#app = app;
		this.#program = program;
		this.key = key;
		this.#system = host.system !== undefined ? host.system : memberSystem(navigator);
		this.#shown = program.versions[0] as ProgramVersion;
		this.#more = h(
			"button",
			{
				type: "button",
				class: "program-more",
				title: t("More options for {name}", { name: app.manifest.name }),
				"aria-label": t("More options for {name}", { name: app.manifest.name }),
				"aria-haspopup": "menu",
				onclick: () => this.#openMenu(),
			},
			icon("more"),
		);
		this.el = h(
			"div",
			{ class: "program-page" },
			h(
				"header",
				{ class: "program-head" },
				h("h1", { class: "program-name" }, app.manifest.name),
				this.#state,
				this.#more,
			),
			h("div", { class: "program-field" }, this.#thing, this.#get, this.#kinds, this.#back),
		);
		this.#drawPictures();
		this.#draw();
		const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => this.#fit()) : undefined;
		observer?.observe(this.#thing);
		this.#lifetime.signal.addEventListener("abort", () => observer?.disconnect(), { once: true });
	}

	get busy(): boolean {
		return this.#busy;
	}

	get shown(): string {
		return this.#shown.version;
	}

	show(version: string): void {
		const found = this.#program.versions.find((each) => each.version === version);
		if (!found || this.#busy) return;
		this.#shown = found;
		this.#said = null;
		this.#draw();
	}

	dispose(): void {
		this.#lifetime.abort();
		this.#downloads?.close();
		for (const url of this.#urls.splice(0)) forgetPictureUrl(url);
		this.el.remove();
	}

	#draw(): void {
		const shown = this.#shown;
		const newest = this.#program.versions[0] as ProgramVersion;
		replace(
			this.#state,
			h("span", { class: "program-dot", "aria-hidden": "true" }),
			t("Version {version} · {day}", { version: shown.version, day: versionDay(shown) }),
		);
		const offer = downloadOffer(shown.forms, this.#system);
		if (!this.#program.screens.phone && !this.#program.screens.desktop) this.#drawTile(offer?.form ?? null);
		const phone = isPhoneSystem(this.#system);
		const own = offer?.own === true;
		const label = !offer
			? t("Download")
			: offer.install
				? t("Install")
				: own
					? t("Download")
					: t("Download for {kind}", { kind: PROGRAM_KIND_NAMES[offer.form.for] });
		const large = offer !== null && offer.form.bytes > MAX_DOWNLOAD_BYTES;
		const button = h(
			"button",
			{
				type: "button",
				class: "program-download",
				disabled: !offer || large || this.#busy,
				onclick: () => {
					if (offer) void this.#download(offer.form, shown.version, button);
				},
			},
			label,
		);
		const note = large
			? t("{size}: too large to download here.", { size: fmtBytes(offer.form.bytes) })
			: own
				? phone
					? t("For this phone")
					: t("For this computer")
				: offer && this.#system
					? t("Not made for {kind} yet", { kind: PROGRAM_KIND_NAMES[this.#system] })
					: null;
		replace(
			this.#get,
			button,
			this.#said ?? (note ? h("p", { class: "program-note" }, note) : h("p", { class: "program-note" })),
		);
		replace(
			this.#kinds,
			PROGRAM_KINDS.map((kind) => {
				const form = shown.forms.find((each) => each.for === kind);
				const name = PROGRAM_KIND_NAMES[kind];
				return form
					? h(
							"button",
							{
								type: "button",
								class: "program-kind is-made",
								title: t("Download {kind}", { kind: name }),
								"data-kind": kind,
								disabled: this.#busy || form.bytes > MAX_DOWNLOAD_BYTES,
								onclick: () => void this.#download(form, shown.version, button),
							},
							h("span", { class: "program-kind-dot", "aria-hidden": "true" }),
							name,
						)
					: h(
							"span",
							{ class: "program-kind", title: t("Not made for {kind} yet", { kind: name }), "data-kind": kind },
							name,
						);
			}),
		);
		replace(
			this.#back,
			shown === newest
				? null
				: h(
						"button",
						{ type: "button", class: "program-back-button", onclick: () => this.show(newest.version) },
						t("Back to the newest, {version}", { version: newest.version }),
					),
		);
		this.#back.hidden = shown === newest;
	}

	#drawPictures(): void {
		const { phone, desktop } = this.#program.screens;
		if (!phone && !desktop) return;
		const name = this.#app.manifest.name;
		const read = folderImageReader(this.#host.folder);
		const picture = (path: string, which: "phone" | "desktop", alt: string) => {
			const img = h("img", { alt, draggable: "false" });
			void read(`${this.#app.path}/${path}`, this.#lifetime.signal)
				.then(async (blob) => {
					if (!blob || this.#lifetime.signal.aborted) return;
					const url = await pictureUrl(blob);
					if (this.#lifetime.signal.aborted) return forgetPictureUrl(url);
					this.#urls.push(url);
					img.addEventListener(
						"load",
						() => {
							const ratio = img.naturalWidth / img.naturalHeight;
							if (Number.isFinite(ratio) && ratio > 0)
								this.#ratios[which] =
									which === "phone"
										? Math.min(0.62, Math.max(0.4, ratio))
										: Math.min(1.9, Math.max(0.55, ratio));
							this.#fit();
						},
						{ once: true },
					);
					img.src = url;
				})
				.catch(() => {});
			return img;
		};
		this.#stage.classList.toggle("has-phone", Boolean(phone));
		this.#stage.classList.toggle("has-desktop", Boolean(desktop));
		replace(
			this.#stage,
			desktop
				? h(
						"div",
						{ class: "program-window" },
						h("div", { class: "program-window-bar" }, h("span", null, name)),
						h(
							"div",
							{ class: "program-window-glass" },
							picture(desktop, "desktop", t("{name} on a computer", { name })),
						),
					)
				: null,
			phone
				? h(
						"div",
						{ class: "program-phone" },
						h("div", { class: "program-screen" }, picture(phone, "phone", t("{name} on a phone", { name }))),
					)
				: null,
		);
	}

	#drawTile(form: ProgramKeptForm | null): void {
		const manifest = this.#app.manifest;
		const mark =
			manifest.emblem === "page"
				? h("span", { class: "program-tile-initial" }, [...manifest.name.trim()][0]?.toUpperCase() ?? "?")
				: interfaceEmblem(manifest.emblem, 120);
		this.#stage.classList.add("is-tile");
		replace(
			this.#stage,
			h(
				"div",
				{ class: "program-tile" },
				h("span", { class: "program-tile-mark", "aria-hidden": "true" }, mark),
				form
					? h(
							"span",
							{ class: "program-tile-file" },
							h("strong", null, form.file),
							h("small", null, fmtBytes(form.bytes)),
						)
					: null,
			),
		);
		this.#fit();
	}

	#fit(): void {
		const box = this.#thing.getBoundingClientRect();
		if (box.width === 0) return;
		const scale = uiScale();
		const narrow = window.matchMedia?.(`(max-width: ${700 * scale}px)`).matches === true;
		const height = narrow ? Number.POSITIVE_INFINITY : box.height;
		const width = box.width;
		const set = (element: Element | null, styles: Record<string, string>) => {
			if (element instanceof HTMLElement) Object.assign(element.style, styles);
		};
		if (this.#stage.classList.contains("is-tile")) {
			const side = Math.floor(
				Math.min(width, height, TILE_MAX * scale, narrow ? width * 0.86 : Number.POSITIVE_INFINITY),
			);
			set(this.#stage, { width: `${side}px`, height: `${side}px` });
			return;
		}
		const phone = this.#stage.querySelector(".program-phone");
		const desktop = this.#stage.querySelector(".program-window");
		const bar =
			(desktop?.querySelector(".program-window-bar") as HTMLElement | null)?.getBoundingClientRect().height ?? 0;
		const most = (narrow ? FIT_NARROW : FIT_MAX) * scale;
		const phoneWidth = (size: number) => {
			const bezel = Math.max(6, Math.round(size * 0.018));
			return { bezel, width: Math.round((size - 2 * bezel) * this.#ratios.phone) + 2 * bezel };
		};
		if (phone && desktop) {
			const across = (size: number) => {
				const own = phoneWidth(size).width;
				const glass = size * 0.8 - bar;
				return { phone: own, window: Math.round(Math.max(own * 1.04, glass * this.#ratios.desktop)), glass };
			};
			const unit = across(100);
			const size = Math.floor(
				Math.min(most, height / 1.06, (width / ((unit.window + unit.phone * 0.8) / 100)) * 0.98),
			);
			const parts = across(size);
			const fitted = phoneWidth(size);
			const radius = Math.round(fitted.width * 0.15);
			set(phone, { width: `${fitted.width}px`, height: `${size}px`, borderRadius: `${radius}px` });
			set(phone.querySelector(".program-screen"), {
				inset: `${fitted.bezel}px`,
				borderRadius: `${radius - fitted.bezel}px`,
			});
			set(desktop, { width: `${parts.window}px`, height: `${Math.round(parts.glass + bar)}px` });
			set(this.#stage, {
				width: `${Math.round(parts.window + fitted.width * 0.8)}px`,
				height: `${Math.round(size * 1.06)}px`,
			});
			return;
		}
		if (phone) {
			const size = Math.floor(Math.min(most, height, width / (this.#ratios.phone * 1.02)));
			const fitted = phoneWidth(size);
			const radius = Math.round(fitted.width * 0.15);
			set(phone, { width: `${fitted.width}px`, height: `${size}px`, borderRadius: `${radius}px` });
			set(phone.querySelector(".program-screen"), {
				inset: `${fitted.bezel}px`,
				borderRadius: `${radius - fitted.bezel}px`,
			});
			set(this.#stage, { width: `${fitted.width}px`, height: `${size}px` });
			return;
		}
		if (desktop) {
			const ratio = this.#ratios.desktop;
			const glass = Math.floor(Math.min(most - bar, height - bar, width / ratio));
			set(desktop, { width: `${Math.round(glass * ratio)}px`, height: `${glass + bar}px` });
			set(this.#stage, { width: `${Math.round(glass * ratio)}px`, height: `${glass + bar}px` });
		}
	}

	#openMenu(): void {
		const earlier = this.#program.versions.slice(1);
		const items: MenuEntry[] = [
			{ kind: "caption", label: t("Earlier versions") },
			...(earlier.length === 0
				? [{ label: t("None yet"), disabled: true, select: () => {} }]
				: earlier.map((version) => ({
						label: `${version.version} · ${versionDay(version)}`,
						checked: version === this.#shown,
						select: () => this.show(version.version),
					}))),
		];
		const box = this.#more.getBoundingClientRect();
		openContextMenu({
			label: t("More options for {name}", { name: this.#app.manifest.name }),
			x: box.right - 4 * uiScale(),
			y: box.bottom + 4 * uiScale(),
			items,
			opener: this.#more,
		});
	}

	async #download(form: ProgramKeptForm, version: string, button: HTMLButtonElement): Promise<void> {
		if (this.#busy) return;
		this.#busy = true;
		this.#said = null;
		this.#draw();
		const say = (text: string) => {
			this.#said = h("p", { class: "program-note is-said", role: "status" }, text);
		};
		const signal = this.#lifetime.signal;
		const progress = this.#get.querySelector<HTMLButtonElement>(".program-download") ?? button;
		const note = this.#get.querySelector<HTMLElement>(".program-note");
		if (note) {
			note.textContent = t("Getting {name}…", { name: form.file });
			note.setAttribute("role", "status");
		}
		try {
			const folder = this.#host.folder();
			const entry = (await folder.read(`${this.#app.path}/${programFilePath(version, form.file)}`, signal)).entry;
			if (entry?.kind !== "file" || !entry.file) {
				say(t("This file is no longer in the app's folder."));
				return;
			}
			if (entry.file.bytes > MAX_DOWNLOAD_BYTES) {
				say(t("{size}: too large to download here.", { size: fmtBytes(entry.file.bytes) }));
				return;
			}
			const file = entry.file;
			if (file.fileSha256 !== form.sha256 || file.bytes !== form.bytes) {
				say(t("This file changed after version {version} was kept.", { version }));
				return;
			}
			this.#downloads ??= new WebFileDownloads({ signal, current: () => this.#host.current?.() });
			const pieces: Blob[] = [];
			if (folder.readFilePieces)
				await folder.readFilePieces(file, signal, (piece, index, count) => {
					pieces.push(new Blob([piece as BlobPart]));
					if (count > 2)
						progress.textContent = t("{percent}%", { percent: Math.round(((index + 1) / count) * 100) });
				});
			else pieces.push(new Blob([(await folder.readFile(file, signal, MAX_DOWNLOAD_BYTES)) as BlobPart]));
			this.#host.current?.();
			this.#downloads.offerPieces(form.file, pieces, file.bytes);
			say(t("It's in your Downloads."));
		} catch {
			if (signal.aborted) return;
			say(t("The download stopped. Try again."));
		} finally {
			this.#busy = false;
			if (!signal.aborted) this.#draw();
		}
	}
}
