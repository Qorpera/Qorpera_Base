import type { AppManifest } from "@qorpera/cloud-client/interface-apps";
import { type AppCallHandler, AppFrame } from "../../ui/app-frame.ts";
import { h, icon, replace } from "../../ui/dom.ts";
import { interfaceEmblem } from "../../ui/interface-emblem.ts";
import { framePage } from "../../ui/page-frame.ts";
import { t } from "../../ui/preferences.ts";
import { type AppBrand, type AppLook, readAppBrand } from "../interface-app-style.ts";
import { AppBridge, type AppBridgeHost, type AppLink, assembleApp, type CompanyApp } from "../interface-apps.ts";
import { QuestionDock, type QuestionDockHost } from "./question-dock.ts";

/* An agent's interface app (deploy/first-node/RUNTIME-INTERFACE-APPS.md §4) or an HTML page of the Company File, live
 * in the locked frame (ui/app-frame.ts), in one of two places:
 * - An app is a page of its own, `#/c/{id}/a/{name}` (Jonas, 8 November 2026: an app is a whole product prototype and
 *   opens as Mailbox and Bank do, never in a panel beside the chat). Its slim header has the way back.
 * - A Company File page linked in a message stands beside the conversation (Jonas, 5 November 2026: PR #1430's agent
 *   sheet, standing beside the thread instead of over it). The thread stays as it is, usable; Escape, in the panel or
 *   in its page, and Close put it away.
 * - A concept of the company's product fills the Concepts viewer's stage (views/concepts.ts; Jonas, 8 November 2026:
 *   "a fullscreen view of the selected concept"). It has no header at all: the concept's own design owns the whole
 *   area, and the viewer's side panel says whose it is, with Reload and Show in Storage.
 * Either way:
 * - Its header (or the Concepts viewer's side panel) is drawn outside the frame, and always says whose app it is and
 *   that Qorpera never asks for a password in it, so a page that draws a sign-in can't pass for this app's own
 *   (security review r1, H2).
 * - On an app's page, the agents' open questions about the app stand in a dock over the page's corner, drawn by Qorpera
 *   outside the frame (views/question-dock.ts, Jonas, 10 November 2026): one tap answers, as in the chat.
 * - It follows the company's folder: a change to the app's files puts its page together again and, when the page
 *   changed, shows it afresh; any other change tells the page that what it reads may have changed.
 * - An app's page starts from Qorpera's base style in the company's colours (app/interface-app-style.ts), read when the
 *   app opens and on Reload; a page that follows the app's light and dark is shown afresh when that changes. A concept
 *   and a page of the Company File are shown exactly as written.
 * - A link the member clicks in an app's page opens here, never in the frame (§4): another app on its page, a file of
 *   the company in Storage, a web page in a new tab. A tab the browser stops is offered in a line of Qorpera's own
 *   under the header, where the member's click opens it. A page of the Company File opens no links. */

/** What is shown: an app by its name, or a page of the Company File by its path. */
export type AppPanelTarget =
	| { readonly kind: "app"; readonly name: string }
	| { readonly kind: "page"; readonly path: string };

/** What stands beside a chat: a page of the Company File. An app opens as a page of its own. */
export type SidePanelTarget = Extract<AppPanelTarget, { kind: "page" }>;

/** Where it stands: beside the chat, with Close; as a page of its own, with the way back; or as the Concepts viewer's
 * concept, with no header (the viewer's side panel has the way back and the controls). */
export type AppPanelPlacement =
	| { readonly kind: "beside"; readonly onClose: () => void }
	| { readonly kind: "page"; readonly back: { readonly href: string; readonly label: string } }
	| { readonly kind: "concept" };

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
	/** Opens an app of the company where apps open: its own page, or the Concepts viewer for a concept. */
	readonly openApp: (name: string) => void;
	/** Where the app's call budget is kept in this tab: the company. */
	readonly budgetKey: string;
	/** The agents' open questions about the app, answered on its page (views/question-dock.ts); absent where the
	 * company has none to show. */
	readonly questions?: QuestionDockHost;
}

/** Changes in the folder put the page together again at most this often. */
const CHANGE_MS = 1500;

export function sameTarget(a: AppPanelTarget, b: AppPanelTarget): boolean {
	return (
		a.kind === b.kind &&
		(a.kind === "app" ? a.name === (b as typeof a).name : a.path === (b as { path: string }).path)
	);
}

const control = (name: string, label: string, onclick: () => void) =>
	h("button", { type: "button", class: "side-panel-button", title: label, "aria-label": label, onclick }, icon(name));

/** Opens a web page in a new tab, as a link in a message opens: with no way back to this window, and with no referrer
 * (the site sends none, public/_headers). False when the browser stopped the tab. The member's click was in the frame:
 * a browser counts it for the pages the frame stands in, or it does not and stops the tab as a pop-up. The tab is asked
 * for without `noopener`, which would hide whether it opened; its way back is cut at once, before it has loaded
 * anything. */
function openTab(href: string): boolean {
	const tab = window.open(href, "_blank");
	if (!tab) return false;
	tab.opener = null;
	return true;
}

export class AppPanel {
	readonly el: HTMLElement;
	readonly target: AppPanelTarget;
	readonly #host: AppPanelHost;
	readonly #lifetime = new AbortController();
	readonly #emblem = h("span", { class: "side-panel-emblem", "aria-hidden": "true" });
	readonly #title: HTMLElement;
	readonly #by = h("span", { class: "side-panel-by" });
	readonly #body = h("div", { class: "side-panel-body" });
	/** What takes the focus when the panel opens: Close beside the chat, the way back on a page. */
	readonly #first: HTMLElement;
	#frame: AppFrame | undefined;
	#page: string | undefined;
	#path: string | undefined;
	#loading: Promise<void> | undefined;
	#again = false;
	#timer: ReturnType<typeof setTimeout> | undefined;
	/** An app's page only: the open questions that point at it, drawn by Qorpera over the page's corner. */
	#dock: QuestionDock | undefined;
	/** The company's colours as last read (null: none), for the base style of an app's page. */
	#brand: AppBrand | null = null;
	/** A web link the browser would not open by itself, offered under the header. */
	#offered: HTMLElement | undefined;

	constructor(host: AppPanelHost, target: AppPanelTarget, placement: AppPanelPlacement) {
		this.#host = host;
		this.target = target;
		const actions = [
			control("reload", t("Reload"), () => void this.reload(true)),
			control("folder", t("Show in Storage"), () => {
				if (this.#path) host.openInStorage(this.#path);
			}),
		];
		if (placement.kind === "concept") {
			// Nothing of Qorpera's over the concept: the frame is the whole stage. The heading is kept, unshown.
			this.#title = h("strong", { class: "side-panel-title" });
			this.el = h("section", { class: "side-panel is-concept", tabindex: "-1" }, this.#body);
			this.#first = this.el;
		} else if (placement.kind === "page") {
			// The page's own heading: the app's name, once, at the top of the page.
			this.#title = h("h1", { class: "side-panel-title" });
			this.#first = h(
				"a",
				{
					class: "side-panel-button side-panel-back",
					href: placement.back.href,
					title: placement.back.label,
					"aria-label": placement.back.label,
				},
				icon("back"),
			);
			this.el = h(
				"section",
				{ class: "side-panel is-page", tabindex: "-1" },
				h("header", { class: "side-panel-header" }, this.#first, ...this.#headerCopy(), ...actions),
				this.#body,
			);
			if (host.questions && target.kind === "app") {
				const name = target.name;
				this.#dock = new QuestionDock(host.questions, (apps) => apps.has(name));
				this.el.append(this.#dock.el);
			}
		} else {
			this.#title = h("strong", { class: "side-panel-title" });
			this.#first = control("close", t("Close"), () => placement.onClose());
			this.el = h(
				"aside",
				{ class: "side-panel", "aria-label": t("Beside the chat"), tabindex: "-1" },
				h("header", { class: "side-panel-header" }, ...this.#headerCopy(), ...actions, this.#first),
				this.#body,
			);
			this.el.addEventListener(
				"keydown",
				(event: KeyboardEvent) => {
					if (event.key !== "Escape" || event.defaultPrevented) return;
					event.preventDefault();
					placement.onClose();
				},
				{ signal: this.#lifetime.signal },
			);
		}
		this.#lifetime.signal.addEventListener(
			"abort",
			host.onFolderChange(() => this.#changed()),
			{ once: true },
		);
		// The app turned light or dark: a page that follows it is put together again in the new scheme.
		window.addEventListener("qorpera-theme-change", () => void this.reload(false), {
			signal: this.#lifetime.signal,
		});
		this.#heading(
			target.kind === "app" ? target.name : target.path.slice(target.path.lastIndexOf("/") + 1),
			null,
			null,
		);
		this.#status(t("Opening…"));
		void this.reload(false);
	}

	focus(): void {
		this.#first.focus({ preventScroll: true });
	}

	dispose(): void {
		this.#lifetime.abort();
		clearTimeout(this.#timer);
		this.#frame?.dispose();
		this.#frame = undefined;
		this.#dock?.dispose();
		this.#dock = undefined;
		this.#offered = undefined;
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

	#headerCopy(): HTMLElement[] {
		return [this.#emblem, h("span", { class: "side-panel-copy" }, this.#title, this.#by)];
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
		replace(this.#emblem, interfaceEmblem(manifest?.emblem ?? "page", 22));
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
		this.#withdraw();
		this.#body.classList.remove("is-dark");
		replace(this.#body, h("p", { class: "side-panel-status" }, text));
	}

	/** Opens what a link in the app's page leads to, already checked (app/interface-apps.ts `appLink`): another app
	 * where apps open, a file or folder of the company in Storage, as a folder link in a message opens there, or a web
	 * page in a new tab. */
	#follow(link: AppLink): void {
		if (this.#lifetime.signal.aborted) return;
		if (link.kind === "app") this.#host.openApp(link.name);
		else if (link.kind === "file") this.#host.openInStorage(link.path);
		else if (!openTab(link.href)) this.#offer(link.href);
	}

	/** Offers a web link the browser stopped as a link of Qorpera's own under the header, named by where it really
	 * leads: the member's click on it opens the tab, as a link in a message does. One at a time; it goes when it is
	 * followed or closed, or when the page is shown afresh. */
	#offer(href: string): void {
		this.#withdraw();
		const url = new URL(href);
		const link = h(
			"a",
			{ href, target: "_blank", rel: "noopener noreferrer", title: href },
			t("Open {name}", { name: `${url.host}${url.pathname === "/" ? "" : url.pathname}` }),
		);
		const offered = h("p", { class: "side-panel-link", role: "status" }, link);
		const withdraw = () => {
			if (this.#offered === offered) this.#withdraw();
		};
		// After the click has opened the tab.
		link.addEventListener("click", () => setTimeout(withdraw, 0));
		offered.append(control("close", t("Close"), withdraw));
		this.#offered = offered;
		this.#body.before(offered);
		link.focus({ preventScroll: true });
	}

	#withdraw(): void {
		this.#offered?.remove();
		this.#offered = undefined;
	}

	async #load(fresh: boolean): Promise<void> {
		const signal = this.#lifetime.signal;
		if (!this.#frame) replace(this.#body, h("p", { class: "side-panel-status" }, t("Opening…")));
		const folder = this.#host.folder();
		let page: string | null;
		let handle: AppCallHandler;
		let name: string;
		let dark = false;
		if (this.target.kind === "app") {
			const target = this.target;
			// Read afresh when opened or asked to; after a change, as the company's reader just read them.
			const afresh = fresh || !this.#frame;
			const apps = afresh ? await this.#host.readApps(signal) : this.#host.apps();
			const app = apps.find((entry) => entry.name === target.name);
			if (signal.aborted) return;
			if (!app) {
				this.#path = undefined;
				return this.#status(t("This app isn't in the company anymore."));
			}
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
			// A concept is the product's own design, shown as written. Any other app starts from Qorpera's base style in
			// the company's colours, read when the app opens or is reloaded: after a change in the folder the ones read
			// before stand, as they do when they can't be read now (with none read yet, Qorpera's own).
			let look: AppLook | undefined;
			if (!manifest.concept) {
				if (afresh)
					try {
						this.#brand = await readAppBrand(folder, signal);
					} catch {
						/* What was read before stands. */
					}
				if (signal.aborted) return;
				// The theme on screen (ui/appearance.ts `applyTheme`).
				const scheme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
				look = { scheme, brand: this.#brand };
			}
			const assembled = await assembleApp(folder, { path: app.path, entry: manifest.entry }, signal, look);
			if (signal.aborted) return;
			if (!assembled.ok) return this.#status(assembled.message);
			page = assembled.page;
			dark = assembled.scheme === "dark";
			const bridge = new AppBridge(
				this.#host,
				{ ...app, manifest },
				`${this.#host.budgetKey}:${app.name}`,
				signal,
				(link) => this.#follow(link),
			);
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
			// A page of the Company File is no app: it reads nothing, and its links open nothing.
			handle = async () => ({ ok: false, error: "Only an app in apps/ reads the company's data" });
		}
		if (!fresh && this.#frame && page === this.#page) {
			this.#frame.changed();
			return;
		}
		this.#frame?.dispose();
		this.#withdraw();
		const frame = new AppFrame(page, t("App: {name}", { name }), "side-panel-frame", handle, () => {
			if (this.#frame !== frame) return;
			this.#status(t("This app reloaded itself. Press Reload to start it again."));
		});
		this.#frame = frame;
		this.#page = page;
		// What stands behind the page until it has drawn: white, or the dark page's own colour.
		this.#body.classList.toggle("is-dark", dark);
		// The frame document loads, then the page written into it: "Opening…" stays over it until the page is there.
		const opening = h("p", { class: "side-panel-status is-over" }, t("Opening…"));
		let loads = 0;
		frame.frame.addEventListener("load", () => {
			if (++loads === 2) opening.remove();
		});
		replace(this.#body, frame.frame, opening);
	}
}
