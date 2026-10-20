import { SurfaceDialog } from "../../ui/dialog.ts";
import { h, replace, spinner } from "../../ui/dom.ts";
import { presentationLocale, t } from "../../ui/preferences.ts";
import { BANK_SUMMARY_PATH } from "../bank-page.ts";
import {
	type BankCategory,
	type BankPoint,
	type BankRhythm,
	type BankSummary,
	parseBankSummary,
} from "../bank-summary.ts";
import type { CompanyController } from "../company.ts";

/* The Bank page (app/bank-page.ts): the company's bank account, drawn from its bank summary (app/bank-summary.ts) as the
 * folder reader last read it. Three tabs. Overview: the saldo with what is disponibel and reserveret, the saldo over
 * time with what is expected ahead, and money in and out per month. Money in and Money out: the last month by category
 * as a ring and a list, each category opening to what it holds, and every month. Put in money tells the member how to
 * move their own money into the company, as a loan or as share capital; nothing here moves money. */

type Tab = "overview" | "in" | "out";
type Range = "quarter" | "year";

/** The ring's colours, in the list's order: money in greens and blues, money out reds first. */
const IN_COLOURS = ["#00c878", "#2f80ed", "#00bfb3", "#f59e0b", "#7868d7", "#87674c", "#b3afaa"];
const OUT_COLOURS = ["#f26b5e", "#f59e0b", "#3d86df", "#b45cf0", "#00bfb3", "#87674c", "#7868d7", "#b3afaa"];
const CHART_WIDTH = 812;
const CHART_HEIGHT = 230;
const CHART_TOP = 18;
const CHART_BOTTOM = 204;

const kroner = new Intl.NumberFormat("da-DK", { maximumFractionDigits: 0 });
const money = (amount: number) => t("{amount} kr", { amount: kroner.format(Math.round(amount)) });

function day(value: string): Date {
	return new Date(`${value}T12:00:00Z`);
}

function shortDate(value: string): string {
	return new Intl.DateTimeFormat(presentationLocale(), { day: "numeric", month: "short", timeZone: "UTC" }).format(
		day(value),
	);
}

function monthName(value: string, style: "long" | "short"): string {
	return new Intl.DateTimeFormat(presentationLocale(), { month: style, timeZone: "UTC" }).format(day(`${value}-15`));
}

function rhythmLabel(rhythm: BankRhythm): string {
	const labels: Record<BankRhythm, () => string> = {
		once: () => t("Once"),
		daily: () => t("Every day"),
		weekdays: () => t("Weekdays"),
		weekly: () => t("Weekly"),
		monthly: () => t("Monthly"),
		quarterly: () => t("Every quarter"),
		yearly: () => t("Every year"),
		"each-payout": () => t("Each payout"),
		"now-and-then": () => t("Now and then"),
	};
	return labels[rhythm]();
}

/** The saldo smoothed for drawing: each point the weighted mean of its neighbours (1, 2, 3, 2, 1). The hover still
 * shows the saldo the bank gave for that day. */
function smoothed(points: readonly BankPoint[]): number[] {
	const weights = [1, 2, 3, 2, 1];
	return points.map((_, index) => {
		let sum = 0;
		let total = 0;
		weights.forEach((weight, offset) => {
			const point = points[index + offset - 2];
			if (!point) return;
			sum += point.saldo * weight;
			total += weight;
		});
		return sum / total;
	});
}

/** A smooth line through `points` (Catmull-Rom as cubic Béziers). */
function curve(points: readonly (readonly [number, number])[]): string {
	const first = points[0];
	if (!first) return "";
	let path = `M${first[0].toFixed(1)},${first[1].toFixed(1)}`;
	for (let index = 0; index < points.length - 1; index++) {
		const p1 = points[index] ?? first;
		const p0 = points[index - 1] ?? p1;
		const p2 = points[index + 1] ?? p1;
		const p3 = points[index + 2] ?? p2;
		const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
		const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
		path += ` C${c1[0]?.toFixed(1)},${c1[1]?.toFixed(1)} ${c2[0]?.toFixed(1)},${c2[1]?.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
	}
	return path;
}

const SVG = "http://www.w3.org/2000/svg";
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>): SVGElementTagNameMap[K] {
	const element = document.createElementNS(SVG, tag);
	for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
	return element;
}

class BankView {
	readonly el = h("section", { class: "page bank" });
	readonly #company: CompanyController;
	#text: string | undefined;
	#summary: BankSummary | null = null;
	#tab: Tab = "overview";
	#range: Range = "year";
	#hover = -1;
	#open = "";
	#hovered = "";
	#categoriesShown = true;
	#monthsShown = true;
	#dialog: SurfaceDialog | null = null;
	/** The line under the saldo that names the day the pointer is on. */
	#hoverLine: HTMLElement | null = null;

	constructor(company: CompanyController) {
		this.#company = company;
	}

	/** Draws the summary when its text, the language or the company's state it shows changed. */
	update(text: string | undefined, loading: boolean): void {
		const key = JSON.stringify([text ?? null, loading, presentationLocale()]);
		if (key === this.el.dataset.drawn) return;
		this.el.dataset.drawn = key;
		if (text !== this.#text) {
			this.#text = text;
			this.#summary = text === undefined ? null : parseBankSummary(text);
			this.#hover = -1;
		}
		this.#draw(loading);
	}

	dispose(): void {
		this.#dialog?.close(false);
	}

	#redraw(): void {
		this.#draw(false);
	}

	#draw(loading: boolean): void {
		if (loading) {
			replace(this.el, h("div", { class: "bank-waiting" }, spinner(t("Opening company"))));
			return;
		}
		const summary = this.#summary;
		if (!summary) {
			replace(this.el, this.#empty(this.#text !== undefined));
			return;
		}
		const tabs = h(
			"div",
			{ class: "bank-tabs", role: "tablist", "aria-label": t("Bank") },
			(
				[
					["overview", t("Overview")],
					["in", t("Money in")],
					["out", t("Money out")],
				] as const
			).map(([tab, label]) =>
				h(
					"button",
					{
						type: "button",
						role: "tab",
						class: "bank-tab",
						"aria-selected": String(this.#tab === tab),
						onclick: () => {
							this.#tab = tab;
							this.#open = "";
							this.#redraw();
						},
					},
					label,
				),
			),
		);
		const body =
			this.#tab === "overview" ? this.#overview(summary) : this.#detail(summary, this.#tab === "in" ? "in" : "out");
		replace(
			this.el,
			tabs,
			h(
				"div",
				{ class: "bank-scroll", "data-scroll-key": "bank" },
				h(
					"div",
					{ class: "bank-column" },
					summary.pausedSince ? this.#paused(summary) : null,
					h("div", { class: summary.pausedSince ? "bank-dimmed" : "" }, body),
				),
			),
		);
	}

	#empty(unreadable: boolean): HTMLElement {
		return h(
			"div",
			{ class: "bank-empty" },
			h("h1", null, unreadable ? t("The bank summary can't be read") : t("No bank yet")),
			h(
				"p",
				null,
				unreadable
					? t("Its file in the company folder doesn't follow the bank summary format.")
					: t("When the company's bank is connected, its saldo and what comes in and goes out show here."),
			),
		);
	}

	#paused(summary: BankSummary): HTMLElement {
		return h(
			"div",
			{ class: "bank-paused", role: "status" },
			h(
				"strong",
				null,
				t("{bank} paused sharing on {date}.", { bank: summary.bank, date: shortDate(summary.pausedSince ?? "") }),
			),
			" ",
			h("span", null, t("Banks ask again every 180 days. It takes half a minute with MitID.")),
		);
	}

	#overview(summary: BankSummary): HTMLElement {
		const hoverLine = h("span", { class: "bank-hover" }, this.#hoverText(summary));
		this.#hoverLine = hoverLine;
		const updated = new Intl.DateTimeFormat(presentationLocale(), { dateStyle: "medium", timeStyle: "short" }).format(
			new Date(summary.updatedAt),
		);
		return h(
			"div",
			{ class: "bank-overview" },
			h(
				"section",
				{ class: "bank-saldo", "aria-label": t("Saldo") },
				h(
					"div",
					{ class: "bank-saldo-head" },
					h(
						"div",
						null,
						h("span", { class: "bank-label" }, t("Saldo")),
						h("div", { class: "bank-amount" }, money(summary.saldo)),
						h(
							"div",
							{ class: "bank-sub" },
							h("span", null, t("Disponibel"), " ", h("strong", null, money(summary.disponibel))),
							h("span", null, t("Reserveret"), " ", money(summary.reserveret)),
							hoverLine,
						),
					),
					h(
						"button",
						{ type: "button", class: "btn btn-primary bank-put", onclick: () => this.#openPut(summary) },
						t("Put in money"),
					),
				),
				this.#chart(summary),
				h(
					"div",
					{ class: "bank-range", role: "group", "aria-label": t("Range") },
					(
						[
							["quarter", t("3 months")],
							["year", t("1 year")],
						] as const
					).map(([range, label]) =>
						h(
							"button",
							{
								type: "button",
								"aria-pressed": String(this.#range === range),
								onclick: () => {
									this.#range = range;
									this.#hover = -1;
									this.#redraw();
								},
							},
							label,
						),
					),
				),
				h("small", { class: "bank-updated" }, t("{bank} · updated {when}", { bank: summary.bank, when: updated })),
			),
			this.#inAndOut(summary),
		);
	}

	/** The points the chart draws for the chosen range: the history, then what is expected. */
	#points(summary: BankSummary): { points: BankPoint[]; today: number; expected: Set<number> } {
		const last = summary.history[summary.history.length - 1];
		const days = this.#range === "year" ? 365 : 91;
		const from = last ? new Date(day(last.date).getTime() - days * 86_400_000).toISOString().slice(0, 10) : "";
		const history = summary.history.filter((point) => point.date >= from);
		const points = [...history, ...summary.expected];
		return {
			points,
			today: history.length - 1,
			expected: new Set(summary.expected.map((_, index) => history.length + index)),
		};
	}

	#hoverText(summary: BankSummary): string {
		const { points, today, expected } = this.#points(summary);
		const point = points[this.#hover];
		if (this.#hover < 0 || this.#hover === today || !point) return "";
		return expected.has(this.#hover)
			? t("Expected around {date}: {amount}", { date: shortDate(point.date), amount: money(point.saldo) })
			: t("{date}: {amount}", { date: shortDate(point.date), amount: money(point.saldo) });
	}

	#chart(summary: BankSummary): HTMLElement {
		const { points, today, expected } = this.#points(summary);
		const wrap = h("div", { class: "bank-chart" });
		if (points.length < 2 || today < 0) {
			wrap.append(
				h("p", { class: "bank-note" }, t("The saldo over time shows once the bank has shared a few days.")),
			);
			return wrap;
		}
		const drawn = smoothed(points);
		const low = Math.floor((Math.min(...drawn) - 10_000) / 50_000) * 50_000;
		const high = Math.ceil((Math.max(...drawn) + 10_000) / 50_000) * 50_000;
		const x = (index: number) => (index / (points.length - 1)) * CHART_WIDTH;
		const y = (value: number) => CHART_BOTTOM - ((value - low) / (high - low || 1)) * (CHART_BOTTOM - CHART_TOP);
		const xy = drawn.map((value, index) => [x(index), y(value)] as const);
		const line = curve(xy.slice(0, today + 1));
		const ahead = curve(xy.slice(today));
		const chart = svg("svg", {
			viewBox: `0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`,
			role: "img",
			"aria-label": t("The saldo over the last {range}, with what is expected ahead dotted", {
				range: this.#range === "year" ? t("year") : t("3 months"),
			}),
		});
		const gradient = svg("linearGradient", { id: "bank-area", x1: "0", x2: "0", y1: "0", y2: "1" });
		gradient.append(
			svg("stop", { offset: "0", "stop-color": "#00c878", "stop-opacity": "0.16" }),
			svg("stop", { offset: "1", "stop-color": "#00c878", "stop-opacity": "0" }),
		);
		const defs = svg("defs", {});
		defs.append(gradient);
		let grid = "";
		const plot = h("div", { class: "bank-chart-plot" });
		const labels: HTMLElement[] = [];
		for (let value = low; value <= high; value += 50_000) {
			grid += `M0,${y(value).toFixed(1)} L${CHART_WIDTH},${y(value).toFixed(1)} `;
			plot.append(
				h(
					"span",
					{ class: "bank-axis bank-axis-y", style: `top:${((y(value) / CHART_HEIGHT) * 100).toFixed(2)}%` },
					`${kroner.format(value / 1000)}k`,
				),
			);
		}
		const cursor = svg("line", { y1: "0", y2: String(CHART_BOTTOM), class: "bank-cursor" });
		const dot = svg("circle", { r: "5", class: "bank-dot" });
		chart.append(
			defs,
			svg("path", { d: grid, class: "bank-grid" }),
			svg("path", { d: `${line} L${x(today)},${CHART_BOTTOM} L0,${CHART_BOTTOM} Z`, fill: "url(#bank-area)" }),
			svg("path", { d: line, class: "bank-line" }),
			svg("path", { d: ahead, class: "bank-ahead" }),
			cursor,
			dot,
		);
		// The pointer moves only the cursor, the dot and the line that names the day; nothing else is drawn again.
		const place = () => {
			const shown = this.#hover >= 0 && this.#hover < xy.length ? this.#hover : today;
			const at = xy[shown];
			if (!at) return;
			cursor.setAttribute("x1", at[0].toFixed(1));
			cursor.setAttribute("x2", at[0].toFixed(1));
			cursor.classList.toggle("is-shown", shown !== today);
			dot.setAttribute("cx", at[0].toFixed(1));
			dot.setAttribute("cy", at[1].toFixed(1));
			dot.classList.toggle("bank-dot-ahead", expected.has(shown));
			if (this.#hoverLine) this.#hoverLine.textContent = this.#hoverText(summary);
		};
		place();
		let lastMonth = "";
		points.forEach((each, index) => {
			const month = each.date.slice(0, 7);
			if (month === lastMonth) return;
			lastMonth = month;
			if (index === 0 || (this.#range === "year" && Number(month.slice(5)) % 2 === 0)) return;
			labels.push(
				h(
					"span",
					{ class: "bank-axis bank-axis-x", style: `left:${((x(index) / CHART_WIDTH) * 100).toFixed(2)}%` },
					monthName(month, "short"),
				),
			);
		});
		plot.prepend(chart);
		wrap.append(plot, ...labels);
		wrap.addEventListener("pointermove", (event) => {
			const box = chart.getBoundingClientRect();
			if (box.width <= 0) return;
			const index = Math.round(((event.clientX - box.left) / box.width) * (points.length - 1));
			const next = Math.max(0, Math.min(points.length - 1, index));
			if (next === this.#hover) return;
			this.#hover = next;
			place();
		});
		wrap.addEventListener("pointerleave", () => {
			if (this.#hover === -1) return;
			this.#hover = -1;
			place();
		});
		return wrap;
	}

	#inAndOut(summary: BankSummary): HTMLElement {
		const months = summary.months.slice(-6);
		const top = Math.max(1, ...months.flatMap((month) => [month.in, month.out]));
		return h(
			"section",
			{ class: "bank-flow", "aria-label": t("In and out") },
			h(
				"div",
				{ class: "bank-flow-head" },
				h("h2", null, t("In and out")),
				h(
					"div",
					{ class: "bank-flow-links" },
					h("button", { type: "button", class: "btn", onclick: () => this.#go("in") }, t("Money in")),
					h("button", { type: "button", class: "btn", onclick: () => this.#go("out") }, t("Money out")),
				),
			),
			h(
				"div",
				{ class: "bank-bars" },
				months.map((month) => {
					const net = month.in - month.out;
					return h(
						"div",
						{ class: "bank-bar-month" },
						h(
							"div",
							{ class: "bank-bar-pair" },
							h("span", {
								class: "bank-bar bank-bar-in",
								style: `height:${((month.in / top) * 100).toFixed(1)}%`,
								title: t("{month} in: {amount}", {
									month: monthName(month.month, "long"),
									amount: money(month.in),
								}),
							}),
							h("span", {
								class: "bank-bar bank-bar-out",
								style: `height:${((month.out / top) * 100).toFixed(1)}%`,
								title: t("{month} out: {amount}", {
									month: monthName(month.month, "long"),
									amount: money(month.out),
								}),
							}),
						),
						h("span", { class: "bank-bar-label" }, monthName(month.month, "short")),
						h(
							"span",
							{ class: net >= 0 ? "bank-net bank-net-up" : "bank-net bank-net-down" },
							`${net >= 0 ? "+" : "−"}${money(Math.abs(net))}`,
						),
					);
				}),
			),
		);
	}

	#go(tab: Tab): void {
		this.#tab = tab;
		this.#open = "";
		this.#redraw();
	}

	#detail(summary: BankSummary, side: "in" | "out"): HTMLElement {
		const part = side === "in" ? summary.moneyIn : summary.moneyOut;
		const colours = side === "in" ? IN_COLOURS : OUT_COLOURS;
		const total = part.categories.reduce((sum, category) => sum + category.total, 0);
		const months = summary.months.slice(-12);
		const average = months.length ? months.reduce((sum, month) => sum + month[side], 0) / months.length : 0;
		const repeating = side === "out" ? summary.moneyOut.repeating : null;
		return h(
			"div",
			{ class: `bank-detail bank-detail-${side}` },
			h(
				"div",
				{ class: "bank-detail-head" },
				h(
					"div",
					null,
					h("span", { class: "bank-label" }, monthName(part.month, "long")),
					h("div", { class: "bank-amount bank-amount-side" }, money(total)),
				),
				h(
					"div",
					{ class: "bank-detail-side" },
					h(
						"span",
						{ class: "bank-label" },
						side === "out" && repeating !== null ? t("Repeats every month") : t("Average a month"),
					),
					h(
						"div",
						{ class: "bank-amount-small" },
						money(side === "out" && repeating !== null ? repeating : average),
					),
				),
			),
			this.#categories(part.categories, colours, total, side),
			this.#months(months, side),
			side === "out"
				? summary.moneyOut.later.map((later) =>
						h(
							"div",
							{ class: "bank-later" },
							h("span", null, t("Also coming: {name}", { name: later.name })),
							h(
								"span",
								null,
								h("strong", null, money(later.amount)),
								" ",
								t("on {date}", { date: shortDate(later.date) }),
							),
						),
					)
				: null,
		);
	}

	#fold(title: string, shown: boolean, toggle: () => void): HTMLButtonElement {
		return h(
			"button",
			{ type: "button", class: "bank-fold", "aria-expanded": String(shown), onclick: toggle },
			h("span", { class: "bank-chevron", "aria-hidden": "true" }),
			title,
		);
	}

	#categories(
		categories: readonly BankCategory[],
		colours: readonly string[],
		total: number,
		side: "in" | "out",
	): HTMLElement {
		const section = h(
			"section",
			{ class: "bank-section" },
			this.#fold(side === "in" ? t("Where it comes from") : t("Where it goes"), this.#categoriesShown, () => {
				this.#categoriesShown = !this.#categoriesShown;
				this.#redraw();
			}),
		);
		if (!this.#categoriesShown) return section;
		if (categories.length === 0) {
			section.append(h("p", { class: "bank-note" }, t("Nothing this month yet.")));
			return section;
		}
		const colour = (index: number) => colours[index % colours.length] ?? "#b3afaa";
		let at = 0;
		const stops: string[] = [];
		categories.forEach((category, index) => {
			const from = (at / (total || 1)) * 100;
			const to = ((at + category.total) / (total || 1)) * 100;
			const gap = Math.max(from, to - 0.6);
			const tint = this.#hovered && this.#hovered !== category.name ? `${colour(index)}40` : colour(index);
			stops.push(`${tint} ${from.toFixed(2)}% ${gap.toFixed(2)}%`, `var(--bg) ${gap.toFixed(2)}% ${to.toFixed(2)}%`);
			at += category.total;
		});
		const focus = categories.find((category) => category.name === this.#hovered);
		const ring = h(
			"div",
			{ class: "bank-ring-wrap" },
			h("div", {
				class: "bank-ring",
				role: "img",
				"aria-label": categories
					.map((category) => `${category.name} ${Math.round((category.total / (total || 1)) * 100)}%`)
					.join(", "),
				style: `background:conic-gradient(${stops.join(", ")})`,
			}),
			h(
				"div",
				{ class: "bank-ring-hole" },
				h("span", null, focus ? focus.name : t("Total")),
				h("strong", null, money(focus ? focus.total : total)),
			),
		);
		const list = h(
			"div",
			{ class: "bank-categories" },
			categories.map((category, index) => {
				const open = this.#open === category.name;
				const row = h(
					"div",
					{ class: "bank-category" },
					h(
						"button",
						{
							type: "button",
							class: "bank-category-row",
							"aria-expanded": String(open),
							onclick: () => {
								this.#open = open ? "" : category.name;
								this.#redraw();
							},
							onpointerenter: () => {
								if (this.#hovered === category.name) return;
								this.#hovered = category.name;
								this.#redraw();
							},
						},
						h("span", { class: "bank-swatch", style: `background:${colour(index)}` }),
						h(
							"span",
							{ class: "bank-category-name" },
							category.name,
							category.items.length > 1 ? h("small", null, ` ${category.items.length}`) : null,
						),
						h("span", { class: "bank-share" }, `${Math.round((category.total / (total || 1)) * 100)}%`),
						h("span", { class: "bank-category-amount" }, money(category.total)),
						h("span", { class: "bank-chevron bank-chevron-down", "aria-hidden": "true" }),
					),
				);
				if (open)
					row.append(
						h(
							"div",
							{ class: "bank-items" },
							category.items.map((item) =>
								h(
									"div",
									{ class: "bank-item" },
									h("span", { class: "bank-item-name" }, item.name),
									h("span", null, rhythmLabel(item.rhythm)),
									h("span", null, item.next ? shortDate(item.next) : "—"),
									h("span", { class: "bank-item-amount" }, money(item.amount)),
								),
							),
						),
					);
				return row;
			}),
		);
		list.addEventListener("pointerleave", () => {
			if (!this.#hovered) return;
			this.#hovered = "";
			this.#redraw();
		});
		section.append(h("div", { class: "bank-split" }, ring, list));
		return section;
	}

	#months(months: readonly BankSummary["months"][number][], side: "in" | "out"): HTMLElement {
		const section = h(
			"section",
			{ class: "bank-section" },
			this.#fold(t("Each month"), this.#monthsShown, () => {
				this.#monthsShown = !this.#monthsShown;
				this.#redraw();
			}),
		);
		if (!this.#monthsShown) return section;
		const top = Math.max(1, ...months.map((month) => month[side]));
		section.append(
			h(
				"div",
				{ class: "bank-year" },
				months.map((month, index) =>
					h(
						"div",
						{ class: "bank-year-month" },
						h("span", {
							class: `bank-year-bar bank-year-${side}${index === months.length - 1 ? " bank-year-now" : ""}`,
							style: `height:${((month[side] / top) * 100).toFixed(1)}%`,
							title: `${monthName(month.month, "long")}: ${money(month[side])}`,
						}),
						h("span", { class: "bank-bar-label" }, monthName(month.month, "short")),
					),
				),
			),
		);
		return section;
	}

	#openPut(summary: BankSummary): void {
		this.#dialog?.close(false);
		const state = this.#company.store.get();
		const cofounder =
			state.staff.find((agent) => agent.id === this.#company.cofounderId())?.displayName ?? t("the Co-Founder");
		const member = state.team?.members.find((each) => each.userId === this.#company.userId)?.displayName ?? "";
		let kind: "loan" | "shares" = "loan";
		let amount = "";
		let step = 1;
		const dialog = new SurfaceDialog(t("Put in money"), "bank-put-dialog", () => {
			if (this.#dialog === dialog) this.#dialog = null;
		});
		this.#dialog = dialog;
		const draw = () => {
			const amountText = money(Number(amount.replace(/\./g, "").replace(",", ".")) || 0);
			const transferText =
				kind === "loan"
					? t("Loan from {name}", { name: member || t("the owner") })
					: t("Share capital, {name}", { name: member || t("the owner") });
			const copy = (value: string) =>
				h(
					"button",
					{
						type: "button",
						class: "btn btn-small",
						onclick: (event: MouseEvent) => {
							const target = event.currentTarget;
							void navigator.clipboard?.writeText(value).then(() => {
								if (target instanceof HTMLButtonElement) target.textContent = t("Copied");
							});
						},
					},
					t("Copy"),
				);
			const body =
				step === 1
					? h(
							"div",
							{ class: "bank-put-step" },
							h(
								"label",
								{ class: "bank-put-amount" },
								h("span", null, t("How much")),
								h(
									"span",
									{ class: "bank-put-field" },
									h("input", {
										type: "text",
										inputmode: "decimal",
										value: amount,
										"aria-label": t("Amount in kroner"),
										oninput: (event: Event) => {
											if (event.target instanceof HTMLInputElement) amount = event.target.value;
										},
									}),
									h("span", null, t("kr")),
								),
							),
							h(
								"div",
								{ class: "bank-put-kinds", role: "radiogroup", "aria-label": t("How the money goes in") },
								(
									[
										[
											"loan",
											t("A loan to the company"),
											t("You can take it back later. {agent} writes a short loan paper for the books.", {
												agent: cofounder,
											}),
										],
										[
											"shares",
											t("More share capital"),
											t(
												"It stays in the company for good, and has to be registered with the Danish Business Authority. {agent} prepares it, and you sign with MitID.",
												{ agent: cofounder },
											),
										],
									] as const
								).map(([value, title, about]) =>
									h(
										"button",
										{
											type: "button",
											role: "radio",
											class: "bank-put-kind",
											"aria-checked": String(kind === value),
											onclick: () => {
												kind = value;
												draw();
											},
										},
										h("span", { class: "bank-put-radio", "aria-hidden": "true" }),
										h("span", null, h("strong", null, title), h("small", null, about)),
									),
								),
							),
						)
					: h(
							"div",
							{ class: "bank-put-step" },
							h(
								"p",
								null,
								t(
									"Send {amount} from your own bank to the company's account, with this text on the transfer:",
									{ amount: amountText },
								),
							),
							h(
								"div",
								{ class: "bank-put-details" },
								h("span", null, t("To")),
								summary.payTo
									? h("strong", null, `${summary.bank} · ${summary.payTo.reg} ${summary.payTo.account}`)
									: h("span", null, t("The account number shows once the bank shares it.")),
								summary.payTo ? copy(`${summary.payTo.reg} ${summary.payTo.account}`) : h("span"),
								h("span", null, t("Text")),
								h("strong", null, transferText),
								copy(transferText),
							),
							h(
								"p",
								{ class: "bank-note" },
								kind === "loan"
									? t(
											"It shows here as money in when it arrives. Tell {agent}, so the books keep it as a loan from you.",
											{
												agent: cofounder,
											},
										)
									: t(
											"It shows here as money in when it arrives. Tell {agent}, so the registration can be prepared.",
											{
												agent: cofounder,
											},
										),
							),
						);
			replace(
				dialog.content,
				h("h2", { class: "bank-put-title" }, t("Put in money")),
				body,
				h(
					"div",
					{ class: "bank-put-actions" },
					step === 2
						? h(
								"button",
								{
									type: "button",
									class: "btn",
									onclick: () => {
										step = 1;
										draw();
									},
								},
								t("Back"),
							)
						: h("span"),
					h(
						"button",
						{
							type: "button",
							class: "btn btn-primary",
							onclick: () => {
								if (step === 1) {
									step = 2;
									draw();
								} else dialog.close();
							},
						},
						step === 1 ? t("Continue") : t("Done"),
					),
				),
			);
		};
		draw();
		dialog.open();
	}
}

const views = new WeakMap<HTMLElement, BankView>();

/** Draws the Bank page into `container`, keeping what the member chose (the tab, the range, an open category) across
 * redraws of the same page. */
export function renderBank(container: HTMLElement, company: CompanyController): void {
	const state = company.store.get();
	let view = views.get(container);
	if (!view || view.el.parentElement !== container) {
		view?.dispose();
		view = new BankView(company);
		views.set(container, view);
		replace(container, view.el);
	}
	view.update(state.interfaceFolder?.files.get(BANK_SUMMARY_PATH), state.interfaceFolder === undefined);
}
