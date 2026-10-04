import type { NativeExecutionConnections } from "@qorpera/cloud-client/cloud-native-subscription-control";
import {
	CLOUD_ROUTINE_WEEKDAYS,
	type CloudRoutine,
	type CloudRoutineOccurrence,
	type CloudRoutineReplyPolicy,
	type CloudRoutineTrigger,
	type CloudRoutineWeekday,
	cloudRoutineWeekdayName,
	describeCloudRoutineTrigger,
	parseCloudRoutineTrigger,
} from "@qorpera/cloud-client/cloud-routines";
import { WebCompanyFolderRejectedError, withProblems } from "../../cloud/company-folder-writes.ts";
import { planLogin, type WebMemberConnection } from "../../cloud/native-subscription.ts";
import {
	canPayForRoutine,
	claudeLogin,
	type WebRoutine,
	WebRoutineChangedError,
	WebRoutineEndedError,
	type WebRoutineFile,
	WebRoutineGoneError,
	WebRoutineNoPayerError,
	type WebRoutines,
} from "../../cloud/routines.ts";
import type { HostedStaffAgent } from "../../cloud/types.ts";
import { dialogPageHeader } from "../../ui/dialog.ts";
import { button, fmtTime, h, icon, replace } from "../../ui/dom.ts";
import { phrase, presentationLocale, presentationTimeZone, t } from "../../ui/preferences.ts";
import { uiScale } from "../../ui/scale.ts";
import type { CompanyController } from "../company.ts";
import type { WorkspaceActions } from "../workspace-actions.ts";
import { effortName } from "./composer-models.ts";

export interface AgentRoutineAccess {
	routines: WebRoutines;
	/** The signed-in member's own model accounts. */
	accounts: (signal: AbortSignal) => Promise<NativeExecutionConnections>;
	/** Owners and admins create, change, pause and resume routines. */
	canManage: () => boolean;
	/** A member's name, for a routine that started again when they turned on work while away. */
	memberName?: (userId: string) => string | undefined;
}

/** Routine access for the signed-in member, or none when the page was not given the routine calls. */
export function routineAccessFor(
	company: CompanyController,
	actions: WorkspaceActions,
): AgentRoutineAccess | undefined {
	const routines = actions.routines,
		accounts = actions.nativeSubscription;
	if (!routines || !accounts) return undefined;
	return {
		routines,
		accounts: (signal) => accounts.listConnections(signal),
		canManage: () => company.store.get().team?.capabilities.authorize === true,
		memberName: (userId) => company.store.get().team?.members.find((member) => member.userId === userId)?.displayName,
	};
}

type Shape = "interval" | "weekly";
const UNITS = { minutes: 1, hours: 60, days: 1440 } as const;
/** An interval runs every 5 minutes at most and once a week at least (the routine file's `minutes`). */
const INTERVAL_MINUTES = { min: 5, max: 10_080 } as const;

/** The shape of a schedule the editor makes: every so many minutes, or days at a time. */
function shapeOf(trigger: CloudRoutineTrigger): Shape | undefined {
	if (trigger.kind !== "schedule" || "windowStart" in trigger) return undefined;
	return "localTime" in trigger ? "weekly" : "interval";
}

/** The editor shows a routine's one trigger: an interval or days at a time. Anything else (more triggers, a time
 * window, a file change, a hook's events) has no shape here, and a save would drop what the editor cannot show. A
 * file change is not offered: a folder-v2 company's routines do not start on one until the folder's file events reach
 * routines. */
function editorShape(routine: CloudRoutine): Shape | undefined {
	const [trigger, ...more] = routine.triggers;
	return trigger && !more.length ? shapeOf(trigger) : undefined;
}

/** The cloud lists one row per connection version; the picker offers each account
 * once, at its newest version (a consent raises the version, not the account). */
function latestVersions(accounts: readonly WebMemberConnection[]): WebMemberConnection[] {
	const newest = new Map<string, WebMemberConnection>();
	for (const account of accounts) {
		const current = newest.get(account.connectionId);
		if (!current || current.connectionVersion < account.connectionVersion) newest.set(account.connectionId, account);
	}
	return [...newest.values()];
}

function accountLabel(account: WebMemberConnection): string {
	const name = planLogin(account)
		? t("ChatGPT plan")
		: account.provider === "openai" || account.provider === "openai-codex"
			? "ChatGPT"
			: account.provider === "anthropic"
				? "Claude"
				: account.provider;
	const who = account.providerAccountEmail ?? account.providerAccountReference;
	return who ? `${name} · ${who}` : name;
}

/** Option labels for the account picker. The same account connected more than once
 * (each sign-in adds a connection) would read identically, so repeats are numbered in
 * list order: "ChatGPT · name@example.com", "… (2)", "… (3)". */
function accountLabels(accounts: readonly WebMemberConnection[]): string[] {
	const seen = new Map<string, number>();
	return accounts.map((account) => {
		const label = accountLabel(account);
		const count = (seen.get(label) ?? 0) + 1;
		seen.set(label, count);
		return count === 1 ? label : `${label} (${count})`;
	});
}

const RUN_LABELS: Record<string, string> = {
	pending: phrase("Waiting to start"),
	queued: phrase("Waiting to start"),
	running: phrase("Running"),
	completed: phrase("Finished"),
	blocked: phrase("Could not start"),
	failed: phrase("Failed"),
	cancelled: phrase("Cancelled"),
	superseded: phrase("Skipped"),
};

function runLabel(run: CloudRoutineOccurrence): string {
	const status = Object.hasOwn(RUN_LABELS, run.status) ? t(RUN_LABELS[run.status]!) : run.status;
	return `${status} · ${fmtTime(run.finishedAt ?? run.scheduledFor ?? run.createdAt)}`;
}

/** Why a paused routine waits, in plain words, or null when the cloud gave no reason this page knows. The reasons are
 * the routine index's (`pause_reason`): a member or its agent paused it, it could not start with the access it had, no
 * model account pays for it, or its agent was archived (F2's P15, which pauses an archived agent's routines; the pause
 * stays until a member resumes the routine, also after the agent is active again). */
function pauseWords(reason: string | undefined, agentName: string): string | null {
	switch (reason) {
		case "member":
			return t("Paused by a member");
		case "agent":
			return t("Paused by {name}", { name: agentName });
		case "authorization_failed":
			return t("Paused: it could not start with the access it had");
		case "needs_model_account":
			return t("Paused: no model account pays for it");
		case "agent_archived":
			return t("Paused when its agent was archived");
		default:
			return null;
	}
}

function controlLabel(control: Element): string {
	return control.getAttribute("aria-label") ?? control.textContent ?? "";
}

/** A clock time such as "08:48" as the viewer's language writes it: "8:48 AM", "08.48". */
function clockTime(localTime: string): string {
	const [hour, minute] = localTime.split(":").map(Number);
	return new Date(Date.UTC(2000, 0, 1, hour!, minute!)).toLocaleTimeString(presentationLocale(), {
		hour: "numeric",
		minute: "2-digit",
		timeZone: "UTC",
	});
}

/** When a trigger runs, in few words: "Weekdays at 8:48 AM". A weekly time is on
 * the routine's own clock; the caller says which zone that is. */
function whenWords(trigger: CloudRoutineTrigger): string {
	if (!("localTime" in trigger)) return describeCloudRoutineTrigger(trigger, t);
	const days = new Set(trigger.weekdays),
		time = clockTime(trigger.localTime);
	if (days.size === 7) return t("Every day at {time}", { time });
	if (days.size === 5 && !days.has("saturday") && !days.has("sunday")) return t("Weekdays at {time}", { time });
	if (days.size === 2 && days.has("saturday") && days.has("sunday")) return t("Weekends at {time}", { time });
	return t("{days} at {time}", {
		days: CLOUD_ROUTINE_WEEKDAYS.filter((day) => days.has(day))
			.map((day) => cloudRoutineWeekdayName(day, t))
			.join(", "),
		time,
	});
}

/** A trigger in few words, naming a weekly time's zone when it is not the viewer's own. */
function whenShort(trigger: CloudRoutineTrigger): string {
	const words = whenWords(trigger);
	return "localTime" in trigger && trigger.timeZone !== presentationTimeZone()
		? `${words} (${trigger.timeZone})`
		: words;
}

/** Fades the prompt's edges where more of it lies above or below. */
function markOverflow(prompt: HTMLElement): void {
	prompt.toggleAttribute("data-above", prompt.scrollTop > 0);
	prompt.toggleAttribute("data-below", prompt.scrollTop + prompt.clientHeight < prompt.scrollHeight - 1);
}

/** The clock a zone shows at an instant, to the minute, written as a UTC time value. */
function wallClock(instant: number, timeZone: string): number {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-CA", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
		})
			.formatToParts(instant)
			.map((part) => [part.type, Number(part.value)]),
	);
	return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!);
}

/** A weekly routine's first-run instant, moved by as much as the member moved
 * its clock time on that day: an earlier time still runs on the chosen day
 * instead of the next one. Unmoved when either time does not exist that day. */
function movedStart(
	startAt: string,
	from: { localTime: string; timeZone: string },
	to: { localTime: string; timeZone: string },
): string {
	const day = Math.floor(wallClock(Date.parse(startAt), from.timeZone) / 86_400_000) * 86_400_000;
	const at = ({ localTime, timeZone }: { localTime: string; timeZone: string }) => {
		const [hour, minute] = localTime.split(":").map(Number);
		const wall = day + (hour! * 60 + minute!) * 60_000;
		let instant = wall;
		for (let attempt = 0; attempt < 4; attempt += 1) instant += wall - wallClock(instant, timeZone);
		return wallClock(instant, timeZone) === wall ? instant : undefined;
	};
	const before = at(from),
		after = at(to);
	return before === undefined || after === undefined
		? startAt
		: new Date(Date.parse(startAt) + after - before).toISOString();
}

/** The Routines page of an agent's details: standing work the cloud starts on a schedule. Each routine is a file in
 * the company's folder, `agents/<handle>/routines/<key>.md`, which the switch and the editor write as the member
 * (folder core C4, P34r). */
export class AgentRoutines {
	readonly el = h("section", { class: "agent-page agent-routines" });
	/** The agent as it is now, so a rename shows here without reopening. */
	readonly #agent: () => HostedStaffAgent;
	readonly #access: AgentRoutineAccess | undefined;
	readonly #signal: AbortSignal;
	readonly #back: (() => void) | undefined;
	#routines: WebRoutine[] = [];
	#runs: CloudRoutineOccurrence[] = [];
	/** The routines whose file this member finds: only those have a switch and Edit. */
	#files: ReadonlySet<string> = new Set();
	#accounts: WebMemberConnection[] = [];
	#busy = false;
	#editing = false;
	/** Until the first read answers, an empty list means "not known yet". */
	#loaded = false;
	#message = "";
	/** The one routine whose card is open. */
	#open: string | undefined;
	/** Switches the member moved, shown where they were moved until a list read
	 * after the change comes back; a change that failed moves its switch back. */
	readonly #flipped = new Map<string, boolean>();
	/** The routine whose switch is being changed now. */
	#moving: string | undefined;
	/** Counts switch changes, so a read that went out before one does not undo it. */
	#changes = 0;
	/** Numbers each list read, so an answer older than one already shown is dropped. */
	#reads = 0;
	#shown = 0;
	/** Stops waiting for the last opened card to finish growing. */
	#opening: AbortController | undefined;
	readonly #prompts =
		typeof ResizeObserver === "function"
			? new ResizeObserver((entries) => {
					for (const entry of entries) markOverflow(entry.target as HTMLElement);
				})
			: undefined;
	/** `back` leaves the list for the page this one was opened from. */
	constructor(
		agent: () => HostedStaffAgent,
		access: AgentRoutineAccess | undefined,
		signal: AbortSignal,
		back?: () => void,
	) {
		this.#agent = agent;
		this.#access = access;
		this.#signal = signal;
		this.#back = back;
		signal.addEventListener("abort", () => this.#prompts?.disconnect(), { once: true });
		this.#list();
		if (access) void this.#refresh();
	}
	/** Reads the list again, unless a routine is open in the editor. */
	refresh(): void {
		if (!this.#editing && !this.#busy) void this.#refresh();
	}
	async #refresh(): Promise<void> {
		const access = this.#access;
		if (!access || this.#signal.aborted) return;
		const read = ++this.#reads;
		// A read that went out before a switch was moved may predate the change.
		const changes = this.#changes;
		try {
			const [routines, runs, files] = await Promise.all([
				access.routines.list(),
				access.routines.runs(),
				access.routines.files(),
			]);
			if (this.#signal.aborted || read < this.#shown) return;
			this.#shown = read;
			this.#routines = routines.filter(
				(item) => item.staffAgentId === this.#agent().id && item.status !== "retired",
			);
			this.#runs = runs;
			this.#files = files;
			if (changes === this.#changes && !this.#busy) this.#flipped.clear();
			this.#message = "";
		} catch {
			if (this.#signal.aborted || read < this.#shown) return;
			this.#message = t("Routines could not be read. Refresh to try again.");
		}
		this.#loaded = true;
		if (!this.#editing) this.#list();
	}
	#list(): void {
		this.#editing = false;
		const focused = this.#focused();
		const access = this.#access;
		const manage = access?.canManage() === true;
		const create = manage
			? button([icon("plus"), t("New routine")], () => void this.#edit(undefined), { disabled: this.#busy })
			: null;
		// The open instruction keeps its place through a redraw.
		const scrolled = this.#cardFor(this.#open)?.querySelector(".routine-card-prompt")?.scrollTop ?? 0;
		const cards = this.#routines.map((routine) => this.#card(routine, manage));
		replace(
			this.el,
			dialogPageHeader(
				t("Routines"),
				this.#back,
				t("Back to agent details"),
				t("Recurring work, on a schedule or when something happens."),
			),
			this.#message ? h("p", { class: "surface-status", role: "status" }, this.#message) : null,
			cards.length
				? [
						h("div", { class: "routine-list" }, ...cards),
						create ? h("div", { class: "routine-list-footer" }, create) : null,
					]
				: access && !this.#loaded
					? h("p", { class: "agent-page-loading", role: "status" }, t("Reading routines…"))
					: h(
							"div",
							{ class: "agent-page-empty" },
							icon("clock"),
							h(
								"p",
								null,
								access
									? t("{name} has no routines yet.", { name: this.#agent().displayName })
									: t("Routines will appear here."),
							),
							create,
						),
		);
		const kept = this.#cardFor(this.#open)?.querySelector(".routine-card-prompt");
		if (kept) kept.scrollTop = scrolled;
		this.#prompts?.disconnect();
		for (const prompt of this.el.querySelectorAll<HTMLElement>(".routine-card-prompt")) {
			markOverflow(prompt);
			this.#prompts?.observe(prompt);
		}
		this.#refocus(focused);
	}
	/** One routine as a card: its name, when it runs and a switch that pauses it.
	 * Opened, the instruction reads beside the facts and Edit appears by the switch. */
	#card(routine: WebRoutine, manage: boolean): HTMLElement {
		const id = routine.routineId;
		const open = this.#open === id;
		const last = this.#runs.find((run) => run.routineId === id);
		// A dynamic routine has one next run at a time, chosen by its agent after each run.
		const dynamic = routine.triggers.some((trigger) => trigger.kind === "once");
		const ended = routine.status === "expired" || routine.status === "concluded";
		// A routine is its file: one this member does not find (out of their reach, from before the files, or a cloud
		// that does not list them yet) cannot be changed from here.
		const known = this.#files.has(id);
		// A concluded routine plans no more runs; its agent's reason says why.
		const concluded = routine.status === "concluded" ? routine.conclusion : null;
		// Why a paused routine waits, while it is paused as the member sees it.
		const paused =
			routine.status === "paused" && !this.#runsNow(routine)
				? pauseWords(routine.pauseReason, this.#agent().displayName)
				: null;
		const fact = (label: string, ...value: (Node | string | null)[]) =>
			h("div", { class: "routine-card-fact" }, h("dt", null, label), h("dd", null, ...value));
		const lever = h("button", {
			type: "button",
			role: "switch",
			class: "routine-switch",
			"aria-label": routine.title,
			onclick: () => void this.#toggle(routine),
		});
		this.#setLever(lever, routine, manage);
		const edit = button(t("Edit"), () => void this.#edit(routine), { small: true, disabled: this.#busy });
		edit.classList.add("routine-card-edit");
		return h(
			"article",
			{ class: open ? "routine-card is-open" : "routine-card", dataset: { routineId: id } },
			h(
				"div",
				{
					class: "routine-card-head",
					// The head's own room around its controls opens the card too.
					onclick: (event: MouseEvent) => {
						if (!(event.target as Element).closest("button")) this.#expand(id);
					},
				},
				h(
					"button",
					{
						type: "button",
						class: "routine-card-summary",
						"aria-expanded": String(open),
						"aria-controls": `routine-${id}`,
						onclick: () => this.#expand(id),
					},
					h("strong", null, routine.title),
					h("span", null, concluded ?? routine.triggers.map(whenShort).join("; ")),
					paused ? h("span", { class: "routine-card-paused" }, paused) : null,
				),
				// An ended routine is read-only: a member save keeps its end (its expiry or run
				// limit), so neither Edit nor Resume could start it again. Its agent can. The
				// editor has no shape for a dynamic routine: its agent changes it, and a member
				// may pause and resume it.
				manage && known && !ended && !dynamic && editorShape(routine) ? edit : null,
				ended
					? h("span", { class: "routine-card-state" }, routine.status === "concluded" ? t("Done") : t("Ended"))
					: known
						? lever
						: null,
			),
			h(
				"div",
				{ class: "routine-card-body", id: `routine-${id}`, inert: !open },
				h(
					"div",
					{ class: "routine-card-clip" },
					h(
						"div",
						{ class: "routine-card-inner" },
						h(
							"section",
							{ class: "routine-card-instruction" },
							h("h3", null, t("Instruction")),
							h(
								"div",
								{
									class: "routine-card-prompt",
									role: "region",
									tabindex: "0",
									"aria-label": t("Instruction"),
									onscroll: (event: Event) => markOverflow(event.currentTarget as HTMLElement),
								},
								routine.prompt,
							),
						),
						h(
							"dl",
							{ class: "routine-card-facts" },
							routine.status === "concluded"
								? null
								: fact(
										t("When to run"),
										h(
											"span",
											{ class: "routine-card-when" },
											icon("clock"),
											h(
												"span",
												null,
												...routine.triggers.map((trigger) =>
													h(
														"span",
														{ class: "routine-card-trigger" },
														whenWords(trigger),
														"localTime" in trigger ? h("small", null, trigger.timeZone) : null,
													),
												),
												dynamic && routine.status === "active"
													? h(
															"small",
															null,
															t("Runs until {name} decides it is done", {
																name: this.#agent().displayName,
															}),
														)
													: null,
											),
										),
									),
							routine.status === "active" && routine.nextRunAt
								? fact(t("Next run"), fmtTime(routine.nextRunAt))
								: null,
							concluded ? fact(t("Done"), concluded) : null,
							// Started again by the platform when its member turned on work while away for the
							// ChatGPT plan that pays (20260929985000), while that version is current.
							routine.status === "active" && routine.resumeReason === "plan_turned_on" && routine.resumedAt
								? fact(
										t("Resumed"),
										t("When {name} turned on “Work while you're away”", {
											name:
												(routine.resumedByUserId && this.#access?.memberName?.(routine.resumedByUserId)) ||
												t("a member"),
										}),
										" · ",
										fmtTime(routine.resumedAt),
									)
								: null,
							fact(t("Last run"), last ? runLabel(last) : t("Has not run yet")),
						),
					),
				),
			),
		);
	}
	/** Opens one card and closes the one that was open, in place. */
	#expand(id: string): void {
		const previous = this.#cardFor(this.#open);
		this.#open = this.#open === id ? undefined : id;
		const card = this.#cardFor(this.#open);
		for (const item of [previous, card]) {
			if (!item) continue;
			const open = item === card;
			item.classList.toggle("is-open", open);
			item.querySelector(".routine-card-summary")?.setAttribute("aria-expanded", String(open));
			item.querySelector(".routine-card-body")?.toggleAttribute("inert", !open);
		}
		this.#opening?.abort();
		if (!card) return;
		this.#reveal(card, previous);
		// The page cannot scroll past its end while the card is still growing, so a
		// card near the end is brought the rest of the way once it is open.
		const body = card.querySelector<HTMLElement>(".routine-card-body");
		if (!body || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
		const opening = new AbortController();
		this.#opening = opening;
		body.addEventListener(
			"transitionend",
			(event) => {
				if (event.target !== body || event.propertyName !== "grid-template-rows") return;
				opening.abort();
				if (this.#open === id && card.isConnected) this.#reveal(card, undefined);
			},
			{ signal: opening.signal },
		);
	}
	/** A switch as the routine stands, or where the member moved it. While one
	 * switch moves, the others wait. */
	#setLever(lever: HTMLElement, routine: CloudRoutine, manage: boolean): void {
		const id = routine.routineId;
		const on = this.#runsNow(routine);
		// A routine never runs under an archived agent: turned on, it is paused again at once.
		const archived = this.#archived();
		lever.setAttribute("aria-checked", String(on));
		lever.title = !manage
			? t("Only owners and admins can pause or resume routines.")
			: archived && !on
				? t("Reactivate the agent first")
				: on
					? t("Pause routine")
					: t("Resume routine");
		if (this.#moving === id) lever.setAttribute("aria-busy", "true");
		else lever.removeAttribute("aria-busy");
		const locked = !manage || (archived && !on);
		lever.classList.toggle("is-locked", locked);
		if (locked || (this.#busy && this.#moving !== id)) lever.setAttribute("aria-disabled", "true");
		else lever.removeAttribute("aria-disabled");
	}
	/** The agent is archived: its routines stay paused until it is active again. */
	#archived(): boolean {
		return this.#agent().employmentStatus === "archived";
	}
	/** Whether a routine runs, as the member sees it: where its switch was moved,
	 * else the last read. An editor save keeps this, not the state it opened with. */
	#runsNow(routine: CloudRoutine): boolean {
		const id = routine.routineId;
		return (
			this.#flipped.get(id) ?? (this.#routines.find((item) => item.routineId === id) ?? routine).status === "active"
		);
	}
	/** Brings the switches and buttons up to date in place, so a moved switch slides
	 * instead of being drawn anew in its new place. */
	#setControls(): void {
		const manage = this.#access?.canManage() === true;
		for (const lever of this.el.querySelectorAll<HTMLElement>(".routine-switch")) {
			const routine = this.#routines.find(
				(item) => item.routineId === lever.closest<HTMLElement>(".routine-card")?.dataset.routineId,
			);
			if (routine) this.#setLever(lever, routine, manage);
		}
		for (const control of this.el.querySelectorAll<HTMLButtonElement>(
			".routine-card-edit, .routine-list-footer .btn",
		))
			control.disabled = this.#busy;
		if (!this.#message) this.el.querySelector(":scope > .surface-status")?.remove();
	}
	#cardFor(id: string | undefined): HTMLElement | undefined {
		return id
			? [...this.el.querySelectorAll<HTMLElement>(".routine-card")].find((item) => item.dataset.routineId === id)
			: undefined;
	}
	/** Scrolls the page so the opening card will be seen whole, between the heading
	 * and the bottom edge, as it opens (a closing card above it gives its room back). */
	#reveal(card: HTMLElement, closing: HTMLElement | undefined): void {
		const scroller = this.el.parentElement,
			header = this.el.querySelector(".dialog-page-header");
		const clip = card.querySelector(".routine-card-clip"),
			inner = card.querySelector(".routine-card-inner");
		if (!scroller || !header || !clip || !inner || typeof scroller.scrollBy !== "function") return;
		const scale = uiScale();
		const box = card.getBoundingClientRect();
		const given =
			closing && closing.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING
				? (closing.querySelector(".routine-card-clip")?.getBoundingClientRect().height ?? 0)
				: 0;
		const top = box.top - given,
			bottom = top + box.height - clip.getBoundingClientRect().height + inner.getBoundingClientRect().height;
		const above = header.getBoundingClientRect().bottom + 8 * scale,
			below = scroller.getBoundingClientRect().bottom - 12 * scale;
		const by = bottom > below ? Math.min(bottom - below, top - above) : top < above ? top - above : 0;
		if (Math.abs(by) < 1) return;
		const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
		scroller.scrollBy({ top: by, behavior: still ? "auto" : "smooth" });
	}
	/** The focused control as its label and place among controls that share it,
	 * so a redrawn list can put focus back where it was. */
	#focused(): [string, number] | undefined {
		const active = document.activeElement;
		if (!(active instanceof HTMLElement) || !this.el.contains(active)) return undefined;
		const label = controlLabel(active);
		return [label, this.#controls(label).indexOf(active)];
	}
	#refocus(focused: [string, number] | undefined): void {
		if (!focused) return;
		const [label, index] = focused;
		const same = this.#controls(label);
		// A control that changed (Pause became Resume) hands focus to the way back.
		(same[index] ?? same[0] ?? this.#controls(t("Back to agent details"))[0])?.focus({ preventScroll: true });
	}
	#controls(label: string): HTMLElement[] {
		return [...this.el.querySelectorAll<HTMLElement>("button, .routine-card-prompt")].filter(
			(item) => controlLabel(item) === label,
		);
	}
	async #loadAccounts(): Promise<boolean> {
		try {
			const result = await this.#access!.accounts(this.#signal);
			if (this.#signal.aborted) return false;
			// A Claude login never pays for a routine. An account switched on for work while away comes first, as the
			// one a routine runs on; a ChatGPT plan its member has not turned on comes last: a routine cannot run on it
			// (Codex accounts keep their order).
			const accounts = latestVersions(
				result.connections.filter(
					(item) =>
						item.connectionStatus === "active" && item.authorizationState === "active" && !claudeLogin(item),
				),
			);
			const on = (item: WebMemberConnection) => canPayForRoutine(item) && item.allowAutonomous === true;
			this.#accounts = [
				...accounts.filter(on),
				...accounts.filter((item) => !on(item) && canPayForRoutine(item)),
				...accounts.filter((item) => !canPayForRoutine(item)),
			];
			return true;
		} catch {
			if (!this.#signal.aborted) {
				this.#message = t("Your model accounts could not be read. Try again.");
				this.#list();
			}
			return false;
		}
	}
	async #toggle(routine: CloudRoutine): Promise<void> {
		if (
			this.#busy ||
			!this.#access?.canManage() ||
			!this.#files.has(routine.routineId) ||
			(this.#archived() && !this.#runsNow(routine))
		)
			return;
		const id = routine.routineId;
		// Where the switch stood: a failed change puts it back there, even if that was a
		// place it was moved to whose change no read has confirmed yet.
		const previous = this.#flipped.get(id);
		const enabled = !this.#runsNow(routine);
		this.#busy = true;
		this.#moving = id;
		this.#changes += 1;
		// The switch moves at once and stays there until a list read after the change.
		this.#flipped.set(id, enabled);
		this.#message = "";
		this.#setControls();
		let failed = false;
		let failure = "";
		const listening = routine.triggers.some((item) => item.kind === "listener");
		try {
			// A pause needs no login. A resume runs on the first account that can pay: a ChatGPT plan only once its
			// member turned on work while away, and never for a file-change or webhook routine.
			let payer: WebMemberConnection | undefined;
			if (enabled && !(await this.#loadAccounts())) {
				failed = true;
				failure = this.#message;
			} else if (enabled) {
				payer = this.#accounts.find((item) => canPayForRoutine(item, listening));
				if (!payer) {
					failed = true;
					failure = !this.#accounts.length
						? t(
								"Connect a model account in Settings first; a routine runs on the account of the member who last saved it.",
							)
						: listening
							? t("A ChatGPT plan can't pay for routines that start on a file change or a webhook.")
							: t("Turn on “Work while you're away” for this ChatGPT plan in Settings first.");
				}
			}
			if (!failed) await this.#access.routines.setEnabled(routine, payer, enabled, crypto.randomUUID());
		} catch (error) {
			failed = true;
			// A routine that ended meanwhile shows as ended once the list is read again.
			failure = error instanceof WebRoutineEndedError ? "" : t("The routine could not be changed. Try again.");
		} finally {
			this.#busy = false;
			this.#moving = undefined;
			if (failed && previous === undefined) this.#flipped.delete(id);
			else if (failed) this.#flipped.set(id, previous!);
			if (!this.#signal.aborted) {
				this.#setControls();
				await this.#refresh();
				// The read clears the line; a failed change keeps saying why.
				if (failure && !this.#signal.aborted && !this.#editing) {
					this.#message = failure;
					this.#list();
				}
			}
		}
	}
	/** Opens the editor on a new routine, or on a routine's file as it is now: the read whose version a save names.
	 * `notice` stands on its status line, such as why the form opened again. */
	async #edit(routine: CloudRoutine | undefined, notice = ""): Promise<void> {
		const access = this.#access;
		if (this.#busy || this.#editing || !access?.canManage()) return;
		if (routine && (!editorShape(routine) || !this.#files.has(routine.routineId))) return;
		this.#editing = true;
		let opened: WebRoutineFile | undefined;
		if (routine) {
			try {
				opened = await access.routines.open(routine);
				if (!opened.trigger) throw new Error("The editor does not make this routine's schedule");
			} catch {
				if (this.#signal.aborted) return;
				this.#editing = false;
				await this.#refresh();
				if (this.#signal.aborted || this.#editing) return;
				this.#message = t("This routine could not be opened.");
				this.#list();
				return;
			}
		}
		if (!(await this.#loadAccounts())) {
			this.#editing = false;
			return;
		}
		if (this.#signal.aborted) return;
		// The form shows the file: its schedule, name, instructions and reply.
		const first = opened?.trigger;
		const shape: Shape = (first && shapeOf(first)) ?? "weekly";
		// A member's new routine runs at low effort, like a conversation; an edit keeps
		// the file's own, which its agent may have set to medium or high.
		const effort = opened?.file.effort ?? "low";
		// One id per draft, so a retry is the same routine. One save id per form: a change set whose answer never
		// came is sent again as it was by the next Save, and only an answer frees it.
		const clientRoutineId = opened?.file.id ?? crypto.randomUUID();
		const saveId = crypto.randomUUID();
		const zone = presentationTimeZone();
		const title = h("input", {
			type: "text",
			maxlength: "160",
			value: opened?.file.title ?? "",
			"aria-label": t("Routine name"),
		});
		const prompt = h(
			"textarea",
			{ rows: 5, maxlength: "8000", "aria-label": t("What to do"), value: opened?.file.instructions ?? "" },
			opened?.file.instructions ?? "",
		);
		const when = h(
			"select",
			{ "aria-label": t("When it runs") },
			h("option", { value: "weekly" }, t("On chosen days at a set time")),
			h("option", { value: "interval" }, t("Every so often")),
		);
		when.value = shape;
		const minutes = first?.kind === "schedule" && shape === "interval" ? first.intervalMinutes : 60;
		const unit = h(
			"select",
			{ "aria-label": t("Interval unit") },
			h("option", { value: "minutes" }, t("minutes")),
			h("option", { value: "hours" }, t("hours")),
			h("option", { value: "days" }, t("days")),
		);
		unit.value = minutes % 1440 === 0 ? "days" : minutes % 60 === 0 ? "hours" : "minutes";
		const every = h("input", {
			type: "number",
			value: String(minutes / UNITS[unit.value as keyof typeof UNITS]),
			"aria-label": t("Interval"),
		});
		// The bounds follow the unit: 5 to 10,080 minutes, 1 to 168 hours, 1 to 7 days.
		const bound = () => {
			const per = UNITS[unit.value as keyof typeof UNITS];
			every.min = String(Math.ceil(INTERVAL_MINUTES.min / per));
			every.max = String(Math.floor(INTERVAL_MINUTES.max / per));
		};
		unit.addEventListener("change", bound);
		bound();
		const chosen = new Set<CloudRoutineWeekday>(
			first && "localTime" in first ? first.weekdays : ["monday", "tuesday", "wednesday", "thursday", "friday"],
		);
		const days = h(
			"div",
			{ class: "routine-days", role: "group", "aria-label": t("Days") },
			...CLOUD_ROUTINE_WEEKDAYS.map((day) => {
				const box = h("input", { type: "checkbox", checked: chosen.has(day) });
				box.onchange = () => (box.checked ? chosen.add(day) : chosen.delete(day));
				return h("label", null, box, cloudRoutineWeekdayName(day, t));
			}),
		);
		const time = h("input", {
			type: "time",
			value: first && "localTime" in first ? first.localTime : "09:00",
			"aria-label": t("Time"),
		});
		const timeZone = h("input", {
			type: "text",
			value: first && "timeZone" in first ? first.timeZone : zone,
			"aria-label": t("Time zone"),
			maxlength: "128",
		});
		const reply = h(
			"select",
			{ "aria-label": t("Reply") },
			h("option", { value: "required" }, t("Always post a reply in the conversation")),
			h("option", { value: "optional" }, t("Reply only when there is something to say")),
			h("option", { value: "silent" }, t("Work silently")),
		);
		reply.value = first?.replyPolicy ?? "required";
		// Who pays: the routine runs on the member's own account that works while they're away. Only when none is
		// switched on does the member choose one here, which saving switches on.
		const own = this.#accounts.find((item) => canPayForRoutine(item) && item.allowAutonomous === true);
		const choices = own ? [] : this.#accounts.filter((item) => canPayForRoutine(item));
		const picker = h(
			"select",
			{ "aria-label": t("Model account") },
			...accountLabels(choices).map((label, index) => h("option", { value: choices[index]!.connectionId }, label)),
		) as HTMLSelectElement;
		const payer = () => own ?? choices.find((item) => item.connectionId === picker.value);
		// Nothing here can pay: connect an account, or turn on a ChatGPT plan (the only kind left once Claude is not).
		const noPayer = () =>
			this.#accounts.length
				? t("Turn on “Work while you're away” for this ChatGPT plan in Settings first.")
				: t("Connect a model account in Settings first.");
		const payment = own
			? h("p", { class: "muted" }, t("This routine runs on your own account that works while you're away."))
			: choices.length
				? h(
						"label",
						null,
						t("Runs on"),
						picker,
						h(
							"small",
							null,
							t(
								"Saving lets {name} use this account for this routine while you are away. Pause the routine to stop it.",
								{ name: this.#agent().displayName },
							),
						),
					)
				: h(
						"p",
						{ class: "muted" },
						this.#accounts.length
							? t("Turn on “Work while you're away” for this ChatGPT plan in Settings first.")
							: t(
									"Connect a model account in Settings → My connections first. A routine runs on a member's own account.",
								),
					);
		const intervalFields = h("div", { class: "routine-inline" }, t("Every"), every, unit);
		const weeklyFields = h(
			"div",
			{ class: "routine-when" },
			days,
			h("div", { class: "routine-inline" }, t("at"), time, timeZone),
		);
		// A first run an agent held back (firstRunAt) that is still ahead: shown, and the member may let it go.
		const held =
			first?.kind === "schedule" && "startAt" in first && first.startAt && Date.parse(first.startAt) > Date.now()
				? first.startAt
				: undefined;
		const heldStart = () => {
			if (!held || !first || !("localTime" in first)) return held;
			try {
				const moved = movedStart(held, first, { localTime: time.value, timeZone: timeZone.value.trim() });
				// A time already past would run the routine at once, so the agent's instant stays.
				return Date.parse(moved) > Date.now() ? moved : held;
			} catch {
				// A time still being typed, or a zone this browser does not know: unmoved.
				return held;
			}
		};
		const wait = h("input", { type: "checkbox", checked: true });
		const waitText = h("span");
		const waiting = h("label", { class: "routine-wait" }, wait, waitText);
		const showHeld = () => {
			if (held)
				waitText.textContent = t("Wait until {time} before the first run", { time: fmtTime(heldStart() ?? held) });
		};
		time.oninput = timeZone.oninput = showHeld;
		showHeld();
		const sync = () => {
			intervalFields.hidden = when.value !== "interval";
			weeklyFields.hidden = when.value !== "weekly";
			waiting.hidden = !held || when.value !== shape;
		};
		when.onchange = sync;
		sync();
		const status = h("p", { class: "surface-status", role: "status" }, notice);
		// A new interval's first run is one interval from the form's first Save, so a retry sends the same draft.
		const starts = new Map<number, string>();
		const next = (interval: number) => {
			const at =
				starts.get(interval) ??
				new Date(Math.ceil((Date.now() + interval * 60_000) / 60_000) * 60_000).toISOString();
			starts.set(interval, at);
			return at;
		};
		const trigger = (): CloudRoutineTrigger => {
			const replyPolicy = reply.value === "required" ? {} : { replyPolicy: reply.value as CloudRoutineReplyPolicy };
			const id = first?.id ?? crypto.randomUUID();
			// Only while the box shows: it belongs to the routine's own kind of schedule.
			const letGo = !waiting.hidden && !wait.checked;
			if (when.value === "weekly")
				return parseCloudRoutineTrigger({
					id,
					kind: "schedule",
					intervalMinutes: 1440,
					// Once past, the scheduler ignores a weekly start, so a past one is kept as it is; one let go is removed.
					startAt: !letGo && first && "localTime" in first ? (heldStart() ?? first.startAt) : undefined,
					weekdays: CLOUD_ROUTINE_WEEKDAYS.filter((day) => chosen.has(day)),
					localTime: time.value,
					timeZone: timeZone.value.trim(),
					...replyPolicy,
				});
			const intervalMinutes = Math.round(Number(every.value) * UNITS[unit.value as keyof typeof UNITS]);
			// While the interval stays, so does the file's first-run time as read (or its absence), and a held one let
			// go is removed. A new interval's first run is one interval away, not at once.
			const kept =
				first?.kind === "schedule" &&
				!("localTime" in first) &&
				!("windowStart" in first) &&
				first.intervalMinutes === intervalMinutes
					? first
					: undefined;
			return parseCloudRoutineTrigger({
				id,
				kind: "schedule",
				intervalMinutes,
				startAt: kept ? (letGo ? undefined : kept.startAt) : next(intervalMinutes),
				...replyPolicy,
			});
		};
		const save = button(t("Save routine"), () => void submit(), { primary: true });
		const leave = () => {
			if (!this.#busy) this.#list();
		};
		const cancel = button(t("Cancel"), leave);
		const submit = async () => {
			if (this.#busy || !access.canManage()) return;
			let built: CloudRoutineTrigger;
			try {
				built = trigger();
			} catch {
				status.textContent =
					when.value === "interval"
						? t("Choose an interval between 5 minutes and 7 days.")
						: t("Choose at least one day, a time and a time zone such as Europe/Copenhagen.");
				return;
			}
			if (!title.value.trim() || !prompt.value.trim()) {
				status.textContent = t("Give the routine a name and say what to do.");
				return;
			}
			// A new routine always needs a login; an edit only when it changes something.
			const account = payer();
			if (!opened && !account) {
				status.textContent = noPayer();
				return;
			}
			this.#busy = true;
			save.disabled = cancel.disabled = true;
			status.textContent = t("Saving…");
			let after: "reopen" | "gone" | undefined;
			try {
				const saved = await access.routines.save(
					{
						clientRoutineId,
						staffAgentId: this.#agent().id,
						title: title.value.trim(),
						prompt: prompt.value.trim(),
						trigger: built,
						effort,
						...(opened ? { opened } : {}),
					},
					account,
					saveId,
				);
				if (this.#signal.aborted) return;
				// Nothing is written: an unchanged save would resume a routine the platform paused, which only the
				// switch does.
				if (saved === "unchanged") {
					status.textContent = t("Nothing changed.");
					return;
				}
				this.#busy = false;
				this.#editing = false;
				this.#message = "";
				await this.#refresh();
			} catch (error) {
				if (this.#signal.aborted) return;
				if (error instanceof WebRoutineChangedError && routine) after = "reopen";
				else if (error instanceof WebRoutineGoneError && routine) after = "gone";
				else
					status.textContent =
						error instanceof WebRoutineNoPayerError
							? noPayer()
							: error instanceof WebCompanyFolderRejectedError
								? // Nothing was written; the file's or the hook's problems say why, in English.
									withProblems(t("The routine could not be saved."), error.problems)
								: t("The routine could not be saved. Your draft is still here.");
			} finally {
				this.#busy = false;
				save.disabled = cancel.disabled = false;
			}
			if (after === "reopen") {
				// Someone changed what the form shows: it opens again on what the file says now.
				this.#editing = false;
				await this.#edit(routine, t("This routine changed while you were editing it."));
			} else if (after === "gone") {
				this.#editing = false;
				await this.#refresh();
				if (this.#signal.aborted || this.#editing) return;
				this.#message = t("This routine is no longer available.");
				this.#list();
			}
		};
		replace(
			this.el,
			dialogPageHeader(routine ? t("Edit routine") : t("New routine"), leave, t("Back to routines")),
			h(
				"div",
				{ class: "routine-editor" },
				h("label", null, t("Name"), title),
				h("label", null, t("What should {name} do?", { name: this.#agent().displayName }), prompt),
				h("label", null, t("When"), when),
				intervalFields,
				weeklyFields,
				waiting,
				h("label", null, t("Reply"), reply),
				h("div", { class: "muted" }, t("Effort: {effort}", { effort: effortName(effort) })),
				payment,
				status,
				h("div", { class: "surface-actions" }, cancel, save),
			),
		);
		title.focus();
	}
}
