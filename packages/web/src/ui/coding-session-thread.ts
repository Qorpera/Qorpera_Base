/* A coding session as its own thread, opened from its line in the agent's
 * conversation (or its figure in the header) the way a message to a coworker opens: over the thread,
 * with its own header ("Bo ⇄ Claude Code", the session's title under it), the
 * session unfolded, and a footer that says who may type. The owner types into
 * the session here; everyone else reads it ("This session is view-only"). */
import type { CodingSession } from "../cloud/coding-session.ts";
import type { HostedStaffAgent } from "../cloud/types.ts";
import { agentFigure } from "./avatar.ts";
import {
	type CodingSessionApi,
	CodingSessionElement,
	type CodingSessionNames,
	HARNESS_NAMES,
	harnessBadge,
} from "./coding-session.ts";
import { button, h } from "./dom.ts";
import { matchesKey } from "./keys.ts";
import { t } from "./preferences.ts";

export interface CodingSessionThreadOptions {
	agent: HostedStaffAgent | undefined;
	names: (session: CodingSession) => CodingSessionNames;
	viewerOwns: (session: CodingSession) => boolean;
	api: CodingSessionApi;
	signal: AbortSignal;
	askAgent?: (text: string) => void;
	close: () => void;
}

const BACK_GLYPH =
	'<path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>';
const SWAP_GLYPH =
	'<path d="M7 7h11m0 0l-3-3m3 3l-3 3M17 17H6m0 0l3 3m-3-3l3-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>';
const LOCK_GLYPH =
	'<rect x="5" y="10.5" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 10.5V8a4 4 0 018 0v2.5" fill="none" stroke="currentColor" stroke-width="1.8"/>';

function glyph(markup: string, size: number, className: string): SVGSVGElement {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("width", String(size));
	svg.setAttribute("height", String(size));
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("class", className);
	svg.innerHTML = markup;
	return svg;
}

export class CodingSessionThreadView {
	readonly el: HTMLElement;
	readonly element: CodingSessionElement;
	readonly #lifetime = new AbortController();
	readonly #close: () => void;

	constructor(session: CodingSession, options: CodingSessionThreadOptions) {
		this.#close = options.close;
		const signal = AbortSignal.any([options.signal, this.#lifetime.signal]);
		const names = options.names(session);
		const owns = options.viewerOwns(session);
		const harness = HARNESS_NAMES[session.harness];
		this.element = new CodingSessionElement(session, {
			names: options.names,
			viewerOwns: options.viewerOwns,
			api: options.api,
			signal,
			askAgent: options.askAgent,
		});
		const back = h(
			"button",
			{
				type: "button",
				class: "icon-button coding-thread-back",
				"aria-label": t("Back to the conversation"),
				title: t("Back to the conversation"),
				onclick: () => this.close(),
			},
			glyph(BACK_GLYPH, 18, "icon"),
		);
		const header = h(
			"header",
			{ class: "thread-header coding-thread-header" },
			back,
			h(
				"div",
				{ class: "coding-thread-identity" },
				agentFigure(options.agent, names.agent, { size: 28 }),
				glyph(SWAP_GLYPH, 14, "coding-thread-swap"),
				h("span", { class: "coding-thread-harness" }, harnessBadge(session.harness)),
				h(
					"div",
					{ class: "coding-thread-names" },
					h("h1", null, `${names.agent} ⇄ ${harness}`),
					h("div", { class: "coding-thread-subtitle" }, session.title),
				),
			),
		);
		const scroller = h("div", { class: "coding-thread-body" }, this.element.el);
		const footer = h(
			"footer",
			{ class: "coding-thread-footer" },
			owns
				? h(
						"span",
						{ class: "coding-thread-note" },
						t("Your answers and follow-ups go to {harness}. Uses your {harness} plan.", { harness }),
					)
				: h(
						"span",
						{ class: "coding-thread-note" },
						glyph(LOCK_GLYPH, 12, "coding-glyph"),
						t("This session is view-only. Only {owner} can type; steer it through {agent}.", {
							owner: names.owner,
							agent: names.agent,
						}),
					),
			button(t("Close"), () => this.close(), { small: true }),
		);
		this.el = h(
			"section",
			{
				class: "coding-thread",
				role: "dialog",
				"aria-modal": "false",
				"aria-label": `${names.agent} ⇄ ${harness} · ${session.title}`,
				onkeydown: (event: KeyboardEvent) => {
					if (!matchesKey(event, "dismiss")) return;
					event.preventDefault();
					event.stopPropagation();
					this.close();
				},
			},
			header,
			scroller,
			footer,
		);
		if (options.signal.aborted) this.dispose();
		else
			options.signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
	}

	/** A fresh listing from the thread: the same element update as in the line. */
	update(session: CodingSession): void {
		this.element.update(session);
	}

	attach(body: HTMLElement): void {
		body.append(this.el);
		this.el.querySelector<HTMLButtonElement>(".coding-thread-back")?.focus();
	}

	close(): void {
		if (this.#lifetime.signal.aborted) return;
		this.dispose();
		this.#close();
	}

	dispose(): void {
		if (this.#lifetime.signal.aborted) return;
		this.#lifetime.abort();
		this.element.dispose();
		this.el.remove();
	}
}
