import type { CloudApi } from "../../cloud/api.ts";
import { CloudRpcError, describeError } from "../../cloud/client.ts";
import type { Leaderboard, LeaderboardCompany, LeaderboardPerson } from "../../cloud/social.ts";
import { button, companyLogo, h, notice, replace } from "../../ui/dom.ts";
import { presentationLocale, t } from "../../ui/preferences.ts";
import { listSkeleton } from "../../ui/skeleton.ts";
import { lastOnline } from "./friends.ts";

/* Settings → Leaderboard (Jonas, 9 Nov 2026: direction C, "Champion of the week"). Four wide tabs across the page:
 * busiest friends and busiest companies this week (a round from Monday, Danish time; a task is work an agent finished
 * and saved for a company), and top-earning friends and companies (all sales so far, without VAT). Whoever leads gets
 * a banner with their figure cheering; the ranking below shows who moved up or down since last week, and your own
 * row says how far it is to the next place. A person's figures sum their companies, and the figure of their busiest
 * company stands for them. One switch takes the account off its friends' boards (qorpera_friends_leaderboard). */

type Board = "busy-friends" | "busy-companies" | "earning-friends" | "earning-companies";

const BOARDS: { id: Board; title: () => string; period: () => string }[] = [
	{ id: "busy-friends", title: () => t("Busiest friends"), period: () => t("This week") },
	{ id: "busy-companies", title: () => t("Busiest companies"), period: () => t("This week") },
	{ id: "earning-friends", title: () => t("Top-earning friends"), period: () => t("All time") },
	{ id: "earning-companies", title: () => t("Top-earning companies"), period: () => t("All time") },
];

const count = (value: number) => new Intl.NumberFormat(presentationLocale()).format(value);
const kroner = (ore: number) =>
	new Intl.NumberFormat(presentationLocale(), { style: "currency", currency: "DKK", maximumFractionDigits: 0 }).format(
		ore / 100,
	);
const tasks = (value: number) => (value === 1 ? t("1 task") : t("{count} tasks", { count: count(value) }));

/** Places by score, with ties sharing a place (1, 1, 3). */
function placesBy<Row>(rows: readonly Row[], value: (row: Row) => number): Map<Row, number> {
	const sorted = [...rows].sort((a, b) => value(b) - value(a));
	const places = new Map<Row, number>();
	sorted.forEach((row, index) => {
		const previous = sorted[index - 1];
		places.set(row, index > 0 && previous && value(row) === value(previous) ? places.get(previous)! : index + 1);
	});
	return places;
}

/** One row of a board: who, how to draw them, this week's figure and last week's. */
interface Entry {
	key: string;
	name: string;
	/** The seed of the company figure that stands for them. */
	figure: string;
	detail: string;
	me: boolean;
	value: number;
	lastWeek: number;
	/** The company the leader's line names ("at Lærdom"), for a person. */
	company?: string;
}

export class LeaderboardView {
	readonly el: HTMLElement;
	readonly #api: CloudApi;
	readonly #signal: AbortSignal;
	readonly #openFriends: () => void;
	readonly #tabs = h("div", { class: "leaderboard-tabs", role: "tablist", "aria-label": t("Leaderboards") });
	readonly #champion = h("div", { class: "leaderboard-champion-slot" });
	readonly #list = h("div", { class: "leaderboard-list", role: "tabpanel" });
	readonly #switch: HTMLButtonElement;
	readonly #switchNote = h("small");
	#data: Leaderboard | undefined;
	#board: Board = "busy-friends";
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
		for (const board of BOARDS)
			this.#tabs.append(
				h(
					"button",
					{
						type: "button",
						role: "tab",
						class: "leaderboard-tab",
						"data-board": board.id,
						onclick: () => {
							this.#board = board.id;
							this.#draw();
						},
					},
					h("strong", null, board.title()),
					h("small", null, board.period()),
				),
			);
		this.#tabs.addEventListener("keydown", (event) => {
			if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
			event.preventDefault();
			const index = BOARDS.findIndex((board) => board.id === this.#board);
			const next = BOARDS[(index + (event.key === "ArrowRight" ? 1 : -1) + BOARDS.length) % BOARDS.length]!;
			this.#board = next.id;
			this.#draw();
			this.#tabs.querySelector<HTMLElement>(`[data-board="${next.id}"]`)?.focus();
		});
		this.el = h(
			"section",
			{ class: "page leaderboard" },
			h("h1", null, t("Leaderboard")),
			this.#tabs,
			this.#champion,
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
			: t("Your friends see you and your companies.");
		for (const tab of this.#tabs.querySelectorAll<HTMLButtonElement>("[role=tab]")) {
			const chosen = tab.dataset.board === this.#board;
			tab.setAttribute("aria-selected", String(chosen));
			tab.tabIndex = chosen ? 0 : -1;
		}
		this.#list.toggleAttribute("aria-busy", this.#loading);
		if (this.#missing) {
			replace(this.#champion);
			replace(this.#list, notice("neutral", t("The leaderboard isn't available yet.")));
			return;
		}
		if (!data) {
			replace(this.#champion);
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

	#entries(data: Leaderboard): Entry[] {
		const earning = this.#board.startsWith("earning");
		const companyName = (id: string | null) => data.companies.find((company) => company.profileId === id)?.name;
		if (this.#board.endsWith("friends"))
			return data.people.map((person: LeaderboardPerson) => {
				const seen = person.me ? undefined : lastOnline(person.lastSeenAt);
				return {
					key: person.userId,
					name: person.displayName,
					figure: person.mainProfileId ?? person.userId,
					detail: person.me ? t("You") : (seen?.text ?? ""),
					me: person.me,
					value: earning ? person.revenueOre : person.tasks,
					lastWeek: person.lastWeekTasks,
					...(companyName(person.mainProfileId) ? { company: companyName(person.mainProfileId)! } : {}),
				};
			});
		return data.companies.map((company: LeaderboardCompany) => {
			const members = company.members
				.map((id) => data.people.find((person) => person.userId === id))
				.filter((person): person is LeaderboardPerson => Boolean(person));
			return {
				key: company.profileId,
				name: company.name,
				figure: company.profileId,
				detail: members.map((person) => (person.me ? t("You") : person.displayName)).join(", "),
				me: members.some((person) => person.me),
				value: earning ? company.revenueOre : company.tasks,
				lastWeek: company.lastWeekTasks,
			};
		});
	}

	#drawBoard(data: Leaderboard): void {
		const earning = this.#board.startsWith("earning");
		const entries = this.#entries(data);
		const places = placesBy(entries, (entry) => entry.value);
		const ordered = [...entries].sort((a, b) => places.get(a)! - places.get(b)!);
		// Up or down since last week, for this week's boards, once last week had anything to rank.
		const lastPlaces = placesBy(entries, (entry) => entry.lastWeek);
		const moves = !earning && entries.some((entry) => entry.lastWeek > 0);
		const figure = (amount: number) => (earning ? kroner(amount) : tasks(amount));
		this.#drawChampion(data, ordered, figure);
		const friends = data.people.filter((person) => !person.me).length;
		replace(
			this.#list,
			this.#error ? notice("danger", this.#error) : null,
			ordered.length
				? h(
						"ol",
						{
							class: "leaderboard-rows",
							"aria-label": BOARDS.find((board) => board.id === this.#board)!.title(),
						},
						...ordered.map((entry) => {
							const place = places.get(entry)!;
							const move = moves ? lastPlaces.get(entry)! - place : 0;
							const above = ordered.filter((other) => other.value > entry.value).at(-1);
							const nudge = entry.me
								? entry.value > 0 && place === 1
									? t("You're in the lead.")
									: above
										? earning
											? t("{amount} behind {name}", {
													amount: kroner(above.value - entry.value),
													name: above.name,
												})
											: t("{count} to pass {name}", {
													count: tasks(above.value - entry.value + 1),
													name: above.name,
												})
										: ""
								: "";
							const detail = [entry.detail, nudge].filter(Boolean).join(" · ");
							return h(
								"li",
								{ class: entry.me ? "leaderboard-row is-me" : "leaderboard-row" },
								h(
									"span",
									{ class: "leaderboard-place", "aria-label": t("Place {place}", { place }) },
									entry.value > 0 ? String(place) : "–",
								),
								moves
									? h(
											"span",
											{
												class: `leaderboard-move ${move > 0 ? "is-up" : move < 0 ? "is-down" : ""}`,
												title:
													move > 0
														? t("Up {count} since last week", { count: move })
														: move < 0
															? t("Down {count} since last week", { count: -move })
															: t("Same place as last week"),
											},
											move === 0 ? "–" : `${move > 0 ? "▲" : "▼"} ${Math.abs(move)}`,
										)
									: null,
								companyLogo(entry.figure, "leaderboard-figure"),
								h(
									"span",
									{ class: "leaderboard-who" },
									h("strong", null, entry.name),
									detail ? h("small", null, detail) : null,
								),
								h("strong", { class: "leaderboard-score" }, earning ? kroner(entry.value) : count(entry.value)),
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

	/** The leader's banner: their figure cheering in confetti, how far ahead they are, and how long is left. */
	#drawChampion(data: Leaderboard, ordered: Entry[], figure: (amount: number) => string): void {
		const earning = this.#board.startsWith("earning");
		const leader = ordered[0];
		const second = ordered.find((entry) => entry !== leader && entry.value < (leader?.value ?? 0));
		const daysLeft = Math.max(0, Math.ceil((Date.parse(data.until) - Date.now()) / 86_400_000));
		const timing = earning
			? t("All sales so far, without VAT.")
			: daysLeft <= 1
				? t("Week {week} ends tonight at midnight. Last chance to catch up.", { week: data.week })
				: t("Week {week} ends Sunday at midnight. {days} days left to catch up.", {
						week: data.week,
						days: daysLeft,
					});
		if (!leader || leader.value <= 0) {
			replace(
				this.#champion,
				h(
					"div",
					{ class: "leaderboard-champion is-open" },
					h(
						"div",
						{ class: "leaderboard-champion-copy" },
						h("small", null, earning ? t("Most revenue") : t("Busiest this week")),
						h("strong", null, t("Nobody is ahead yet")),
						h(
							"span",
							null,
							earning ? t("The first sale takes the lead.") : t("The first task this week takes the lead."),
						),
						h("span", { class: "leaderboard-champion-timing" }, timing),
					),
				),
			);
			return;
		}
		const lead = [
			leader.company && !earning
				? t("{amount} at {company}", { amount: figure(leader.value), company: leader.company })
				: figure(leader.value),
			second
				? t("{amount} ahead of {name}", { amount: figure(leader.value - second.value), name: second.name })
				: null,
		]
			.filter(Boolean)
			.join(" · ");
		const confetti = Array.from({ length: 8 }, (_, index) =>
			h("span", { class: `leaderboard-confetti is-${index + 1}`, "aria-hidden": "true" }),
		);
		replace(
			this.#champion,
			h(
				"div",
				{ class: "leaderboard-champion" },
				...confetti,
				h("span", { class: "leaderboard-champion-figure" }, companyLogo(leader.figure)),
				h(
					"div",
					{ class: "leaderboard-champion-copy" },
					h("small", null, earning ? t("Most revenue so far") : t("Busiest this week, so far")),
					h("strong", null, leader.name),
					h("span", null, lead),
					h("span", { class: "leaderboard-champion-timing" }, timing),
				),
			),
		);
	}
}
