import {
	type EconomicsCurveEvaluation,
	type EconomicsDocument,
	type EconomicsEvaluation,
	type EconomicsFormat,
	type EconomicsHeadline,
	type EconomicsInput,
	type EconomicsScenario,
	evaluateEconomicsCurve,
	evaluateEconomicsModel,
	parseEconomicsDocument,
	type SurfaceEconomicsBlock,
} from "@qorpera/contracts";
import { h, icon } from "../../../ui/dom.ts";
import { t } from "../../../ui/preferences.ts";
import { type SurfaceBlockContext, type SurfaceBlockPrepared, sectionHead } from "./context.ts";
import type * as StrategyCharts from "./strategy-charts.ts";
import type {
	BreakEvenData,
	ChartMount,
	FlowStream,
	MoneyFlowData,
	WaterfallData,
	WaterfallStep,
} from "./strategy-charts.ts";
import {
	askButton,
	currencyAmount,
	disclosure,
	panelId,
	percentAmount,
	plainNumber,
	strategyEmpty,
	tierBadge,
} from "./strategy-kit.ts";

export type EconomicsView = "flow" | "waterfall" | "curve";

export interface EconomicsPick {
	readonly scenario: string | null;
	readonly overrides: Readonly<Record<string, number>>;
	readonly view?: EconomicsView;
}

export interface EconomicsMemory {
	readonly get: () => EconomicsPick | undefined;
	readonly set: (pick: EconomicsPick) => void;
}

interface Shape {
	readonly format?: EconomicsFormat;
	readonly unit?: string;
	readonly digits: number;
}

type Stream = FlowStream;

type Tone = "good" | "warn" | "bad";

type Drawn =
	| { readonly view: "flow"; readonly mount: ChartMount<MoneyFlowData> }
	| { readonly view: "waterfall"; readonly mount: ChartMount<WaterfallData> }
	| { readonly view: "curve"; readonly mount: ChartMount<BreakEvenData> };

interface Lever {
	readonly range: HTMLInputElement;
	readonly output: HTMLElement;
	readonly snaps: readonly HTMLButtonElement[];
}

interface Metric {
	readonly headline: EconomicsHeadline;
	readonly el: HTMLElement;
	readonly value: HTMLElement;
}

interface Flag {
	readonly key: string;
	readonly index: number;
	readonly severity: "fatal" | "warning";
	readonly label: string;
	readonly message: string;
	readonly button: HTMLButtonElement;
}

interface ScenarioCard {
	readonly scenario: EconomicsScenario | undefined;
	readonly el: HTMLButtonElement;
	readonly value: HTMLElement;
	readonly dot: HTMLElement;
}

const PRIMARY_LEVERS = 3;
const MARK_LABELS = 2;
const VIEW_ORDER: readonly EconomicsView[] = ["flow", "waterfall", "curve"];

let boardSeq = 0;
let chartsLoading: Promise<typeof StrategyCharts> | undefined;

function loadCharts(): Promise<typeof StrategyCharts> {
	chartsLoading ??= import("./strategy-charts.ts").catch((error: unknown) => {
		chartsLoading = undefined;
		throw error;
	});
	return chartsLoading;
}

function stepDigits(step: number | undefined): number {
	if (step === undefined || Number.isInteger(step)) return 0;
	return Math.min(4, String(step).split(".")[1]?.length ?? 0);
}

function shapeFor(unit?: string, currency?: string, format?: EconomicsFormat, digits = 0): Shape {
	if (format) return { format, ...(unit ? { unit } : {}), digits };
	if (unit === "%") return { format: "percent", digits };
	if (unit === "h" || unit === "hours") return { format: "hours", digits };
	if (unit && (unit === currency || /^[A-Z]{3}$/.test(unit))) return { format: "currency", unit, digits };
	return { ...(unit ? { unit } : {}), digits };
}

function amount(value: number | null | undefined, shape: Shape, currency?: string, compact = false): string {
	if (value === null || value === undefined) return "–";
	switch (shape.format) {
		case "currency":
			return currencyAmount(value, shape.unit ?? currency, compact);
		case "percent":
			return percentAmount(value);
		case "hours":
			return `${plainNumber(value, Math.max(shape.digits, 1), compact)} h`;
		default: {
			const text = plainNumber(value, Math.max(shape.digits, Math.abs(value) < 100 ? 1 : 0), compact);
			return shape.unit ? `${text} ${shape.unit}` : text;
		}
	}
}

function clampTo(input: EconomicsInput, value: number): number {
	return Math.min(input.max, Math.max(input.min, value));
}

function share(input: EconomicsInput, value: number): string {
	const span = input.max - input.min;
	return String(span > 0 ? (clampTo(input, value) - input.min) / span : 0);
}

function primaryInputs(doc: EconomicsDocument): readonly EconomicsInput[] {
	const flagged = doc.inputs.filter((input) => input.primary === true).slice(0, PRIMARY_LEVERS);
	if (flagged.length > 0) return flagged;
	const lead = doc.curve ? doc.inputs.find((input) => input.id === doc.curve?.xInput) : undefined;
	const rest = doc.inputs.filter((input) => input !== lead);
	return [...(lead ? [lead] : []), ...rest].slice(0, PRIMARY_LEVERS);
}

function river(doc: EconomicsDocument, values: EconomicsEvaluation["values"]): MoneyFlowData | null {
	const income: Stream[] = [];
	const cost: Stream[] = [];
	let total: { id: string; label: string } | undefined;
	for (const step of doc.waterfall ?? []) {
		if (step.kind === "total") {
			total = { id: step.id, label: step.label };
			continue;
		}
		const raw = values[step.id] ?? null;
		if (raw === null) continue;
		const kind = step.kind ?? (raw < 0 ? "cost" : "income");
		const size = Math.abs(raw);
		if (kind === "cost" || raw < 0) cost.push({ id: step.id, label: step.label, kind: "cost", size, signed: size });
		else income.push({ id: step.id, label: step.label, kind: "income", size, signed: size });
	}
	if (income.length === 0 && cost.length === 0) return null;
	const revenue = income.reduce((sum, item) => sum + item.size, 0);
	const spent = cost.reduce((sum, item) => sum + item.size, 0);
	const net = (total ? values[total.id] : null) ?? revenue - spent;
	const trimZero = (items: Stream[]): Stream[] => {
		const active = items.filter((item) => item.size > 0);
		return active.length > 0 ? active : items;
	};
	if (net >= 0) {
		const kept: Stream = {
			id: total?.id ?? "net",
			label: total?.label ?? t("Net"),
			kind: "total",
			size: net,
			signed: net,
		};
		return { left: trimZero(income), right: [...trimZero(cost), kept], revenue };
	}
	const gap: Stream = { id: "shortfall", label: t("Shortfall"), kind: "shortfall", size: -net, signed: net };
	return { left: trimZero([...income, gap]), right: trimZero(cost), revenue };
}

function bridge(doc: EconomicsDocument, values: EconomicsEvaluation["values"]): WaterfallData | null {
	const steps: WaterfallStep[] = [];
	let run = 0;
	let revenue = 0;
	let closed = false;
	for (const step of doc.waterfall ?? []) {
		if (step.kind === "total") {
			const net = values[step.id] ?? run;
			steps.push({ id: step.id, label: step.label, kind: "total", size: Math.abs(net), signed: net });
			closed = true;
			continue;
		}
		const raw = values[step.id] ?? null;
		if (raw === null) continue;
		const size = Math.abs(raw);
		const income = (step.kind ?? (raw < 0 ? "cost" : "income")) === "income" && raw >= 0;
		run += income ? size : -size;
		if (income) revenue += size;
		steps.push({
			id: step.id,
			label: step.label,
			kind: income ? "income" : "cost",
			size,
			signed: income ? size : -size,
		});
	}
	if (!steps.some((step) => step.kind !== "total")) return null;
	if (!closed) steps.push({ id: "net", label: t("Net"), kind: "total", size: Math.abs(run), signed: run });
	return { steps, revenue };
}

function drawable(curve: EconomicsCurveEvaluation | null): curve is EconomicsCurveEvaluation {
	return curve !== null && curve.points.filter((point) => point.y !== null).length >= 2;
}

function curveNote(curve: EconomicsCurveEvaluation, xText: (value: number) => string): HTMLElement | null {
	const { breakEvenX, capacityX } = curve;
	if (breakEvenX !== null && capacityX !== null && breakEvenX > capacityX) {
		return h(
			"p",
			{ class: "studio-econ-chart-note is-danger" },
			t("Break-even needs {value}, past the capacity ceiling of {ceiling}.", {
				value: xText(breakEvenX),
				ceiling: xText(capacityX),
			}),
		);
	}
	if (breakEvenX !== null) {
		return h("p", { class: "studio-econ-chart-note" }, t("Break-even at {value}.", { value: xText(breakEvenX) }));
	}
	const ys = curve.points.flatMap((point) => (point.y === null ? [] : [point.y]));
	if (ys.length && ys.every((y) => y < 0)) {
		return h("p", { class: "studio-econ-chart-note is-danger" }, t("No break-even anywhere in this range."));
	}
	return null;
}

function viewLabel(view: EconomicsView): string {
	if (view === "flow") return t("Money flow");
	if (view === "waterfall") return t("Waterfall");
	return t("Break-even");
}

function economicsBoard(
	doc: EconomicsDocument,
	heading: string,
	changed: boolean,
	ctx: SurfaceBlockContext,
	memory: EconomicsMemory | undefined,
): HTMLElement {
	const board = ++boardSeq;
	const currency = doc.currency;
	const inputs = new Map(doc.inputs.map((input) => [input.id, input]));
	const remembered = memory?.get();
	let scenario: EconomicsScenario | undefined = doc.scenarios?.find((item) => item.id === remembered?.scenario);
	const overrides = new Map<string, number>();
	for (const [id, value] of Object.entries(remembered?.overrides ?? {})) {
		const input = inputs.get(id);
		if (input) overrides.set(id, clampTo(input, value));
	}
	const hasFlow = Boolean(doc.waterfall?.length);
	const xInput = doc.curve ? inputs.get(doc.curve.xInput) : undefined;
	const hasCurve = Boolean(doc.curve && xInput);
	const available = VIEW_ORDER.filter((key) => (key === "curve" ? hasCurve : hasFlow));
	let view: EconomicsView = available[0] ?? "flow";
	if (remembered?.view && available.includes(remembered.view)) view = remembered.view;
	let hovered: Stream | null = null;
	let pinned: string | null = null;
	let opened: string | null = null;
	let dismissed = false;
	let fatalSeen = "";
	let latest: MoneyFlowData | null = null;
	let charts: typeof StrategyCharts | null = null;
	let chartsFailed = false;
	let waiting = false;
	let drawn: Drawn | null = null;

	const presetFor = (input: EconomicsInput, pick: EconomicsScenario | undefined) =>
		clampTo(input, pick?.values[input.id] ?? input.value);
	const presetOf = (input: EconomicsInput) => presetFor(input, scenario);
	const levelOf = (input: EconomicsInput) => overrides.get(input.id) ?? presetOf(input);
	const current = () => Object.fromEntries(doc.inputs.map((input) => [input.id, levelOf(input)]));
	const inputShape = (input: EconomicsInput) => shapeFor(input.unit, currency, undefined, stepDigits(input.step));
	const shown = (input: EconomicsInput) => amount(levelOf(input), inputShape(input), currency);
	const unitOf = (id: string) => (doc.computed.find((formula) => formula.id === id) ?? inputs.get(id))?.unit;
	const headlineShape = (headline: EconomicsHeadline) =>
		shapeFor(headline.unit ?? unitOf(headline.id), currency, headline.format);
	const headlineText = (headline: EconomicsHeadline, values: EconomicsEvaluation["values"]) =>
		amount(values[headline.id], headlineShape(headline), currency, true);
	const moneyShape = shapeFor(currency, currency, currency ? "currency" : undefined);
	const money = (value: number) => amount(value, moneyShape, currency, true);

	const levers = new Map<string, Lever>();
	const setValue = (input: EconomicsInput, value: number) => {
		const next = clampTo(input, value);
		if (next === presetOf(input)) overrides.delete(input.id);
		else overrides.set(input.id, next);
		refresh();
	};
	const pickScenario = (next: EconomicsScenario | undefined) => {
		scenario = next;
		overrides.clear();
		refresh();
	};

	const leverOf = (input: EconomicsInput, primary: boolean): HTMLElement => {
		const id = `studio-econ-${board}-${input.id}`;
		const shape = inputShape(input);
		const range: HTMLInputElement = h("input", {
			id,
			type: "range",
			class: "studio-econ-range",
			min: String(input.min),
			max: String(input.max),
			step: String(input.step ?? "any"),
			value: String(levelOf(input)),
			oninput: () => {
				setValue(input, Number(range.value));
			},
		});
		const output = h("output", { class: "studio-econ-lever-value", for: id });
		const marks = input.marks ?? [];
		const ticks = marks.map((mark) => {
			const snap = t("Snap to {label}", { label: mark.label });
			const tick = h("button", {
				type: "button",
				class: "studio-econ-tick-mark",
				"data-value": String(mark.value),
				title: `${snap} · ${amount(mark.value, shape, currency)}`,
				"aria-label": snap,
				tabindex: "-1",
				onclick: () => setValue(input, mark.value),
			});
			tick.style.setProperty("--at", share(input, mark.value));
			return tick;
		});
		const named = !primary || marks.length <= MARK_LABELS;
		const chips = named
			? marks.map((mark) =>
					h(
						"button",
						{
							type: "button",
							class: "studio-econ-mark",
							"data-value": String(mark.value),
							title: t("Snap to {label}", { label: mark.label }),
							onclick: () => setValue(input, mark.value),
						},
						h("span", { class: "studio-econ-mark-label" }, mark.label),
						" ",
						h("b", null, amount(mark.value, shape, currency)),
					),
				)
			: [];
		levers.set(input.id, { range, output, snaps: [...ticks, ...chips] });
		const basis = [input.source, input.note].filter((part): part is string => Boolean(part)).join(" · ");
		return h(
			"div",
			{ class: `studio-econ-lever${primary ? " is-primary" : ""}`, "data-input": input.id },
			h(
				"div",
				{ class: "studio-econ-lever-top" },
				h("label", { for: id, class: "studio-econ-lever-label" }, input.label),
				primary ? null : tierBadge(input.tier, input.source),
				output,
			),
			h(
				"div",
				{ class: "studio-econ-track" },
				range,
				ticks.length ? h("div", { class: "studio-econ-ticks" }, ticks) : null,
			),
			chips.length
				? h("div", { class: "studio-econ-marks", role: "group", "aria-label": t("Market references") }, chips)
				: null,
			!primary && basis ? h("p", { class: "studio-econ-note" }, basis) : null,
		);
	};

	const primaries = primaryInputs(doc);
	const secondaries = doc.inputs.filter((input) => !primaries.includes(input));
	const grounded = primaries.filter((input) => input.source || input.note);
	const primaryStrip = h(
		"div",
		{ class: "studio-econ-levers", role: "group", "aria-label": t("Key levers"), "data-tour-id": "econ:levers" },
		primaries.map((input) => leverOf(input, true)),
	);
	const drawerCount = secondaries.length + grounded.length;
	const drawer = drawerCount
		? h(
				"div",
				{ class: "studio-econ-drawer", id: panelId("studio-econ-drawer"), hidden: true },
				grounded.length
					? h(
							"ul",
							{ class: "studio-econ-basis" },
							grounded.map((input) =>
								h(
									"li",
									{ class: "studio-econ-basis-row", "data-input": input.id },
									tierBadge(input.tier, input.source),
									" ",
									h("strong", null, input.label),
									" ",
									h(
										"span",
										null,
										[input.source, input.note].filter((part): part is string => Boolean(part)).join(" · "),
									),
								),
							),
						)
					: null,
				secondaries.length
					? h(
							"div",
							{ class: "studio-econ-secondary" },
							secondaries.map((input) => leverOf(input, false)),
						)
					: null,
			)
		: null;
	const drawerToggle = drawer
		? h(
				"button",
				{
					type: "button",
					class: "studio-econ-assumptions",
					"aria-expanded": "false",
					"aria-controls": drawer.id,
				},
				h("span", null, t("Assumptions ({count})", { count: String(drawerCount) })),
				icon("chevron-down"),
			)
		: null;
	if (drawer && drawerToggle) {
		drawerToggle.addEventListener("click", () => disclosure(drawerToggle, drawer, drawer.hidden));
	}

	const headlines = doc.headlines ?? [];
	const lead = headlines.find((item) => item.emphasis === "primary") ?? headlines[0];

	const cardOf = (item: EconomicsScenario | undefined): ScenarioCard => {
		const value = h("strong", { class: "studio-econ-scenario-value" });
		const dot = h("i", { class: "studio-econ-scenario-dot", "aria-hidden": "true" });
		const el = h(
			"button",
			{
				type: "button",
				class: `studio-econ-scenario${item ? "" : " is-base"}`,
				...(item ? { "data-scenario": item.id } : {}),
				onclick: () => pickScenario(item),
			},
			h(
				"span",
				{ class: "studio-econ-scenario-top" },
				dot,
				h("span", { class: "studio-econ-scenario-name" }, item?.name ?? t("Base")),
			),
			value,
		);
		return { scenario: item, el, value, dot };
	};
	const cards: ScenarioCard[] = doc.scenarios?.length ? [cardOf(undefined), ...doc.scenarios.map(cardOf)] : [];
	const toneOf = (result: EconomicsEvaluation): Tone => {
		const fired = result.constraints.filter((status) => status.triggered);
		const value = lead ? (result.values[lead.id] ?? null) : null;
		if (fired.some((status) => status.constraint.severity === "fatal")) return "bad";
		if (value !== null && value < 0 && lead?.toneWhenNegative === "danger") return "bad";
		if (fired.length > 0) return "warn";
		if (value !== null && lead?.target !== undefined && value < lead.target) return "warn";
		return "good";
	};
	const signedHeadline = (result: EconomicsEvaluation): string => {
		if (!lead) return "";
		const value = result.values[lead.id] ?? null;
		const text = amount(value, headlineShape(lead), currency, true);
		return value !== null && value > 0 ? `+${text}` : text;
	};

	const reset = h(
		"button",
		{
			type: "button",
			class: "studio-econ-reset",
			hidden: true,
			onclick: () => {
				overrides.clear();
				refresh();
			},
		},
		t("Reset"),
	);
	const thesis = h("p", { class: "studio-econ-thesis", hidden: true });

	const heroLabel = h("span", { class: "studio-econ-hero-label" });
	const heroValue = h("strong", { class: "studio-econ-hero-value" });
	const heroUnit = h("span", { class: "studio-econ-hero-unit" });
	const heroSub = h("span", { class: "studio-econ-hero-sub" });
	const readout = h(
		"div",
		{ class: "studio-econ-readout", "aria-live": "polite", ...(lead ? { "data-headline": lead.id } : {}) },
		heroLabel,
		h("div", { class: "studio-econ-hero-row" }, heroValue, heroUnit),
		heroSub,
	);
	const metrics: Metric[] = headlines
		.filter((item) => item !== lead)
		.map((headline) => {
			const value = h("strong", { class: "studio-econ-metric-value" });
			const el = h(
				"li",
				{ class: "studio-econ-metric", "data-headline": headline.id },
				h("span", { class: "studio-econ-metric-label" }, headline.label),
				value,
			);
			return { headline, el, value };
		});
	const holds = h("span", { class: "studio-econ-holds", hidden: true }, t("All constraints hold"));
	const flagLine = h("p", { class: "studio-econ-flag-line", hidden: true, "aria-live": "polite" });
	const flags: Flag[] = (doc.constraints ?? []).map((constraint, index) => {
		const key = constraint.id ?? `constraint-${index + 1}`;
		const button = h(
			"button",
			{
				type: "button",
				class: `studio-econ-flag is-${constraint.severity}`,
				"data-constraint": key,
				"aria-expanded": "false",
				hidden: true,
				onclick: () => {
					if (shownFlag() === key) {
						opened = null;
						dismissed = true;
					} else {
						opened = key;
						dismissed = false;
					}
					paintFlags();
				},
			},
			h("i", { class: "studio-econ-flag-dot", "aria-hidden": "true" }),
			h("span", null, constraint.label),
		);
		return {
			key,
			index,
			severity: constraint.severity,
			label: constraint.label,
			message: constraint.message,
			button,
		};
	});
	const flagStrip =
		flags.length > 0
			? h(
					"div",
					{ class: "studio-econ-flags" },
					holds,
					flags.map((flag) => flag.button),
				)
			: null;
	const verdict = doc.verdict ? h("p", { class: "studio-econ-verdict", hidden: true }, doc.verdict) : null;
	const hero = h(
		"div",
		{ class: "studio-econ-hero", "data-tour-id": "econ:hero" },
		readout,
		metrics.length
			? h(
					"ul",
					{ class: "studio-econ-metrics" },
					metrics.map((metric) => metric.el),
				)
			: null,
		flagStrip,
	);

	let triggered: Flag[] = [];
	const shownFlag = (): string | null => {
		if (opened && triggered.some((flag) => flag.key === opened)) return opened;
		if (dismissed) return null;
		return triggered.find((flag) => flag.severity === "fatal")?.key ?? null;
	};
	function paintFlags(): void {
		const open = shownFlag();
		for (const flag of flags) {
			const on = triggered.includes(flag);
			flag.button.hidden = !on;
			flag.button.setAttribute("aria-expanded", String(on && flag.key === open));
			flag.button.classList.toggle("is-open", on && flag.key === open);
		}
		const active = flags.find((flag) => flag.key === open);
		flagLine.hidden = !active;
		flagLine.className = `studio-econ-flag-line${active ? ` is-${active.severity}` : ""}`;
		flagLine.replaceChildren(
			...(active ? [h("strong", null, active.label), " ", h("span", null, active.message)] : []),
		);
	}

	const views: HTMLButtonElement[] =
		available.length > 1
			? available.map((key) =>
					h(
						"button",
						{
							type: "button",
							class: "studio-econ-view",
							"data-econ-view": key,
							onclick: () => {
								if (view === key) return;
								view = key;
								hovered = null;
								pinned = null;
								refresh();
							},
						},
						viewLabel(key),
					),
				)
			: [];
	const chartHost = h("div", { class: "studio-econ-chart-host is-loading", role: "img" });
	const chartFoot = h("div", { class: "studio-econ-chart-foot" });
	const stage = h("div", { class: "studio-econ-stage" }, chartHost, chartFoot);
	const xText = (value: number) => amount(value, xInput ? inputShape(xInput) : shapeFor(), currency, true);
	const yText = (value: number) =>
		amount(value, doc.curve ? shapeFor(unitOf(doc.curve.yOutput) ?? currency, currency) : moneyShape, currency, true);
	const capacityLabel = doc.curve?.capacityLabel ?? t("Capacity ceiling");

	let values: Record<string, number> = current();
	let evaluation = evaluateEconomicsModel(doc, values);
	const peekStream = (): Stream | null => {
		if (hovered) return hovered;
		if (!pinned || !latest) return null;
		return [...latest.left, ...latest.right].find((item) => item.id === pinned) ?? null;
	};
	function paintHero(): void {
		const peek = peekStream();
		readout.classList.toggle("is-peek", peek !== null);
		const fatal = triggered.some((flag) => flag.severity === "fatal");
		if (peek) {
			const revenue = latest?.revenue ?? 0;
			heroLabel.textContent = peek.label;
			heroValue.textContent = money(peek.signed);
			heroUnit.textContent = doc.period ? t("/ {period}", { period: doc.period }) : "";
			heroSub.textContent =
				revenue > 0 ? t("{share} of revenue", { share: percentAmount((peek.size / revenue) * 100) }) : "";
			readout.classList.toggle("is-bad", peek.kind === "shortfall");
			readout.classList.toggle("is-good", peek.kind === "total" && peek.size > 0);
			readout.hidden = false;
			return;
		}
		readout.hidden = !lead;
		if (!lead) return;
		const value = evaluation.values[lead.id] ?? null;
		const shape = headlineShape(lead);
		const negative = value !== null && value < 0 && lead.toneWhenNegative === "danger";
		heroLabel.textContent = lead.label;
		heroValue.textContent = amount(value, shape, currency, true);
		heroUnit.textContent = shape.format === "currency" && doc.period ? t("/ {period}", { period: doc.period }) : "";
		heroSub.textContent =
			lead.target !== undefined ? t("Target {value}", { value: amount(lead.target, shape, currency, true) }) : "";
		readout.classList.toggle("is-bad", negative || fatal);
		readout.classList.toggle("is-good", !negative && !fatal && value !== null && value > 0);
	}

	const compose = () => {
		const result = evaluateEconomicsModel(doc, current());
		const leverText = doc.inputs.map((input) => `${input.label} ${shown(input)}`).join(", ");
		const results = headlines.map((item) => `${item.label} ${headlineText(item, result.values)}`);
		const limits = result.constraints
			.filter((status) => status.triggered)
			.map((status) => `${status.constraint.label} (${status.constraint.message})`)
			.join("; ");
		const lines = [
			t("Challenge these numbers in {title}.", { title: doc.title ?? heading }),
			scenario ? t("Scenario: {name}.", { name: scenario.name }) : "",
			t("Levers: {levers}.", { levers: leverText }),
			results.length ? t("Results: {results}.", { results: results.join(", ") }) : "",
			limits ? t("Triggered constraints: {constraints}.", { constraints: limits }) : "",
			t(
				"Pressure-test the weakest assumptions against real benchmarks, name what breaks first, and propose a structural fix.",
			),
		];
		return { prompt: lines.filter(Boolean).join("\n"), title: t("Challenge the numbers") };
	};
	const challenge = askButton(ctx, t("Challenge these numbers"), compose);

	const unmount = () => {
		drawn?.mount.dispose();
		drawn = null;
		chartHost.removeAttribute("data-chart");
	};
	const blank = (...notes: HTMLElement[]) => {
		unmount();
		chartHost.hidden = true;
		chartFoot.replaceChildren(...notes);
	};
	const note = (text: string) => h("p", { class: "studio-econ-chart-note" }, text);
	const live = <V extends EconomicsView>(key: V): Extract<Drawn, { view: V }> | null => {
		if (!drawn || drawn.view !== key || drawn.mount.disposed()) return null;
		return drawn as Extract<Drawn, { view: V }>;
	};
	const reveal = (next: Drawn) => {
		drawn = next;
		chartHost.hidden = false;
		chartHost.classList.remove("is-loading");
		chartHost.dataset.chart = next.view;
	};
	const chartSignal = ctx.renderSignal ?? ctx.signal;
	const ready = (): typeof StrategyCharts | null => {
		if (charts) return charts;
		unmount();
		chartHost.hidden = false;
		chartHost.classList.add("is-loading");
		if (waiting) return null;
		waiting = true;
		loadCharts().then(
			(lib) => {
				if (chartSignal.aborted) return;
				charts = lib;
				paintStage();
			},
			() => {
				if (chartSignal.aborted) return;
				chartsFailed = true;
				paintStage();
			},
		);
		return null;
	};

	function paintStage(): void {
		for (const button of views) {
			const on = button.dataset.econView === view;
			button.classList.toggle("is-on", on);
			button.setAttribute("aria-pressed", String(on));
		}
		const flowLabel = view === "flow" ? t("Where the money goes") : viewLabel(view);
		chartHost.setAttribute("aria-label", view === "curve" ? (xInput?.label ?? flowLabel) : flowLabel);
		const shareOf = (ratio: number) => t("{share} of revenue", { share: percentAmount(ratio * 100) });
		if (view === "flow" || view === "waterfall") {
			latest = river(doc, evaluation.values);
			const steps = bridge(doc, evaluation.values);
			if (!latest || !steps) {
				blank(note(t("The flow can't be drawn from these numbers yet.")));
				return;
			}
			if (chartsFailed) {
				blank(note(t("The chart couldn't load.")));
				return;
			}
			chartFoot.replaceChildren();
			const lib = ready();
			if (!lib) return;
			if (view === "flow") {
				const onStage = live("flow");
				if (onStage) {
					onStage.mount.update(latest);
					return;
				}
				unmount();
				reveal({
					view: "flow",
					mount: lib.mountMoneyFlowChart(chartHost, chartSignal, latest, {
						hub: t("Money in"),
						money,
						percent: (ratio) => percentAmount(ratio * 100),
						share: shareOf,
						onHover: (stream) => {
							hovered = stream;
							paintHero();
						},
						onPick: (stream) => {
							pinned = pinned === stream.id ? null : stream.id;
							paintHero();
						},
					}),
				});
				return;
			}
			const onStage = live("waterfall");
			if (onStage) {
				onStage.mount.update(steps);
				return;
			}
			unmount();
			reveal({
				view: "waterfall",
				mount: lib.mountWaterfallChart(chartHost, chartSignal, steps, { money, axisMoney: money, share: shareOf }),
			});
			return;
		}
		latest = null;
		const curve = evaluateEconomicsCurve(doc, values);
		if (!drawable(curve)) {
			blank(note(t("The curve can't be drawn from these numbers yet.")));
			return;
		}
		const verdictNote = curveNote(curve, xText);
		if (chartsFailed) {
			blank(note(t("The chart couldn't load.")), ...(verdictNote ? [verdictNote] : []));
			return;
		}
		chartFoot.replaceChildren(...(verdictNote ? [verdictNote] : []));
		const lib = ready();
		if (!lib) return;
		const data: BreakEvenData = { ...curve, zeroLine: doc.curve?.zeroLine !== false };
		const onStage = live("curve");
		if (onStage) {
			onStage.mount.update(data);
			return;
		}
		unmount();
		reveal({
			view: "curve",
			mount: lib.mountBreakEvenChart(chartHost, chartSignal, data, {
				xText,
				yText,
				xTitle: xInput?.label ?? "",
				capacityLabel,
				breakEvenLabel: (x) => t("Break-even {value}", { value: xText(x) }),
			}),
		});
	}

	function paintCards(): void {
		for (const card of cards) {
			const on = card.scenario?.id === scenario?.id;
			const preset = () =>
				Object.fromEntries(doc.inputs.map((input) => [input.id, presetFor(input, card.scenario)]));
			const result = on ? evaluation : evaluateEconomicsModel(doc, preset());
			card.el.classList.toggle("is-on", on);
			card.el.setAttribute("aria-pressed", String(on));
			card.value.textContent = signedHeadline(result);
			card.value.hidden = !lead;
			const tone = toneOf(result);
			card.dot.className = `studio-econ-scenario-dot is-${tone}`;
			card.el.dataset.tone = tone;
		}
	}

	function refresh(): void {
		values = current();
		evaluation = evaluateEconomicsModel(doc, values);
		for (const input of doc.inputs) {
			const lever = levers.get(input.id);
			const value = values[input.id];
			if (!lever || value === undefined) continue;
			if (Number(lever.range.value) !== value) lever.range.value = String(value);
			lever.range.style.setProperty("--fill", share(input, value));
			const text = shown(input);
			lever.output.textContent = text;
			lever.range.setAttribute("aria-valuetext", text);
			for (const snap of lever.snaps) snap.classList.toggle("is-on", Number(snap.dataset.value) === value);
		}
		paintCards();
		thesis.textContent = scenario?.thesis ?? "";
		thesis.hidden = !scenario?.thesis;
		reset.hidden = overrides.size === 0;

		triggered = flags.filter((flag) => evaluation.constraints[flag.index]?.triggered === true);
		const fatalKeys = triggered
			.filter((flag) => flag.severity === "fatal")
			.map((flag) => flag.key)
			.join(",");
		if (fatalKeys !== fatalSeen) {
			fatalSeen = fatalKeys;
			dismissed = false;
		}
		holds.hidden = triggered.length > 0;
		paintFlags();
		if (verdict) verdict.hidden = Boolean(scenario?.thesis) || triggered.some((flag) => flag.severity === "fatal");

		for (const metric of metrics) {
			const value = evaluation.values[metric.headline.id] ?? null;
			const shape = headlineShape(metric.headline);
			const target = metric.headline.target;
			metric.el.classList.toggle(
				"is-negative",
				value !== null && value < 0 && metric.headline.toneWhenNegative === "danger",
			);
			metric.el.classList.toggle("is-short", value !== null && target !== undefined && value < target);
			metric.value.textContent = amount(value, shape, currency, true);
			if (target !== undefined) {
				metric.el.title = t("Target {value}", { value: amount(target, shape, currency, true) });
			}
		}
		if (available.length) paintStage();
		paintHero();
		memory?.set({ scenario: scenario?.id ?? null, overrides: Object.fromEntries(overrides), view });
	}

	const title =
		doc.title || doc.subtitle
			? h(
					"div",
					{ class: "studio-econ-title" },
					doc.title ? h("h3", null, doc.title) : null,
					doc.subtitle ? h("p", null, doc.subtitle) : null,
				)
			: null;
	const scenarioStrip = cards.length
		? h(
				"div",
				{
					class: "studio-econ-scenarios",
					role: "group",
					"aria-label": t("Scenarios"),
					"data-tour-id": "econ:scenarios",
				},
				cards.map((card) => card.el),
			)
		: null;
	const viewSwitch = views.length
		? h("div", { class: "studio-econ-views", role: "group", "aria-label": t("View") }, views)
		: null;
	const foot = h(
		"div",
		{ class: "studio-econ-foot" },
		drawerToggle,
		reset,
		challenge ? h("span", { class: "studio-econ-foot-ask" }, challenge) : null,
	);
	const section = h(
		"section",
		{ class: "studio-section studio-econ", "data-block": "economics" },
		sectionHead(heading, changed),
		title ? h("div", { class: "studio-econ-head" }, title) : null,
		scenarioStrip,
		thesis,
		hero,
		flagLine,
		verdict,
		available.length
			? h("div", { class: "studio-econ-board", "data-tour-id": "econ:visual" }, viewSwitch, stage)
			: null,
		primaryStrip,
		foot,
		drawer,
	);
	refresh();
	return section;
}

export function prepareEconomics(
	block: SurfaceEconomicsBlock,
	ctx: SurfaceBlockContext,
	memory?: EconomicsMemory,
): SurfaceBlockPrepared {
	const read = ctx.read(block.from);
	const doc = read.found ? parseEconomicsDocument(read.value) : null;
	const heading = block.heading ? ctx.words(block.heading) : t("Unit economics");
	if (!doc) {
		return {
			filled: false,
			pieces: [
				{
					build: () =>
						h(
							"section",
							{ class: "studio-section studio-econ", "data-block": "economics" },
							sectionHead(heading, false),
							strategyEmpty(
								"economics",
								t("No model yet"),
								t(
									"Unit economics, scenarios and hard constraints will live here: every lever live, every number marked verified, benchmark or hypothesis.",
								),
								askButton(ctx, t("Build the model"), () => ({
									prompt: t(
										"Build the unit economics model for our recommended play: real benchmarks for prices, fees and taxes, explicit hypotheses for the rest, hard capacity constraints and a break-even curve.",
									),
									title: t("Build the model"),
								})),
							),
						),
				},
			],
		};
	}
	return { filled: true, pieces: [{ build: () => economicsBoard(doc, heading, read.changed, ctx, memory) }] };
}
