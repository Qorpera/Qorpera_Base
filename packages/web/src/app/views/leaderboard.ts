import type { CloudApi } from "../../cloud/api.ts";
import { CloudRpcError, describeError } from "../../cloud/client.ts";
import type {
	Leaderboard,
	LeaderboardAgent,
	LeaderboardCompany,
	LeaderboardDays,
	LeaderboardPerson,
} from "../../cloud/social.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { button, companyLogo, h, notice, replace } from "../../ui/dom.ts";
import { presentationLocale, t } from "../../ui/preferences.ts";
import { listSkeleton } from "../../ui/skeleton.ts";
import { lastOnline, personFace } from "./friends.ts";

/* Settings → Leaderboard (Jonas, 9 Nov 2026): you and your friends compared over the last 7 or 30 days, as people,
 * as companies, and as the agents of those companies. Everything is counted by the database
 * (qorpera_friends_leaderboard): agent runs, hours agents ran, active days, messages written, active agents, sales the
 * good will counted, and per agent its runs and the runs that saved work. One switch takes the account off its
 * friends' boards. */

type Board = "people" | "companies" | "agents";

interface Metric<Row> {
	id: string;
	/** The chip's label, and the unit under the score. */
	label: () => string;
	unit: (value: number) => string;
	value: (row: Row) => number;
	/** Sales show as money, hours with one decimal. */
	format?: (value: number) => string;
}

const count = (value: number) => new Intl.NumberFormat(presentationLocale()).format(value);
const hours = (value: number) =>
	new Intl.NumberFormat(presentationLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
const kroner = (ore: number) =>
	new Intl.NumberFormat(presentationLocale(), { style: "currency", currency: "DKK", maximumFractionDigits: 0 }).format(
		ore / 100,
	);

const AGENT_RUNS = {
	id: "runs",
	label: () => t("Agent runs"),
	unit: (value: number) => (value === 1 ? t("agent run") : t("agent runs")),
};
const AGENT_HOURS = {
	id: "hours",
	label: () => t("Agent hours"),
	unit: (value: number) => (value === 1 ? t("agent hour") : t("agent hours")),
	format: hours,
};
const SALES = { id: "sales", label: () => t("Sales"), unit: () => t("sales"), format: kroner };

const PEOPLE: Metric<LeaderboardPerson>[] = [
	{ ...AGENT_RUNS, value: (row) => row.agentRuns },
	{ ...AGENT_HOURS, value: (row) => row.agentHours },
	{
		id: "days",
		label: () => t("Active days"),
		unit: (value) => (value === 1 ? t("active day") : t("active days")),
		value: (row) => row.activeDays,
	},
	{
		id: "messages",
		label: () => t("Messages"),
		unit: (value) => (value === 1 ? t("message") : t("messages")),
		value: (row) => row.messages,
	},
	{ ...SALES, value: (row) => row.salesOre },
];
const COMPANIES: Metric<LeaderboardCompany>[] = [
	{ ...AGENT_RUNS, value: (row) => row.agentRuns },
	{ ...AGENT_HOURS, value: (row) => row.agentHours },
	{
		id: "agents",
		label: () => t("Agents"),
		unit: (value) => (value === 1 ? t("agent") : t("agents")),
		value: (row) => row.agents,
	},
	{ ...SALES, value: (row) => row.salesOre },
];
const AGENTS: Metric<LeaderboardAgent>[] = [
	{
		id: "runs",
		label: () => t("Runs"),
		unit: (value) => (value === 1 ? t("run") : t("runs")),
		value: (row) => row.runs,
	},
	{
		id: "saved",
		label: () => t("Saved work"),
		unit: (value) => (value === 1 ? t("run saved work") : t("runs saved work")),
		value: (row) => row.saved,
	},
];

/** Places by score, with ties sharing a place (1, 1, 3). */
function ranked<Row>(rows: readonly Row[], value: (row: Row) => number): { row: Row; place: number }[] {
	const sorted = [...rows].sort((a, b) => value(b) - value(a));
	let place = 0;
	return sorted.map((row, index) => {
		if (index === 0 || value(row) !== value(sorted[index - 1]!)) place = index + 1;
		return { row, place };
	});
}

export class LeaderboardView {
	readonly el: HTMLElement;
	readonly #api: CloudApi;
	readonly #signal: AbortSignal;
	readonly #openFriends: () => void;
	readonly #tabs = h("div", { class: "leaderboard-switch", role: "group", "aria-label": t("Compare") });
	readonly #period = h("div", { class: "leaderboard-switch", role: "group", "aria-label": t("Period") });
	readonly #metrics = h("div", { class: "leaderboard-metrics", role: "group", "aria-label": t("Rank by") });
	readonly #list = h("div", { class: "leaderboard-list" });
	readonly #visible: HTMLInputElement;
	readonly #visibleNote = h("small", { class: "muted" });
	#board: Board = "people";
	#days: LeaderboardDays = 7;
	#metric: Record<Board, string> = { people: "runs", companies: "runs", agents: "runs" };
	#data: Leaderboard | undefined;
	#loading = false;
	#error: string | undefined;
	#missing = false;
	#saving = false;
	/** The visibility this page last saved: a board read before the save landed must not show the old one. */
	#savedHidden: boolean | undefined;
	#turn = 0;

	constructor(api: CloudApi, signal: AbortSignal, openFriends: () => void) {
		this.#api = api;
		this.#signal = signal;
		this.#openFriends = openFriends;
		for (const [board, label] of [
			["people", t("People")],
			["companies", t("Companies")],
			["agents", t("Agents")],
		] as const)
			this.#tabs.append(
				h(
					"button",
					{
						type: "button",
						"data-board": board,
						onclick: () => {
							this.#board = board;
							this.#draw();
						},
					},
					label,
				),
			);
		for (const days of [7, 30] as const)
			this.#period.append(
				h(
					"button",
					{
						type: "button",
						"data-days": String(days),
						onclick: () => {
							if (this.#days === days) return;
							this.#days = days;
							void this.load();
						},
					},
					days === 7 ? t("7 days") : t("30 days"),
				),
			);
		this.#visible = h("input", {
			type: "checkbox",
			onchange: () => void this.#setVisible(this.#visible.checked),
		});
		this.el = h(
			"section",
			{ class: "page leaderboard" },
			h("h1", null, t("Leaderboard")),
			h(
				"p",
				{ class: "settings-lead" },
				t("How you and your friends compare: you, your companies, and the agents that work in them."),
			),
			h("div", { class: "leaderboard-bar" }, this.#tabs, this.#period),
			this.#metrics,
			this.#list,
			h(
				"label",
				{ class: "leaderboard-visible" },
				this.#visible,
				h("span", null, h("strong", null, t("Show me on my friends' leaderboards")), this.#visibleNote),
			),
		);
		this.#draw();
		void this.load();
	}

	async load(): Promise<void> {
		if (this.#signal.aborted) return;
		const turn = ++this.#turn;
		this.#loading = true;
		this.#error = undefined;
		this.#draw();
		try {
			const data = await this.#api.getFriendsLeaderboard(this.#days);
			if (this.#signal.aborted || turn !== this.#turn) return;
			this.#data = this.#savedHidden === undefined ? data : { ...data, hidden: this.#savedHidden };
		} catch (error) {
			if (this.#signal.aborted || turn !== this.#turn) return;
			if (error instanceof CloudRpcError && error.missing) this.#missing = true;
			else this.#error = describeError(error);
		} finally {
			if (!this.#signal.aborted && turn === this.#turn) {
				this.#loading = false;
				this.#draw();
			}
		}
	}

	async #setVisible(visible: boolean): Promise<void> {
		if (this.#saving || this.#signal.aborted) return;
		this.#saving = true;
		this.#draw();
		try {
			await this.#api.setLeaderboardHidden(!visible);
			this.#savedHidden = !visible;
			if (this.#data) this.#data = { ...this.#data, hidden: !visible };
		} catch (error) {
			if (!this.#signal.aborted) this.#error = describeError(error);
		} finally {
			this.#saving = false;
			if (!this.#signal.aborted) this.#draw();
		}
	}

	#draw(): void {
		if (this.#signal.aborted) return;
		for (const control of this.#tabs.querySelectorAll<HTMLButtonElement>("button"))
			control.setAttribute("aria-pressed", String(control.dataset.board === this.#board));
		for (const control of this.#period.querySelectorAll<HTMLButtonElement>("button")) {
			control.setAttribute("aria-pressed", String(control.dataset.days === String(this.#days)));
			control.disabled = this.#missing;
		}
		const data = this.#data;
		this.#visible.checked = !data?.hidden;
		this.#visible.disabled = !data || this.#saving || this.#missing;
		this.#visibleNote.textContent = data?.hidden
			? t("Your friends don't see you now. You still see yourself here.")
			: t("Your friends see your row, your companies and their agents.");
		this.#list.toggleAttribute("aria-busy", this.#loading);
		if (this.#missing) {
			replace(this.#metrics);
			replace(this.#list, notice("neutral", t("The leaderboard isn't available yet.")));
			return;
		}
		if (!data) {
			replace(this.#metrics);
			replace(
				this.#list,
				this.#error
					? notice(
							"danger",
							this.#error,
							" ",
							button(t("Try again"), () => void this.load(), { small: true }),
						)
					: listSkeleton(t("Loading leaderboard"), 4),
			);
			return;
		}
		if (this.#board === "people") this.#drawBoard(PEOPLE, data.people, (row, metric) => this.#personRow(row, metric));
		else if (this.#board === "companies")
			this.#drawBoard(COMPANIES, data.companies, (row, metric) => this.#companyRow(row, metric, data));
		else this.#drawBoard(AGENTS, data.agents, (row) => this.#agentRow(row, data));
	}

	#drawBoard<Row>(
		metrics: Metric<Row>[],
		rows: readonly Row[],
		draw: (row: Row, metric: Metric<Row>) => { face: HTMLElement; name: string; detail: string; me?: boolean },
	): void {
		const metric = metrics.find((item) => item.id === this.#metric[this.#board]) ?? metrics[0]!;
		replace(
			this.#metrics,
			h("span", { class: "leaderboard-metrics-label" }, t("Rank by")),
			...metrics.map((item) =>
				h(
					"button",
					{
						type: "button",
						"aria-pressed": String(item === metric),
						onclick: () => {
							this.#metric[this.#board] = item.id;
							this.#draw();
						},
					},
					item.label(),
				),
			),
		);
		const places = ranked(rows, metric.value);
		const top = Math.max(1, ...rows.map(metric.value));
		const friends = this.#data?.people.filter((person) => !person.me).length ?? 0;
		replace(
			this.#list,
			this.#error ? notice("danger", this.#error) : null,
			places.length
				? h(
						"ol",
						{ class: "leaderboard-rows", "aria-label": metric.label() },
						...places.map(({ row, place }) => {
							const shown = draw(row, metric);
							const value = metric.value(row);
							const bar = h("span", { class: "leaderboard-meter-fill" });
							bar.style.width = `${Math.round((value / top) * 100)}%`;
							return h(
								"li",
								{
									class: [
										"leaderboard-row",
										shown.me ? "is-me" : "",
										value > 0 && place <= 3 ? `is-place-${place}` : "",
									]
										.filter(Boolean)
										.join(" "),
								},
								h(
									"span",
									{ class: "leaderboard-place", "aria-label": t("Place {place}", { place }) },
									String(place),
								),
								shown.face,
								h(
									"span",
									{ class: "leaderboard-who" },
									h("strong", null, shown.name),
									shown.detail ? h("small", null, shown.detail) : null,
								),
								h(
									"span",
									{ class: "leaderboard-score" },
									h("strong", null, (metric.format ?? count)(value)),
									h("small", null, metric.unit(value)),
									h("span", { class: "leaderboard-meter", "aria-hidden": "true" }, bar),
								),
							);
						}),
					)
				: h(
						"p",
						{ class: "panel-empty muted" },
						this.#board === "agents" ? t("No agent has run in this period.") : t("Nothing to compare yet."),
					),
			friends === 0
				? h(
						"div",
						{ class: "leaderboard-invite" },
						h(
							"span",
							null,
							h("strong", null, t("Better with friends")),
							h("small", null, t("Add friends to see how you and your companies compare.")),
						),
						button(t("Add friends"), () => this.#openFriends(), { primary: true, small: true }),
					)
				: null,
		);
	}

	#personRow(row: LeaderboardPerson, metric: Metric<LeaderboardPerson>) {
		const seen = lastOnline(row.lastSeenAt);
		const companies = row.companies === 1 ? t("1 company") : t("{count} companies", { count: count(row.companies) });
		const detail = [
			row.me ? t("You") : seen?.text,
			companies,
			metric.id === "runs" ? null : this.#runsLine(row.agentRuns),
		]
			.filter(Boolean)
			.join(" · ");
		return {
			face: personFace(row.displayName, row.userId, !row.me && seen?.online === true),
			name: row.displayName,
			detail,
			me: row.me,
		};
	}

	#companyRow(row: LeaderboardCompany, metric: Metric<LeaderboardCompany>, data: Leaderboard) {
		const names = row.members
			.map((id) => data.people.find((person) => person.userId === id))
			.filter((person): person is LeaderboardPerson => Boolean(person))
			.map((person) => (person.me ? t("You") : person.displayName));
		const detail = [
			names.join(", "),
			metric.id === "agents"
				? null
				: row.agents === 1
					? t("1 agent")
					: t("{count} agents", { count: count(row.agents) }),
		]
			.filter(Boolean)
			.join(" · ");
		return {
			face: companyLogo(row.profileId, "leaderboard-logo"),
			name: row.name,
			detail,
			me: row.members.some((id) => data.people.some((person) => person.me && person.userId === id)),
		};
	}

	/** An agent of one of your own companies is marked as yours. */
	#agentRow(row: LeaderboardAgent, data: Leaderboard) {
		const me = data.people.find((person) => person.me)?.userId;
		return {
			face: agentFigure(
				{
					id: row.staffAgentId,
					displayName: row.displayName,
					appearance: row.appearance,
					templateId: row.templateId,
				},
				row.displayName,
				{ size: 34, still: true },
			),
			name: row.displayName,
			detail: [row.role === row.displayName ? "" : row.role, row.companyName].filter(Boolean).join(" · "),
			me: data.companies.some(
				(company) => company.profileId === row.profileId && company.members.includes(me ?? ""),
			),
		};
	}

	#runsLine(runs: number): string {
		return runs === 1 ? t("1 agent run") : t("{count} agent runs", { count: count(runs) });
	}
}
