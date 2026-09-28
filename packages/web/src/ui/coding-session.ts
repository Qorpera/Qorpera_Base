/* A coding session: in the thread, one centered line where the agent started it,
 * "Started a coding session in (mark) Codex", the way a message to a coworker
 * shows; the line opens the session as its own thread (coding-session-thread.ts).
 * While the session runs, the thread's header carries it beside the agent: the
 * agent's figure wearing the harness mark, moving as the agent's own figure does.
 * The session's thread shows its own steps, the harness's voice, the owner's
 * input and the pull request. Everything here is a projection of the kernel's
 * session view and event stream; nothing comes from the agent's prose.
 *
 * The session's thread follows its stream itself: a short poll while the session
 * works, a slower one while it waits or after it finished (a follow-up starts it
 * again). */

import { describeError } from "../cloud/client.ts";
import {
	type CodingHarness,
	type CodingSession,
	type CodingSessionEvent,
	type CodingSessionRead,
	codingSessionSettled,
	codingSessionTakesInput,
} from "../cloud/coding-session.ts";
import type { HostedStaffAgent, JsonValue } from "../cloud/types.ts";
import { agentFigure } from "./avatar.ts";
import { button, h, replace } from "./dom.ts";
import type { Activity } from "./figure-motion.ts";
import { t } from "./preferences.ts";

export const HARNESS_NAMES: Record<CodingHarness, string> = { codex: "Codex", "claude-code": "Claude Code" };

/** The names the captions are written with. `owner` is "you" for the owner's own view. */
export interface CodingSessionNames {
	agent: string;
	owner: string;
	ownerIsViewer: boolean;
}

export type CodingSessionTone = "working" | "attention" | "done" | "failed" | "idle";

const POLL_WORKING_MS = 2_500;
const POLL_WAITING_MS = 6_000;
const POLL_SETTLED_MS = 30_000;
const POLL_HIDDEN_MS = 20_000;
/** Steps shown in full when the session is expanded; older ones fold into one line. */
const RECENT_EVENTS = 10;

/** qorpera/coding/<worker uuid> reads as qorpera/coding/7f3a… */
export function shortBranch(branch: string): string {
	return branch.replace(/^(qorpera\/coding\/[0-9a-f]{4})[0-9a-f-]{32,}$/, "$1…");
}

function cap(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The thread's line, in pieces around the harness, which is drawn with its mark
 * wherever the language puts it. The agent is the thread's own, so it is not named,
 * as in "Messaged Nova". */
export function codingSessionLine(harness: CodingHarness): { before: string; name: string; after: string } {
	const [before = "", after = ""] = t("Started a coding session in {harness}").split("{harness}");
	return { before, name: HARNESS_NAMES[harness], after };
}

export function fmtDuration(ms: number): string {
	const minutes = Math.max(0, Math.floor(ms / 60_000));
	if (minutes < 1) return t("less than a minute");
	if (minutes < 60) return t("{minutes} min", { minutes });
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? t("{hours} h {minutes} min", { hours, minutes: rest }) : t("{hours} h", { hours });
}

/** The live status line: the state, how long, the last step, the diff size. */
export function codingSessionStatus(
	session: CodingSession,
	names: CodingSessionNames,
	now = Date.now(),
): { text: string; tone: CodingSessionTone } {
	const since = (iso: string | undefined) => (iso ? fmtDuration(now - Date.parse(iso)) : undefined);
	const files =
		session.filesChanged > 0
			? session.filesChanged === 1
				? t("{count} file changed", { count: session.filesChanged })
				: t("{count} files changed", { count: session.filesChanged })
			: undefined;
	switch (session.phase) {
		case "queued":
			return { text: t("Waiting for a computer"), tone: "idle" };
		case "preparing":
			return {
				text: [t("Preparing the workspace"), since(session.updatedAt)].filter(Boolean).join(" · "),
				tone: "working",
			};
		case "running":
			return {
				text: [t("Working"), since(session.startedAt), session.lastStep, files].filter(Boolean).join(" · "),
				tone: "working",
			};
		case "awaiting_input": {
			const paused = since(session.updatedAt);
			return {
				text: names.ownerIsViewer
					? t("Needs you · your answer is recorded in this thread")
					: paused
						? t("Needs {name} · paused {duration}", { name: names.owner, duration: paused })
						: t("Needs {name} · paused now", { name: names.owner }),
				tone: "attention",
			};
		}
		case "input_ready":
			return { text: t("Answer sent · waiting for the session"), tone: "working" };
		case "publishing":
			return { text: [t("Opening the pull request"), files].filter(Boolean).join(" · "), tone: "working" };
		case "completed":
			return {
				text: session.pullRequest
					? t("Draft PR ready · session kept for follow-ups")
					: t("Finished · session kept for follow-ups"),
				tone: "done",
			};
		case "failed":
			return { text: t("Failed · workspace kept"), tone: "failed" };
		case "cancelled":
			return { text: t("Cancelled · workspace kept"), tone: "idle" };
	}
}

export interface CodingSessionApi {
	read(workerId: string, afterEvent: number): Promise<CodingSessionRead>;
	answer(workerId: string, text: string, clientRequestId: string): Promise<void>;
	delegate(workerId: string, clientRequestId: string): Promise<void>;
}

/** The session, unfolded, as the body of its own thread (the thread view adds header and footer). */
export interface CodingSessionElementOptions {
	/** Read at every render with the current session: names follow the roster and the owner. */
	names: (session: CodingSession) => CodingSessionNames;
	/** Whether the signed-in member owns the session (the kernel says; the listing repeats it). */
	viewerOwns: (session: CodingSession) => boolean;
	api: CodingSessionApi;
	signal: AbortSignal;
	/** Put a sentence in the composer, e.g. "Ask Mark to review". */
	askAgent?: (text: string) => void;
}

function text(value: JsonValue, ...keys: string[]): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	for (const key of keys) {
		const found = value[key];
		if (typeof found === "string" && found.trim()) return found;
	}
	return undefined;
}

function options(value: JsonValue): string[] {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
	const found = value.options;
	return Array.isArray(found)
		? found.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 6)
		: [];
}

/* The makers' own marks: OpenAI's for Codex (the ChatGPT mark, as on the Connections
 * card) and the Claude spark for Claude Code. Drawn in currentColor; the stylesheet
 * gives the Claude spark its own orange. */
const HARNESS_MARKS: Record<CodingHarness, { viewBox: string; path: string }> = {
	codex: {
		viewBox: "146.694 227.042 267.198 264.812",
		path: "M249.176 323.434V298.276C249.176 296.158 249.971 294.569 251.825 293.509L302.406 264.381C309.29 260.409 317.5 258.555 325.973 258.555C357.75 258.555 377.877 283.185 377.877 309.399C377.877 311.253 377.877 313.371 377.611 315.49L325.178 284.771C322.001 282.919 318.822 282.919 315.645 284.771L249.176 323.434ZM367.283 421.415V361.301C367.283 357.592 365.694 354.945 362.516 353.092L296.048 314.43L317.763 301.982C319.617 300.925 321.206 300.925 323.058 301.982L373.639 331.112C388.205 339.586 398.003 357.592 398.003 375.069C398.003 395.195 386.087 413.733 367.283 421.412V421.415ZM233.553 368.452L211.838 355.742C209.986 354.684 209.19 353.095 209.19 350.975V292.718C209.19 264.383 230.905 242.932 260.301 242.932C271.423 242.932 281.748 246.641 290.49 253.26L238.321 283.449C235.146 285.303 233.555 287.951 233.555 291.659V368.455L233.553 368.452ZM280.292 395.462L249.176 377.985V340.913L280.292 323.436L311.407 340.913V377.985L280.292 395.462ZM300.286 475.968C289.163 475.968 278.837 472.259 270.097 465.64L322.264 435.449C325.441 433.597 327.03 430.949 327.03 427.239V350.445L349.011 363.155C350.865 364.213 351.66 365.802 351.66 367.922V426.179C351.66 454.514 329.679 475.965 300.286 475.965V475.968ZM237.525 416.915L186.944 387.785C172.378 379.31 162.582 361.305 162.582 343.827C162.582 323.436 174.763 305.164 193.563 297.485V357.861C193.563 361.571 195.154 364.217 198.33 366.071L264.535 404.467L242.82 416.915C240.967 417.972 239.377 417.972 237.525 416.915ZM234.614 460.343C204.689 460.343 182.71 437.833 182.71 410.028C182.71 407.91 182.976 405.792 183.238 403.672L235.405 433.863C238.582 435.715 241.763 435.715 244.938 433.863L311.407 395.466V420.622C311.407 422.742 310.612 424.331 308.758 425.389L258.179 454.519C251.293 458.491 243.083 460.343 234.611 460.343H234.614ZM300.286 491.854C332.329 491.854 359.073 469.082 365.167 438.892C394.825 431.211 413.892 403.406 413.892 375.073C413.892 356.535 405.948 338.529 391.648 325.552C392.972 319.991 393.766 314.43 393.766 308.87C393.766 271.003 363.048 242.666 327.562 242.666C320.413 242.666 313.528 243.723 306.644 246.109C294.725 234.457 278.307 227.042 260.301 227.042C228.258 227.042 201.513 249.815 195.42 280.004C165.761 287.685 146.694 315.49 146.694 343.824C146.694 362.362 154.638 380.368 168.938 393.344C167.613 398.906 166.819 404.467 166.819 410.027C166.819 447.894 197.538 476.231 233.024 476.231C240.172 476.231 247.058 475.173 253.943 472.788C265.859 484.441 282.278 491.854 300.286 491.854Z",
	},
	"claude-code": {
		viewBox: "0 0 24 24",
		path: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
	},
};

/** The harness's mark on its own, for a line of text. */
export function harnessMark(harness: CodingHarness, size: number): SVGSVGElement {
	const mark = HARNESS_MARKS[harness];
	const svg = svgEl(`<path d="${mark.path}" fill="currentColor"/>`, size, `coding-mark coding-mark-${harness}`);
	svg.setAttribute("viewBox", mark.viewBox);
	return svg;
}

/** The harness's mark on a disc: the badge a figure wears, or the harness's own avatar. */
export function harnessBadge(harness: CodingHarness): HTMLElement {
	return h(
		"span",
		{ class: `coding-badge coding-badge-${harness}`, title: HARNESS_NAMES[harness] },
		harnessMark(harness, 8),
	);
}

function svgEl(markup: string, size: number, className = ""): SVGSVGElement {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("width", String(size));
	svg.setAttribute("height", String(size));
	svg.setAttribute("aria-hidden", "true");
	if (className) svg.setAttribute("class", className);
	svg.innerHTML = markup;
	return svg;
}

const STEP_GLYPH =
	'<path d="M4 12h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
const CHECK_GLYPH =
	'<path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>';
const PR_GLYPH =
	'<circle cx="6" cy="5" r="2.4" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="6" cy="19" r="2.4" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="18" cy="19" r="2.4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M6 7.4v9.2M18 16.6V11a3 3 0 00-3-3h-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M14.5 5.5L12 8l2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>';
const LOCK_GLYPH =
	'<rect x="5" y="10.5" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 10.5V8a4 4 0 018 0v2.5" fill="none" stroke="currentColor" stroke-width="1.8"/>';

function checkTone(status: string): CodingSessionTone {
	const value = status.toLowerCase();
	if (/pass|success|green|ok/.test(value)) return "done";
	if (/fail|error|red/.test(value)) return "failed";
	if (/skip|cancel|neutral/.test(value)) return "idle";
	return "working";
}

export class CodingSessionElement {
	readonly el: HTMLElement;
	readonly #options: CodingSessionElementOptions;
	readonly #lifetime = new AbortController();
	#session: CodingSession;
	#events: CodingSessionEvent[] = [];
	#cursor = 0;
	#showAll = false;
	#busy = false;
	/** Why the last answer or delegation was refused. */
	#error: string | undefined;
	/** Why the stream cannot be read, shown only while nothing is known yet. */
	#readError: string | undefined;
	#requestId: string | undefined;
	#draft = "";
	#poll: ReturnType<typeof setTimeout> | undefined;
	#request: AbortController | undefined;
	#refreshing: Promise<void> | undefined;
	#renderedKey = "";

	constructor(session: CodingSession, options: CodingSessionElementOptions) {
		this.#session = session;
		this.#options = options;
		this.el = h("section", {
			class: "coding-session",
			dataset: { workerId: session.workerId, phase: session.phase },
			"aria-label": t("Coding session"),
		});
		if (options.signal.aborted) this.dispose();
		else
			options.signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
		document.addEventListener("visibilitychange", () => this.#onVisibility(), { signal: this.#lifetime.signal });
		window.addEventListener("focus", () => void this.refresh(), { signal: this.#lifetime.signal });
		this.#render();
		void this.refresh();
	}

	get session(): CodingSession {
		return this.#session;
	}

	get disposed(): boolean {
		return this.#lifetime.signal.aborted;
	}

	/** A fresh listing from the thread's own reads; the element keeps the newer of the two. */
	update(session: CodingSession): void {
		if (this.disposed) return;
		const newer = session.updatedAt.localeCompare(this.#session.updatedAt) >= 0;
		const moved = session.phase !== this.#session.phase;
		if (newer) this.#session = { ...session, isOwner: session.isOwner ?? this.#session.isOwner };
		this.#render();
		// A phase the poll did not see yet (an answer landed, the executor took it) shortens the wait.
		if (newer && moved) void this.refresh();
	}

	/** Reads the events after the cursor and the current view; reschedules itself. */
	refresh(): Promise<void> {
		if (this.disposed) return Promise.resolve();
		if (this.#refreshing) return this.#refreshing;
		clearTimeout(this.#poll);
		const request = new AbortController();
		this.#request = request;
		this.#refreshing = (async () => {
			try {
				const read = await this.#options.api.read(this.#session.workerId, this.#cursor);
				if (request.signal.aborted || this.disposed) return;
				const known = new Set(this.#events.map((event) => event.id));
				for (const event of read.events) if (!known.has(event.id)) this.#events.push(event);
				this.#events.sort((a, b) => a.id - b.id);
				this.#cursor = this.#events[this.#events.length - 1]?.id ?? this.#cursor;
				this.#session = { ...read.session, isOwner: read.isOwner };
				this.#readError = undefined;
			} catch (error) {
				if (request.signal.aborted || this.disposed) return;
				// A read that fails leaves the last known state standing; the next poll tries again.
				this.#readError = this.#events.length ? undefined : describeError(error);
			} finally {
				if (this.#request === request) this.#request = undefined;
				this.#refreshing = undefined;
				if (!this.disposed) {
					this.#render();
					this.#schedule();
				}
			}
		})();
		return this.#refreshing;
	}

	dispose(): void {
		if (this.disposed) return;
		this.#lifetime.abort();
		this.#request?.abort();
		clearTimeout(this.#poll);
	}

	#schedule(): void {
		clearTimeout(this.#poll);
		if (this.disposed) return;
		const phase = this.#session.phase;
		const wait =
			typeof document !== "undefined" && document.hidden
				? POLL_HIDDEN_MS
				: codingSessionSettled(phase)
					? POLL_SETTLED_MS
					: phase === "awaiting_input"
						? POLL_WAITING_MS
						: POLL_WORKING_MS;
		this.#poll = setTimeout(() => void this.refresh(), wait);
	}

	#onVisibility(): void {
		if (!document.hidden) void this.refresh();
	}

	async #send(text: string): Promise<void> {
		const value = text.trim();
		if (!value || this.#busy || this.disposed) return;
		this.#requestId ??= crypto.randomUUID();
		this.#busy = true;
		this.#error = undefined;
		this.#render();
		try {
			await this.#options.api.answer(this.#session.workerId, value, this.#requestId);
			this.#requestId = undefined;
			this.#draft = "";
		} catch (error) {
			this.#error = describeError(error);
		} finally {
			this.#busy = false;
		}
		this.#render();
		await this.refresh();
	}

	async #delegate(): Promise<void> {
		if (this.#busy || this.disposed) return;
		this.#requestId ??= crypto.randomUUID();
		this.#busy = true;
		this.#error = undefined;
		this.#render();
		try {
			await this.#options.api.delegate(this.#session.workerId, this.#requestId);
			this.#requestId = undefined;
		} catch (error) {
			this.#error = describeError(error);
		} finally {
			this.#busy = false;
		}
		this.#render();
		await this.refresh();
	}

	#render(): void {
		if (this.disposed) return;
		const session = this.#session;
		const names = this.#options.names(session);
		const owns = this.#options.viewerOwns(session);
		const status = codingSessionStatus(session, names);
		const key = JSON.stringify([
			session,
			names,
			owns,
			this.#showAll,
			this.#busy,
			this.#error,
			this.#readError,
			this.#events.length,
			status.text,
		]);
		if (key === this.#renderedKey) return;
		this.#renderedKey = key;
		this.el.dataset.phase = session.phase;
		this.el.dataset.tone = status.tone;
		replace(
			this.el,
			this.#renderHead(names),
			this.#renderBody(names),
			session.pullRequest ? this.#renderPullRequest(names) : null,
			owns ? this.#renderInput(names) : this.#renderLock(names),
			h(
				"div",
				{ class: `coding-status coding-tone-${status.tone}`, role: "status" },
				h("span", { class: `coding-dot coding-dot-${status.tone}`, "aria-hidden": "true" }),
				h("span", { class: "coding-status-text" }, status.text),
			),
		);
	}

	#renderHead(names: CodingSessionNames): HTMLElement {
		const session = this.#session;
		const meta = [
			session.repository.name,
			shortBranch(session.branch),
			session.model,
			t("managed by {name}", { name: names.agent }),
		].filter(Boolean);
		return h(
			"div",
			{ class: "coding-head" },
			h("div", { class: "coding-title" }, session.title),
			h(
				"div",
				{ class: "coding-meta" },
				...meta.flatMap((part, index) => [
					index ? h("span", { "aria-hidden": "true" }, "·") : null,
					h("span", { class: index === 1 ? "coding-mono" : undefined }, part),
				]),
			),
		);
	}

	#renderBody(names: CodingSessionNames): HTMLElement {
		const events = this.#events.filter((event) => event.kind !== "phase");
		const folded = !this.#showAll && events.length > RECENT_EVENTS ? events.length - RECENT_EVENTS : 0;
		const shown = folded ? events.slice(folded) : events;
		const rows = shown
			.map((event) => this.#renderEvent(event, names))
			.filter((row): row is HTMLElement => Boolean(row));
		return h(
			"div",
			{ class: "coding-body" },
			folded
				? h(
						"div",
						{ class: "coding-row coding-row-fold" },
						button(
							folded === 1
								? t("{count} earlier step", { count: folded })
								: t("{count} earlier steps", { count: folded }),
							() => {
								this.#showAll = true;
								this.#render();
							},
							{ small: true },
						),
					)
				: null,
			...rows,
			!rows.length && !this.#readError
				? h(
						"div",
						{ class: "coding-row coding-row-quiet" },
						this.#session.phase === "queued"
							? t("Waiting for a computer to start the session.")
							: t("Nothing reported yet."),
					)
				: null,
			this.#readError && !rows.length
				? h("div", { class: "coding-row coding-row-error", role: "alert" }, this.#readError)
				: null,
		);
	}

	#renderEvent(event: CodingSessionEvent, names: CodingSessionNames): HTMLElement | undefined {
		const harness = HARNESS_NAMES[this.#session.harness];
		switch (event.kind) {
			case "step": {
				const title = text(event.body, "text", "title", "command", "summary") ?? t("Step");
				const status = text(event.body, "status");
				return h(
					"div",
					{ class: "coding-row coding-row-step" },
					svgEl(STEP_GLYPH, 14, "coding-glyph"),
					h(
						"div",
						null,
						title,
						status
							? h("span", { class: `coding-step-status coding-tone-${checkTone(status)}` }, ` ${status}`)
							: null,
					),
				);
			}
			case "text": {
				const body = text(event.body, "text", "summary") ?? "";
				if (!body) return undefined;
				return h(
					"div",
					{ class: "coding-row coding-row-voice" },
					h("span", { class: "coding-voice", title: harness }, harnessBadge(this.#session.harness)),
					h("div", { class: "coding-voice-text" }, ...body.split(/\n{2,}/).map((part) => h("p", null, part))),
				);
			}
			case "needs_input": {
				const question =
					text(event.body, "needs", "question") ?? this.#session.needs ?? t("The session has a question.");
				return h(
					"div",
					{ class: "coding-row coding-row-question" },
					h(
						"div",
						{ class: "coding-question" },
						h(
							"div",
							{ class: "coding-question-from" },
							harnessBadge(this.#session.harness),
							t("{harness} asks", { harness }),
						),
						h("div", null, question),
					),
				);
			}
			case "input": {
				const who = event.actor === "agent" ? names.agent : names.ownerIsViewer ? t("You") : names.owner;
				return h(
					"div",
					{ class: "coding-row coding-row-input" },
					h("span", { class: "coding-who" }, who),
					h("div", null, text(event.body, "text") ?? ""),
				);
			}
			case "delegated":
				return h(
					"div",
					{ class: "coding-row coding-row-quiet" },
					names.ownerIsViewer
						? t("You left it to {agent}", { agent: names.agent })
						: t("{owner} left it to {agent}", { owner: names.owner, agent: names.agent }),
				);
			case "published": {
				const url = text(event.body, "url");
				const number =
					typeof event.body === "object" && event.body && !Array.isArray(event.body)
						? event.body.number
						: undefined;
				const label =
					typeof number === "number" ? t("Draft PR #{number} opened", { number }) : t("Draft PR opened");
				return h(
					"div",
					{ class: "coding-row coding-row-step" },
					svgEl(PR_GLYPH, 14, "coding-glyph"),
					url ? h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, label) : h("div", null, label),
				);
			}
			case "finished": {
				const summary = text(event.body, "summary");
				return summary
					? h(
							"div",
							{ class: "coding-row coding-row-step" },
							svgEl(CHECK_GLYPH, 14, "coding-glyph coding-tone-done"),
							h("div", null, summary),
						)
					: undefined;
			}
			case "failed": {
				const reason = text(event.body, "reason", "summary");
				return h(
					"div",
					{ class: "coding-row coding-row-error", role: "alert" },
					reason === "executor-lease-expired"
						? t(
								"The computer running this session stopped answering. The workspace is kept; a follow-up starts it again.",
							)
						: reason
							? t("Failed: {reason}", { reason })
							: t("Failed"),
				);
			}
			default:
				return undefined;
		}
	}

	#renderPullRequest(names: CodingSessionNames): HTMLElement {
		const session = this.#session;
		const pr = session.pullRequest!;
		const files =
			session.filesChanged > 0
				? session.filesChanged === 1
					? t("{count} file", { count: session.filesChanged })
					: t("{count} files", { count: session.filesChanged })
				: undefined;
		const artifacts = session.artifacts.length
			? session.artifacts.length === 1
				? t("{count} artifact", { count: session.artifacts.length })
				: t("{count} artifacts", { count: session.artifacts.length })
			: undefined;
		const meta = [
			`${session.repository.owner}/${session.repository.name}`,
			`${shortBranch(session.branch)} → ${session.repository.baseBranch}`,
			files,
			artifacts,
		].filter(Boolean) as string[];
		const ask = this.#options.askAgent;
		return h(
			"div",
			{ class: "coding-pr" },
			h(
				"div",
				{ class: "coding-pr-card" },
				svgEl(PR_GLYPH, 22, "coding-pr-glyph"),
				h(
					"div",
					{ class: "coding-pr-body" },
					h(
						"div",
						{ class: "coding-pr-title" },
						pr.title ?? t("Draft pull request"),
						h("span", { class: "coding-pr-number" }, ` #${pr.number}`),
					),
					h("div", { class: "coding-pr-meta" }, meta.join(" · ")),
					session.checks.length
						? h(
								"div",
								{ class: "coding-checks" },
								...session.checks.map((check) =>
									h(
										"div",
										{ class: "coding-check" },
										h("span", {
											class: `coding-dot coding-dot-${checkTone(check.status)}`,
											"aria-hidden": "true",
										}),
										h("span", null, `${check.name} · ${check.status}`),
									),
								),
							)
						: null,
				),
			),
			h(
				"div",
				{ class: "coding-actions" },
				h(
					"a",
					{
						class: "btn btn-small btn-primary",
						href: `${pr.url}/files`,
						target: "_blank",
						rel: "noopener noreferrer",
					},
					t("Review changes"),
				),
				h(
					"a",
					{ class: "btn btn-small", href: pr.url, target: "_blank", rel: "noopener noreferrer" },
					t("Open on GitHub"),
				),
				ask
					? button(
							t("Ask {name} to review", { name: names.agent }),
							() =>
								ask(
									// The quotes travel with the title: a key is written in double quotes.
									t(
										"Please review the draft PR #{number} from your coding session {title} and tell me what you think.",
										{ number: pr.number, title: `"${session.title}"` },
									),
								),
							{ small: true },
						)
					: null,
			),
		);
	}

	#renderInput(names: CodingSessionNames): HTMLElement {
		const session = this.#session;
		const harness = HARNESS_NAMES[session.harness];
		const takesInput = codingSessionTakesInput(session);
		const asking = session.phase === "awaiting_input";
		const question = asking ? [...this.#events].reverse().find((event) => event.kind === "needs_input") : undefined;
		const choices = question ? options(question.body) : [];
		const field = h("input", {
			type: "text",
			class: "coding-field-input",
			"aria-label": asking ? t("Answer the session") : t("Follow up on the session"),
			placeholder: asking
				? choices.length
					? t("Or answer in your own words")
					: t("Answer the session")
				: takesInput
					? t("Follow up on this session")
					: t("The session is working"),
			value: this.#draft,
			disabled: !takesInput || this.#busy,
			oninput: (event: Event) => {
				this.#draft = (event.target as HTMLInputElement).value;
			},
			onkeydown: (event: KeyboardEvent) => {
				if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
					event.preventDefault();
					void this.#send(this.#draft);
				}
			},
		});
		const send = button(
			this.#busy ? t("Sending…") : asking ? t("Answer") : t("Send"),
			() => void this.#send(this.#draft),
			{
				small: true,
				primary: true,
				disabled: !takesInput || this.#busy,
			},
		);
		send.classList.add("coding-send");
		const hint = asking
			? t("Your answer goes to {harness} and is recorded in this thread.", { harness })
			: takesInput
				? t("A follow-up starts the session again on the same branch. Uses your {harness} plan.", { harness })
				: session.phase === "queued"
					? t("You can talk to the session once it starts. Uses your {harness} plan.", { harness })
					: t(
							"The session is working; you can answer when it asks or follow up when it is done. Uses your {harness} plan.",
							{ harness },
						);
		return h(
			"div",
			{ class: "coding-talk" },
			choices.length
				? h(
						"div",
						{ class: "coding-options" },
						...choices.map((choice, index) =>
							button(choice, () => void this.#send(choice), {
								small: true,
								primary: index === 0,
								disabled: this.#busy,
							}),
						),
					)
				: null,
			asking
				? h(
						"div",
						{ class: "coding-options" },
						button(t("Let {name} decide", { name: names.agent }), () => void this.#delegate(), {
							small: true,
							disabled: this.#busy,
						}),
					)
				: null,
			h("div", { class: "coding-field" }, field, send),
			this.#error ? h("div", { class: "coding-hint coding-row-error", role: "alert" }, this.#error) : null,
			h("div", { class: "coding-hint" }, hint),
		);
	}

	#renderLock(names: CodingSessionNames): HTMLElement {
		const harness = HARNESS_NAMES[this.#session.harness];
		return h(
			"div",
			{ class: "coding-talk coding-talk-locked" },
			h(
				"div",
				{ class: "coding-hint" },
				svgEl(LOCK_GLYPH, 12, "coding-glyph"),
				t("Only {owner} can type here. Everyone else steers through {agent}. Uses {ownerName}'s {harness} plan.", {
					owner: names.owner,
					agent: names.agent,
					ownerName: cap(names.owner),
					harness,
				}),
			),
		);
	}
}

/** How a session's figure moves in the header, in the agents' own vocabulary:
 * working while it works, waiting while it asks, still while it waits for a computer. */
export function codingSessionActivity(phase: CodingSession["phase"]): Activity {
	if (phase === "awaiting_input") return "Waiting";
	if (phase === "queued" || codingSessionSettled(phase)) return "Idle";
	return "Working";
}

/** A session that is still going, in the thread's header beside the agent: the
 * agent's figure wearing the harness mark, with its own clock so it does not move
 * in step with the agent. Hover or focus unfolds the session's title; a click
 * opens the session as its own thread. */
export class CodingSessionSlot {
	readonly el: HTMLButtonElement;
	readonly #avatar = h("span", { class: "coding-slot-avatar" });
	readonly #name = h("span", { class: "coding-slot-name" });
	#figureKey = "";

	constructor(workerId: string, open: (opener: HTMLElement) => void) {
		this.el = h(
			"button",
			{ type: "button", class: "coding-slot", dataset: { workerId }, onclick: () => open(this.el) },
			this.#avatar,
			this.#name,
		) as HTMLButtonElement;
	}

	update(session: CodingSession, agent: HostedStaffAgent | undefined, names: CodingSessionNames): void {
		const activity = codingSessionActivity(session.phase);
		const figureKey = JSON.stringify([activity, session.harness, agent?.id, agent?.appearance, agent?.templateId]);
		if (figureKey !== this.#figureKey) {
			this.#figureKey = figureKey;
			// The button's own title names the session; the badge's would cover it.
			const badge = harnessBadge(session.harness);
			badge.removeAttribute("title");
			replace(
				this.#avatar,
				agentFigure(agent, names.agent, { size: 22, activity, identity: `coding:${session.workerId}` }),
				badge,
			);
		}
		const status = codingSessionStatus(session, names);
		const label = `${session.title} · ${status.text}`;
		if (this.#name.textContent !== session.title) this.#name.textContent = session.title;
		this.el.title = label;
		this.el.setAttribute("aria-label", t("{label}. Open the session", { label }));
		this.el.dataset.tone = status.tone;
	}
}
