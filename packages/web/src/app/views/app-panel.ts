import type { AppManifest } from "@qorpera/cloud-client/interface-apps";
import { type AppAnswer, type AppCall, AppFrame } from "../../ui/app-frame.ts";
import { h, icon, replace } from "../../ui/dom.ts";
import { interfaceEmblem } from "../../ui/interface-emblem.ts";
import { framePage } from "../../ui/page-frame.ts";
import { t } from "../../ui/preferences.ts";
import { AppBridge, type AppBridgeHost, assembleApp, type CompanyApp } from "../interface-apps.ts";
import { AppAskBar } from "./app-ask-bar.ts";
import { QuestionDock, type QuestionDockHost } from "./question-dock.ts";

/* An agent's interface app (deploy/first-node/RUNTIME-INTERFACE-APPS.md §4) or an HTML page of the Company File, live
 * in the locked frame (ui/app-frame.ts), in one of two places:
 * - An app is a page of its own, `#/c/{id}/a/{name}` (Jonas, 8 November 2026: an app is a whole product prototype and
 *   opens as Mailbox and Bank do, never in a panel beside the chat). It has no header (Jonas, 10 November 2026: "I
 *   would remove any headers as they add nothing but bad visual design"): the app is the whole page, the rail beside
 *   it shows which app is open and leads everywhere else, and opening the app again reads it afresh.
 * - A Company File page linked in a message stands beside the conversation (Jonas, 5 November 2026: PR #1430's agent
 *   sheet, standing beside the thread instead of over it). The thread stays as it is, usable; Escape, in the panel or
 *   in its page, and Close put it away.
 * - A concept of the company's product fills the Concepts viewer's stage (views/concepts.ts; Jonas, 8 November 2026:
 *   "a fullscreen view of the selected concept"). It has no header at all: the concept's own design owns the whole
 *   area, and the viewer's side panel says whose it is, with Reload and Show in Storage.
 * Either way:
 * - Beside the chat, the header (and for a concept the viewer's side panel) is drawn outside the frame, and says whose
 *   page it is and that Qorpera never asks for a password in it, so a page that draws a sign-in can't pass for this
 *   app's own (security review r1, H2). An app's own page says neither since it lost its header: what Qorpera draws
 *   there is the bar of a request and the questions dock.
 * - When an app's page can't be shown, the line that says why carries the ways on a header had: Reload, the app's
 *   folder in Storage, and the way back when the app is gone.
 * - On an app's page, the agents' open questions about the app stand in a dock over the page's corner, drawn by Qorpera
 *   outside the frame (views/question-dock.ts, Jonas, 10 November 2026): one tap answers, as in the chat.
 * - An app's page may ask the member to change something (an answer to such a question, a row of a table): Qorpera
 *   puts each request to the member on a bar above the frame (views/app-ask-bar.ts), and nothing changes without their
 *   yes there. The member's Reload lets an app that was told not now three times ask again. What a page may read and
 *   ask for is what its manifest says now, also when the manifest changes under a page that stays as it is; a request
 *   made under an earlier manifest, or by a page since put away, is refused before anything is shown.
 * - It follows the company's folder: a change to the app's files puts its page together again and, when the page
 *   changed, shows it afresh; any other change tells the page that what it reads may have changed. */

/** What is shown: an app by its name, or a page of the Company File by its path. */
export type AppPanelTarget =
	| { readonly kind: "app"; readonly name: string }
	| { readonly kind: "page"; readonly path: string };

/** What stands beside a chat: a page of the Company File. An app opens as a page of its own. */
export type SidePanelTarget = Extract<AppPanelTarget, { kind: "page" }>;

/** Where it stands: beside the chat, with Close; as a page of its own, with no header (`back` is where a page that
 * can't be shown leads); or as the Concepts viewer's concept, with no header either (the viewer's side panel has the
 * way back and the controls). */
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
	/** Where the app's call budget is kept in this tab: the company. */
	readonly budgetKey: string;
	/** The agents' open questions about the app, answered on its page (views/question-dock.ts); absent where the
	 * company has none to show. */
	readonly questions?: QuestionDockHost;
}

/** Who answers the frame's calls: the bridge of the app as its manifest was last read (`version`, the manifest's). */
interface Serving {
	readonly version: string | null;
	readonly bridge: AppBridge;
}

/** Changes in the folder put the page together again at most this often. */
const CHANGE_MS = 1500;

export function sameTarget(a: AppPanelTarget, b: AppPanelTarget): boolean {
	return (
		a.kind === b.kind &&
		(a.kind === "app" ? a.name === (b as typeof a).name : a.path === (b as { path: string }).path)
	);
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
	/** What takes the focus when the panel opens: Close beside the chat, else the page itself. */
	readonly #first: HTMLElement;
	/** An app's own page: where it leads when the app can't be shown. Undefined in the other placements. */
	readonly #back: { readonly href: string; readonly label: string } | undefined;
	#frame: AppFrame | undefined;
	#page: string | undefined;
	#path: string | undefined;
	#loading: Promise<void> | undefined;
	#again = false;
	#timer: ReturnType<typeof setTimeout> | undefined;
	/** An app's page only: the open questions that point at it, drawn by Qorpera over the page's corner. */
	#dock: QuestionDock | undefined;
	/** An app only: where its requests for a change are put to the member, above its frame. */
	#ask: AppAskBar | undefined;
	/** The emblem the app's manifest names, for the bar. */
	#emblemName: AppManifest["emblem"] = "page";
	/** An app only: who answers its page's calls now. Replaced with the frame, and under the same frame when the
	 * manifest changed, so the page never reads or asks for more (or less) than the manifest says now (review r1 of
	 * #1633, F1 and F2). Undefined for a page of the Company File, which reads nothing. */
	#serving: Serving | undefined;

	constructor(host: AppPanelHost, target: AppPanelTarget, placement: AppPanelPlacement) {
		this.#host = host;
		this.target = target;
		if (placement.kind === "concept") {
			// Nothing of Qorpera's over the concept: the frame is the whole stage. The heading is kept, unshown.
			this.#title = h("strong", { class: "side-panel-title" });
			this.el = h("section", { class: "side-panel is-concept", tabindex: "-1" }, this.#body);
			this.#first = this.el;
		} else if (placement.kind === "page") {
			// Nothing of Qorpera's over the app (Jonas, 10 November 2026): the frame is the whole page, named for
			// assistive technology by the section's label. The heading is kept, unshown.
			this.#title = h("strong", { class: "side-panel-title" });
			this.el = h("section", { class: "side-panel is-page", tabindex: "-1" }, this.#body);
			this.#first = this.el;
			this.#back = placement.back;
			if (host.questions && target.kind === "app") {
				const name = target.name;
				this.#dock = new QuestionDock(host.questions, (apps) => apps.has(name));
				this.el.append(this.#dock.el);
			}
		} else {
			const control = (name: string, label: string, onclick: () => void) =>
				h(
					"button",
					{ type: "button", class: "side-panel-button", title: label, "aria-label": label, onclick },
					icon(name),
				);
			this.#title = h("strong", { class: "side-panel-title" });
			this.#first = control("close", t("Close"), () => placement.onClose());
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
					this.#first,
				),
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
		if (target.kind === "app") {
			// Above the frame and outside it, in every placement: the bar pushes the page down, and is never over it.
			this.#ask = new AppAskBar({
				emblem: () => interfaceEmblem(this.#emblemName, 22),
				agent: (agentId) => host.questions?.agent(agentId),
				open: (open) => {
					if (this.#frame) this.#frame.holdEscape = open;
				},
			});
			this.el.insertBefore(this.#ask.el, this.#body);
		}
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
		replace(this.#body, h("p", { class: "side-panel-status" }, t("Opening…")));
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
		this.#ask?.dispose();
		this.#ask = undefined;
		this.#serving = undefined;
		this.el.remove();
	}

	/** Reads the app or page and shows it: afresh when `fresh` (the member asked: Reload, or opening it again) or when
	 * its page changed. The member's reload also lets an app that was told not now three times ask again. */
	reload(fresh: boolean): Promise<void> {
		if (fresh) this.#ask?.reset();
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
		if (this.#back) this.el.setAttribute("aria-label", title);
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

	/** Says why nothing is shown. An app's own page has no header, so the line carries the ways on: Reload, the app's
	 * folder in Storage when it has one, and the way back when the app is `gone`. */
	#status(text: string, gone = false): void {
		this.#frame?.dispose();
		this.#frame = undefined;
		this.#serve(null);
		this.#page = undefined;
		const line = h("p", { class: "side-panel-status" }, text);
		const back = this.#back;
		if (!back) {
			replace(this.#body, line);
			return;
		}
		const path = this.#path;
		replace(
			this.#body,
			h(
				"div",
				{ class: "side-panel-state" },
				line,
				h(
					"div",
					{ class: "side-panel-ways" },
					gone ? h("a", { class: "side-panel-way", href: back.href }, back.label) : null,
					h(
						"button",
						{ type: "button", class: "side-panel-way", onclick: () => void this.reload(true) },
						t("Reload"),
					),
					path
						? h(
								"button",
								{ type: "button", class: "side-panel-way", onclick: () => this.#host.openInStorage(path) },
								t("Show in Storage"),
							)
						: null,
				),
			),
		);
	}

	/** Starts answering the page's calls for the app as its manifest is now, or for none (a page of the Company File,
	 * or nothing shown). A request that waits for the member was made under the earlier manifest or by the earlier
	 * page: it goes, unsaved. One whose check is still running is refused when the check ends, before anything is
	 * shown. One the member already allowed is on its way and is not touched. */
	#serve(app: (CompanyApp & { readonly manifest: AppManifest }) | null): void {
		this.#ask?.cancel();
		if (!app) {
			this.#serving = undefined;
			return;
		}
		const bar = this.#ask;
		const live = () => this.#serving === serving;
		const serving: Serving = {
			version: app.version,
			bridge: new AppBridge(
				this.#host,
				app,
				`${this.#host.budgetKey}:${app.name}`,
				this.#lifetime.signal,
				bar && {
					closed: () => (live() ? bar.closed() : "gone"),
					ask: (ask, perform) => (live() ? bar.ask(ask, perform) : Promise.resolve({ outcome: "gone" as const })),
				},
			),
		};
		this.#serving = serving;
	}

	#answer(call: AppCall): Promise<AppAnswer> {
		// A page of the Company File is no app: it reads nothing.
		return this.#serving
			? this.#serving.bridge.answer(call)
			: Promise.resolve({ ok: false, error: "Only an app in apps/ reads the company's data" });
	}

	async #load(fresh: boolean): Promise<void> {
		const signal = this.#lifetime.signal;
		if (!this.#frame) replace(this.#body, h("p", { class: "side-panel-status" }, t("Opening…")));
		const folder = this.#host.folder();
		let page: string | null;
		let served: (CompanyApp & { readonly manifest: AppManifest }) | null = null;
		let name: string;
		if (this.target.kind === "app") {
			const target = this.target;
			// Read afresh when opened or asked to; after a change, as the company's reader just read them.
			const apps = fresh || !this.#frame ? await this.#host.readApps(signal) : this.#host.apps();
			const app = apps.find((entry) => entry.name === target.name);
			if (signal.aborted) return;
			if (!app) {
				this.#path = undefined;
				return this.#status(t("This app isn't in the company anymore."), true);
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
			this.#emblemName = manifest.emblem;
			this.#heading(manifest.name, manifest, this.#host.agentName(manifest.owner));
			const assembled = await assembleApp(folder, { path: app.path, entry: manifest.entry }, signal);
			if (signal.aborted) return;
			if (!assembled.ok) return this.#status(assembled.message);
			page = assembled.page;
			served = { ...app, manifest };
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
		}
		const same = !fresh && this.#frame !== undefined && page === this.#page;
		// With a new page, and under the same page when the app's manifest changed: what it may read and ask for now.
		if (!same || (served !== null && this.#serving?.version !== served.version)) this.#serve(served);
		if (same) {
			this.#frame?.changed();
			return;
		}
		this.#frame?.dispose();
		const answer = (call: AppCall) => this.#answer(call);
		const frame = new AppFrame(page, t("App: {name}", { name }), "side-panel-frame", answer, () => {
			if (this.#frame !== frame) return;
			this.#status(t("This app reloaded itself. Press Reload to start it again."));
		});
		this.#frame = frame;
		this.#page = page;
		// The frame document loads, then the page written into it: "Opening…" stays over it until the page is there.
		const opening = h("p", { class: "side-panel-status is-over" }, t("Opening…"));
		let loads = 0;
		frame.frame.addEventListener("load", () => {
			if (++loads === 2) opening.remove();
		});
		replace(this.#body, frame.frame, opening);
	}
}
