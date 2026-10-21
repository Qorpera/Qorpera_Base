import type { NativeExecutionConnections } from "@qorpera/cloud-client/cloud-native-subscription-control";
import { cloudRoutineTriggerOfFile } from "@qorpera/cloud-client/cloud-routine-file";
import {
	CLOUD_ROUTINE_WEEKDAYS,
	type CloudRoutine,
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
	type WebRoutineLoginRefusal,
	WebRoutineLoginRefusedError,
	WebRoutineNoPayerError,
	type WebRoutinePayer,
	type WebRoutines,
} from "../../cloud/routines.ts";
import type { HostedStaffAgent } from "../../cloud/types.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { type Child, fmtDate, fmtTime, h, icon, replace } from "../../ui/dom.ts";
import {
	phrase,
	presentationDay,
	presentationLocale,
	presentationTimeZone,
	previousDay,
	t,
	timeZoneOption,
} from "../../ui/preferences.ts";
import type { CompanyController } from "../company.ts";
import type { WorkspaceActions } from "../workspace-actions.ts";

export interface AgentRoutineAccess {
	routines: WebRoutines;
	/** The signed-in member's own model accounts. */
	accounts: (signal: AbortSignal) => Promise<NativeExecutionConnections>;
	/** Owners and admins create, change, pause and resume routines. */
	canManage: () => boolean;
	/** Members who may write (contributors and up) choose one of their own logins for a routine whose login can't
	 * pay; the cloud refuses one without write access to the routine's file. Owners and admins when absent. */
	canWrite?: () => boolean;
	/** A member's name, for a routine whose login waits on that member. */
	memberName?: (userId: string) => string | undefined;
	/** The signed-in member: a routine whose login is their own asks them to sign in again. */
	memberId?: string;
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
		canWrite: () => company.store.get().team?.capabilities.write === true,
		memberName: (userId) => company.store.get().team?.members.find((member) => member.userId === userId)?.displayName,
		memberId: company.userId,
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

/** The composer makes a routine's one trigger: an interval or days at a time. Anything else (more triggers, a time
 * window, a dynamic routine's next run, a hook's events) it keeps as the file has it, shown in words: only the reply
 * changes (#edit). A file change is never made here: a folder-v2 company's routines do not start on one until the
 * folder's file events reach routines. */
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

/** Why a login was refused for a routine, in plain words (20260930095000). */
function refusalWords(reason: WebRoutineLoginRefusal): string {
	switch (reason) {
		case "stopped":
			return t("The company is stopped, so its routines can't change now.");
		case "cannot_pay":
			return t("This login can't pay for work while you're away right now. Choose another one.");
		case "usage_limit":
			return t("This login has reached its usage limit. Choose another one, or wait until it resets.");
		case "sign_in":
			return t("Sign in to this login again in Settings → My connections, or choose another one.");
		case "plan_listener":
			return t("A ChatGPT plan can't pay for routines that start on a file change or a webhook.");
		case "not_yours":
			return t("You can only choose one of your own logins.");
		case "unavailable":
			return t("You can't change who pays for this routine.");
	}
}

/** What a redraw finds a control by: its own focus key (a row names its routine, whose line may change), else its
 * label. */
function controlLabel(control: Element): string {
	return control.getAttribute("data-focus") ?? control.getAttribute("aria-label") ?? control.textContent ?? "";
}

/** A text button: words only, no box. */
function textButton(label: Child, onclick: () => void, className: string, disabled = false): HTMLButtonElement {
	return h("button", { type: "button", class: `routine-text ${className}`, disabled, onclick }, label);
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

/** When the next run is, in few words: a time today, "tomorrow", or a day such as "26 Oct". */
function nextWords(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	const zone = timeZoneOption();
	const day = presentationDay(date, zone.timeZone),
		today = presentationDay(new Date(), zone.timeZone);
	if (day === today) return fmtTime(iso);
	if (previousDay(day) === today) return t("tomorrow");
	return date.toLocaleDateString(presentationLocale(), { month: "short", day: "numeric", ...zone });
}

/** A day's whole name in the viewer's language, for its one-letter circle: "Monday", "mandag". */
function dayName(day: CloudRoutineWeekday): string {
	// 4 January 2026 is a Sunday, the cloud's first day.
	return new Date(Date.UTC(2026, 0, 4 + CLOUD_ROUTINE_WEEKDAYS.indexOf(day))).toLocaleDateString(
		presentationLocale(),
		{
			weekday: "long",
			timeZone: "UTC",
		},
	);
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

/** What a routine's reply setting is called in the composer. */
const REPLIES: readonly [CloudRoutineReplyPolicy, string][] = [
	["required", phrase("Always")],
	["optional", phrase("When there is news")],
	["silent", phrase("Never")],
];

/** "Choose a login" while it is open: the member's own logins that can pay for the routine, the one chosen, and what
 * the control says (what to do when none can, or why a choice was refused). */
interface Choice {
	routineId: string;
	logins: WebMemberConnection[];
	chosen: string;
	note: string;
}

/** An agent's Routines page, over its conversation: standing work the cloud starts on a schedule. Each routine is a
 * file in the company's folder, `agents/<handle>/routines/<key>.md`, which the switch and the composer write as the
 * member (folder core C4, P34r). */
export class AgentRoutines {
	readonly el = h("section", { class: "agent-routines" });
	/** The agent as it is now, so a rename shows here without reopening. */
	readonly #agent: () => HostedStaffAgent;
	readonly #access: AgentRoutineAccess | undefined;
	readonly #signal: AbortSignal;
	readonly #close: (() => void) | undefined;
	readonly #back: boolean;
	#routines: WebRoutine[] = [];
	/** The routines whose file this member finds: only those have a switch and open in the composer. */
	#files: ReadonlySet<string> = new Set();
	#accounts: WebMemberConnection[] = [];
	/** Who pays for each listed routine, read after each list read (20260930095000). A routine whose read failed, or
	 * a cloud without the read, has none, and its row says nothing of it. */
	#payers: ReadonlyMap<string, WebRoutinePayer> = new Map();
	/** The routine whose "Choose a login" is open. */
	#choosing: Choice | undefined;
	#busy = false;
	/** The composer is open or opening: it owns the screen, and the list never draws over it (#list) until it is
	 * left (#toList). */
	#editing = false;
	/** Counts navigations (the composer opening or closing, the chooser opening or closing). A step that waited on the
	 * cloud navigates, or says why something failed, only while the count is the one it started with. */
	#screen = 0;
	/** Until the first read answers, an empty list means "not known yet". */
	#loaded = false;
	#message = "";
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
	/** What opened the composer (a routine's row or New routine): focus goes back to it when the list returns. */
	#returnTo: string | undefined;
	/** The agent's figure, kept through redraws so it does not start over. */
	#figure: { key: string; el: HTMLElement } | undefined;
	/** `close` leaves the routines: back to the agent's card when `back` (they are its page), else closes them. */
	constructor(
		agent: () => HostedStaffAgent,
		access: AgentRoutineAccess | undefined,
		signal: AbortSignal,
		close?: () => void,
		back = false,
	) {
		this.#back = back;
		this.#agent = agent;
		this.#access = access;
		this.#signal = signal;
		this.#close = close;
		this.#list();
		if (access) void this.#refresh();
	}
	/** Reads the list again, unless a routine is open in the composer. */
	refresh(): void {
		if (!this.#held()) void this.#refresh();
	}
	async #refresh(): Promise<void> {
		const access = this.#access;
		if (!access || this.#signal.aborted) return;
		const read = ++this.#reads;
		// A read that went out before a switch was moved may predate the change.
		const changes = this.#changes;
		try {
			const [routines, files] = await Promise.all([
				access.routines.list(),
				// Routines whose files could not be found are read-only; the list still shows.
				access.routines
					.files()
					.catch((): ReadonlySet<string> => new Set()),
			]);
			if (this.#signal.aborted || read < this.#shown) return;
			this.#shown = read;
			this.#routines = routines.filter(
				(item) => item.staffAgentId === this.#agent().id && item.status !== "retired",
			);
			this.#files = files;
			if (changes === this.#changes && !this.#busy) this.#flipped.clear();
			this.#message = "";
		} catch {
			if (this.#signal.aborted || read < this.#shown) return;
			this.#message = t("Routines could not be read. Refresh to try again.");
		}
		this.#loaded = true;
		this.#list();
		// Who pays comes after the list, which never waits for it.
		if (read === this.#shown) void this.#readPayers(read);
	}
	/** Reads who pays for each listed routine, once per list read: the first alone, so a cloud without the read is
	 * asked once. A read that fails keeps what the last one said (a choice open on it stays); a routine never read, or
	 * a cloud without the read, says nothing. */
	async #readPayers(read: number): Promise<void> {
		const routines = this.#access?.routines;
		const [first, ...rest] = this.#routines;
		if (!routines || !first) return;
		const found = new Map<string, WebRoutinePayer>();
		const one = async (routine: WebRoutine) => {
			const paid = await routines.payer(routine.routineId).catch(() => undefined);
			if (paid) found.set(routine.routineId, paid);
			return paid;
		};
		const missing = (await one(first)) === null;
		if (!missing) await Promise.all(rest.map(one));
		if (this.#signal.aborted || read !== this.#shown) return;
		const payers = new Map<string, WebRoutinePayer>();
		if (!missing)
			for (const routine of this.#routines) {
				const paid = found.get(routine.routineId) ?? this.#payers.get(routine.routineId);
				if (paid) payers.set(routine.routineId, paid);
			}
		// Nothing to show before or after (a cloud without the read) draws nothing again.
		const drawn = this.#payers.size > 0;
		this.#payers = payers;
		// A routine whose login pays again needs no choice; not while a change or the composer holds the page (a choice
		// being used ends with its own answer).
		if (this.#choosing && !this.#held() && payers.get(this.#choosing.routineId)?.canPay !== false) {
			this.#choosing = undefined;
			this.#navigate();
		}
		if ((drawn || payers.size > 0) && !this.#busy) this.#list();
	}
	/** Draws the list as it stands. Reads that answer redraw it whenever it owns the screen: they draw what is known
	 * now, never a choice made before. It never draws over a composer that is open or opening. */
	#list(): void {
		if (this.#editing) return;
		const focused = this.#focused();
		// Back from the composer, focus returns to what opened it.
		const back = this.#returnTo;
		this.#returnTo = undefined;
		const access = this.#access;
		const manage = access?.canManage() === true;
		const agent = this.#agent();
		const create = manage
			? h(
					"button",
					{
						type: "button",
						class: "icon-button routine-create",
						title: t("New routine"),
						"aria-label": t("New routine"),
						disabled: this.#busy,
						onclick: () => void this.#edit(undefined),
					},
					icon("plus"),
				)
			: null;
		create?.setAttribute("data-focus", "create");
		const rows = this.#routines.map((routine) => this.#row(routine, manage));
		replace(
			this.el,
			this.#close || create
				? h(
						"div",
						{ class: "routine-top" },
						this.#close
							? h(
									"button",
									{
										type: "button",
										class: "icon-button routine-close",
										title: this.#back ? t("Back to agent details") : t("Close routines"),
										"aria-label": this.#back ? t("Back to agent details") : t("Close routines"),
										onclick: this.#close,
									},
									icon(this.#back ? "back" : "close"),
								)
							: null,
						// In the agent's card the title stands beside the way back; the card already shows whose they are.
						this.#back ? h("h2", { class: "routine-title" }, t("Routines")) : null,
						create,
					)
				: null,
			this.#back
				? null
				: h(
						"header",
						{ class: "routine-heading" },
						this.#figureOf(agent),
						h("div", null, h("h2", null, t("Routines")), h("p", null, agent.displayName)),
					),
			this.#message ? h("p", { class: "surface-status", role: "status" }, this.#message) : null,
			rows.length
				? h("div", { class: "routine-list" }, ...rows)
				: access && !this.#loaded
					? h("p", { class: "routine-quiet", role: "status" }, t("Reading routines…"))
					: h(
							"p",
							{ class: "routine-quiet" },
							access
								? t("{name} has no routines yet.", { name: agent.displayName })
								: t("Routines will appear here."),
						),
		);
		if (focused) this.#refocus(focused, back);
		else if (back && (!document.activeElement || document.activeElement === document.body))
			this.#controls(back)[0]?.focus({ preventScroll: true });
	}
	/** The agent's figure, drawn anew only when its look changes or it left the page (the composer replaced it). */
	#figureOf(agent: HostedStaffAgent): HTMLElement {
		const key = JSON.stringify([agent.id, agent.displayName, agent.appearance, agent.templateId]);
		if (this.#figure?.key !== key || !this.#figure.el.isConnected)
			this.#figure = { key, el: agentFigure(agent, agent.displayName, { size: 52 }) };
		return this.#figure.el;
	}
	/** One routine as a row: its name, a line saying when it runs (or why it waits) and a switch that pauses it. A row
	 * opens it in the composer, drawn read-only when the member may not change it. */
	#row(routine: WebRoutine, manage: boolean): HTMLElement {
		const id = routine.routineId;
		const ended = routine.status === "expired" || routine.status === "concluded";
		// A routine is its file: one this member does not find (out of their reach, from before the files, or a cloud
		// that does not list them yet) cannot be changed from here.
		const known = this.#files.has(id);
		// An ended routine is read-only: a member save keeps its end (its expiry or run limit), so neither the composer
		// nor a resume could start it again. Its agent can. Any other routine opens in the composer: one whose triggers it
		// does not make keeps how it runs.
		const editable = manage && known && !ended;
		const on = this.#runsNow(routine);
		// A routine whose login cannot pay waits for one (20260930095000): the line says so, and a member who may
		// write chooses one of their own logins here.
		const paid = this.#payers.get(id);
		const problem = paid && !paid.canPay && !ended ? this.#waitWords(paid) : null;
		const choosing = this.#choosing?.routineId === id ? this.#choosing : undefined;
		const choice = problem !== null && this.#mayChoose() && known;
		const text = [
			h("strong", null, routine.title),
			h(
				"span",
				{ class: problem ? "routine-row-line is-problem" : "routine-row-line" },
				problem ?? this.#line(routine, on),
			),
		];
		const main = h(
			"button",
			{
				type: "button",
				class: "routine-row-main",
				dataset: { focus: `row:${id}` },
				disabled: this.#held(),
				onclick: () => this.#read(routine, editable),
			},
			...text,
		);
		const lever = h("button", {
			type: "button",
			role: "switch",
			class: "routine-switch",
			"aria-label": routine.title,
			dataset: { focus: `switch:${id}` },
			onclick: () => void this.#toggle(routine),
		});
		this.#setLever(lever, routine, manage);
		return h(
			"div",
			{
				class: on ? "routine-row" : "routine-row is-quiet",
				dataset: { routineId: id },
				// The row's own room around its controls opens the routine too.
				onclick: (event: MouseEvent) => {
					if (!(event.target as Element).closest("button, select, .routine-login")) main.click();
				},
			},
			main,
			choice && !choosing
				? textButton(t("Choose a login"), () => void this.#openChoice(routine), "routine-choose", this.#busy)
				: null,
			lever,
			choice && choosing ? this.#loginChoice(routine, choosing) : null,
		);
	}
	/** A routine's line: when it runs and when next, or that it is paused and why, or that it ended. */
	#line(routine: WebRoutine, on: boolean): string {
		const state = this.#state(routine, on);
		if (routine.status === "concluded" || routine.status === "expired") return state!;
		const when = routine.triggers.map(whenShort).join("; ");
		if (state) return `${when} · ${state}`;
		const next = routine.status === "active" && routine.nextRunAt ? nextWords(routine.nextRunAt) : "";
		return next ? `${when} · ${t("next {when}", { when: next })}` : when;
	}
	/** Why a routine does not run, or null while it runs: it is done (and why), ended, or paused (and why). */
	#state(routine: WebRoutine, on: boolean): string | null {
		if (routine.status === "concluded") return [t("Done"), routine.conclusion].filter(Boolean).join(" · ");
		if (routine.status === "expired") return t("Ended");
		if (on) return null;
		// Paused as the member sees it: the reason belongs to the read that said paused.
		return (
			(routine.status === "paused" ? pauseWords(routine.pauseReason, this.#agent().displayName) : null) ??
			t("Paused")
		);
	}
	/** "Paid by you since 4 Oct": the member's own login, another member's, or a company account. */
	#paidBy(paid: WebRoutinePayer): string {
		const date = fmtDate(paid.since);
		if (paid.payer === "company") return t("Paid by the company since {date}", { date });
		if (paid.payerUserId === this.#access?.memberId) return t("Paid by you since {date}", { date });
		return t("Paid by {name} since {date}", {
			name: (paid.payerUserId && this.#access?.memberName?.(paid.payerUserId)) || t("a member"),
			date,
		});
	}
	/** Why the routine's login can't pay now (20260930095000). The routine keeps the login, and its runs wait until it
	 * can pay again, or until someone chooses another. */
	#waitWords(paid: WebRoutinePayer): string {
		if (paid.waitsFor === "usage_limit") return t("Runs wait until this login's usage limit resets.");
		if (paid.waitsFor !== "sign_in") return t("Paused: no model account pays for it");
		if (paid.payerUserId === this.#access?.memberId)
			return t("Sign in to this login again in Settings → My connections to let it run.");
		const name = paid.payerUserId && this.#access?.memberName?.(paid.payerUserId);
		return name
			? t("Runs wait until {name} signs in to this login again.", { name })
			: t("Runs wait until this login is signed in again.");
	}
	/** "Choose a login", open under its row: the member's own logins that can pay for the routine, or what to do when
	 * none can. */
	#loginChoice(routine: WebRoutine, choosing: Choice): HTMLElement {
		const note = choosing.note ? h("p", { role: "status" }, choosing.note) : null;
		const cancel = textButton(t("Cancel"), () => this.#closeChoice(), "routine-login-cancel", this.#busy);
		if (!choosing.logins.length)
			return h("div", { class: "routine-login" }, note, h("div", { class: "routine-login-actions" }, cancel));
		const picker = h(
			"select",
			{ "aria-label": t("Login"), disabled: this.#busy },
			...accountLabels(choosing.logins).map((label, index) =>
				h("option", { value: choosing.logins[index]!.connectionId }, label),
			),
		) as HTMLSelectElement;
		picker.value = choosing.chosen;
		picker.onchange = () => {
			choosing.chosen = picker.value;
		};
		const use = textButton(t("Use this login"), () => void this.#useLogin(routine), "routine-login-use", this.#busy);
		return h(
			"div",
			{ class: "routine-login" },
			picker,
			h(
				"small",
				null,
				t(
					"Choosing a login lets {name} use it for this routine while you are away. Pause the routine to stop it.",
					{ name: this.#agent().displayName },
				),
			),
			note,
			h("div", { class: "routine-login-actions" }, use, cancel),
		);
	}
	/** A switch as the routine stands, or where the member moved it. While one
	 * switch moves, or the composer opens, the others wait. */
	#setLever(lever: HTMLElement, routine: CloudRoutine, manage: boolean): void {
		const id = routine.routineId;
		const on = this.#runsNow(routine);
		// A routine never runs under an archived agent: turned on, it is paused again at once.
		const archived = this.#archived();
		// An ended routine's switch stays, off and locked: a member save keeps its end, so only its agent starts it
		// again. One whose file this member doesn't find can't be changed from here either.
		const ended = routine.status === "expired" || routine.status === "concluded";
		const known = this.#files.has(id);
		lever.setAttribute("aria-checked", String(on && !ended));
		lever.title = ended
			? routine.status === "concluded"
				? t("Done: {name} ended this routine", { name: this.#agent().displayName })
				: t("This routine has ended")
			: !known
				? t("This routine can't be changed from here")
				: !manage
					? t("Only owners and admins can pause or resume routines.")
					: archived && !on
						? t("Reactivate the agent first")
						: on
							? t("Pause routine")
							: t("Resume routine");
		if (this.#moving === id) lever.setAttribute("aria-busy", "true");
		else lever.removeAttribute("aria-busy");
		const locked = ended || !known || !manage || (archived && !on);
		lever.classList.toggle("is-locked", locked);
		if (locked || (this.#held() && this.#moving !== id)) lever.setAttribute("aria-disabled", "true");
		else lever.removeAttribute("aria-disabled");
		// The row quiets as its switch moves off, before the read redraws its line.
		lever.closest(".routine-row")?.classList.toggle("is-quiet", !on);
	}
	/** The agent is archived: its routines stay paused until it is active again. */
	#archived(): boolean {
		return this.#agent().employmentStatus === "archived";
	}
	/** Whether a routine runs, as the member sees it: where its switch was moved,
	 * else the last read. A composer save keeps this, not the state it opened with. */
	#runsNow(routine: CloudRoutine): boolean {
		const id = routine.routineId;
		return (
			this.#flipped.get(id) ?? (this.#routines.find((item) => item.routineId === id) ?? routine).status === "active"
		);
	}
	/** Whether the list's controls wait: a change is under way, or the composer is open or opening over the list. */
	#held(): boolean {
		return this.#busy || this.#editing;
	}
	/** One navigation (#screen); returns the new count. */
	#navigate(): number {
		return ++this.#screen;
	}
	/** Leaves the composer for the list: the list owns the screen again. */
	#toList(): void {
		this.#editing = false;
		this.#navigate();
		this.#list();
	}
	/** Brings the switches and buttons up to date in place, so a moved switch slides
	 * instead of being drawn anew in its new place. While the composer opens, the list's controls wait, the chooser's
	 * Cancel too. */
	#setControls(): void {
		const manage = this.#access?.canManage() === true;
		for (const lever of this.el.querySelectorAll<HTMLElement>(".routine-switch")) {
			const routine = this.#routines.find(
				(item) => item.routineId === lever.closest<HTMLElement>(".routine-row")?.dataset.routineId,
			);
			if (routine) this.#setLever(lever, routine, manage);
		}
		for (const control of this.el.querySelectorAll<HTMLButtonElement | HTMLSelectElement>(
			"button.routine-row-main, .routine-create, .routine-choose, .routine-login button, .routine-login select",
		))
			control.disabled = this.#held();
		if (!this.#message) this.el.querySelector(":scope > .surface-status")?.remove();
	}
	/** A member who may write chooses one of their own logins for a routine whose login can't pay. */
	#mayChoose(): boolean {
		const access = this.#access;
		return access ? (access.canWrite ?? access.canManage)() : false;
	}
	#rowFor(id: string): HTMLElement | undefined {
		return [...this.el.querySelectorAll<HTMLElement>(".routine-row")].find((item) => item.dataset.routineId === id);
	}
	/** The focused control as its label and place among controls that share it,
	 * so a redrawn list can put focus back where it was. */
	#focused(): [string, number] | undefined {
		const active = document.activeElement;
		if (!(active instanceof HTMLElement) || !this.el.contains(active)) return undefined;
		const label = controlLabel(active);
		return [label, this.#controls(label).indexOf(active)];
	}
	#refocus([label, index]: [string, number], back: string | undefined): void {
		const same = this.#controls(label);
		// A control that is gone (the composer's, or a choice that closed) hands focus to what opened the composer, else
		// to the way out.
		(
			same[index] ??
			same[0] ??
			(back ? this.#controls(back)[0] : undefined) ??
			this.el.querySelector<HTMLElement>(".routine-close")
		)?.focus({ preventScroll: true });
	}
	#controls(label: string): HTMLElement[] {
		return [...this.el.querySelectorAll<HTMLElement>("button, select")].filter(
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
		// Not while the composer opens over the list either: a change then would draw the list over it.
		if (
			this.#busy ||
			this.#editing ||
			!this.#access?.canManage() ||
			!this.#files.has(routine.routineId) ||
			routine.status === "expired" ||
			routine.status === "concluded" ||
			(this.#archived() && !this.#runsNow(routine))
		)
			return;
		const id = routine.routineId;
		// Where the switch stood: a failed change puts it back there, even if that was a
		// place it was moved to whose change no read has confirmed yet.
		const previous = this.#flipped.get(id);
		const enabled = !this.#runsNow(routine);
		// A routine whose login can't pay keeps it on a resume and goes on waiting (20260930095000): the switch opens
		// "Choose a login" under its row instead. Without that read, the switch resumes as before, and so it does for a
		// login that is only at its usage limit or needs a new sign-in: the routine runs on it once it can pay again.
		const paid = this.#payers.get(id);
		if (enabled && paid?.canPay === false && paid.waitsFor !== "usage_limit" && paid.waitsFor !== "sign_in") {
			if (this.#choosing?.routineId === id) this.#focusChoice(id);
			else void this.#openChoice(routine);
			return;
		}
		const screen = this.#screen;
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
					failure = this.#noLogin(listening);
				}
			}
			if (!failed) await this.#access.routines.setEnabled(routine, payer, enabled, crypto.randomUUID());
		} catch (error) {
			failed = true;
			// A routine that ended meanwhile shows as ended once the list is read again. A refusal saved nothing; the
			// file's or the hook's problems say why, in English.
			failure =
				error instanceof WebRoutineEndedError
					? ""
					: error instanceof WebCompanyFolderRejectedError
						? withProblems(t("The routine could not be changed."), error.problems)
						: t("The routine could not be changed. Try again.");
		} finally {
			this.#busy = false;
			this.#moving = undefined;
			if (failed && previous === undefined) this.#flipped.delete(id);
			else if (failed) this.#flipped.set(id, previous!);
			if (!this.#signal.aborted) {
				this.#setControls();
				await this.#refresh();
				// The read clears the line; a failed change keeps saying why, unless the member went elsewhere meanwhile.
				if (failure && !this.#signal.aborted && screen === this.#screen && !this.#editing) {
					this.#message = failure;
					this.#list();
				}
			}
		}
	}
	/** What to do when none of the member's accounts can pay for a routine (`listening`: one that starts on a file
	 * change or a webhook). */
	#noLogin(listening: boolean): string {
		return !this.#accounts.length
			? t(
					"Connect a model account in Settings first; a routine runs on the account of the member who last saved it.",
				)
			: listening
				? t("A ChatGPT plan can't pay for routines that start on a file change or a webhook.")
				: t("Turn on “Work while you're away” for this ChatGPT plan in Settings first.");
	}
	/** Opens "Choose a login" on the member's own logins that can pay for the routine: never a Claude login, and a
	 * ChatGPT plan only once its member turned on work while away, and never for a file-change or webhook routine. The
	 * web lists no company accounts, so a routine is moved to one elsewhere. */
	async #openChoice(routine: CloudRoutine): Promise<void> {
		if (this.#held() || !this.#mayChoose()) return;
		const screen = this.#screen;
		// The read holds the page as a switch's change does: no composer opens over the list meanwhile.
		this.#busy = true;
		this.#setControls();
		const loaded = await this.#loadAccounts();
		this.#busy = false;
		if (this.#signal.aborted || screen !== this.#screen || this.#editing) return;
		if (!loaded) {
			// The list says why; its controls are free again.
			this.#setControls();
			return;
		}
		const listening = routine.triggers.some((item) => item.kind === "listener");
		const logins = this.#accounts.filter((item) => canPayForRoutine(item, listening));
		this.#choosing = {
			routineId: routine.routineId,
			logins,
			chosen: logins[0]?.connectionId ?? "",
			note: logins.length ? "" : this.#noLogin(listening),
		};
		this.#navigate();
		this.#list();
		this.#focusChoice(routine.routineId);
	}
	/** Cancel: the choice closes. Not while a change or the composer holds the page. */
	#closeChoice(): void {
		const id = this.#choosing?.routineId;
		if (this.#held() || !id) return;
		this.#choosing = undefined;
		this.#navigate();
		this.#list();
		this.#focusChoice(id);
	}
	/** Focus stays with the choice as it opens or closes: its first control, or "Choose a login" once it is closed. */
	#focusChoice(routineId: string): void {
		this.#rowFor(routineId)
			?.querySelector<HTMLElement>(".routine-login select, .routine-login button, .routine-choose")
			?.focus({ preventScroll: true });
	}
	/** Runs the routine on the chosen login: its consent and binding first, as a save's, then the pick. A refused login
	 * keeps the choice open and says why. The list and who pays are read again either way. Not while a change or the
	 * composer holds the page. */
	async #useLogin(routine: WebRoutine): Promise<void> {
		const access = this.#access;
		const choosing = this.#choosing;
		if (this.#held() || !access || !this.#mayChoose() || !choosing || choosing.routineId !== routine.routineId)
			return;
		const account = choosing.logins.find((item) => item.connectionId === choosing.chosen);
		if (!account) return;
		let screen = this.#screen;
		this.#busy = true;
		choosing.note = "";
		this.#list();
		let failure = "";
		try {
			const paid = await access.routines.setLogin(routine.routineId, account);
			if (this.#signal.aborted || screen !== this.#screen) return;
			// The choice is done and closes; the row says at once whether the login pays. Null: the cloud has no pick,
			// and nothing of it shows.
			this.#choosing = undefined;
			screen = this.#navigate();
			if (paid) this.#payers = new Map(this.#payers).set(routine.routineId, paid);
		} catch (error) {
			if (this.#signal.aborted || screen !== this.#screen) return;
			if (error instanceof WebRoutineLoginRefusedError && error.reason === "unavailable") {
				// No login would do: the choice closes, and the list says why.
				this.#choosing = undefined;
				screen = this.#navigate();
				failure = refusalWords(error.reason);
			} else
				choosing.note =
					error instanceof WebRoutineLoginRefusedError
						? refusalWords(error.reason)
						: t("The login could not be chosen. Try again.");
		} finally {
			this.#busy = false;
		}
		await this.#refresh();
		// Said only while the member is where the pick left them.
		if (failure && !this.#signal.aborted && screen === this.#screen && !this.#editing) {
			this.#message = failure;
			this.#list();
		}
	}
	/** Opens a routine in the composer's layout, read-only: its name and instruction as text, when it runs, its reply and
	 * who pays as plain lines, and no Save. Edit opens the composer on it where the member may change it. It draws what
	 * the list read, so it asks the cloud nothing. */
	#read(routine: WebRoutine, editable: boolean): void {
		if (this.#held()) return;
		// It owns the screen as the composer does: reads that answer meanwhile do not draw the list over it.
		this.#editing = true;
		this.#returnTo = `row:${routine.routineId}`;
		const screen = this.#navigate();
		const leave = () => {
			if (!this.#busy && screen === this.#screen) this.#toList();
		};
		const back = textButton([icon("chevron"), t("Routines")], leave, "routine-back");
		const edit = editable
			? textButton(
					t("Edit"),
					() => {
						if (this.#busy || screen !== this.#screen) return;
						// The read view hands the screen to the composer, which holds it from here (#edit).
						this.#editing = false;
						void this.#edit(routine);
					},
					"routine-edit",
				)
			: null;
		const field = (label: string, ...lines: Child[]) =>
			h("div", { class: "routine-field" }, h("span", { class: "routine-label" }, label), h("div", null, ...lines));
		const state = this.#state(routine, this.#runsNow(routine));
		const reply = REPLIES.find(([value]) => value === (routine.triggers[0]?.replyPolicy ?? "required"))?.[1];
		const paid = this.#payers.get(routine.routineId);
		const ended = routine.status === "expired" || routine.status === "concluded";
		replace(
			this.el,
			h(
				"div",
				{ class: "routine-editor is-reading" },
				h("div", { class: "routine-read-top" }, back, edit),
				h("h2", { class: "routine-name" }, routine.title),
				h("p", { class: "routine-prompt" }, routine.prompt),
				h(
					"div",
					{ class: "routine-fields" },
					field(
						t("When"),
						...routine.triggers.map((trigger) => h("span", { class: "routine-account" }, whenShort(trigger))),
						state ? h("p", { class: "routine-hint" }, state) : null,
					),
					reply ? field(t("Reply"), h("span", { class: "routine-account" }, t(reply))) : null,
					paid?.payer
						? field(
								t("Runs on"),
								h("span", { class: "routine-account" }, this.#paidBy(paid)),
								!paid.canPay && !ended
									? h("p", { class: "routine-hint is-problem" }, this.#waitWords(paid))
									: null,
							)
						: null,
				),
			),
		);
		back.focus();
	}
	/** Opens the composer on a new routine, or on a routine's file as it is now: the read whose version a save names.
	 * `notice` stands on its status line, such as why the form opened again. */
	async #edit(routine: CloudRoutine | undefined, notice = ""): Promise<void> {
		const access = this.#access;
		if (this.#held() || !access?.canManage()) return;
		if (routine && !this.#files.has(routine.routineId)) return;
		// The composer owns the screen from here: the list stays while the file and the logins are read, its controls
		// waiting (the chooser's Cancel too), and nothing draws it over the composer.
		this.#editing = true;
		this.#returnTo = routine ? `row:${routine.routineId}` : "create";
		const screen = this.#navigate();
		this.#setControls();
		let opened: WebRoutineFile | undefined;
		// The file's trigger as it stays, when the composer does not make it: a time window, a dynamic routine's next
		// run, a webhook, or a routine listed with more than one trigger. Only its reply changes.
		let keep: CloudRoutineTrigger | undefined;
		if (routine) {
			try {
				opened = await access.routines.open(routine);
				if (!opened.trigger || !editorShape(routine)) keep = cloudRoutineTriggerOfFile(opened.file) ?? undefined;
				// A file change is neither made nor kept here.
				if (!opened.trigger && !keep) throw new Error("The composer does not open this routine's trigger");
			} catch {
				if (this.#signal.aborted || screen !== this.#screen) return;
				this.#editing = false;
				const back = this.#navigate();
				await this.#refresh();
				if (this.#signal.aborted || back !== this.#screen || this.#editing) return;
				this.#message = t("This routine could not be opened.");
				this.#list();
				return;
			}
			if (this.#signal.aborted || screen !== this.#screen) return;
		}
		const loaded = await this.#loadAccounts();
		if (this.#signal.aborted || screen !== this.#screen) return;
		// The list says why the logins could not be read (#loadAccounts), its controls free again.
		if (!loaded) {
			this.#toList();
			return;
		}
		// The form shows the file: its schedule, name, instructions and reply. A kept trigger has no controls.
		// Not a conditional: its type would drop days at a time, a subtype of an interval.
		let made = opened?.trigger;
		if (keep) made = undefined;
		const first = made;
		// A routine that starts on a webhook runs on no ChatGPT plan.
		const listening = keep?.kind === "listener";
		const shape: Shape = (first && shapeOf(first)) ?? "weekly";
		let kind = shape;
		// A member's new routine runs at low effort, like a conversation; an edit keeps
		// the file's own, which its agent may have set to medium or high.
		const effort = opened?.file.effort ?? "low";
		// One id per draft, so a retry is the same routine. One save id per form: a change set whose answer never
		// came is sent again as it was by the next Save, and only an answer frees it.
		const clientRoutineId = opened?.file.id ?? crypto.randomUUID();
		const saveId = crypto.randomUUID();
		const zone = presentationTimeZone();
		const name = this.#agent().displayName;
		const title = h("input", {
			type: "text",
			class: "routine-name",
			maxlength: "160",
			value: opened?.file.title ?? "",
			placeholder: t("Routine name"),
			"aria-label": t("Routine name"),
		});
		// The file allows 32,768 bytes of instructions. Each character is at least one byte, so this bound never cuts text
		// that fits; the file's parse says when longer characters take it past.
		const prompt = h(
			"textarea",
			{
				class: "routine-prompt",
				rows: 2,
				maxlength: "32768",
				placeholder: t("What should {name} do?", { name }),
				"aria-label": t("What to do"),
				value: opened?.file.instructions ?? "",
			},
			opened?.file.instructions ?? "",
		);
		// The instructions grow with what is written, so the page alone scrolls. A page not laid out yet keeps its rows.
		const grow = () => {
			prompt.style.height = "auto";
			if (prompt.scrollHeight) prompt.style.height = `${prompt.scrollHeight}px`;
		};
		prompt.addEventListener("input", grow);
		const minutes = first?.kind === "schedule" && shape === "interval" ? first.intervalMinutes : 60;
		const unit = h(
			"select",
			{ class: "routine-unit", "aria-label": t("Interval unit") },
			h("option", { value: "minutes" }, t("minutes")),
			h("option", { value: "hours" }, t("hours")),
			h("option", { value: "days" }, t("days")),
		);
		unit.value = minutes % 1440 === 0 ? "days" : minutes % 60 === 0 ? "hours" : "minutes";
		const every = h("input", {
			type: "number",
			class: "routine-every-count",
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
		// Monday first, as a week reads here; the file keeps the cloud's order.
		const week = [...CLOUD_ROUTINE_WEEKDAYS.slice(1), CLOUD_ROUTINE_WEEKDAYS[0]];
		const days = h(
			"div",
			{ class: "routine-days", role: "group", "aria-label": t("Days") },
			...week.map((day) => {
				const circle = h(
					"button",
					{
						type: "button",
						class: "routine-day",
						"aria-pressed": String(chosen.has(day)),
						"aria-label": dayName(day),
					},
					cloudRoutineWeekdayName(day, t).slice(0, 1),
				);
				circle.onclick = () => {
					if (chosen.has(day)) chosen.delete(day);
					else chosen.add(day);
					circle.setAttribute("aria-pressed", String(chosen.has(day)));
				};
				return circle;
			}),
		);
		const time = h("input", {
			type: "time",
			class: "routine-time",
			value: first && "localTime" in first ? first.localTime : "09:00",
			"aria-label": t("Time"),
		});
		// The file's own zone, also for an interval whose file keeps one: its quiet hours may go by it. Not shown: a new
		// routine takes the viewer's zone, and an edit keeps the file's.
		const timeZone = h("input", {
			type: "text",
			class: "routine-zone",
			value: opened?.file.timezone ?? zone,
			"aria-label": t("Time zone"),
			maxlength: "128",
			spellcheck: "false",
		});
		let replyPolicy: CloudRoutineReplyPolicy = (keep ?? first)?.replyPolicy ?? "required";
		const replies = REPLIES.map(([value, label]) =>
			h(
				"button",
				{ type: "button", role: "radio", class: "routine-choice", onclick: () => setReply(value) },
				t(label),
			),
		);
		const setReply = (value: CloudRoutineReplyPolicy, focus = false) => {
			replyPolicy = value;
			for (const [index, choice] of replies.entries()) {
				const on = REPLIES[index]![0] === value;
				choice.setAttribute("aria-checked", String(on));
				choice.tabIndex = on ? 0 : -1;
				if (on && focus) choice.focus();
			}
		};
		setReply(replyPolicy);
		const reply = h(
			"div",
			{
				class: "routine-choices",
				role: "radiogroup",
				"aria-label": t("Reply"),
				// Arrows move the choice, as in any radio group.
				onkeydown: (event: KeyboardEvent) => {
					const step = ["ArrowRight", "ArrowDown"].includes(event.key)
						? 1
						: ["ArrowLeft", "ArrowUp"].includes(event.key)
							? -1
							: 0;
					if (!step) return;
					event.preventDefault();
					const at = REPLIES.findIndex(([value]) => value === replyPolicy);
					setReply(REPLIES[(at + step + REPLIES.length) % REPLIES.length]![0], true);
				},
			},
			...replies,
		);
		// Who pays: the routine runs on the member's own account that works while they're away. Only when none is
		// switched on does the member choose one here, which saving switches on.
		const own = this.#accounts.find((item) => canPayForRoutine(item, listening) && item.allowAutonomous === true);
		const choices = own ? [] : this.#accounts.filter((item) => canPayForRoutine(item, listening));
		const labels = accountLabels(choices);
		const picker = h(
			"select",
			{ class: "routine-account-picker", "aria-label": t("Model account"), hidden: true },
			...labels.map((label, index) => h("option", { value: choices[index]!.connectionId }, label)),
		) as HTMLSelectElement;
		const payer = () => own ?? choices.find((item) => item.connectionId === picker.value);
		// Nothing here can pay: connect an account, or turn on a ChatGPT plan (the only kind left once Claude is not).
		const noPayer = () =>
			!this.#accounts.length
				? t("Connect a model account in Settings first.")
				: listening
					? t("A ChatGPT plan can't pay for routines that start on a file change or a webhook.")
					: t("Turn on “Work while you're away” for this ChatGPT plan in Settings first.");
		const shown = h("span", { class: "routine-account" }, labels[0] ?? "");
		const accountLine = h(
			"div",
			{ class: "routine-account-line" },
			shown,
			// Change reveals the picker in the line's place.
			choices.length > 1
				? textButton(
						t("Change"),
						() => {
							accountLine.hidden = true;
							picker.hidden = false;
							picker.focus();
						},
						"routine-change",
					)
				: null,
		);
		picker.onchange = () => {
			shown.textContent = labels[picker.selectedIndex] ?? "";
		};
		const payment: Child[] = own
			? [
					h("span", { class: "routine-account" }, accountLabel(own)),
					h(
						"p",
						{ class: "routine-hint" },
						t("This routine runs on your own account that works while you're away."),
					),
				]
			: choices.length
				? [accountLine, picker]
				: [
						h(
							"p",
							{ class: "routine-hint" },
							this.#accounts.length
								? noPayer()
								: t(
										"Connect a model account in Settings → My connections first. A routine runs on a member's own account.",
									),
						),
					];
		const intervalFields = h("div", { class: "routine-every" }, t("Every"), every, unit);
		const weeklyFields = h(
			"div",
			{ class: "routine-weekly" },
			h("div", { class: "routine-week" }, days, h("span", { class: "routine-at" }, t("at"), time)),
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
		// One quiet way to the other kind of schedule.
		const kindSwitch = textButton(
			"",
			() => {
				kind = kind === "weekly" ? "interval" : "weekly";
				sync();
			},
			"routine-kind",
		);
		const sync = () => {
			intervalFields.hidden = kind !== "interval";
			weeklyFields.hidden = kind !== "weekly";
			waiting.hidden = !held || kind !== shape;
			kindSwitch.textContent = kind === "weekly" ? t("or every few hours") : t("or on chosen days");
		};
		sync();
		const status = h("p", { class: "surface-status", role: "status" }, notice);
		// A new interval's first run is one interval from the form's first Save, and a new routine's trigger keeps one id,
		// so a retry sends the same draft.
		const triggerId = first?.id ?? crypto.randomUUID();
		const starts = new Map<number, string>();
		const next = (interval: number) => {
			const at =
				starts.get(interval) ??
				new Date(Math.ceil((Date.now() + interval * 60_000) / 60_000) * 60_000).toISOString();
			starts.set(interval, at);
			return at;
		};
		const trigger = (): CloudRoutineTrigger => {
			const replied = replyPolicy === "required" ? {} : { replyPolicy };
			// A kept trigger goes back as the file has it, with the reply the member chose.
			if (keep) {
				const { replyPolicy: _reply, ...kept } = keep;
				return { ...kept, ...replied } as CloudRoutineTrigger;
			}
			// Only while the box shows: it belongs to the routine's own kind of schedule.
			const letGo = !waiting.hidden && !wait.checked;
			if (kind === "weekly")
				return parseCloudRoutineTrigger({
					id: triggerId,
					kind: "schedule",
					intervalMinutes: 1440,
					// Once past, the scheduler ignores a weekly start, so a past one is kept as it is; one let go is removed.
					startAt: !letGo && first && "localTime" in first ? (heldStart() ?? first.startAt) : undefined,
					weekdays: CLOUD_ROUTINE_WEEKDAYS.filter((day) => chosen.has(day)),
					localTime: time.value,
					timeZone: timeZone.value.trim(),
					...replied,
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
				id: triggerId,
				kind: "schedule",
				intervalMinutes,
				startAt: kept ? (letGo ? undefined : kept.startAt) : next(intervalMinutes),
				...replied,
			});
		};
		const save = h("button", { type: "button", class: "routine-save", onclick: () => void submit() }, t("Save"));
		// This form's own navigations, and its save's steps, act only while it owns the screen (#screen).
		const leave = () => {
			if (!this.#busy && screen === this.#screen) this.#toList();
		};
		const cancel = textButton(t("Cancel"), leave, "routine-cancel");
		const submit = async () => {
			if (this.#busy || screen !== this.#screen || !access.canManage()) return;
			let built: CloudRoutineTrigger;
			try {
				built = trigger();
			} catch {
				status.textContent =
					kind === "interval"
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
			let after: "reopen" | "made" | "gone" | undefined;
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
				if (this.#signal.aborted || screen !== this.#screen) return;
				// Nothing is written: an unchanged save would resume a routine the platform paused, which only the
				// switch does.
				if (saved === "unchanged") {
					status.textContent = t("Nothing changed.");
					return;
				}
				this.#busy = false;
				this.#editing = false;
				this.#navigate();
				this.#message = "";
				await this.#refresh();
			} catch (error) {
				if (this.#signal.aborted || screen !== this.#screen) return;
				// A new routine's save meets a change only once a lost answer's replay made the routine: this form is then
				// that routine's.
				if (error instanceof WebRoutineChangedError) after = routine ? "reopen" : "made";
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
				// A form whose new routine was made stays shut until it opens on that routine: its save id is done, and a
				// Save as a new routine would find the routine there and write nothing of the draft.
				save.disabled = cancel.disabled = after === "made";
			}
			if (after === "reopen") {
				// Someone changed what the form shows: it opens again on what the file says now.
				const notice = t("This routine changed while you were editing it.");
				this.#editing = false;
				await this.#edit(routine, notice);
				// The composer did not open again (the routine is no longer one it opens): the list says why.
				if (this.#signal.aborted || screen !== this.#screen) return;
				this.#message ||= notice;
				this.#toList();
			} else if (after === "made") {
				// The list says which routine this form made (the index keeps the file's id); the form opens again on its
				// file, as an edit of it. The form stays while the list is read.
				await this.#refresh();
				if (this.#signal.aborted || screen !== this.#screen) return;
				this.#editing = false;
				const notice = t("This routine changed while you were editing it.");
				const made = this.#routines.find((item) => item.clientRoutineId === clientRoutineId);
				if (made) await this.#edit(made, notice);
				// The form is still this one: the routine is not listed yet, or not one the composer opens. The list says
				// why the form closed, unless its read failed.
				if (this.#signal.aborted || screen !== this.#screen) return;
				this.#message ||= notice;
				this.#toList();
			} else if (after === "gone") {
				this.#editing = false;
				const back = this.#navigate();
				await this.#refresh();
				if (this.#signal.aborted || back !== this.#screen || this.#editing) return;
				this.#message = t("This routine is no longer available.");
				this.#list();
			}
		};
		const field = (label: string, ...control: Child[]) =>
			h("div", { class: "routine-field" }, h("span", { class: "routine-label" }, label), h("div", null, ...control));
		replace(
			this.el,
			h(
				"div",
				{ class: "routine-editor" },
				textButton([icon("chevron"), t("Routines")], leave, "routine-back"),
				title,
				prompt,
				h(
					"div",
					{ class: "routine-fields" },
					keep
						? field(t("When"), h("span", { class: "routine-account" }, whenShort(keep)))
						: field(t("When"), intervalFields, weeklyFields, waiting, kindSwitch),
					field(t("Reply"), reply),
					field(t("Runs on"), ...payment),
				),
				h("div", { class: "routine-actions" }, save, cancel),
				status,
			),
		);
		grow();
		title.focus();
	}
}
