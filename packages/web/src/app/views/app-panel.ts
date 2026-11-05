import type { AppManifest } from "@qorpera/cloud-client/interface-apps";
import { type AppCallHandler, AppFrame } from "../../ui/app-frame.ts";
import { h, icon, replace } from "../../ui/dom.ts";
import { interfaceEmblem } from "../../ui/interface-emblem.ts";
import { framePage } from "../../ui/page-frame.ts";
import { t } from "../../ui/preferences.ts";
import { AppBridge, type AppBridgeHost, assembleApp, type CompanyApp } from "../interface-apps.ts";

/* The side panel beside a conversation (Jonas, 5 November 2026: agents' apps "sit in the chat and pop out in a side
 * panel", like Claude's artifacts): PR #1430's agent sheet, standing beside the thread instead of over it. The thread
 * stays as it is, usable, and the panel shows an interface app (deploy/first-node/RUNTIME-INTERFACE-APPS.md §4) or an
 * HTML page of the Company File, live in the locked frame (ui/app-frame.ts).
 * - Its header is drawn here, outside the frame, and always says whose app it is and that Qorpera never asks for a
 *   password in it, so a page that draws a sign-in can't pass for this app's own (security review r1, H2).
 * - It follows the company's folder: a change to the app's files puts its page together again and, when the page
 *   changed, shows it afresh; any other change tells the page that what it reads may have changed.
 * - Escape, in the panel or in its page, and Close put it away. */

/** What the panel shows: an app by its name, or a page of the Company File by its path. */
export type SidePanelTarget =
	| { readonly kind: "app"; readonly name: string }
	| { readonly kind: "page"; readonly path: string };

/** What the panel needs from the open company. */
export interface AppPanelHost extends AppBridgeHost {
	/** The company's apps, read now. */
	readonly readApps: (signal: AbortSignal) => Promise<readonly CompanyApp[]>;
	/** The company's apps as last read: after a folder change they are read before the panel hears of it. */
	readonly apps: () => readonly CompanyApp[];
	/** An agent's name by its id. */
	readonly agentName: (agentId: string | null) => string | null;
	/** Calls `listener` after each change in the company's folder; answers the call that stops it. */
	readonly onFolderChange: (listener: () => void) => () => void;
	readonly openInStorage: (path: string) => void;
	/** Where the app's call budget is kept in this tab: the company. */
	readonly budgetKey: string;
}

/** Changes in the folder put the page together again at most this often. */
const CHANGE_MS = 1500;

export function sameTarget(a: SidePanelTarget, b: SidePanelTarget): boolean {
	return (
		a.kind === b.kind &&
		(a.kind === "app" ? a.name === (b as typeof a).name : a.path === (b as { path: string }).path)
	);
}

export class AppPanel {
	readonly el: HTMLElement;
	readonly target: SidePanelTarget;
	readonly #host: AppPanelHost;
	readonly #lifetime = new AbortController();
	readonly #emblem = h("span", { class: "side-panel-emblem", "aria-hidden": "true" });
	readonly #title = h("strong", { class: "side-panel-title" });
	readonly #by = h("span", { class: "side-panel-by" });
	readonly #body = h("div", { class: "side-panel-body" });
	readonly #close: HTMLButtonElement;
	#frame: AppFrame | undefined;
	#page: string | undefined;
	#path: string | undefined;
	#loading: Promise<void> | undefined;
	#again = false;
	#timer: ReturnType<typeof setTimeout> | undefined;

	constructor(host: AppPanelHost, target: SidePanelTarget, onClose: () => void) {
		this.#host = host;
		this.target = target;
		const control = (name: string, label: string, onclick: () => void) =>
			h(
				"button",
				{ type: "button", class: "side-panel-button", title: label, "aria-label": label, onclick },
				icon(name),
			);
		this.#close = control("close", t("Close"), () => onClose()) as HTMLButtonElement;
		this.el = h(
			"aside",
			{ class: "side-panel", "aria-label": t("Beside the chat"), tabindex: "-1" },
			h(
				"header",
				{ class: "side-panel-header" },
				this.#emblem,
				h("span", { class: "side-panel-copy" }, this.#title, this.#by),
				control("reload", t("Reload"), () => void this.reload(true)),
				control("folder", t("Show in Storage"), () => {
					if (this.#path) host.openInStorage(this.#path);
				}),
				this.#close,
			),
			this.#body,
		);
		this.el.addEventListener(
			"keydown",
			(event: KeyboardEvent) => {
				if (event.key !== "Escape" || event.defaultPrevented) return;
				event.preventDefault();
				onClose();
			},
			{ signal: this.#lifetime.signal },
		);
		this.#lifetime.signal.addEventListener(
			"abort",
			host.onFolderChange(() => this.#changed()),
			{ once: true },
		);
		this.#heading(
			target.kind === "app" ? target.name : target.path.slice(target.path.lastIndexOf("/") + 1),
			null,
			null,
		);
		this.#status(t("Opening…"));
		void this.reload(false);
	}

	focus(): void {
		this.#close.focus({ preventScroll: true });
	}

	dispose(): void {
		this.#lifetime.abort();
		clearTimeout(this.#timer);
		this.#frame?.dispose();
		this.#frame = undefined;
		this.el.remove();
	}

	/** Reads the app or page and shows it: afresh when `fresh` or when its page changed. */
	reload(fresh: boolean): Promise<void> {
		if (this.#loading) {
			this.#again = true;
			return this.#loading;
		}
		this.#loading = this.#load(fresh)
			.catch(() => {
				if (!this.#frame) this.#status(t("This can't be opened right now."));
			})
			.finally(() => {
				this.#loading = undefined;
				if (this.#again && !this.#lifetime.signal.aborted) {
					this.#again = false;
					void this.reload(false);
				}
			});
		return this.#loading;
	}

	/** At most once each CHANGE_MS, however often the folder changes (a busy company changes it every second). */
	#changed(): void {
		if (this.#timer !== undefined) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.reload(false);
		}, CHANGE_MS);
	}

	#heading(title: string, manifest: AppManifest | null, owner: string | null): void {
		this.#title.textContent = title;
		this.#title.title = manifest?.about ? `${title} · ${manifest.about}` : title;
		replace(this.#emblem, interfaceEmblem(manifest?.emblem ?? "page", manifest?.colour ?? null, 22));
		const made = owner
			? t("Made by {name}", { name: owner })
			: manifest
				? t("Made by an agent")
				: t("A page of the Company File");
		this.#by.textContent = `${made} · ${t("Qorpera never asks for passwords here")}`;
	}

	#status(text: string): void {
		this.#frame?.dispose();
		this.#frame = undefined;
		this.#page = undefined;
		replace(this.#body, h("p", { class: "side-panel-status" }, text));
	}

	async #load(fresh: boolean): Promise<void> {
		const signal = this.#lifetime.signal;
		const folder = this.#host.folder();
		let page: string | null;
		let handle: AppCallHandler;
		let name: string;
		if (this.target.kind === "app") {
			const target = this.target;
			// Read afresh when opened or asked to; after a change, as the company's reader just read them.
			const apps = fresh || !this.#frame ? await this.#host.readApps(signal) : this.#host.apps();
			const app = apps.find((entry) => entry.name === target.name);
			if (signal.aborted) return;
			if (!app) return this.#status(t("No app is called {name}.", { name: target.name }));
			this.#path = app.path;
			const manifest = app.manifest;
			if (!manifest) {
				this.#heading(app.name, null, null);
				return this.#status(
					t("This app's app.toml has problems: {problems}", {
						problems: app.problems.map((problem) => problem.message).join("; "),
					}),
				);
			}
			name = manifest.name;
			this.#heading(manifest.name, manifest, this.#host.agentName(manifest.owner));
			const assembled = await assembleApp(folder, { path: app.path, entry: manifest.entry }, signal);
			if (signal.aborted) return;
			if (!assembled.ok) return this.#status(assembled.message);
			page = assembled.page;
			const bridge = new AppBridge(this.#host, { ...app, manifest }, `${this.#host.budgetKey}:${app.name}`, signal);
			handle = (call) => bridge.answer(call);
		} else {
			const path = this.target.path;
			this.#path = path;
			name = path.slice(path.lastIndexOf("/") + 1);
			this.#heading(name, null, null);
			const entry = (await folder.read(path, signal)).entry;
			if (signal.aborted) return;
			if (entry?.kind !== "file" || !entry.file || entry.file.bytes > 1024 * 1024)
				return this.#status(t("This page can't be shown here."));
			let html: string;
			try {
				html = new TextDecoder("utf-8", { fatal: true }).decode(
					await folder.readFile(entry.file, signal, 1024 * 1024),
				);
			} catch {
				return this.#status(t("This page can't be shown here."));
			}
			if (signal.aborted) return;
			page = framePage(html);
			if (page === null) return this.#status(t("This page can't be shown live."));
			// A page of the Company File is no app: it reads nothing.
			handle = async () => ({ ok: false, error: "Only an app in apps/ reads the company's data" });
		}
		if (!fresh && this.#frame && page === this.#page) {
			this.#frame.changed();
			return;
		}
		this.#frame?.dispose();
		const frame = new AppFrame(page, t("App: {name}", { name }), "side-panel-frame", handle, () => {
			if (this.#frame !== frame) return;
			this.#status(t("This app reloaded itself. Press Reload to start it again."));
		});
		this.#frame = frame;
		this.#page = page;
		replace(this.#body, frame.frame);
	}
}
