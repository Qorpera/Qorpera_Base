import {
	type EconomicsConstraintStatus,
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
import { h } from "../../../ui/dom.ts";
import { t } from "../../../ui/preferences.ts";
import { type SurfaceBlockContext, type SurfaceBlockPrepared, sectionHead } from "./context.ts";
import {
	askButton,
	currencyAmount,
	kicker,
	percentAmount,
	plainNumber,
	strategyEmpty,
	svgEl,
	tierBadge,
} from "./strategy-kit.ts";

export interface EconomicsPick {
	readonly scenario: string | null;
	readonly overrides: Readonly<Record<string, number>>;
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

interface WaterfallBar {
	readonly label: string;
	readonly from: number;
	readonly to: number;
	readonly kind: "income" | "cost" | "total";
}

interface CurveLook {
	readonly xText: (value: number) => string;
	readonly yText: (value: number) => string;
	readonly xTitle: string;
	readonly capacityLabel: string;
	readonly zeroLine: boolean;
}

interface Lever {
	readonly range: HTMLInputElement;
	readonly output: HTMLElement;
	readonly chips: readonly HTMLButtonElement[];
}

interface Kpi {
	readonly headline: EconomicsHeadline;
	readonly el: HTMLElement;
	readonly value: HTMLElement;
	readonly sub: HTMLElement;
}

const WATERFALL = { width: 560, row: 34, pad: 8, label: 150, value: 96 } as const;
const CURVE = { width: 560, height: 280, left: 60, right: 16, top: 30, bottom: 42 } as const;
const PILL_CHAR = 6.4;

let boardSeq = 0;

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

function short(text: string, chars: number): string {
	return text.length > chars ? `${text.slice(0, chars - 1)}…` : text;
}

function waterfallBars(doc: EconomicsDocument, values: EconomicsEvaluation["values"]): WaterfallBar[] {
	const bars: WaterfallBar[] = [];
	let run = 0;
	for (const step of doc.waterfall ?? []) {
		const raw = values[step.id] ?? null;
		if (step.kind === "total") {
			const total = raw ?? run;
			bars.push({ label: step.label, from: 0, to: total, kind: "total" });
			run = total;
			continue;
		}
		const delta = raw === null ? 0 : step.kind === "cost" ? -Math.abs(raw) : raw;
		const kind = step.kind ?? (delta < 0 ? "cost" : "income");
		bars.push({ label: step.label, from: run, to: run + delta, kind });
		run += delta;
	}
	if (bars.length > 0 && bars.at(-1)?.kind !== "total") {
		bars.push({ label: t("Net"), from: 0, to: run, kind: "total" });
	}
	return bars;
}

function waterfallSvg(bars: readonly WaterfallBar[], money: (value: number) => string): SVGSVGElement {
	const { width, row, pad, label, value } = WATERFALL;
	const height = pad * 2 + bars.length * row;
	const x0 = label + 12;
	const x1 = width - value - 8;
	const edges = bars.flatMap((bar) => [bar.from, bar.to]);
	const lo = Math.min(0, ...edges);
	const span = Math.max(0, ...edges) - lo || 1;
	const sx = (v: number) => x0 + ((v - lo) / span) * (x1 - x0);
	const zero = sx(0);
	const svg = svgEl("svg", {
		class: "studio-econ-svg is-waterfall",
		viewBox: `0 0 ${width} ${height}`,
		role: "img",
		"aria-label": t("Contribution waterfall"),
	});
	svg.append(svgEl("line", { class: "studio-econ-zero", x1: zero, x2: zero, y1: 4, y2: height - 4 }));
	bars.forEach((bar, index) => {
		const y = pad + index * row;
		const mid = y + row / 2 + 4;
		const barY = y + 8;
		const shown = bar.kind === "total" ? bar.to : bar.to - bar.from;
		const tone = shown < 0 ? " is-negative" : "";
		const name = svgEl(
			"text",
			{ class: `studio-econ-wf-label is-${bar.kind}`, x: label, y: mid, "text-anchor": "end" },
			svgEl("title", {}, bar.label),
			short(bar.label, 22),
		);
		const rect = svgEl("rect", {
			class: `studio-econ-wf-bar is-${bar.kind}${tone}`,
			x: Math.min(sx(bar.from), sx(bar.to)),
			y: barY,
			width: Math.max(2, Math.abs(sx(bar.to) - sx(bar.from))),
			height: row - 16,
			rx: 4,
		});
		const figure = svgEl(
			"text",
			{ class: `studio-econ-wf-value is-${bar.kind}${tone}`, x: width - 2, y: mid, "text-anchor": "end" },
			money(shown),
		);
		svg.append(name, rect, figure);
		if (index < bars.length - 1 && bars[index + 1]?.kind !== "total") {
			const cx = sx(bar.to);
			const link = svgEl("line", {
				class: "studio-econ-wf-link",
				x1: cx,
				x2: cx,
				y1: barY + row - 16,
				y2: barY + row,
			});
			svg.append(link);
		}
	});
	return svg;
}

function segments(points: EconomicsCurveEvaluation["points"]): { x: number; y: number }[][] {
	const runs: { x: number; y: number }[][] = [];
	let run: { x: number; y: number }[] = [];
	for (const point of points) {
		if (point.y === null) {
			if (run.length) runs.push(run);
			run = [];
		} else {
			run.push({ x: point.x, y: point.y });
		}
	}
	if (run.length) runs.push(run);
	return runs;
}

function curveSvg(curve: EconomicsCurveEvaluation, look: CurveLook): SVGSVGElement | null {
	const { width, height, left, right, top, bottom } = CURVE;
	const ys = curve.points.flatMap((point) => (point.y === null ? [] : [point.y]));
	if (ys.length < 2) return null;
	const xMin = curve.points[0]!.x;
	const xMax = curve.points.at(-1)!.x;
	const plotRight = width - right;
	const plotBottom = height - bottom;
	const rawLo = Math.min(0, ...ys, curve.currentY ?? 0);
	const rawHi = Math.max(0, ...ys, curve.currentY ?? 0);
	const pad = (rawHi - rawLo) * 0.08 || 1;
	const lo = rawLo - pad;
	const hi = rawHi + pad;
	const sx = (x: number) => left + ((x - xMin) / (xMax - xMin || 1)) * (plotRight - left);
	const sy = (y: number) => plotBottom - ((y - lo) / (hi - lo)) * (plotBottom - top);
	const at = (x: number, y: number) => `${sx(x).toFixed(1)} ${sy(y).toFixed(1)}`;
	const gradient = `studio-econ-fill-${++boardSeq}`;
	const stops = svgEl(
		"linearGradient",
		{ id: gradient, x1: 0, x2: 0, y1: 0, y2: 1 },
		svgEl("stop", { class: "studio-econ-stop is-top", offset: "0%" }),
		svgEl("stop", { class: "studio-econ-stop is-bottom", offset: "100%" }),
	);
	const svg = svgEl("svg", {
		class: "studio-econ-svg is-curve",
		viewBox: `0 0 ${width} ${height}`,
		role: "img",
		"aria-label": look.xTitle,
	});
	svg.append(svgEl("defs", {}, stops));
	for (let tick = 0; tick <= 4; tick += 1) {
		const value = lo + ((hi - lo) * tick) / 4;
		const y = sy(value);
		const label = look.yText(value);
		svg.append(
			svgEl("line", { class: "studio-econ-grid", x1: left, x2: plotRight, y1: y, y2: y }),
			svgEl("text", { class: "studio-econ-tick", x: left - 8, y: y + 4, "text-anchor": "end" }, label),
		);
	}
	const capacityX = curve.capacityX;
	if (capacityX !== null && capacityX < xMax) {
		const cx = sx(Math.max(capacityX, xMin));
		const zone = svgEl("rect", {
			class: "studio-econ-capacity",
			x: cx,
			y: top,
			width: plotRight - cx,
			height: plotBottom - top,
		});
		const edge = svgEl("line", { class: "studio-econ-capacity-edge", x1: cx, x2: cx, y1: top, y2: plotBottom });
		const tag = svgEl(
			"text",
			{ class: "studio-econ-capacity-label", x: cx + 8, y: plotBottom - 10 },
			short(look.capacityLabel, 28),
		);
		svg.append(zone, edge, tag);
	}
	const zeroY = sy(0);
	if (look.zeroLine) {
		svg.append(svgEl("line", { class: "studio-econ-zero", x1: left, x2: plotRight, y1: zeroY, y2: zeroY }));
	}
	for (const run of segments(curve.points)) {
		const line = run.map((point, index) => `${index ? "L" : "M"}${at(point.x, point.y)}`);
		const first = run[0]!;
		const last = run.at(-1)!;
		const area = svgEl("path", {
			class: "studio-econ-area",
			d: `M${at(first.x, 0)} L${line.join(" ").slice(1)} L${at(last.x, 0)} Z`,
			fill: `url(#${gradient})`,
		});
		svg.append(area, svgEl("path", { class: "studio-econ-line", d: line.join(" ") }));
	}
	const breakEven = curve.breakEvenX;
	if (breakEven !== null) {
		const bx = sx(breakEven);
		const beyond = capacityX !== null && breakEven > capacityX;
		const text = t("Break-even {value}", { value: look.xText(breakEven) });
		const pillWidth = text.length * PILL_CHAR + 18;
		const pillX = Math.min(plotRight - pillWidth, Math.max(left, bx - pillWidth / 2));
		const pillMid = pillX + pillWidth / 2;
		const mark = svgEl(
			"g",
			{ class: `studio-econ-breakeven${beyond ? " is-impossible" : ""}` },
			svgEl("line", { class: "studio-econ-breakeven-line", x1: bx, x2: bx, y1: top, y2: plotBottom }),
			svgEl("rect", { class: "studio-econ-pill", x: pillX, y: 4, width: pillWidth, height: 20, rx: 10 }),
			svgEl("text", { class: "studio-econ-pill-text", x: pillMid, y: 18, "text-anchor": "middle" }, text),
		);
		svg.append(mark);
	}
	if (curve.currentY !== null) {
		const nx = sx(Math.min(xMax, Math.max(xMin, curve.currentX)));
		const ny = sy(curve.currentY);
		const tone = curve.currentY < 0 ? " is-negative" : "";
		svg.append(
			svgEl("line", { class: "studio-econ-now-guide", x1: nx, x2: nx, y1: ny, y2: plotBottom }),
			svgEl("circle", { class: `studio-econ-now-halo${tone}`, cx: nx, cy: ny, r: 10 }),
			svgEl("circle", { class: `studio-econ-now${tone}`, cx: nx, cy: ny, r: 5 }),
		);
	}
	const tickY = plotBottom + 18;
	const axisX = (left + plotRight) / 2;
	svg.append(
		svgEl("text", { class: "studio-econ-tick", x: left, y: tickY }, look.xText(xMin)),
		svgEl("text", { class: "studio-econ-tick", x: plotRight, y: tickY, "text-anchor": "end" }, look.xText(xMax)),
		svgEl("text", { class: "studio-econ-axis", x: axisX, y: height - 6, "text-anchor": "middle" }, look.xTitle),
	);
	return svg;
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

function curveMissing(): HTMLElement {
	return h("p", { class: "studio-econ-chart-note" }, t("The curve can't be drawn from these numbers yet."));
}

function constraintCallout({ constraint }: EconomicsConstraintStatus): HTMLElement {
	const { label, message, severity } = constraint;
	const copy = h("div", { class: "studio-econ-alert-copy" }, h("strong", null, label), h("p", null, message));
	return h(
		"div",
		{ class: `studio-econ-alert is-${severity}`, "data-constraint": constraint.id ?? label },
		h("span", { class: "studio-econ-alert-mark", "aria-hidden": "true" }),
		copy,
	);
}

function kpiSub(headline: EconomicsHeadline, shape: Shape, currency?: string, period?: string): string {
	if (headline.target !== undefined) {
		return t("Target {value}", { value: amount(headline.target, shape, currency, true) });
	}
	if (shape.format === "currency" && period) return t("Per {period}", { period });
	return "";
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
	const presetOf = (input: EconomicsInput) => clampTo(input, scenario?.values[input.id] ?? input.value);
	const levelOf = (input: EconomicsInput) => overrides.get(input.id) ?? presetOf(input);
	const current = () => Object.fromEntries(doc.inputs.map((input) => [input.id, levelOf(input)]));
	const inputShape = (input: EconomicsInput) => shapeFor(input.unit, currency, undefined, stepDigits(input.step));
	const shown = (input: EconomicsInput) => amount(levelOf(input), inputShape(input), currency);
	const unitOf = (id: string) => (doc.computed.find((formula) => formula.id === id) ?? inputs.get(id))?.unit;
	const headlineShape = (headline: EconomicsHeadline) =>
		shapeFor(headline.unit ?? unitOf(headline.id), currency, headline.format);
	const kpiText = (headline: EconomicsHeadline, values: EconomicsEvaluation["values"]) =>
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

	const leverOf = (input: EconomicsInput): HTMLElement => {
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
			const tick = h("span", { class: "studio-econ-tick-mark", "aria-hidden": "true" });
			tick.style.setProperty("--at", share(input, mark.value));
			return tick;
		});
		const chips = marks.map((mark) =>
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
				h("b", null, amount(mark.value, shape, currency)),
			),
		);
		levers.set(input.id, { range, output, chips });
		const top = h(
			"div",
			{ class: "studio-econ-lever-top" },
			h("label", { for: id, class: "studio-econ-lever-label" }, input.label),
			tierBadge(input.tier, input.source),
			output,
		);
		const track = h(
			"div",
			{ class: "studio-econ-track" },
			range,
			ticks.length ? h("div", { class: "studio-econ-ticks" }, ticks) : null,
		);
		const markList = chips.length
			? h("div", { class: "studio-econ-marks", role: "group", "aria-label": t("Market references") }, chips)
			: null;
		return h(
			"div",
			{ class: "studio-econ-lever", "data-input": input.id },
			top,
			track,
			markList,
			input.note ? h("p", { class: "studio-econ-note" }, input.note) : null,
		);
	};

	const groups = new Map<string, EconomicsInput[]>();
	for (const input of doc.inputs) {
		const key = input.group ?? "";
		groups.set(key, [...(groups.get(key) ?? []), input]);
	}
	const leverColumn = h(
		"div",
		{ class: "studio-econ-levers" },
		[...groups].map(([group, items]) =>
			h(
				"div",
				{ class: "studio-econ-group" },
				h("h4", { class: "studio-econ-group-head" }, group || t("Levers")),
				items.map(leverOf),
			),
		),
	);

	const basePill = h(
		"button",
		{
			type: "button",
			class: "studio-econ-scenario is-base",
			onclick: () => pickScenario(undefined),
		},
		t("Base"),
	);
	const scenarioPills = (doc.scenarios ?? []).map((item) =>
		h(
			"button",
			{
				type: "button",
				class: "studio-econ-scenario",
				"data-scenario": item.id,
				onclick: () => pickScenario(item),
			},
			item.name,
		),
	);
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
	const alerts = h("div", { class: "studio-econ-alerts", "aria-live": "polite" });
	const kpis = (doc.headlines ?? []).map((headline): Kpi => {
		const value = h("strong", { class: "studio-econ-kpi-value" });
		const sub = h("span", { class: "studio-econ-kpi-sub" });
		const el = h(
			"div",
			{
				class: `studio-econ-kpi${headline.emphasis === "primary" ? " is-primary" : ""}`,
				"data-headline": headline.id,
			},
			h("span", { class: "studio-econ-kpi-label" }, headline.label),
			value,
			sub,
		);
		return { headline, el, value, sub };
	});

	const waterfallSlot = h("div", { class: "studio-econ-chart-body" });
	const curveSlot = h("div", { class: "studio-econ-chart-body" });
	const curveNoteSlot = h("div", { class: "studio-econ-chart-foot" });
	const xInput = doc.curve ? inputs.get(doc.curve.xInput) : undefined;
	const xShape = xInput ? inputShape(xInput) : shapeFor();
	const yShape = doc.curve ? shapeFor(unitOf(doc.curve.yOutput) ?? currency, currency) : moneyShape;
	const look: CurveLook = {
		xText: (value) => amount(value, xShape, currency, true),
		yText: (value) => amount(value, yShape, currency, true),
		xTitle: xInput?.label ?? "",
		capacityLabel: doc.curve?.capacityLabel ?? t("Capacity ceiling"),
		zeroLine: doc.curve?.zeroLine !== false,
	};
	const waterfallFigure = doc.waterfall?.length
		? h(
				"figure",
				{ class: "studio-econ-chart is-waterfall" },
				h(
					"figcaption",
					null,
					h("strong", null, t("Where the money goes")),
					doc.period ? h("span", null, t("Per {period}", { period: doc.period })) : null,
				),
				waterfallSlot,
			)
		: null;
	const curveFigure =
		doc.curve && xInput
			? h(
					"figure",
					{ class: "studio-econ-chart is-curve" },
					h(
						"figcaption",
						null,
						h("strong", null, doc.curve.label ?? t("Break-even & capacity")),
						doc.curve.yLabel ? h("span", null, doc.curve.yLabel) : null,
					),
					curveSlot,
					curveNoteSlot,
				)
			: null;
	const charts = [waterfallFigure, curveFigure].filter((chart): chart is HTMLElement => chart !== null);

	const compose = () => {
		const evaluation = evaluateEconomicsModel(doc, current());
		const leverText = doc.inputs.map((input) => `${input.label} ${shown(input)}`).join(", ");
		const results = (doc.headlines ?? []).map((item) => `${item.label} ${kpiText(item, evaluation.values)}`);
		const triggered = evaluation.constraints
			.filter((status) => status.triggered)
			.map((status) => `${status.constraint.label} (${status.constraint.message})`)
			.join("; ");
		const lines = [
			t("Challenge these numbers in {title}.", { title: doc.title ?? heading }),
			scenario ? t("Scenario: {name}.", { name: scenario.name }) : "",
			t("Levers: {levers}.", { levers: leverText }),
			results.length ? t("Results: {results}.", { results: results.join(", ") }) : "",
			triggered ? t("Triggered constraints: {constraints}.", { constraints: triggered }) : "",
			t(
				"Pressure-test the weakest assumptions against real benchmarks, name what breaks first, and propose a structural fix.",
			),
		];
		return { prompt: lines.filter(Boolean).join("\n"), title: t("Challenge the numbers") };
	};
	const challenge = askButton(ctx, t("Challenge these numbers"), compose, "is-primary");

	function refresh(): void {
		const values = current();
		const evaluation = evaluateEconomicsModel(doc, values);
		for (const input of doc.inputs) {
			const lever = levers.get(input.id);
			const value = values[input.id];
			if (!lever || value === undefined) continue;
			if (Number(lever.range.value) !== value) lever.range.value = String(value);
			lever.range.style.setProperty("--fill", share(input, value));
			const text = shown(input);
			lever.output.textContent = text;
			lever.range.setAttribute("aria-valuetext", text);
			for (const chip of lever.chips) chip.classList.toggle("is-on", Number(chip.dataset.value) === value);
		}
		basePill.classList.toggle("is-on", scenario === undefined);
		basePill.setAttribute("aria-pressed", String(scenario === undefined));
		for (const pill of scenarioPills) {
			const on = pill.dataset.scenario === scenario?.id;
			pill.classList.toggle("is-on", on);
			pill.setAttribute("aria-pressed", String(on));
		}
		thesis.textContent = scenario?.thesis ?? "";
		thesis.hidden = !scenario?.thesis;
		reset.hidden = overrides.size === 0;

		const triggered = evaluation.constraints.filter((status) => status.triggered);
		const fatal = triggered.filter((status) => status.constraint.severity === "fatal");
		const warnings = triggered.filter((status) => status.constraint.severity === "warning");
		const verdict =
			fatal.length === 0 && doc.verdict
				? h("div", { class: "studio-econ-verdict" }, kicker(t("Verdict")), h("p", null, doc.verdict))
				: null;
		const holds =
			evaluation.constraints.length > 0 && triggered.length === 0
				? h("p", { class: "studio-econ-holds" }, t("Every hard constraint holds."))
				: null;
		const callouts = [...fatal, ...warnings].map(constraintCallout);
		const extras = [verdict, holds].filter((note) => note !== null);
		alerts.replaceChildren(...callouts, ...extras);

		for (const kpi of kpis) {
			const value = evaluation.values[kpi.headline.id] ?? null;
			const shape = headlineShape(kpi.headline);
			const negative = value !== null && value < 0 && kpi.headline.toneWhenNegative === "danger";
			const target = kpi.headline.target;
			kpi.el.classList.toggle("is-negative", negative);
			kpi.el.classList.toggle("is-short", value !== null && target !== undefined && value < target);
			kpi.value.textContent = amount(value, shape, currency, true);
			kpi.sub.textContent = kpiSub(kpi.headline, shape, currency, doc.period);
		}

		if (doc.waterfall?.length) {
			const bars = waterfallBars(doc, evaluation.values);
			waterfallSlot.replaceChildren(waterfallSvg(bars, money));
		}
		if (curveFigure) {
			const curve = evaluateEconomicsCurve(doc, values);
			const svg = curve ? curveSvg(curve, look) : null;
			curveSlot.replaceChildren(svg ?? curveMissing());
			const note = curve ? curveNote(curve, look.xText) : null;
			curveNoteSlot.replaceChildren(...(note ? [note] : []));
		}
		memory?.set({ scenario: scenario?.id ?? null, overrides: Object.fromEntries(overrides) });
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
	const scenarioAttrs = { class: "studio-econ-scenarios", role: "group", "aria-label": t("Scenarios") };
	const scenarioGroup = scenarioPills.length ? h("div", scenarioAttrs, basePill, scenarioPills) : null;
	const head = h(
		"div",
		{ class: "studio-econ-head" },
		title,
		h("div", { class: "studio-econ-switch" }, scenarioGroup, reset),
	);
	const kpiStrip = kpis.length
		? h(
				"div",
				{ class: "studio-econ-kpis" },
				kpis.map((kpi) => kpi.el),
			)
		: null;
	const canvas = h(
		"div",
		{ class: `studio-econ-canvas${charts.length ? "" : " is-single"}` },
		leverColumn,
		charts.length ? h("div", { class: "studio-econ-charts" }, charts) : null,
	);
	const section = h(
		"section",
		{ class: "studio-section studio-econ", "data-block": "economics" },
		sectionHead(heading, changed),
		head,
		thesis,
		alerts,
		kpiStrip,
		canvas,
		challenge ? h("div", { class: "studio-strategy-foot" }, challenge) : null,
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
