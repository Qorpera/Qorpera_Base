import type { CloudApi } from "../../cloud/api.ts";
import { CloudRpcError, describeError } from "../../cloud/client.ts";
import type { Leaderboard, LeaderboardCompany, LeaderboardPerson } from "../../cloud/social.ts";
import { button, companyLogo, h, notice, replace } from "../../ui/dom.ts";
import { presentationLocale, t } from "../../ui/preferences.ts";
import { listSkeleton } from "../../ui/skeleton.ts";
import { lastOnline, personFace } from "./friends.ts";

/* Settings → Leaderboard (Jonas, 9 Nov 2026): two categories, each for your friends or for companies. Busiest is
 * tasks done this week, a task being work an agent finished and saved for a company; Revenue is all sales so far,
 * without VAT. A person's figure is the sum over the companies they are a member of. One switch takes the account
 * off its friends' boards. Figures come from qorpera_friends_leaderboard. */

type Category = "busiest" | "revenue";
type Who = "friends" | "companies";

const count = (value: number) => new Intl.NumberFormat(presentationLocale()).format(value);
const kroner = (ore: number) =>
	new Intl.NumberFormat(presentationLocale(), { style: "currency", currency: "DKK", maximumFractionDigits: 0 }).format(
		ore / 100,
	);

/** Places by score, with ties sharing a place (1, 1, 3). */
function ranked<Row>(rows: readonly Row[], value: (row: Row) => number): { row: Row; place: number }[] {
	const sorted = [...rows].sort((a, b) => value(b) - value(a));
	let place = 0;
	return sorted.map((row, index) => {
		if (index === 0 || value(row) !== value(sorted[index - 1]!)) place = index + 1;
		return { row, place };
	});
}

/** One row of a board: who, a line under the name, and their figure. */
interface Shown {
	face: HTMLElement;
	name: string;
	detail: string;
	me: boolean;
	value: number;
}

export class LeaderboardView {
	readonly el: HTMLElement;
	readonly #api: CloudApi;
	readonly #signal: AbortSignal;
	readonly #openFriends: () => void;
	readonly #category = h("div", { class: "settings-modes", role: "group", "aria-label": t("Category") });
	readonly #who = h("div", { class: "settings-modes", role: "group", "aria-label": t("Friends or companies") });
	readonly #about = h("p", { class: "leaderboard-about" });
	readonly #list = h("div", { class: "leaderboard-list" });
	readonly #switch: HTMLButtonElement;
	readonly #switchNote = h("small");
	#data: Leaderboard | undefined;
	#shownCategory: Category = "busiest";
	#shownWho: Who = "friends";
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
		const choice = (group: HTMLElement, value: string, label: string, pick: () => void) =>
			group.append(
				h("button", { type: "button", class: "settings-mode", "data-value": value, onclick: pick }, label),
			);
		choice(this.#category, "busiest", t("Busiest"), () => this.#show({ category: "busiest" }));
		choice(this.#category, "revenue", t("Revenue"), () => this.#show({ category: "revenue" }));
		choice(this.#who, "friends", t("Friends"), () => this.#show({ who: "friends" }));
		choice(this.#who, "companies", t("Companies"), () => this.#show({ who: "companies" }));
		this.el = h(
			"section",
			{ class: "page leaderboard" },
			h("h1", null, t("Leaderboard")),
			h("p", { class: "settings-lead" }, t("See how you and your friends are doing.")),
			h("div", { class: "leaderboard-bar" }, this.#category, this.#who),
			this.#about,
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

	#show(next: { category?: Category; who?: Who }): void {
		this.#shownCategory = next.category ?? this.#shownCategory;
		this.#shownWho = next.who ?? this.#shownWho;
		this.#draw();
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
			: t("Your friends see you and your companies.");
		for (const [group, chosen] of [
			[this.#category, this.#shownCategory],
			[this.#who, this.#shownWho],
		] as const)
			for (const control of group.querySelectorAll<HTMLButtonElement>("button"))
				control.setAttribute("aria-pressed", String(control.dataset.value === chosen));
		this.#about.textContent =
			this.#shownCategory === "busiest"
				? t("Tasks done this week. A task is work an agent finished for a company.")
				: t("All sales so far, without VAT.");
		this.#list.toggleAttribute("aria-busy", this.#loading);
		if (this.#missing) {
			replace(this.#list, notice("neutral", t("The leaderboard isn't available yet.")));
			return;
		}
		if (!data) {
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
		this.#drawBoard(data);
	}

	/** The chosen category for your friends or for companies. A row with nothing yet has no place. */
	#drawBoard(data: Leaderboard): void {
		const revenue = this.#shownCategory === "revenue";
		const figure = (row: { tasks: number; revenueOre: number }) => (revenue ? row.revenueOre : row.tasks);
		const rows: Shown[] =
			this.#shownWho === "friends"
				? data.people.map((person) => this.#person(person, figure(person)))
				: data.companies.map((company) => this.#company(company, data, figure(company)));
		const top = Math.max(1, ...rows.map((row) => row.value));
		const friends = data.people.filter((person) => !person.me).length;
		replace(
			this.#list,
			this.#error ? notice("danger", this.#error) : null,
			rows.length
				? h(
						"ol",
						{ class: "leaderboard-rows", "aria-label": this.#about.textContent ?? "" },
						...ranked(rows, (row) => row.value).map(({ row, place }) => {
							const bar = h("span", { class: "leaderboard-meter-fill" });
							bar.style.width = `${Math.round((row.value / top) * 100)}%`;
							return h(
								"li",
								{
									class: [
										"leaderboard-row",
										row.me ? "is-me" : "",
										row.value > 0 && place <= 3 ? `is-place-${place}` : "",
									]
										.filter(Boolean)
										.join(" "),
								},
								h(
									"span",
									{ class: "leaderboard-place", "aria-label": t("Place {place}", { place }) },
									row.value > 0 ? String(place) : "–",
								),
								row.face,
								h(
									"span",
									{ class: "leaderboard-who" },
									h("strong", null, row.name),
									row.detail ? h("small", null, row.detail) : null,
								),
								h(
									"span",
									{ class: "leaderboard-score" },
									h("strong", null, revenue ? kroner(row.value) : count(row.value)),
									revenue ? null : h("small", null, row.value === 1 ? t("task done") : t("tasks done")),
									h("span", { class: "leaderboard-meter", "aria-hidden": "true" }, bar),
								),
							);
						}),
					)
				: h("p", { class: "panel-empty muted" }, t("No companies yet.")),
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

	#person(person: LeaderboardPerson, value: number): Shown {
		const seen = person.me ? undefined : lastOnline(person.lastSeenAt);
		const companies =
			person.companies === 1 ? t("1 company") : t("{count} companies", { count: count(person.companies) });
		return {
			face: personFace(person.displayName, person.userId, seen?.online === true),
			name: person.displayName,
			detail: [person.me ? t("You") : seen?.text, companies].filter(Boolean).join(" · "),
			me: person.me,
			value,
		};
	}

	#company(company: LeaderboardCompany, data: Leaderboard, value: number): Shown {
		const members = company.members
			.map((id) => data.people.find((person) => person.userId === id))
			.filter((person): person is LeaderboardPerson => Boolean(person));
		return {
			face: companyLogo(company.profileId),
			name: company.name,
			detail: members.map((person) => (person.me ? t("You") : person.displayName)).join(", "),
			me: members.some((person) => person.me),
			value,
		};
	}
}
