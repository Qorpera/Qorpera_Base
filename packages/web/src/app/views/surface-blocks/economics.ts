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
import {
	askButton,
	currencyAmount,
	disclosure,
	panelId,
	percentAmount,
	plainNumber,
	strategyEmpty,
	svgEl,
	tierBadge,
} from "./strategy-kit.ts";

export type EconomicsView = "flow" | "curve";

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

type StreamKind = "income" | "cost" | "total" | "shortfall";

interface Stream {
	readonly id: string;
	readonly label: string;
	readonly kind: StreamKind;
	readonly size: number;
	readonly signed: number;
}

interface River {
	readonly left: readonly Stream[];
	readonly right: readonly Stream[];
	readonly revenue: number;
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

const FLOW = {
	width: 800,
	pad: 18,
	labelIn: 168,
	inBar: 178,
	barW: 10,
	spineX: 380,
	spineW: 16,
	outX: 600,
	labelOut: 622,
	spineH: 210,
	slot: 38,
	gap: 12,
	chars: 26,
} as const;
const CURVE = { width: 720, height: 300, left: 66, right: 24, top: 40, bottom: 46 } as const;
const PRIMARY_LEVERS = 3;
const MARK_LABELS = 2;

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

function fixed(value: number): string {
	return value.toFixed(1);
}

function primaryInputs(doc: EconomicsDocument): readonly EconomicsInput[] {
	const flagged = doc.inputs.filter((input) => input.primary === true).slice(0, PRIMARY_LEVERS);
	if (flagged.length > 0) return flagged;
	const lead = doc.curve ? doc.inputs.find((input) => input.id === doc.curve?.xInput) : undefined;
	const rest = doc.inputs.filter((input) => input !== lead);
	return [...(lead ? [lead] : []), ...rest].slice(0, PRIMARY_LEVERS);
}

function river(doc: EconomicsDocument, values: EconomicsEvaluation["values"]): River | null {
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
	if (net >= 0) {
		const kept: Stream = {
			id: total?.id ?? "net",
			label: total?.label ?? t("Net"),
			kind: "total",
			size: net,
			signed: net,
		};
		return { left: income, right: [...cost, kept], revenue };
	}
	const gap: Stream = { id: "shortfall", label: t("Shortfall"), kind: "shortfall", size: -net, signed: net };
	return { left: [...income, gap], right: cost, revenue };
}

function ribbon(x0: number, a0: number, x1: number, b0: number, size: number): string {
	const xm = (x0 + x1) / 2;
	const a1 = a0 + size;
	const b1 = b0 + size;
	return [
		`M${fixed(x0)} ${fixed(a0)}`,
		`C${fixed(xm)} ${fixed(a0)} ${fixed(xm)} ${fixed(b0)} ${fixed(x1)} ${fixed(b0)}`,
		`L${fixed(x1)} ${fixed(b1)}`,
		`C${fixed(xm)} ${fixed(b1)} ${fixed(xm)} ${fixed(a1)} ${fixed(x0)} ${fixed(a1)}`,
		"Z",
	].join(" ");
}

interface FlowHooks {
	readonly money: (value: number) => string;
	readonly peek: (stream: Stream | null) => void;
	readonly pin: (stream: Stream) => void;
}

function flowSvg(flow: River, hooks: FlowHooks): SVGSVGElement {
	const { width, pad, spineH, slot, gap } = FLOW;
	const largest = Math.max(
		flow.left.reduce((sum, item) => sum + item.size, 0),
		flow.right.reduce((sum, item) => sum + item.size, 0),
	);
	const scale = largest > 0 ? spineH / largest : 0;
	const thick = (stream: Stream) => Math.max(2, stream.size * scale);
	const sideHeight = (side: readonly Stream[]) =>
		side.reduce((sum, item) => sum + Math.max(thick(item), slot), 0) + gap * Math.max(0, side.length - 1);
	const span = (side: readonly Stream[]) => side.reduce((sum, item) => sum + thick(item), 0);
	const inner = Math.max(spineH, sideHeight(flow.left), sideHeight(flow.right));
	const height = inner + pad * 2;
	const spineSpan = Math.max(span(flow.left), span(flow.right));
	const spineTop = pad + (inner - spineSpan) / 2;
	const hatch = `studio-econ-hatch-${++boardSeq}`;
	const svg = svgEl("svg", {
		class: "studio-econ-svg is-flow",
		viewBox: `0 0 ${width} ${fixed(height)}`,
		role: "group",
		"aria-label": t("Where the money goes"),
	});
	svg.append(
		svgEl(
			"defs",
			{},
			svgEl(
				"pattern",
				{ id: hatch, width: 7, height: 7, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" },
				svgEl("rect", { class: "studio-econ-hatch-ground", width: 7, height: 7 }),
				svgEl("line", { class: "studio-econ-hatch", x1: 0, y1: 0, x2: 0, y2: 7 }),
			),
		),
	);
	const bands = svgEl("g", { class: "studio-econ-bands" });
	const nodes = svgEl("g", { class: "studio-econ-nodes" });
	const labels = svgEl("g", { class: "studio-econ-labels" });
	const wire = (el: SVGElement, stream: Stream) => {
		el.addEventListener("mouseenter", () => hooks.peek(stream));
		el.addEventListener("mouseleave", () => hooks.peek(null));
		el.addEventListener("focus", () => hooks.peek(stream));
		el.addEventListener("blur", () => hooks.peek(null));
		el.addEventListener("click", () => hooks.pin(stream));
		el.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			event.preventDefault();
			hooks.pin(stream);
		});
	};
	const figure = (stream: Stream) => {
		const money = hooks.money(stream.signed);
		if (stream.kind === "income" || flow.revenue <= 0) return money;
		return `${money} · ${percentAmount((stream.size / flow.revenue) * 100)}`;
	};
	const lay = (side: readonly Stream[], isLeft: boolean) => {
		let slotTop = pad + (inner - sideHeight(side)) / 2;
		let cursor = spineTop;
		for (const stream of side) {
			const size = thick(stream);
			const room = Math.max(size, slot);
			const endTop = slotTop + (room - size) / 2;
			const mid = slotTop + room / 2;
			const d = isLeft
				? ribbon(FLOW.inBar + FLOW.barW, endTop, FLOW.spineX, cursor, size)
				: ribbon(FLOW.spineX + FLOW.spineW, cursor, FLOW.outX, endTop, size);
			const words = `${stream.label} ${figure(stream)}`;
			const band = svgEl("path", {
				class: `studio-econ-band is-${stream.kind}`,
				"data-stream": stream.id,
				d,
				tabindex: 0,
				role: "button",
				"aria-label": words,
				...(stream.kind === "shortfall" ? { fill: `url(#${hatch})` } : {}),
			});
			wire(band, stream);
			bands.append(band);
			nodes.append(
				svgEl("rect", {
					class: `studio-econ-node is-${stream.kind}`,
					"data-stream": stream.id,
					x: isLeft ? FLOW.inBar : FLOW.outX,
					y: fixed(endTop),
					width: FLOW.barW,
					height: fixed(size),
					rx: 2,
				}),
			);
			const x = isLeft ? FLOW.labelIn : FLOW.labelOut;
			const anchor = isLeft ? "end" : "start";
			const label = svgEl(
				"g",
				{ class: `studio-econ-flow-label is-${stream.kind}`, "data-stream": stream.id },
				svgEl("title", {}, stream.label),
				svgEl(
					"text",
					{ class: "studio-econ-flow-name", x, y: fixed(mid - 3), "text-anchor": anchor },
					short(stream.label, FLOW.chars),
				),
				svgEl(
					"text",
					{ class: "studio-econ-flow-amount", x, y: fixed(mid + 13), "text-anchor": anchor },
					figure(stream),
				),
			);
			wire(label, stream);
			labels.append(label);
			slotTop += room + gap;
			cursor += size;
		}
	};
	lay(flow.left, true);
	lay(flow.right, false);
	const spine = svgEl("rect", {
		class: "studio-econ-spine",
		x: FLOW.spineX,
		y: fixed(spineTop),
		width: FLOW.spineW,
		height: fixed(Math.max(2, spineSpan)),
		rx: 3,
	});
	svg.append(bands, nodes, spine, labels);
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

function edgeAnchor(x: number, lo: number, hi: number): { anchor: "start" | "middle" | "end"; dx: number } {
	const at = (x - lo) / (hi - lo || 1);
	if (at > 0.72) return { anchor: "end", dx: -10 };
	if (at < 0.28) return { anchor: "start", dx: 10 };
	return { anchor: "middle", dx: 0 };
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
	const pad = (rawHi - rawLo) * 0.1 || 1;
	const lo = rawLo - pad;
	const hi = rawHi + pad;
	const sx = (x: number) => left + ((x - xMin) / (xMax - xMin || 1)) * (plotRight - left);
	const sy = (y: number) => plotBottom - ((y - lo) / (hi - lo)) * (plotBottom - top);
	const at = (x: number, y: number) => `${fixed(sx(x))} ${fixed(sy(y))}`;
	const seq = ++boardSeq;
	const zeroY = Math.min(plotBottom, Math.max(top, sy(0)));
	const above = `studio-econ-above-${seq}`;
	const below = `studio-econ-below-${seq}`;
	const svg = svgEl("svg", {
		class: "studio-econ-svg is-curve",
		viewBox: `0 0 ${width} ${height}`,
		role: "img",
		"aria-label": look.xTitle,
	});
	svg.append(
		svgEl(
			"defs",
			{},
			svgEl(
				"clipPath",
				{ id: above },
				svgEl("rect", { x: left, y: top, width: plotRight - left, height: fixed(zeroY - top) }),
			),
			svgEl(
				"clipPath",
				{ id: below },
				svgEl("rect", { x: left, y: fixed(zeroY), width: plotRight - left, height: fixed(plotBottom - zeroY) }),
			),
		),
	);
	for (let tick = 0; tick <= 4; tick += 1) {
		const value = lo + ((hi - lo) * tick) / 4;
		const y = sy(value);
		svg.append(
			svgEl("line", { class: "studio-econ-grid", x1: left, x2: plotRight, y1: fixed(y), y2: fixed(y) }),
			svgEl(
				"text",
				{ class: "studio-econ-tick", x: left - 10, y: fixed(y + 4), "text-anchor": "end" },
				look.yText(value),
			),
		);
	}
	const capacityX = curve.capacityX;
	if (capacityX !== null && capacityX < xMax) {
		const cx = sx(Math.max(capacityX, xMin));
		const place = edgeAnchor(cx, left, plotRight);
		svg.append(
			svgEl("rect", {
				class: "studio-econ-capacity",
				x: fixed(cx),
				y: top,
				width: fixed(plotRight - cx),
				height: plotBottom - top,
			}),
			svgEl("line", {
				class: "studio-econ-capacity-edge",
				x1: fixed(cx),
				x2: fixed(cx),
				y1: top - 6,
				y2: plotBottom,
			}),
			svgEl(
				"text",
				{
					class: "studio-econ-capacity-label",
					x: fixed(cx + (place.anchor === "middle" ? 0 : place.dx)),
					y: top - 14,
					"text-anchor": place.anchor === "middle" ? "middle" : place.anchor,
				},
				`${look.capacityLabel} · ${look.xText(capacityX)}`,
			),
		);
	}
	for (const run of segments(curve.points)) {
		const first = run[0]!;
		const last = run.at(-1)!;
		const line = run.map((point, index) => `${index ? "L" : "M"}${at(point.x, point.y)}`).join(" ");
		const area = `M${at(first.x, 0)} L${line.slice(1)} L${at(last.x, 0)} Z`;
		svg.append(
			svgEl("path", { class: "studio-econ-area is-profit", d: area, "clip-path": `url(#${above})` }),
			svgEl("path", { class: "studio-econ-area is-loss", d: area, "clip-path": `url(#${below})` }),
			svgEl("path", { class: "studio-econ-line", d: line }),
		);
	}
	if (look.zeroLine) {
		svg.append(
			svgEl("line", { class: "studio-econ-zero", x1: left, x2: plotRight, y1: fixed(zeroY), y2: fixed(zeroY) }),
		);
	}
	const breakEven = curve.breakEvenX;
	if (breakEven !== null) {
		const bx = sx(breakEven);
		const beyond = capacityX !== null && breakEven > capacityX;
		const place = edgeAnchor(bx, left, plotRight);
		const labelY = zeroY + 22 > plotBottom - 4 ? zeroY - 12 : zeroY + 22;
		svg.append(
			svgEl(
				"g",
				{ class: `studio-econ-breakeven${beyond ? " is-impossible" : ""}` },
				svgEl("circle", { class: "studio-econ-breakeven-ring", cx: fixed(bx), cy: fixed(zeroY), r: 9 }),
				svgEl("circle", { class: "studio-econ-breakeven-dot", cx: fixed(bx), cy: fixed(zeroY), r: 4.5 }),
				svgEl(
					"text",
					{
						class: "studio-econ-breakeven-label",
						x: fixed(bx + place.dx),
						y: fixed(labelY),
						"text-anchor": place.anchor,
					},
					t("Break-even {value}", { value: look.xText(breakEven) }),
				),
			),
		);
	}
	if (curve.currentY !== null) {
		const nx = sx(Math.min(xMax, Math.max(xMin, curve.currentX)));
		const ny = sy(curve.currentY);
		const tone = curve.currentY < 0 ? " is-negative" : "";
		svg.append(
			svgEl("line", { class: "studio-econ-now-guide", x1: fixed(nx), x2: fixed(nx), y1: fixed(ny), y2: plotBottom }),
			svgEl("circle", { class: `studio-econ-now-halo${tone}`, cx: fixed(nx), cy: fixed(ny), r: 11 }),
			svgEl("circle", { class: `studio-econ-now${tone}`, cx: fixed(nx), cy: fixed(ny), r: 5.5 }),
		);
	}
	const tickY = plotBottom + 20;
	svg.append(
		svgEl("text", { class: "studio-econ-tick", x: left, y: tickY }, look.xText(xMin)),
		svgEl("text", { class: "studio-econ-tick", x: plotRight, y: tickY, "text-anchor": "end" }, look.xText(xMax)),
		svgEl(
			"text",
			{ class: "studio-econ-axis", x: (left + plotRight) / 2, y: height - 8, "text-anchor": "middle" },
			look.xTitle,
		),
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
	let view: EconomicsView = hasFlow ? "flow" : "curve";
	if (remembered?.view === "curve" && hasCurve) view = "curve";
	if (remembered?.view === "flow" && hasFlow) view = "flow";
	let hovered: Stream | null = null;
	let pinned: string | null = null;
	let opened: string | null = null;
	let dismissed = false;
	let fatalSeen = "";
	let latest: River | null = null;

	const presetOf = (input: EconomicsInput) => clampTo(input, scenario?.values[input.id] ?? input.value);
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
		{ class: "studio-econ-levers", role: "group", "aria-label": t("Key levers") },
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

	const basePill = h(
		"button",
		{ type: "button", class: "studio-econ-scenario is-base", onclick: () => pickScenario(undefined) },
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

	const headlines = doc.headlines ?? [];
	const lead = headlines.find((item) => item.emphasis === "primary") ?? headlines[0];
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
		{ class: "studio-econ-hero" },
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
		hasFlow && hasCurve
			? (["flow", "curve"] as const).map((key) =>
					h(
						"button",
						{
							type: "button",
							class: "studio-econ-view",
							"data-view": key,
							onclick: () => {
								view = key;
								hovered = null;
								pinned = null;
								refresh();
							},
						},
						key === "flow" ? t("Money flow") : t("Break-even"),
					),
				)
			: [];
	const stage = h("div", { class: "studio-econ-stage" });
	const look: CurveLook = {
		xText: (value) => amount(value, xInput ? inputShape(xInput) : shapeFor(), currency, true),
		yText: (value) =>
			amount(
				value,
				doc.curve ? shapeFor(unitOf(doc.curve.yOutput) ?? currency, currency) : moneyShape,
				currency,
				true,
			),
		xTitle: xInput?.label ?? "",
		capacityLabel: doc.curve?.capacityLabel ?? t("Capacity ceiling"),
		zeroLine: doc.curve?.zeroLine !== false,
	};

	let values: Record<string, number> = current();
	let evaluation = evaluateEconomicsModel(doc, values);
	const peekStream = (): Stream | null => {
		if (hovered) return hovered;
		if (!pinned || !latest) return null;
		return [...latest.left, ...latest.right].find((item) => item.id === pinned) ?? null;
	};
	function paintHero(): void {
		const peek = peekStream();
		const flowEl = stage.querySelector(".studio-econ-flow");
		flowEl?.classList.toggle("is-picking", peek !== null);
		for (const el of stage.querySelectorAll<SVGElement>("[data-stream]")) {
			el.classList.toggle("is-on", el.dataset.stream === peek?.id);
		}
		for (const el of stage.querySelectorAll<SVGElement>(".studio-econ-band")) {
			el.setAttribute("aria-pressed", String(el.dataset.stream === pinned));
		}
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
	const hooks: FlowHooks = {
		money,
		peek: (stream) => {
			hovered = stream;
			paintHero();
		},
		pin: (stream) => {
			pinned = pinned === stream.id ? null : stream.id;
			paintHero();
		},
	};

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

	function paintStage(): void {
		for (const button of views) {
			const on = button.dataset.view === view;
			button.classList.toggle("is-on", on);
			button.setAttribute("aria-pressed", String(on));
		}
		if (view === "flow") {
			latest = river(doc, evaluation.values);
			stage.replaceChildren(
				latest
					? h("div", { class: "studio-econ-flow" }, flowSvg(latest, hooks))
					: h("p", { class: "studio-econ-chart-note" }, t("The flow can't be drawn from these numbers yet.")),
			);
			return;
		}
		latest = null;
		const curve = evaluateEconomicsCurve(doc, values);
		const svg = curve ? curveSvg(curve, look) : null;
		const note = curve ? curveNote(curve, look.xText) : null;
		stage.replaceChildren(h("div", { class: "studio-econ-curve" }, svg ?? curveMissing(), note));
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
		if (verdict) verdict.hidden = triggered.some((flag) => flag.severity === "fatal");

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
		paintStage();
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
	const scenarioGroup = scenarioPills.length
		? h(
				"div",
				{ class: "studio-econ-scenarios", role: "group", "aria-label": t("Scenarios") },
				basePill,
				scenarioPills,
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
		title || scenarioGroup ? h("div", { class: "studio-econ-head" }, title, scenarioGroup) : null,
		thesis,
		hero,
		flagLine,
		verdict,
		hasFlow || hasCurve ? h("div", { class: "studio-econ-board" }, viewSwitch, stage) : null,
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
