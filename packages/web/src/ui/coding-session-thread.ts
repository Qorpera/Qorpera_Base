/* A coding session as its own thread, opened from its line in the agent's
 * conversation (or its figure in the header) the way a message to a coworker opens: over the thread,
 * with its own header ("Bo ⇄ Claude Code", the session's title under it) and the
 * session as a conversation under it, its composer pinned to the bottom. The owner
 * types into the session here; everyone else reads it behind a lock line. The back
 * arrow and Escape return to the conversation. */
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
import { h } from "./dom.ts";
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
		const harness = HARNESS_NAMES[session.harness];
		this.element = new CodingSessionElement(session, {
			agent: options.agent,
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
					h("div", { class: "coding-thread-subtitle", title: session.title }, session.title),
				),
			),
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
			this.element.el,
		);
		if (options.signal.aborted) this.dispose();
		else
			options.signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
	}

	/** A fresh listing from the conversation's poll, handed to the session's own element. */
	update(session: CodingSession): void {
		this.element.update(session);
	}

	/** Over the conversation, with the caret in the composer when the viewer may type now; otherwise on the back
	 * arrow. */
	attach(body: HTMLElement): void {
		body.append(this.el);
		if (!this.element.focusComposer()) this.el.querySelector<HTMLButtonElement>(".coding-thread-back")?.focus();
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
