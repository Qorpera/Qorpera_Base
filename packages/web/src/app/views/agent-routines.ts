import type {
	NativeExecutionConnections,
	NativeMemberConnection,
} from "@qorpera/cloud-client/cloud-native-subscription-control";
import {
	CLOUD_ROUTINE_WEEKDAYS,
	type CloudRoutine,
	type CloudRoutineOccurrence,
	type CloudRoutineReplyPolicy,
	type CloudRoutineTrigger,
	type CloudRoutineWeekday,
	describeCloudRoutineTrigger,
	parseCloudRoutineTrigger,
} from "@qorpera/cloud-client/cloud-routines";
import type { WebRoutines } from "../../cloud/routines.ts";
import type { HostedStaffAgent } from "../../cloud/types.ts";
import { dialogPageHeader } from "../../ui/dialog.ts";
import { badge, button, fmtTime, h, icon, replace } from "../../ui/dom.ts";
import type { CompanyController } from "../company.ts";
import type { WorkspaceActions } from "../workspace-actions.ts";

export interface AgentRoutineAccess {
	routines: WebRoutines;
	/** The signed-in member's own model accounts. */
	accounts: (signal: AbortSignal) => Promise<NativeExecutionConnections>;
	/** Owners and admins create, change, pause and resume routines. */
	canManage: () => boolean;
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
	};
}

type Shape = "interval" | "weekly" | "file";
const UNITS = { minutes: 1, hours: 60, days: 1440 } as const;

/** The cloud lists one row per connection version; the picker offers each account
 * once, at its newest version (a consent raises the version, not the account). */
function latestVersions(accounts: readonly NativeMemberConnection[]): NativeMemberConnection[] {
	const newest = new Map<string, NativeMemberConnection>();
	for (const account of accounts) {
		const current = newest.get(account.connectionId);
		if (!current || current.connectionVersion < account.connectionVersion) newest.set(account.connectionId, account);
	}
	return [...newest.values()];
}

function accountLabel(account: NativeMemberConnection): string {
	const name =
		account.provider === "openai" || account.provider === "openai-codex"
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
function accountLabels(accounts: readonly NativeMemberConnection[]): string[] {
	const seen = new Map<string, number>();
	return accounts.map((account) => {
		const label = accountLabel(account);
		const count = (seen.get(label) ?? 0) + 1;
		seen.set(label, count);
		return count === 1 ? label : `${label} (${count})`;
	});
}

function runLabel(run: CloudRoutineOccurrence): string {
	const words: Record<string, string> = {
		pending: "Waiting to start",
		queued: "Waiting to start",
		running: "Running",
		completed: "Finished",
		blocked: "Could not start",
		failed: "Failed",
		cancelled: "Cancelled",
		superseded: "Skipped",
	};
	return `${words[run.status] ?? run.status} · ${fmtTime(run.finishedAt ?? run.scheduledFor ?? run.createdAt)}`;
}

function controlLabel(control: Element): string {
	return control.getAttribute("aria-label") ?? control.textContent ?? "";
}

/** The Routines page of an agent's details: standing work the cloud starts on
 * a schedule or when a Company File path changes. */
export class AgentRoutines {
	readonly el = h("section", { class: "agent-page agent-routines" });
	/** The agent as it is now, so a rename shows here without reopening. */
	readonly #agent: () => HostedStaffAgent;
	readonly #access: AgentRoutineAccess | undefined;
	readonly #signal: AbortSignal;
	readonly #back: (() => void) | undefined;
	#routines: CloudRoutine[] = [];
	#runs: CloudRoutineOccurrence[] = [];
	#accounts: NativeMemberConnection[] = [];
	#busy = false;
	#editing = false;
	/** Until the first read answers, an empty list means "not known yet". */
	#loaded = false;
	#message = "";
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
		try {
			const [routines, runs] = await Promise.all([access.routines.list(), access.routines.runs()]);
			if (this.#signal.aborted) return;
			this.#routines = routines.filter(
				(item) => item.staffAgentId === this.#agent().id && item.status !== "retired",
			);
			this.#runs = runs;
			this.#message = "";
		} catch {
			if (this.#signal.aborted) return;
			this.#message = "Routines could not be read. Refresh to try again.";
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
			? button([icon("plus"), "New routine"], () => void this.#edit(undefined), { disabled: this.#busy })
			: null;
		const rows = this.#routines.map((routine) => {
			const last = this.#runs.find((run) => run.routineId === routine.routineId);
			return h(
				"article",
				{ class: "routine-row" },
				h(
					"div",
					{ class: "routine-row-copy" },
					h("strong", null, routine.title),
					h("span", null, routine.triggers.map(describeCloudRoutineTrigger).join("; ")),
					h("small", null, last ? `Last run: ${runLabel(last)}` : "Has not run yet"),
				),
				routine.status === "active" ? badge("Active", "ok") : badge("Paused", "warn"),
				manage
					? h(
							"div",
							{ class: "routine-row-actions" },
							button("Edit", () => void this.#edit(routine), { small: true, disabled: this.#busy }),
							button(routine.status === "active" ? "Pause" : "Resume", () => void this.#toggle(routine), {
								small: true,
								disabled: this.#busy,
							}),
						)
					: null,
			);
		});
		replace(
			this.el,
			dialogPageHeader(
				"Routines",
				this.#back,
				"Back to agent details",
				"Recurring work, on a schedule or when something happens.",
			),
			this.#message ? h("p", { class: "surface-status", role: "status" }, this.#message) : null,
			rows.length
				? [
						h("div", { class: "routine-list" }, ...rows),
						create ? h("div", { class: "routine-list-footer" }, create) : null,
					]
				: access && !this.#loaded
					? h("p", { class: "agent-page-loading", role: "status" }, "Reading routines…")
					: h(
							"div",
							{ class: "agent-page-empty" },
							icon("clock"),
							h(
								"p",
								null,
								access ? `${this.#agent().displayName} has no routines yet.` : "Routines will appear here.",
							),
							create,
						),
		);
		this.#refocus(focused);
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
		(same[index] ?? same[0] ?? this.#controls("Back to agent details")[0])?.focus({ preventScroll: true });
	}
	#controls(label: string): HTMLElement[] {
		return [...this.el.querySelectorAll<HTMLElement>("button")].filter((item) => controlLabel(item) === label);
	}
	async #loadAccounts(): Promise<boolean> {
		try {
			const result = await this.#access!.accounts(this.#signal);
			if (this.#signal.aborted) return false;
			this.#accounts = latestVersions(
				result.connections.filter(
					(item) => item.connectionStatus === "active" && item.authorizationState === "active",
				),
			);
			return true;
		} catch {
			if (!this.#signal.aborted) {
				this.#message = "Your model accounts could not be read. Try again.";
				this.#list();
			}
			return false;
		}
	}
	async #toggle(routine: CloudRoutine): Promise<void> {
		if (this.#busy || !this.#access?.canManage()) return;
		this.#busy = true;
		this.#message = routine.status === "active" ? "Pausing…" : "Resuming…";
		this.#list();
		try {
			if (!(await this.#loadAccounts())) return;
			await this.#access.routines.setEnabled(
				routine,
				this.#accounts[0],
				routine.status !== "active",
				crypto.randomUUID(),
			);
			this.#message = "";
		} catch {
			if (!this.#signal.aborted)
				this.#message = this.#accounts.length
					? "The routine could not be changed. Try again."
					: "Connect a model account in Settings first; a routine runs on the account of the member who last saved it.";
		} finally {
			this.#busy = false;
			if (!this.#signal.aborted) await this.#refresh();
		}
	}
	async #edit(routine: CloudRoutine | undefined): Promise<void> {
		if (this.#busy || this.#editing || !this.#access?.canManage()) return;
		this.#editing = true;
		if (!(await this.#loadAccounts())) {
			this.#editing = false;
			return;
		}
		if (this.#signal.aborted) return;
		const first = routine?.triggers[0];
		const shape: Shape = !first
			? "weekly"
			: first.kind === "listener"
				? "file"
				: "localTime" in first
					? "weekly"
					: "interval";
		const clientRoutineId = routine?.clientRoutineId ?? crypto.randomUUID();
		let saveId = crypto.randomUUID();
		const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
		const title = h("input", {
			type: "text",
			maxlength: "160",
			value: routine?.title ?? "",
			"aria-label": "Routine name",
		});
		const prompt = h(
			"textarea",
			{ rows: 5, maxlength: "8000", "aria-label": "What to do", value: routine?.prompt ?? "" },
			routine?.prompt ?? "",
		);
		const when = h(
			"select",
			{ "aria-label": "When it runs" },
			h("option", { value: "weekly" }, "On chosen days at a set time"),
			h("option", { value: "interval" }, "Every so often"),
			h("option", { value: "file" }, "When something in the Company File changes"),
		);
		when.value = shape;
		const minutes = first && first.kind === "schedule" && !("localTime" in first) ? first.intervalMinutes : 60;
		const unit = h(
			"select",
			{ "aria-label": "Interval unit" },
			h("option", { value: "minutes" }, "minutes"),
			h("option", { value: "hours" }, "hours"),
			h("option", { value: "days" }, "days"),
		);
		unit.value = minutes % 1440 === 0 ? "days" : minutes % 60 === 0 ? "hours" : "minutes";
		const every = h("input", {
			type: "number",
			min: "1",
			max: "10080",
			value: String(minutes / UNITS[unit.value as keyof typeof UNITS]),
			"aria-label": "Interval",
		});
		const chosen = new Set<CloudRoutineWeekday>(
			first && "localTime" in first ? first.weekdays : ["monday", "tuesday", "wednesday", "thursday", "friday"],
		);
		const days = h(
			"div",
			{ class: "routine-days", role: "group", "aria-label": "Days" },
			...CLOUD_ROUTINE_WEEKDAYS.map((day) => {
				const box = h("input", { type: "checkbox", checked: chosen.has(day) });
				box.onchange = () => (box.checked ? chosen.add(day) : chosen.delete(day));
				return h("label", null, box, day[0]!.toUpperCase() + day.slice(1, 3));
			}),
		);
		const time = h("input", {
			type: "time",
			value: first && "localTime" in first ? first.localTime : "09:00",
			"aria-label": "Time",
		});
		const timeZone = h("input", {
			type: "text",
			value: first && "timeZone" in first ? first.timeZone : zone,
			"aria-label": "Time zone",
			maxlength: "128",
		});
		const path = h("input", {
			type: "text",
			value: first?.kind === "listener" ? first.path : "",
			placeholder: "finance/invoices",
			"aria-label": "Company File path",
		});
		const match = h(
			"select",
			{ "aria-label": "What counts as a change" },
			h("option", { value: "subtree" }, "This folder and everything in it"),
			h("option", { value: "exact" }, "Exactly this file"),
		);
		match.value = first?.kind === "listener" ? first.match : "subtree";
		const reply = h(
			"select",
			{ "aria-label": "Reply" },
			h("option", { value: "required" }, "Always post a reply in the conversation"),
			h("option", { value: "optional" }, "Reply only when there is something to say"),
			h("option", { value: "silent" }, "Work silently"),
		);
		reply.value = first?.replyPolicy ?? "required";
		const account = h(
			"select",
			{ "aria-label": "Model account" },
			...accountLabels(this.#accounts).map((label, index) =>
				h("option", { value: this.#accounts[index]!.connectionId }, label),
			),
		);
		const intervalFields = h("div", { class: "routine-inline" }, "Every", every, unit);
		const weeklyFields = h(
			"div",
			{ class: "routine-when" },
			days,
			h("div", { class: "routine-inline" }, "at", time, timeZone),
		);
		const fileFields = h("div", { class: "routine-when" }, path, match);
		const sync = () => {
			intervalFields.hidden = when.value !== "interval";
			weeklyFields.hidden = when.value !== "weekly";
			fileFields.hidden = when.value !== "file";
		};
		when.onchange = sync;
		sync();
		const status = h("p", { class: "surface-status", role: "status" });
		const trigger = (): CloudRoutineTrigger => {
			const replyPolicy = reply.value === "required" ? {} : { replyPolicy: reply.value as CloudRoutineReplyPolicy };
			const id = first?.id ?? crypto.randomUUID();
			if (when.value === "file")
				return parseCloudRoutineTrigger({
					id,
					kind: "listener",
					source: "company-file",
					path: path.value.trim().replace(/^\/+|\/+$/g, ""),
					match: match.value,
					timeZone: timeZone.value.trim() || zone,
					...replyPolicy,
				});
			if (when.value === "weekly")
				return parseCloudRoutineTrigger({
					id,
					kind: "schedule",
					intervalMinutes: 1440,
					weekdays: CLOUD_ROUTINE_WEEKDAYS.filter((day) => chosen.has(day)),
					localTime: time.value,
					timeZone: timeZone.value.trim(),
					...replyPolicy,
				});
			const intervalMinutes = Math.round(Number(every.value) * UNITS[unit.value as keyof typeof UNITS]);
			const kept =
				first && first.kind === "schedule" && !("localTime" in first) && "startAt" in first
					? first.startAt
					: undefined;
			const next = new Date(Math.ceil((Date.now() + intervalMinutes * 60_000) / 60_000) * 60_000);
			return parseCloudRoutineTrigger({
				id,
				kind: "schedule",
				intervalMinutes,
				// The first run is one interval from now, not at once.
				startAt: kept ?? next.toISOString(),
				...replyPolicy,
			});
		};
		const save = button("Save routine", () => void submit(), { primary: true });
		const leave = () => {
			if (!this.#busy) this.#list();
		};
		const cancel = button("Cancel", leave);
		const submit = async () => {
			if (this.#busy || !this.#access?.canManage()) return;
			const chosenAccount = this.#accounts.find((item) => item.connectionId === account.value);
			let built: CloudRoutineTrigger;
			try {
				built = trigger();
			} catch {
				status.textContent =
					when.value === "interval"
						? "Choose an interval between 5 minutes and 7 days."
						: when.value === "weekly"
							? "Choose at least one day, a time and a time zone such as Europe/Copenhagen."
							: "Enter a Company File path such as finance/invoices.";
				return;
			}
			if (!title.value.trim() || !prompt.value.trim()) {
				status.textContent = "Give the routine a name and say what to do.";
				return;
			}
			if (!chosenAccount) {
				status.textContent = "Connect a model account in Settings first.";
				return;
			}
			this.#busy = true;
			save.disabled = cancel.disabled = true;
			status.textContent = "Saving…";
			try {
				await this.#access.routines.save(
					{
						clientRoutineId,
						staffAgentId: this.#agent().id,
						title: title.value.trim(),
						prompt: prompt.value.trim(),
						trigger: built,
						enabled: routine ? routine.status === "active" : true,
					},
					chosenAccount,
					saveId,
				);
				if (this.#signal.aborted) return;
				this.#busy = false;
				this.#editing = false;
				this.#message = "";
				await this.#refresh();
			} catch {
				// A changed draft is a new save; the same draft may be retried as itself.
				saveId = crypto.randomUUID();
				if (!this.#signal.aborted) status.textContent = "The routine could not be saved. Your draft is still here.";
			} finally {
				this.#busy = false;
				save.disabled = cancel.disabled = false;
			}
		};
		replace(
			this.el,
			dialogPageHeader(routine ? "Edit routine" : "New routine", leave, "Back to routines"),
			h(
				"div",
				{ class: "routine-editor" },
				h("label", null, "Name", title),
				h("label", null, `What should ${this.#agent().displayName} do?`, prompt),
				h("label", null, "When", when),
				intervalFields,
				weeklyFields,
				fileFields,
				h("label", null, "Reply", reply),
				this.#accounts.length
					? h(
							"label",
							null,
							"Runs on",
							account,
							h(
								"small",
								null,
								`Saving lets ${this.#agent().displayName} use this account for this routine while you are away. Pause the routine to stop it.`,
							),
						)
					: h(
							"p",
							{ class: "muted" },
							"Connect a model account in Settings → Connections first. A routine runs on a member's own account.",
						),
				status,
				h("div", { class: "surface-actions" }, cancel, save),
			),
		);
		title.focus();
	}
}
