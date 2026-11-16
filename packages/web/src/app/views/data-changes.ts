import type {
	CloudMemberDatabase,
	CloudMemberDataChangedDay,
	CloudMemberDataChangedLine,
	CloudMemberDataChanges,
	CloudMemberDataWrite,
} from "@qorpera/cloud-client/cloud-member-data";
import { CLOUD_MEMBER_DATA_ZONE } from "@qorpera/cloud-client/cloud-member-data";
import { agentFigure } from "../../ui/avatar.ts";
import { button, h, personAvatar, replace } from "../../ui/dom.ts";
import { presentationDay, presentationLocale, presentationTimeZone, t, timeZoneOption } from "../../ui/preferences.ts";
import type { CompanyController } from "../company.ts";
import type { CompanyDataCalls } from "../company-data.ts";

const DAYS = 14;
const FOLLOW_PAGES = 20;
const SVG = "http://www.w3.org/2000/svg";
const WIDTH = 888;
const HEIGHT = 300;

export type ChangesGroup = "agents" | "you" | "others";
const GROUPS: readonly ChangesGroup[] = ["agents", "you", "others"];

interface Read {
	readonly database: string;
	zone: string;
	readonly days: readonly string[];
	readonly stop: AbortController;
	writes: CloudMemberDataWrite[];
	counts: readonly CloudMemberDataChangedDay[] | null | undefined;
	next: string | undefined;
	more: boolean;
	pages: number;
	followed: number;
	loading: boolean;
	failed: boolean;
}

export type RowTitle = (database: string, table: string, key: Readonly<Record<string, unknown>>) => unknown;

interface Who {
	readonly name: string;
	readonly you: boolean;
	readonly group: ChangesGroup;
	readonly figure: () => Element;
}

function humanWords(name: string): string {
	const words = name.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
	return words ? words.charAt(0).toLocaleUpperCase() + words.slice(1) : name;
}

function listed(items: readonly string[]): string {
	if (items.length < 2) return items[0] ?? "";
	return t("{first} and {last}", { first: items.slice(0, -1).join(", "), last: items.at(-1) ?? "" });
}

function plainValue(value: unknown): string | undefined {
	if (typeof value === "string") return value.length > 48 ? `${value.slice(0, 47)}…` : value;
	if (typeof value === "number") return new Intl.NumberFormat(locale()).format(value);
	if (typeof value === "boolean") return value ? t("Yes") : t("No");
	return undefined;
}

const locale = () => (presentationLocale() === "da" ? "da-DK" : "en-GB");

export function lastDays(today: string, count = DAYS): string[] {
	const [year, month, day] = today.split("-").map(Number);
	return Array.from({ length: count }, (_, index) =>
		new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) - (count - 1 - index))).toISOString().slice(0, 10),
	);
}

function dayDate(day: string): Date {
	const [year, month, date] = day.split("-").map(Number);
	return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, date ?? 1, 12));
}

export class DataChanges {
	readonly el = h("div", { class: "data-scroll data-changes" });
	readonly #company: CompanyController;
	readonly #calls: () => CompanyDataCalls;
	readonly #titleOf: RowTitle;
	#database: CloudMemberDatabase | undefined;
	#read: Read | undefined;
	#day: string | undefined;

	constructor(company: CompanyController, calls: () => CompanyDataCalls, titleOf: RowTitle = () => undefined) {
		this.#company = company;
		this.#calls = calls;
		this.#titleOf = titleOf;
	}

	dispose(): void {
		this.#read?.stop.abort();
	}

	open(database: CloudMemberDatabase): void {
		this.#database = database;
		this.#read?.stop.abort();
		const zone = presentationTimeZone();
		const today = presentationDay(new Date(), timeZoneOption().timeZone);
		this.#read = {
			database: database.database,
			zone: CLOUD_MEMBER_DATA_ZONE.test(zone) ? zone : "",
			days: lastDays(today),
			stop: new AbortController(),
			writes: [],
			counts: undefined,
			next: undefined,
			more: false,
			pages: 0,
			followed: 0,
			loading: true,
			failed: false,
		};
		this.#day = undefined;
		void this.#page(this.#read);
		this.#render();
	}

	show(database: CloudMemberDatabase): HTMLElement {
		if (this.#read?.database !== database.database) this.open(database);
		else {
			this.#database = database;
			this.#render();
		}
		return this.el;
	}

	async #page(read: Read): Promise<void> {
		read.loading = true;
		try {
			const page: CloudMemberDataChanges = await this.#calls().changes(
				{
					database: read.database,
					...(read.next === undefined ? (read.zone ? { zone: read.zone } : {}) : { after: read.next }),
				},
				read.stop.signal,
			);
			if (read.stop.signal.aborted) return;
			if (read.pages === 0) read.counts = page.days;
			read.writes.push(...page.writes);
			read.next = page.next;
			read.more = page.more;
			read.pages++;
			read.followed++;
			read.failed = false;
		} catch (error) {
			if (read.stop.signal.aborted) return;
			if ((error as { status?: unknown }).status === 400 && read.next === undefined && read.zone) {
				read.zone = "";
				return this.#page(read);
			}
			read.failed = true;
		}
		read.loading = false;
		if (this.#read !== read) return;
		if (this.#day === undefined) this.#day = this.#latest(read);
		if (!read.failed && this.#wants(read) && read.followed < FOLLOW_PAGES) {
			void this.#page(read);
			return;
		}
		this.#render();
	}

	#wants(read: Read): boolean {
		if (!read.more || this.#day === undefined) return false;
		const oldest = read.writes
			.map((write) => write.at)
			.filter((at): at is string => at !== null)
			.at(-1);
		return oldest === undefined || this.#dayOf(oldest, read) >= this.#day;
	}

	#dayOf(at: string, read: Read): string {
		return presentationDay(new Date(at), read.zone || undefined);
	}

	#latest(read: Read): string {
		const totals = this.#totals(read);
		for (let index = read.days.length - 1; index >= 0; index--) {
			const day = read.days[index] ?? "";
			if (GROUPS.some((group) => (totals.get(day)?.[group] ?? 0) > 0)) return day;
		}
		return read.days.at(-1) ?? "";
	}

	#who(by: CloudMemberDataWrite["by"], id: string | null): Who {
		const state = this.#company.store.get();
		const me = this.#company.userId;
		const member = id ? state.team?.members.find((one) => one.userId === id) : undefined;
		const agent = id && by !== "member" ? this.#company.staffById(id) : undefined;
		if (id && id === me && (by === "member" || by === "step"))
			return {
				name: youWord(),
				you: true,
				group: "you",
				figure: () => {
					const avatar = personAvatar(member?.displayName ?? "", me);
					avatar.classList.add("is-me");
					return avatar;
				},
			};
		if (agent) {
			return {
				name: agent.displayName,
				you: false,
				group: "agents",
				figure: () => agentFigure(agent, agent.displayName, { size: 40 }),
			};
		}
		if (member && by !== "agent" && by !== "machine")
			return {
				name: member.displayName,
				you: false,
				group: "others",
				figure: () => personAvatar(member.displayName, member.userId),
			};
		if (by === "agent" || by === "machine")
			return {
				name: t("An agent"),
				you: false,
				group: "agents",
				figure: () => agentFigure(undefined, t("An agent"), { size: 40 }),
			};
		if (by === "member")
			return { name: t("A member"), you: false, group: "others", figure: () => personAvatar("?", id ?? "") };
		return { name: t("Someone"), you: false, group: "others", figure: () => personAvatar("?", id ?? "") };
	}

	#totals(read: Read): Map<string, Record<ChangesGroup, number>> {
		const totals = new Map<string, Record<ChangesGroup, number>>();
		const add = (day: string, group: ChangesGroup, rows: number) => {
			const now = totals.get(day) ?? { agents: 0, you: 0, others: 0 };
			now[group] += rows;
			totals.set(day, now);
		};
		if (read.counts) for (const one of read.counts) add(one.day, this.#who(one.by, one.id).group, one.rows);
		else
			for (const write of read.writes)
				if (write.at)
					add(
						this.#dayOf(write.at, read),
						this.#who(write.by, write.id).group,
						write.tables.reduce((sum, table) => sum + table.rows, 0),
					);
		return totals;
	}

	#thing(table: string, line: CloudMemberDataChangedLine | undefined): string | undefined {
		if (!line) return undefined;
		const described = this.#database?.tables?.find((one) => one.name === table);
		const row = line.after ?? line.before ?? {};
		const key = described?.key ?? Object.keys(line.key ?? {});
		const lead = described?.columns.find((column) => !key.includes(column.name))?.name;
		const title = lead !== undefined && lead in row ? plainValue(row[lead]) : undefined;
		if (title) return title;
		const fromList = line.key && this.#database ? this.#titleOf(this.#database.database, table, line.key) : undefined;
		if (fromList !== undefined) return plainValue(fromList);
		const keyed = line.key ? Object.values(line.key).map(plainValue) : [];
		if (keyed.length === 0 || keyed.some((one) => one === undefined)) return undefined;
		return t("row {key} of {table}", { key: keyed.join(", "), table: humanWords(table) });
	}

	sentence(write: CloudMemberDataWrite): string {
		const parts = write.tables.map((table) => {
			const name = humanWords(table.table);
			const lines = write.lines.filter((line) => line.table === table.table && line.op === table.op);
			const line = table.rows === 1 && lines.length === 1 ? lines[0] : undefined;
			const thing = this.#thing(table.table, line);
			const count = new Intl.NumberFormat(locale()).format(table.rows);
			if (table.op === "add") {
				if (table.rows > 1) return t("added {count} rows to {table}", { count, table: name });
				return thing && line?.after
					? t("added {thing} to {table}", { thing, table: name })
					: t("added a row to {table}", { table: name });
			}
			if (table.op === "remove") {
				if (table.rows > 1) return t("removed {count} rows from {table}", { count, table: name });
				return thing && line?.before
					? t("removed {thing} from {table}", { thing, table: name })
					: t("removed a row from {table}", { table: name });
			}
			if (table.rows > 1) return t("changed {count} rows in {table}", { count, table: name });
			const columns =
				line && line.key === null
					? line.before && line.after
						? Object.keys(line.after).filter(
								(name) => JSON.stringify(line.before?.[name]) !== JSON.stringify(line.after?.[name]),
							)
						: []
					: (line?.columns ?? []);
			if (!thing || columns.length === 0) return t("changed a row in {table}", { table: name });
			const [only] = columns;
			if (columns.length === 1 && only !== undefined && line?.after && only in line.after) {
				const value = line.after[only];
				if (value === null) return t("cleared {column} on {thing}", { column: humanWords(only), thing });
				const shown = plainValue(value);
				if (shown !== undefined)
					return t("set {column} to {value} on {thing}", { column: humanWords(only), value: shown, thing });
			}
			const named = columns.slice(0, columns.length === 4 ? 4 : 3).map(humanWords);
			if (columns.length > 4) named.push(t("{count} other columns", { count: columns.length - 3 }));
			return t("changed {columns} on {thing}", { columns: listed(named), thing });
		});
		const said = listed(parts);
		return write.many ? t("{did} and more", { did: said }) : said;
	}

	#render(): void {
		const active = document.activeElement;
		const focus = active instanceof HTMLElement && this.el.contains(active) ? active.dataset.focusKey : undefined;
		replace(this.el, ...this.#content());
		if (focus !== undefined)
			[...this.el.querySelectorAll<HTMLElement>("[data-focus-key]")]
				.find((one) => one.dataset.focusKey === focus)
				?.focus({ preventScroll: true });
	}

	#content(): HTMLElement[] {
		const read = this.#read;
		if (!read) return [];
		const head = (legend: HTMLElement | null) =>
			h(
				"div",
				{ class: "data-changes-head" },
				h(
					"div",
					{ class: "data-changes-title" },
					h("h2", null, t("Last two weeks")),
					h("p", null, t("Who changed what")),
				),
				legend,
			);
		if (read.pages === 0 && read.loading) return [head(null), this.#skeleton()];
		if (read.pages === 0 && read.failed)
			return [
				head(null),
				h(
					"div",
					{ class: "data-changes-trouble", role: "alert" },
					h("p", { class: "data-changes-quiet" }, t("What changed can't be read just now")),
					button(t("Try again"), () => this.#database && this.open(this.#database)),
				),
			];
		const totals = this.#totals(read);
		const shown = GROUPS.filter((group) => read.days.some((day) => (totals.get(day)?.[group] ?? 0) > 0));
		if (
			shown.length === 0 &&
			!read.writes.some((write) => write.at && read.days.includes(this.#dayOf(write.at, read)))
		)
			return [
				head(null),
				h("p", { class: "data-changes-quiet data-changes-none" }, t("Nothing has changed in the last two weeks.")),
			];
		return [
			head(
				shown.length > 0
					? h(
							"div",
							{ class: "data-changes-legend" },
							...shown.map((group) =>
								h(
									"span",
									{ class: `data-changes-key is-${group}` },
									h("i", { "aria-hidden": "true" }),
									groupName(group),
								),
							),
						)
					: null,
			),
			this.#chart(read, totals),
			this.#list(read),
		];
	}

	#skeleton(): HTMLElement {
		const line = () => h("span", { class: "skeleton skeleton-line" });
		return h(
			"div",
			{ class: "skeleton-group data-changes-skeleton", role: "status" },
			h("span", { class: "visually-hidden" }, t("Loading what changed")),
			h("span", { class: "skeleton data-changes-skeleton-chart" }),
			...Array.from({ length: 3 }, () => h("div", { class: "data-changes-skeleton-row" }, line(), line())),
		);
	}

	#chart(read: Read, totals: Map<string, Record<ChangesGroup, number>>): HTMLElement {
		const values = read.days.map((day) => totals.get(day) ?? { agents: 0, you: 0, others: 0 });
		const peak = Math.max(1, ...values.map((one) => one.agents + one.you + one.others));
		const x = (index: number) => (index * WIDTH) / (read.days.length - 1);
		const y = (value: number) => HEIGHT - (value / peak) * (HEIGHT - 24);
		const svg = document.createElementNS(SVG, "svg");
		svg.setAttribute("viewBox", `0 0 ${WIDTH} ${HEIGHT}`);
		svg.setAttribute("preserveAspectRatio", "none");
		svg.setAttribute("aria-hidden", "true");
		svg.setAttribute("class", "data-changes-svg");
		const stack: ChangesGroup[] = ["agents", "you", "others"];
		for (const [place, group] of stack.entries()) {
			const heights = values.map((one) => stack.slice(place).reduce((sum, below) => sum + one[below], 0));
			let path = `M0 ${HEIGHT}L0 ${y(heights[0] ?? 0)}`;
			for (let index = 1; index < heights.length; index++) {
				const middle = (x(index - 1) + x(index)) / 2;
				path += `C${middle} ${y(heights[index - 1] ?? 0)} ${middle} ${y(heights[index] ?? 0)} ${x(index)} ${y(heights[index] ?? 0)}`;
			}
			path += `L${WIDTH} ${HEIGHT}Z`;
			const area = document.createElementNS(SVG, "path");
			area.setAttribute("d", path);
			area.setAttribute("class", `data-changes-area is-${group}`);
			svg.append(area);
		}
		const chosen = Math.max(0, read.days.indexOf(this.#day ?? ""));
		const top = values[chosen] ?? { agents: 0, you: 0, others: 0 };
		const at = (x(chosen) / WIDTH) * 100;
		const height = (y(top.agents + top.you + top.others) / HEIGHT) * 100;
		const marker = document.createElementNS(SVG, "path");
		marker.setAttribute("d", `M${x(chosen)} ${y(top.agents + top.you + top.others)}V${HEIGHT}`);
		marker.setAttribute("class", "data-changes-marker");
		marker.setAttribute("vector-effect", "non-scaling-stroke");
		svg.append(marker);
		const dayName = (day: string, index: number) => {
			if (index === read.days.length - 1) return t("Today");
			if (index === read.days.length - 2) return t("Yesterday");
			return dayDate(day).toLocaleDateString(
				locale(),
				index >= read.days.length - 7
					? { weekday: "long", timeZone: "UTC" }
					: { day: "numeric", month: "long", timeZone: "UTC" },
			);
		};
		const columns = read.days.map((day, index) => {
			const sum = (values[index]?.agents ?? 0) + (values[index]?.you ?? 0) + (values[index]?.others ?? 0);
			const label = t("{day}: {count} changes", {
				day: dayDate(day).toLocaleDateString(locale(), {
					weekday: "long",
					day: "numeric",
					month: "long",
					timeZone: "UTC",
				}),
				count: new Intl.NumberFormat(locale()).format(sum),
			});
			const one = h("button", {
				type: "button",
				class: "data-changes-day",
				"aria-label": label,
				"aria-pressed": String(index === chosen),
				title: label,
				dataset: { focusKey: `day:${day}` },
				onclick: () => this.#choose(day),
			});
			one.style.setProperty("--at", String(index / (read.days.length - 1)));
			return one;
		});
		const edge = chosen < 3 ? "is-start" : chosen > read.days.length - 4 ? "is-end" : "";
		const picked = h(
			"span",
			{ class: `data-changes-picked ${edge}`.trim() },
			dayName(read.days[chosen] ?? "", chosen),
		);
		picked.style.setProperty("--at", `${at}%`);
		const dot = h("span", { class: "data-changes-dot", "aria-hidden": "true" });
		dot.style.setProperty("--at", `${at}%`);
		dot.style.setProperty("--top", `${height}%`);
		const first = dayDate(read.days[0] ?? "").toLocaleDateString(locale(), {
			day: "numeric",
			month: "long",
			timeZone: "UTC",
		});
		return h(
			"div",
			{ class: "data-changes-chart" },
			h(
				"div",
				{ class: "data-changes-plot", role: "group", "aria-label": t("Changes a day over the last two weeks") },
				svg,
				dot,
				...columns,
			),
			h(
				"div",
				{ class: "data-changes-axis", "aria-hidden": "true" },
				chosen < 3 ? null : h("span", { class: "data-changes-first" }, first),
				picked,
				chosen > read.days.length - 4 ? null : h("span", { class: "data-changes-today" }, t("Today")),
			),
		);
	}

	#choose(day: string): void {
		if (this.#day === day) return;
		this.#day = day;
		const read = this.#read;
		if (read) read.followed = 0;
		if (read && !read.loading && this.#wants(read)) void this.#page(read);
		this.#render();
	}

	#list(read: Read): HTMLElement {
		const day = this.#day;
		const writes = read.writes.filter((write) => write.at !== null && this.#dayOf(write.at, read) === day);
		const waiting = this.#wants(read);
		const time = (at: string) =>
			new Date(at).toLocaleTimeString(locale(), {
				hour: "2-digit",
				minute: "2-digit",
				...(read.zone ? { timeZone: read.zone } : {}),
			});
		return h(
			"div",
			{ class: "data-changes-list" },
			...writes.map((write) => {
				const who = this.#who(write.by, write.id);
				const [before, after] = t("You {did}").split("{did}");
				const via = write.by !== "step" && write.via && write.via !== "list" ? humanWords(write.via) : undefined;
				return h(
					"div",
					{ class: "data-changes-write" },
					h("span", { class: "data-changes-who" }, who.figure()),
					h(
						"p",
						{ class: "data-changes-said" },
						who.you
							? [h("b", null, (before ?? "").trim()), " ", this.sentence(write), (after ?? "").trim()]
							: [h("b", null, who.name), " ", this.sentence(write)],
						via ? h("span", { class: "data-changes-via" }, ` · ${via}`) : null,
					),
					write.at ? h("time", { class: "data-changes-time", datetime: write.at }, time(write.at)) : null,
				);
			}),
			writes.length === 0 && !waiting && !read.loading
				? h("p", { class: "data-changes-quiet" }, t("Nothing changed this day."))
				: null,
			waiting && !read.failed && (read.loading || read.followed < FOLLOW_PAGES)
				? h(
						"div",
						{ class: "skeleton-group data-changes-more", role: "status" },
						h("span", { class: "skeleton skeleton-line" }),
					)
				: null,
			waiting && !read.loading && read.followed >= FOLLOW_PAGES
				? h(
						"div",
						{ class: "data-changes-more" },
						button(t("Show more"), () => {
							read.followed = 0;
							void this.#page(read);
							this.#render();
						}),
					)
				: null,
			read.failed && read.pages > 0
				? h("p", { class: "data-changes-quiet", role: "alert" }, t("What changed can't be read just now"))
				: null,
		);
	}
}

function youWord(): string {
	return t("You {did}").replace("{did}", "").trim();
}

function groupName(group: ChangesGroup): string {
	if (group === "agents") return t("Your agents");
	if (group === "you") return youWord();
	return t("Others");
}
