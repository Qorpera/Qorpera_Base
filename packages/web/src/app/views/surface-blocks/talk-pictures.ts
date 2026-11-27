import {
	type SurfaceTalkPicture,
	type SurfaceTalkTone,
	type SurfaceTalkVersusSide,
	surfaceColorContrast,
	surfaceColorHex,
} from "@qorpera/contracts";
import { h } from "../../../ui/dom.ts";
import { presentationLocale } from "../../../ui/preferences.ts";
import { svgEl } from "./strategy-kit.ts";

export interface TalkTone {
	readonly f: string;
	readonly a: string;
	readonly b: string;
	readonly t: string;
	readonly m: string;
	readonly oa: string;
	readonly ob: string;
}

export type TalkTones = Readonly<Record<SurfaceTalkTone, TalkTone>>;
export type TalkArt = (src: string, alt: string) => HTMLElement | null;

const WHITE = "#ffffff";
const BLACK = "#000000";
const QUIET_MAIN = "#5f6670";
const SPLIT_SHADES = 6;

function mix(from: string, toward: string, amount: number): string {
	const channel = (hex: string, at: number) => Number.parseInt(hex.slice(1 + at * 2, 3 + at * 2), 16);
	return `#${[0, 1, 2]
		.map((at) =>
			Math.round(channel(from, at) + (channel(toward, at) - channel(from, at)) * amount)
				.toString(16)
				.padStart(2, "0"),
		)
		.join("")}`;
}

function readable(colour: string, ground: string, toward: string, least: number): string {
	let out = colour;
	for (let step = 0; step < 8 && (surfaceColorContrast(out, ground) ?? 21) < least; step += 1)
		out = mix(out, toward, 0.2);
	return out;
}

export function talkTones(mainColour: string | undefined): TalkTones {
	const main = surfaceColorHex(mainColour ?? "") ?? QUIET_MAIN;
	const ink = mix(main, BLACK, 0.82);
	const tint = mix(main, WHITE, 0.9);
	const soft = mix(main, WHITE, 0.6);
	const on = (ground: string) =>
		(surfaceColorContrast(WHITE, ground) ?? 21) >= (surfaceColorContrast(ink, ground) ?? 0) ? WHITE : ink;
	const strong = readable(main, tint, BLACK, 3);
	const lifted = readable(main, ink, WHITE, 2);
	const darkBrand = on(main) === WHITE;
	return {
		paper: { f: "#f6f5f2", a: ink, b: strong, t: ink, m: "#77726a", oa: "#f6f5f2", ob: on(strong) },
		tint: { f: tint, a: strong, b: soft, t: ink, m: mix(ink, tint, 0.4), oa: on(strong), ob: ink },
		deep: { f: ink, a: soft, b: lifted, t: tint, m: mix(soft, ink, 0.25), oa: ink, ob: on(lifted) },
		brand: darkBrand
			? { f: main, a: tint, b: soft, t: WHITE, m: mix(WHITE, main, 0.22), oa: ink, ob: ink }
			: { f: main, a: ink, b: mix(ink, main, 0.4), t: ink, m: mix(ink, main, 0.3), oa: tint, ob: tint },
		stone: { f: "#ece9e4", a: ink, b: strong, t: ink, m: "#6b665d", oa: tint, ob: on(strong) },
	};
}

function part(className: string, ...children: (Node | string | null)[]): HTMLElement {
	return h("div", { class: className }, ...children);
}

function moving<E extends HTMLElement | SVGElement>(node: E, kind: string, delay: number): E {
	node.classList.add("tkp-an", `is-${kind}`);
	node.style.setProperty("--d", `${delay.toFixed(2)}s`);
	return node;
}

function amount(value: number, unit: string): string {
	const text = new Intl.NumberFormat(presentationLocale() === "da" ? "da-DK" : "en-US", {
		maximumFractionDigits: 2,
	}).format(value);
	if (unit === "") return text;
	return unit === "%" ? `${text}%` : `${text} ${unit}`;
}

function percentOf(share: number): string {
	return `${(Math.min(1, Math.max(0, share)) * 100).toFixed(2)}%`;
}

function versusSide(side: SurfaceTalkVersusSide, className: string, delay: number): HTMLElement {
	return moving(
		part(
			`tkp-vside ${className}`,
			part("tkp-vtitle", side.title),
			side.big ? part("tkp-vbig", side.big) : null,
			...side.lines.map((line) => part("tkp-vline", line)),
		),
		"rise",
		delay,
	);
}

function body(picture: Exclude<SurfaceTalkPicture, { kind: "art" }>): (HTMLElement | null)[] {
	switch (picture.kind) {
		case "title":
			return [
				moving(part("tkp-kick", picture.kicker), "fade", 0.1),
				moving(part("tkp-title", picture.title), "rise", 0.25),
				picture.sub ? moving(part("tkp-sub", picture.sub), "fade", 0.9) : null,
			];
		case "statement":
			return [
				moving(part("tkp-text", picture.text), "rise", 0.2),
				picture.sub ? moving(part("tkp-textsub", picture.sub), "fade", 1) : null,
			];
		case "quote":
			return [
				moving(part("tkp-qmark", "“"), "fade", 0.1),
				moving(part("tkp-qtext", picture.text), "rise", 0.3),
				moving(part("tkp-qby", picture.by), "fade", 1.1),
			];
		case "number": {
			const length = picture.value.length + (picture.unit ? picture.unit.length * 0.45 + 0.3 : 0);
			const row = moving(
				part(
					"tkp-nrow",
					h("span", null, picture.value),
					picture.unit ? h("span", { class: "tkp-nunit" }, picture.unit) : null,
				),
				"pop",
				0.2,
			);
			row.style.fontSize = `${Math.min(21, 66 / Math.max(length, 1) / 0.58).toFixed(2)}em`;
			return [
				row,
				moving(part("tkp-nlabel", picture.label), "rise", 0.8),
				picture.sub ? moving(part("tkp-nsub", picture.sub), "fade", 1.3) : null,
			];
		}
		case "bars": {
			const reach = Math.max(picture.max ?? 0, picture.line?.value ?? 0, ...picture.items.map((item) => item.value));
			const top = (picture.max === undefined ? reach * 1.06 : reach) || 1;
			const count = picture.items.length;
			const bars = part(
				`tkp-bars${picture.line ? " has-line" : ""}`,
				...picture.items.map((item, at) => {
					const bar = moving(
						h("span", { class: `tkp-bar${item.dim ? " is-dim" : ""}` }),
						"growx",
						0.3 + at * 0.12,
					);
					bar.style.width = percentOf(item.value / top);
					return part(
						"tkp-brow",
						h("span", { class: "tkp-blabel" }, item.label),
						h("span", { class: "tkp-btrack" }, bar),
						moving(
							h("span", { class: "tkp-bval" }, item.show ?? amount(item.value, picture.unit)),
							"fade",
							1 + at * 0.12,
						),
					);
				}),
			);
			bars.style.setProperty("--bh", `${count > 7 ? 2.3 : count > 5 ? 3 : count > 3 ? 3.8 : 5}em`);
			if (picture.line) {
				const share = picture.line.value / top;
				const line = moving(
					part(
						`tkp-bline${share > 0.55 ? " is-flip" : ""}`,
						h("span", null, `${picture.line.label} ${amount(picture.line.value, picture.unit)}`),
					),
					"fade",
					1.2 + count * 0.12,
				);
				line.style.setProperty("--p", Math.min(1, Math.max(0, share)).toFixed(4));
				bars.append(line);
			}
			return [picture.title ? moving(part("tkp-btitle", picture.title), "fade", 0.1) : null, bars];
		}
		case "split": {
			const shade = (at: number) => `is-shade-${at % SPLIT_SHADES}`;
			return [
				moving(
					part(
						"tkp-sphead",
						h("span", null, picture.title ?? ""),
						h("b", null, amount(picture.total, picture.unit)),
					),
					"fade",
					0.1,
				),
				part(
					"tkp-spbar",
					...picture.parts.map((item, at) => {
						const piece = moving(
							h(
								"span",
								{ class: `tkp-sppart ${shade(at)}` },
								item.value / picture.total >= 0.2
									? h("i", null, h("b", null, item.label), amount(item.value, picture.unit))
									: null,
							),
							"growx",
							0.3 + at * 0.25,
						);
						piece.style.flex = `${item.value} 0 0`;
						return piece;
					}),
				),
				part(
					"tkp-splegend",
					...picture.parts.map((item, at) =>
						moving(
							h(
								"span",
								null,
								h("i", { class: shade(at) }),
								h("b", null, item.label),
								h("em", null, amount(item.value, picture.unit)),
							),
							"fade",
							1.2 + at * 0.15,
						),
					),
				),
			];
		}
		case "ring": {
			const drawn = Math.max(picture.percent, picture.percent > 0 ? 0.9 : 0);
			const size = picture.big.length > 5 ? 12.5 : picture.big.length > 3 ? 16 : 20;
			const arc = moving(
				svgEl("circle", {
					class: "tkp-ring-arc",
					cx: 50,
					cy: 50,
					r: 42,
					pathLength: 100,
					"stroke-dasharray": `${drawn} 100`,
					transform: "rotate(-90 50 50)",
				}),
				"arc",
				0.3,
			);
			return [
				part(
					"tkp-ring",
					svgEl(
						"svg",
						{ class: "tkp-ring-svg", viewBox: "0 0 100 100", role: "img", "aria-label": picture.big },
						svgEl("circle", { class: "tkp-ring-track", cx: 50, cy: 50, r: 42 }),
						arc,
						svgEl(
							"text",
							{
								class: "tkp-ring-big",
								x: 50,
								y: 51,
								"text-anchor": "middle",
								"dominant-baseline": "central",
								"font-size": size,
							},
							picture.big,
						),
					),
					part(
						"",
						moving(part("tkp-rlabel", picture.label), "rise", 0.9),
						picture.sub ? moving(part("tkp-rsub", picture.sub), "fade", 1.4) : null,
					),
				),
			];
		}
		case "meter": {
			const pass = (picture.pass.value / picture.max) * 100;
			const stop = (picture.stop.value / picture.max) * 100;
			const good = picture.higherIsBetter ? [pass, 100] : [0, pass];
			const bad = picture.higherIsBetter ? [0, stop] : [stop, 100];
			const band = (className: string, [from, to]: number[], delay: number) => {
				const span = moving(h("span", { class: className }), "fade", delay);
				span.style.left = `${(from ?? 0).toFixed(2)}%`;
				span.style.width = `${((to ?? 0) - (from ?? 0)).toFixed(2)}%`;
				return span;
			};
			const mark = (className: string, at: number, value: number, label: string, delay: number) => {
				const edge = at < 14 ? " at-l" : at > 86 ? " at-r" : "";
				const node = moving(
					part(`tkp-mmark ${className}${edge}`, h("b", null, amount(value, picture.unit)), h("span", null, label)),
					"fade",
					delay,
				);
				node.style.left = `${at.toFixed(2)}%`;
				return node;
			};
			return [
				moving(part("tkp-mtitle", picture.title), "fade", 0.1),
				part(
					"tkp-mwrap",
					part("tkp-mtrack", band("tkp-mbad", bad, 0.5), band("tkp-mgood", good, 0.9)),
					mark("is-pass", pass, picture.pass.value, picture.pass.label, 1.2),
					picture.stop.value !== picture.pass.value
						? mark("is-stop", stop, picture.stop.value, picture.stop.label, 1.7)
						: null,
				),
			];
		}
		case "versus":
			return [
				part("tkp-vrow", versusSide(picture.left, "is-l", 0.2), versusSide(picture.right, "is-r", 0.75)),
				picture.verdict ? moving(part("tkp-verdict", picture.verdict), "fade", 1.6) : null,
			];
		case "steps":
			return [
				part(
					"tkp-strow",
					...picture.items.flatMap((item, at) => [
						at > 0 ? moving(h("span", { class: "tkp-starrow" }, "→"), "fade", 0.05 + at * 0.5) : null,
						moving(
							part(
								`tkp-stbox is-${item.state}`,
								h("b", null, item.title),
								...item.lines.map((line) => h("span", null, line)),
							),
							"pop",
							0.2 + at * 0.5,
						),
					]),
				),
			];
		case "marks": {
			const count = picture.items.length;
			const list = part(
				"tkp-marks",
				...picture.items.map((item, at) =>
					moving(
						part(
							"tkp-mrow",
							h("i", { class: `tkp-dot is-${item.mark}` }),
							h("b", null, item.label),
							h("span", null, item.note ?? ""),
						),
						"rise",
						0.25 + at * 0.22,
					),
				),
			);
			list.style.fontSize = `${count > 5 ? 0.78 : count > 4 ? 0.9 : 1}em`;
			return [picture.title ? moving(part("tkp-btitle", picture.title), "fade", 0.1) : null, list];
		}
		case "matrix": {
			const grid = part(
				"tkp-matrix",
				part("tkp-xrow", h("span"), ...picture.cols.map((name) => h("span", { class: "tkp-xcol" }, name))),
				...picture.rows.map((row, at) =>
					moving(
						part(
							`tkp-xrow${row.us ? " is-us" : ""}`,
							h("b", null, row.label),
							...row.cells.map((cell) =>
								h("span", { class: "tkp-xcell" }, h("i", { class: `tkp-dot is-${cell}` })),
							),
						),
						"rise",
						0.3 + at * 0.25,
					),
				),
			);
			grid.style.setProperty("--n", String(picture.cols.length));
			return [grid];
		}
		case "open":
			return [
				part(
					"tkp-open",
					...picture.items.map((item, at) =>
						moving(
							part("tkp-oitem", h("i"), h("b", null, item.label), h("span", null, item.needs)),
							"pop",
							0.2 + at * 0.4,
						),
					),
				),
			];
		case "timeline": {
			const line = part(
				"tkp-timeline",
				moving(part("tkp-tline"), "growx", 0.2),
				...picture.items.map((item, at) =>
					moving(
						part("tkp-tpoint", h("b", null, item.when), h("i"), h("span", null, item.label)),
						"rise",
						0.5 + at * 0.35,
					),
				),
			);
			line.style.setProperty("--n", String(picture.items.length));
			return [line];
		}
	}
}

export function drawTalkPicture(
	picture: SurfaceTalkPicture,
	tones: TalkTones,
	talkTone: SurfaceTalkTone,
	art: TalkArt,
): HTMLElement {
	const tone = tones[picture.tone ?? talkTone];
	const inner =
		picture.kind === "art"
			? part("tkp-in is-art", art(picture.src, picture.alt) ?? part("tkp-artless", picture.alt))
			: part("tkp-in", ...body(picture));
	for (const [name, value] of Object.entries(tone)) inner.style.setProperty(`--${name}`, value);
	return part("tkp", inner);
}
