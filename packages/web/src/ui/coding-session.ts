/* A coding session in the thread: the centered "sandwich" approved on
 * 2026-09-22. One dashed line carries the start caption ("Mark started a coding
 * session with you in Codex: Fix the delay after send") with the agent's figure
 * and the owner's avatar wearing the harness badge; collapsed, only the live
 * status stands under it; expanded, the session's own steps, the harness's
 * voice, the owner's input and the pull request follow, closed by a second
 * dashed line with the status. Everything here is a projection of the kernel's
 * session view and event stream; nothing comes from the agent's prose.
 *
 * The element persists per session across renders of the thread and follows
 * its stream itself: a short poll while the session works, a slower one while
 * it waits or after it finished (a follow-up starts it again). */

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
import { button, h, personAvatar, replace } from "./dom.ts";

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

/** The first caption: who started what, with whom, where. Once the session
 * settled or asked something, the caption says so instead of the title. */
export function codingSessionCaption(session: CodingSession, names: CodingSessionNames): string {
	const harness = HARNESS_NAMES[session.harness];
	const head = `${names.agent}'s coding session with ${names.owner} in ${harness}`;
	switch (session.phase) {
		case "awaiting_input":
			return `${head} needs ${names.ownerIsViewer ? "your answer" : `an answer from ${names.owner}`}`;
		case "completed":
			return session.pullRequest ? `${head} opened a draft PR` : `${head} finished`;
		case "failed":
			return `${head} failed`;
		case "cancelled":
			return `${head} was cancelled`;
		default:
			return `${names.agent} started a coding session with ${names.owner} in ${harness}: ${session.title}`;
	}
}

export function fmtDuration(ms: number): string {
	const minutes = Math.max(0, Math.floor(ms / 60_000));
	if (minutes < 1) return "less than a minute";
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? `${hours} h ${rest} min` : `${hours} h`;
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
			? `${session.filesChanged} file${session.filesChanged === 1 ? "" : "s"} changed`
			: undefined;
	switch (session.phase) {
		case "queued":
			return { text: "Waiting for a computer", tone: "idle" };
		case "preparing":
			return {
				text: ["Preparing the workspace", since(session.updatedAt)].filter(Boolean).join(" · "),
				tone: "working",
			};
		case "running":
			return {
				text: ["Working", since(session.startedAt), session.lastStep, files].filter(Boolean).join(" · "),
				tone: "working",
			};
		case "awaiting_input":
			return {
				text: names.ownerIsViewer
					? "Needs you · your answer is recorded in this thread"
					: [`Needs ${names.owner}`, `paused ${since(session.updatedAt) ?? "now"}`].join(" · "),
				tone: "attention",
			};
		case "input_ready":
			return { text: "Answer sent · waiting for the session", tone: "working" };
		case "publishing":
			return { text: ["Opening the pull request", files].filter(Boolean).join(" · "), tone: "working" };
		case "completed":
			return {
				text: session.pullRequest
					? "Draft PR ready · session kept for follow-ups"
					: "Finished · session kept for follow-ups",
				tone: "done",
			};
		case "failed":
			return { text: "Failed · workspace kept", tone: "failed" };
		case "cancelled":
			return { text: "Cancelled · workspace kept", tone: "idle" };
	}
}

export interface CodingSessionApi {
	read(workerId: string, afterEvent: number): Promise<CodingSessionRead>;
	answer(workerId: string, text: string, clientRequestId: string): Promise<void>;
	delegate(workerId: string, clientRequestId: string): Promise<void>;
}

export interface CodingSessionElementOptions {
	agent: HostedStaffAgent | undefined;
	/** Read at every render with the current session: names follow the roster and the owner. */
	names: (session: CodingSession) => CodingSessionNames;
	/** Whether the signed-in member owns the session (the kernel says; the listing repeats it). */
	viewerOwns: (session: CodingSession) => boolean;
	api: CodingSessionApi;
	signal: AbortSignal;
	/** The element changed height or content; the thread may re-pin. */
	changed?: () => void;
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

const CLAUDE_GLYPH = '<path d="M12 2l1.8 5.4L19 9l-5.2 1.6L12 16l-1.8-5.4L5 9l5.2-1.6z" fill="currentColor"/>';
const CODEX_GLYPH =
	'<path d="M5 7l6 5-6 5" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 19h7" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/>';

/** The harness mark the owner's avatar wears: Codex's prompt, Claude's spark. */
function harnessBadge(harness: CodingHarness): HTMLElement {
	return h(
		"span",
		{ class: `coding-badge coding-badge-${harness}`, title: HARNESS_NAMES[harness] },
		svgEl(harness === "claude-code" ? CLAUDE_GLYPH : CODEX_GLYPH, 7),
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
	/** Undefined until the member chose: a question the viewer must answer opens the body by itself. */
	#expanded: boolean | undefined;
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
			"aria-label": "Coding session",
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
		if (newer) this.#session = { ...session, isOwner: session.isOwner ?? this.#session.isOwner };
		this.#render();
		// A phase the poll did not see yet (an answer landed, the executor took it) shortens the wait.
		if (newer && session.phase !== this.#session.phase) void this.refresh();
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

	#toggle(): void {
		this.#expanded = !this.#isExpanded();
		this.#render();
		this.#options.changed?.();
	}

	#isExpanded(): boolean {
		if (this.#expanded !== undefined) return this.#expanded;
		return this.#session.phase === "awaiting_input" && this.#options.viewerOwns(this.#session);
	}

	async #send(text: string): Promise<void> {
		const value = text.trim();
		if (!value || this.#busy || this.disposed) return;
		// The member is in the session now: it stays open through the answer and what follows.
		this.#expanded = true;
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
		this.#expanded = true;
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
		const expanded = this.#isExpanded();
		const status = codingSessionStatus(session, names);
		const key = JSON.stringify([
			session,
			names,
			owns,
			expanded,
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
		this.el.classList.toggle("coding-session-expanded", expanded);
		const caption = codingSessionCaption(session, names);
		this.el.setAttribute("aria-label", caption);
		const toggle = button(expanded ? "Hide" : "Show", () => this.#toggle(), { small: true });
		toggle.className = "coding-link";
		toggle.setAttribute("aria-expanded", String(expanded));
		const avatar = h(
			"span",
			{ class: "coding-owner", title: names.ownerIsViewer ? "You" : names.owner },
			personAvatar(names.ownerIsViewer ? "You" : names.owner, session.ownerUserId),
			harnessBadge(session.harness),
		);
		const start = h(
			"div",
			{ class: `coding-line coding-line-start coding-tone-${status.tone}` },
			h("span", { class: "coding-rule", "aria-hidden": "true" }),
			h(
				"span",
				{ class: "coding-label" },
				agentFigure(this.#options.agent, names.agent, { size: 22 }),
				avatar,
				h("span", { class: "coding-caption" }, caption),
				h("span", { class: "coding-dot-sep", "aria-hidden": "true" }, "·"),
				toggle,
			),
			h("span", { class: "coding-rule", "aria-hidden": "true" }),
		);
		const statusLabel = h(
			"span",
			{ class: "coding-status-label" },
			h("span", { class: `coding-dot coding-dot-${status.tone}`, "aria-hidden": "true" }),
			h("span", null, status.text),
		);
		if (!expanded) {
			replace(
				this.el,
				start,
				h("div", { class: `coding-status coding-tone-${status.tone}`, role: "status" }, statusLabel),
			);
			return;
		}
		replace(
			this.el,
			start,
			this.#renderHead(names),
			this.#renderBody(names),
			session.pullRequest ? this.#renderPullRequest(names) : null,
			owns ? this.#renderInput(names) : this.#renderLock(names),
			h(
				"div",
				{ class: `coding-line coding-line-end coding-tone-${status.tone}`, role: "status" },
				h("span", { class: "coding-rule", "aria-hidden": "true" }),
				statusLabel,
				h("span", { class: "coding-rule", "aria-hidden": "true" }),
			),
		);
	}

	#renderHead(names: CodingSessionNames): HTMLElement {
		const session = this.#session;
		const meta = [
			session.repository.name,
			shortBranch(session.branch),
			session.model,
			`managed by ${names.agent}`,
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
							`${folded} earlier step${folded === 1 ? "" : "s"}`,
							() => {
								this.#showAll = true;
								this.#render();
								this.#options.changed?.();
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
							? "Waiting for a computer to start the session."
							: "Nothing reported yet.",
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
				const title = text(event.body, "text", "title", "command", "summary") ?? "Step";
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
					h(
						"span",
						{ class: `coding-voice coding-badge-${this.#session.harness}`, title: harness },
						harnessBadge(this.#session.harness),
					),
					h("div", { class: "coding-voice-text" }, ...body.split(/\n{2,}/).map((part) => h("p", null, part))),
				);
			}
			case "needs_input": {
				const question =
					text(event.body, "needs", "question") ?? this.#session.needs ?? "The session has a question.";
				return h(
					"div",
					{ class: "coding-row coding-row-question" },
					h(
						"div",
						{ class: "coding-question" },
						h("div", { class: "coding-question-from" }, harnessBadge(this.#session.harness), `${harness} asks`),
						h("div", null, question),
					),
				);
			}
			case "input": {
				const who = event.actor === "agent" ? names.agent : names.ownerIsViewer ? "You" : names.owner;
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
					`${names.ownerIsViewer ? "You" : names.owner} left it to ${names.agent}`,
				);
			case "published": {
				const url = text(event.body, "url");
				const number =
					typeof event.body === "object" && event.body && !Array.isArray(event.body)
						? event.body.number
						: undefined;
				const label = `Draft PR${typeof number === "number" ? ` #${number}` : ""} opened`;
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
						? "The computer running this session stopped answering. The workspace is kept; a follow-up starts it again."
						: `Failed${reason ? `: ${reason}` : ""}`,
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
			session.filesChanged > 0 ? `${session.filesChanged} file${session.filesChanged === 1 ? "" : "s"}` : undefined;
		const artifacts = session.artifacts.length
			? `${session.artifacts.length} artifact${session.artifacts.length === 1 ? "" : "s"}`
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
						pr.title ?? "Draft pull request",
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
					"Review changes",
				),
				h(
					"a",
					{ class: "btn btn-small", href: pr.url, target: "_blank", rel: "noopener noreferrer" },
					"Open on GitHub",
				),
				ask
					? button(
							`Ask ${names.agent} to review`,
							() =>
								ask(
									`Please review the draft PR #${pr.number} from your coding session "${session.title}" and tell me what you think.`,
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
			"aria-label": asking ? "Answer the session" : "Follow up on the session",
			placeholder: asking
				? choices.length
					? "Or answer in your own words"
					: "Answer the session"
				: takesInput
					? "Follow up on this session"
					: "The session is working",
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
		const send = button(this.#busy ? "Sending…" : asking ? "Answer" : "Send", () => void this.#send(this.#draft), {
			small: true,
			primary: true,
			disabled: !takesInput || this.#busy,
		});
		send.classList.add("coding-send");
		const hint = asking
			? `Your answer goes to ${harness} and is recorded in this thread.`
			: takesInput
				? `A follow-up starts the session again on the same branch. Uses your ${harness} plan.`
				: session.phase === "queued"
					? `You can talk to the session once it starts. Uses your ${harness} plan.`
					: `The session is working; you can answer when it asks or follow up when it is done. Uses your ${harness} plan.`;
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
						button(`Let ${names.agent} decide`, () => void this.#delegate(), {
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
				`Only ${names.owner} can type here. Everyone else steers through ${names.agent}. Uses ${cap(names.owner)}'s ${harness} plan.`,
			),
		);
	}
}
