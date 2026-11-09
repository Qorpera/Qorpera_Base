import type { CloudApi } from "../../cloud/api.ts";
import { CloudRpcError, describeError } from "../../cloud/client.ts";
import type { Leaderboard, LeaderboardAgent, LeaderboardCompany, LeaderboardPerson } from "../../cloud/social.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { button, companyLogo, h, notice, replace } from "../../ui/dom.ts";
import { presentationLocale, t } from "../../ui/preferences.ts";
import { listSkeleton } from "../../ui/skeleton.ts";
import { lastOnline, personFace } from "./friends.ts";

/* Settings → Leaderboard (Jonas, 9 Nov 2026): this week with your friends, for regular people, not a dashboard. On
 * top, this week's awards: Star agent, Longest streak, Busiest team, Biggest team, and Top seller once a company
 * sells. Under them, you and your friends by tasks done, a task being work an agent finished and saved for one of
 * your companies, each with their streak of days in a row. No tabs, periods or filters. One switch takes the account
 * off its friends' boards. Figures come from qorpera_friends_leaderboard. */

const count = (value: number) => new Intl.NumberFormat(presentationLocale()).format(value);
const kroner = (ore: number) =>
	new Intl.NumberFormat(presentationLocale(), { style: "currency", currency: "DKK", maximumFractionDigits: 0 }).format(
		ore / 100,
	);
const tasks = (value: number) => (value === 1 ? t("1 task done") : t("{count} tasks done", { count: count(value) }));
const streak = (value: number) =>
	value === 1 ? t("1 day in a row") : t("{count} days in a row", { count: count(value) });

/** Places by score, with ties sharing a place (1, 1, 3). */
function ranked<Row>(rows: readonly Row[], value: (row: Row) => number): { row: Row; place: number }[] {
	const sorted = [...rows].sort((a, b) => value(b) - value(a));
	let place = 0;
	return sorted.map((row, index) => {
		if (index === 0 || value(row) !== value(sorted[index - 1]!)) place = index + 1;
		return { row, place };
	});
}

/** The row with the highest score above zero, the first of a tie. */
function best<Row>(rows: readonly Row[], value: (row: Row) => number): Row | undefined {
	let top: Row | undefined;
	for (const row of rows) if (value(row) > 0 && (!top || value(row) > value(top))) top = row;
	return top;
}

export class LeaderboardView {
	readonly el: HTMLElement;
	readonly #api: CloudApi;
	readonly #signal: AbortSignal;
	readonly #openFriends: () => void;
	readonly #awards = h("div", { class: "leaderboard-awards" });
	readonly #list = h("div", { class: "leaderboard-list" });
	readonly #switch: HTMLButtonElement;
	readonly #switchNote = h("small");
	#data: Leaderboard | undefined;
	#loading = false;
	#error: string | undefined;
	#missing = false;
	#saving = false;
	/** The visibility this page last saved. A board read that overlapped the save may carry the old choice, so it
	 * shows this one instead; a read started after the save is the database's own word. */
	#savedHidden: boolean | undefined;
	/** Visibility saves started, so a read knows whether one overlapped it. */
	#saves = 0;
	#turn = 0;

	constructor(api: CloudApi, signal: AbortSignal, openFriends: () => void) {
		this.#api = api;
		this.#signal = signal;
		this.#openFriends = openFriends;
		this.#switch = h("button", {
			type: "button",
			role: "switch",
			class: "routine-switch",
			"aria-label": t("Show me on my friends' leaderboards"),
			onclick: () => {
				if (this.#switch.getAttribute("aria-disabled") !== "true")
					void this.#setVisible(this.#switch.getAttribute("aria-checked") !== "true");
			},
		});
		this.el = h(
			"section",
			{ class: "page leaderboard" },
			h("h1", null, t("Leaderboard")),
			h(
				"p",
				{ class: "settings-lead" },
				t("This week with your friends. A task is work an agent finished for one of your companies."),
			),
			this.#awards,
			this.#list,
			h(
				"div",
				{ class: "settings-preference-row leaderboard-visible" },
				h(
					"div",
					{ class: "settings-copy" },
					h("span", null, t("Show me on my friends' leaderboards")),
					this.#switchNote,
				),
				this.#switch,
			),
		);
		this.#draw();
		void this.load();
	}

	async load(): Promise<void> {
		if (this.#signal.aborted) return;
		const turn = ++this.#turn;
		// A save pending now, or started before this read answers, may land after the database read the old choice.
		const saves = this.#saves;
		const savePending = this.#saving;
		this.#loading = true;
		this.#error = undefined;
		this.#draw();
		try {
			const data = await this.#api.getFriendsLeaderboard();
			if (this.#signal.aborted || turn !== this.#turn) return;
			const overlapped = (savePending || this.#saves !== saves) && this.#savedHidden !== undefined;
			this.#data = overlapped ? { ...data, hidden: this.#savedHidden! } : data;
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
		this.#saves++;
		this.#draw();
		try {
			await this.#api.setLeaderboardHidden(!visible);
			this.#savedHidden = !visible;
			if (this.#data) this.#data = { ...this.#data, hidden: !visible };
		} catch (error) {
			// The save may have landed anyway: the next read says what the database holds.
			this.#savedHidden = undefined;
			if (!this.#signal.aborted) this.#error = describeError(error);
		} finally {
			this.#saving = false;
			if (!this.#signal.aborted) this.#draw();
		}
	}

	#draw(): void {
		if (this.#signal.aborted) return;
		const data = this.#data;
		this.#switch.setAttribute("aria-checked", String(!data?.hidden));
		this.#switch.toggleAttribute("aria-busy", this.#saving);
		if (!data || this.#saving || this.#missing) this.#switch.setAttribute("aria-disabled", "true");
		else this.#switch.removeAttribute("aria-disabled");
		this.#switchNote.textContent = data?.hidden
			? t("Your friends don't see you now. You still see yourself here.")
			: t("Your friends see you, your companies and their agents.");
		this.#list.toggleAttribute("aria-busy", this.#loading);
		if (this.#missing) {
			replace(this.#awards);
			replace(this.#list, notice("neutral", t("The leaderboard isn't available yet.")));
			return;
		}
		if (!data) {
			replace(this.#awards);
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
		this.#drawAwards(data);
		this.#drawPeople(data);
	}

	/** This week's awards; one shows only once someone has earned it. */
	#drawAwards(data: Leaderboard): void {
		const star = best(data.agents, (agent: LeaderboardAgent) => agent.tasks);
		const steady = best(data.people, (person: LeaderboardPerson) => person.streak);
		const busiest = best(data.companies, (company: LeaderboardCompany) => company.tasks);
		const biggest = best(data.companies, (company: LeaderboardCompany) => company.agents);
		const seller = best(data.companies, (company: LeaderboardCompany) => company.salesOre);
		const award = (title: string, face: HTMLElement, name: string, line: string) =>
			h(
				"div",
				{ class: "leaderboard-award" },
				face,
				h(
					"span",
					{ class: "leaderboard-award-copy" },
					h("small", null, title),
					h("strong", null, name),
					h("span", null, line),
				),
			);
		const figure = (agent: LeaderboardAgent) =>
			agentFigure(
				{
					id: agent.staffAgentId,
					displayName: agent.displayName,
					appearance: agent.appearance,
					templateId: agent.templateId,
				},
				agent.displayName,
				{ size: 44 },
			);
		replace(
			this.#awards,
			star
				? award(
						t("Star agent"),
						figure(star),
						star.displayName,
						t("{tasks} at {company}", { tasks: tasks(star.tasks), company: star.companyName }),
					)
				: null,
			steady
				? award(
						t("Longest streak"),
						personFace(steady.displayName, steady.userId, false),
						steady.me ? t("You") : steady.displayName,
						streak(steady.streak),
					)
				: null,
			busiest ? award(t("Busiest team"), companyLogo(busiest.profileId), busiest.name, tasks(busiest.tasks)) : null,
			biggest
				? award(
						t("Biggest team"),
						companyLogo(biggest.profileId),
						biggest.name,
						biggest.agents === 1 ? t("1 agent") : t("{count} agents", { count: count(biggest.agents) }),
					)
				: null,
			seller
				? award(
						t("Top seller"),
						companyLogo(seller.profileId),
						seller.name,
						t("{amount} in sales", { amount: kroner(seller.salesOre) }),
					)
				: null,
		);
	}

	/** You and your friends by tasks done this week. */
	#drawPeople(data: Leaderboard): void {
		const top = Math.max(1, ...data.people.map((person) => person.tasks));
		const friends = data.people.filter((person) => !person.me).length;
		replace(
			this.#list,
			this.#error ? notice("danger", this.#error) : null,
			h(
				"ol",
				{ class: "leaderboard-rows", "aria-label": t("You and your friends this week") },
				...ranked(data.people, (person) => person.tasks).map(({ row, place }) => {
					const seen = row.me ? undefined : lastOnline(row.lastSeenAt);
					const detail = [row.me ? t("You") : seen?.text, row.streak > 0 ? streak(row.streak) : null]
						.filter(Boolean)
						.join(" · ");
					const bar = h("span", { class: "leaderboard-meter-fill" });
					bar.style.width = `${Math.round((row.tasks / top) * 100)}%`;
					return h(
						"li",
						{
							class: [
								"leaderboard-row",
								row.me ? "is-me" : "",
								row.tasks > 0 && place <= 3 ? `is-place-${place}` : "",
							]
								.filter(Boolean)
								.join(" "),
						},
						h("span", { class: "leaderboard-place", "aria-label": t("Place {place}", { place }) }, String(place)),
						personFace(row.displayName, row.userId, seen?.online === true),
						h(
							"span",
							{ class: "leaderboard-who" },
							h("strong", null, row.displayName),
							detail ? h("small", null, detail) : null,
						),
						h(
							"span",
							{ class: "leaderboard-score" },
							h("strong", null, count(row.tasks)),
							h("small", null, row.tasks === 1 ? t("task done") : t("tasks done")),
							h("span", { class: "leaderboard-meter", "aria-hidden": "true" }, bar),
						),
					);
				}),
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
}
