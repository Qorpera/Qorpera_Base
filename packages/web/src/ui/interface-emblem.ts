/* An interface's emblem (RUNTIME-INTERFACES.md §3): one solid shape with cuts. Every emblem is black or white,
 * against the member's theme (Jonas, 9 November 2026: simpler interfaces): the solid parts take the text colour, from
 * `--emblem-ink` (styles/interfaces.css), and the cuts are holes, so a light theme shows black emblems and a dark one
 * white. A file's `colour` no longer tints it. The shapes are fixed here; a file only
 * names one. */

import type { AppIcon } from "@qorpera/cloud-client/app-icons";
import type { InterfaceEmblem } from "@qorpera/cloud-client/interfaces";

const NS = "http://www.w3.org/2000/svg";
/** What the ink is drawn with before the stylesheet says otherwise: the light theme's text colour. */
const INK = "#161615";

type Part = readonly [tag: string, attrs: Readonly<Record<string, string>>];

/** An emblem a file may name, or the Bank page's, the Sites page's or What's new's, which only the web draws
 * (app/bank-page.ts, views/settings-sites.ts, views/whats-new.ts). */
export type Emblem = InterfaceEmblem | "bank" | "globe" | "spark" | "drawers";

/** Each emblem on a 48×48 grid: the solid parts take the ink, the cuts the page colour. */
const EMBLEMS: Readonly<Record<Emblem, readonly Part[]>> = {
	bank: [
		["path", { d: "M24 3.5 44.5 14.6a1.6 1.6 0 0 1-.8 3H4.3a1.6 1.6 0 0 1-.8-3z", fill: "solid" }],
		["circle", { cx: "24", cy: "11.6", r: "2.7", fill: "cut" }],
		["rect", { x: "7", y: "21", width: "5.5", height: "15", rx: "1.6", fill: "solid" }],
		["rect", { x: "16", y: "21", width: "5.5", height: "15", rx: "1.6", fill: "solid" }],
		["rect", { x: "26.5", y: "21", width: "5.5", height: "15", rx: "1.6", fill: "solid" }],
		["rect", { x: "35.5", y: "21", width: "5.5", height: "15", rx: "1.6", fill: "solid" }],
		["rect", { x: "3.5", y: "38.5", width: "41", height: "5.5", rx: "2.2", fill: "solid" }],
	],
	drawers: [
		["rect", { x: "6", y: "5", width: "36", height: "38", rx: "8", fill: "solid" }],
		["path", { d: "M5 18.5h38M5 30h38", stroke: "cut" }],
		["path", { d: "M20 12.2h8M20 24.2h8M20 35.8h8", stroke: "cut-thin" }],
	],
	globe: [
		["circle", { cx: "24", cy: "24", r: "20", fill: "solid" }],
		[
			"path",
			{
				d: "M4.5 24h39M24 4.5c-6 5.4-8.6 12-8.6 19.5S18 38.1 24 43.5M24 4.5c6 5.4 8.6 12 8.6 19.5S30 38.1 24 43.5",
				stroke: "cut",
			},
		],
	],
	// What's new: a big spark and a small one, the small one top left, clear of the drawer's badge.
	spark: [
		["path", { d: "M28 9.5Q31.4 23.6 45.5 27Q31.4 30.4 28 44.5Q24.6 30.4 10.5 27Q24.6 23.6 28 9.5z", fill: "solid" }],
		["path", { d: "M11 3Q12.7 9.3 19 11Q12.7 12.7 11 19Q9.3 12.7 3 11Q9.3 9.3 11 3z", fill: "solid" }],
	],
	pulse: [
		["path", { d: "M24 4c11.6 0 20 8.2 20 19.4C44 35 35.4 44 24 44S4 35 4 23.4C4 12.2 12.4 4 24 4z", fill: "solid" }],
		["path", { d: "M9 25h7.5l3-7.5 5 14 4-10 2.5 3.5H39", stroke: "cut", class: "emblem-beat" }],
	],
	mail: [
		["rect", { x: "4", y: "10", width: "40", height: "29", rx: "6", fill: "solid" }],
		["path", { d: "m8.5 15 15.5 11.5L39.5 15", stroke: "cut" }],
	],
	members: [
		["circle", { cx: "32", cy: "15.5", r: "6.5", fill: "solid" }],
		["path", { d: "M20 40c.8-9 5.4-14 12-14s11.2 5 12 14z", fill: "solid" }],
		["circle", { cx: "18", cy: "17.5", r: "7.5", fill: "solid", stroke: "cut-thin" }],
		["path", { d: "M3.5 42c1-10 6.6-15.5 14.5-15.5S31.5 32 32.5 42z", fill: "solid", stroke: "cut-thin" }],
	],
	coin: [
		["circle", { cx: "24", cy: "24", r: "20", fill: "solid" }],
		["path", { d: "M30.5 15.5a10 10 0 1 0 0 17M13 21.5h13M13 26.5h13", stroke: "cut" }],
	],
	board: [
		["rect", { x: "4", y: "7", width: "40", height: "34", rx: "7", fill: "solid" }],
		["path", { d: "M11 14h7M11 20h7M11 26h7M21 14h6M21 20h6M30 14h7", stroke: "cut" }],
	],
	queue: [
		["path", { d: "M6 10a5 5 0 0 1 5-5h26a5 5 0 0 1 5 5v18a5 5 0 0 1-5 5H20l-9 8v-8a5 5 0 0 1-5-5z", fill: "solid" }],
		["path", { d: "M16 19h.01M24 19h.01M32 19h.01", stroke: "cut-dot" }],
	],
	calendar: [
		["rect", { x: "5", y: "8", width: "38", height: "34", rx: "7", fill: "solid" }],
		["path", { d: "M5 17h38M15 4v8M33 4v8", stroke: "cut" }],
		["path", { d: "M16 26h.01M24 26h.01M32 26h.01M16 34h.01", stroke: "cut-dot" }],
	],
	hire: [
		["circle", { cx: "20", cy: "15", r: "8", fill: "solid" }],
		["path", { d: "M4 42c1-10.5 7-16 16-16s15 5.5 16 16z", fill: "solid" }],
		["path", { d: "M38 11v12M32 17h12", stroke: "solid-line" }],
	],
	chart: [
		["rect", { x: "4", y: "6", width: "40", height: "36", rx: "7", fill: "solid" }],
		["path", { d: "M14 33V24M22 33V15M30 33V20M38 33v-6", stroke: "cut" }],
	],
	page: [
		["path", { d: "M10 4h20l10 10v26a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4z", fill: "solid" }],
		["path", { d: "M14 22h20M14 29h20M14 36h12", stroke: "cut" }],
	],
	// 12 November 2026 (design page 6gSTTCcz3D8AjBpV3GmrH6): 14 more, so the drawer's picker has 24.
	map: [
		["path", { d: "M5 10l12-4 14 4 12-4v32l-12 4-14-4-12 4z", fill: "solid" }],
		["path", { d: "M17 7v31M31 11v31", stroke: "cut-thin" }],
	],
	mountain: [
		["path", { d: "M2.5 40 18 13l7.5 12 5.5-8L45.5 40z", fill: "solid" }],
		["path", { d: "M13.5 21l4.5 3.5 4.5-3.5", stroke: "cut-thin" }],
	],
	tent: [
		["path", { d: "M24 6 4 41h40z", fill: "solid" }],
		["path", { d: "M24 23 17.5 41h13z", fill: "cut" }],
	],
	pin: [
		["path", { d: "M24 44.5S9 30.5 9 19a15 15 0 0 1 30 0c0 11.5-15 25.5-15 25.5z", fill: "solid" }],
		["circle", { cx: "24", cy: "19", r: "5.5", fill: "cut" }],
	],
	cart: [
		["path", { d: "M11 12h33l-4.5 18h-24z", fill: "solid" }],
		["path", { d: "M3.5 6h5.5l5.5 28h24", stroke: "solid-line" }],
		["circle", { cx: "18", cy: "40", r: "3.6", fill: "solid" }],
		["circle", { cx: "35", cy: "40", r: "3.6", fill: "solid" }],
		["path", { d: "M22 17v8M30 17v8", stroke: "cut-thin" }],
	],
	box: [
		["path", { d: "M24 4 43 13v22L24 44 5 35V13z", fill: "solid" }],
		["path", { d: "M5.5 13.5 24 22l18.5-8.5M24 22v21", stroke: "cut" }],
	],
	truck: [
		["rect", { x: "3", y: "10", width: "26", height: "23", rx: "3", fill: "solid" }],
		["path", { d: "M29 17h8.5l6.5 8v8H29z", fill: "solid" }],
		["path", { d: "M32.5 20.5h3.5l3.5 4.5h-7z", fill: "cut" }],
		["circle", { cx: "13", cy: "36.5", r: "5", fill: "solid", stroke: "cut-thin" }],
		["circle", { cx: "36", cy: "36.5", r: "5", fill: "solid", stroke: "cut-thin" }],
	],
	chat: [
		[
			"path",
			{ d: "M9 6h30a5 5 0 0 1 5 5v18a5 5 0 0 1-5 5H21l-9.5 8v-8H9a5 5 0 0 1-5-5V11a5 5 0 0 1 5-5z", fill: "solid" },
		],
		["path", { d: "M13.5 16h21M13.5 24h13", stroke: "cut" }],
	],
	star: [
		[
			"path",
			{
				d: "M24 3.5l6.3 13.3 14.4 1.7-10.6 9.9 2.8 14.3L24 35.6l-12.9 7.1 2.8-14.3L3.3 18.5l14.4-1.7z",
				fill: "solid",
			},
		],
	],
	heart: [
		[
			"path",
			{ d: "M24 42S4.5 30 4.5 17A9.8 9.8 0 0 1 24 13.6 9.8 9.8 0 0 1 43.5 17C43.5 30 24 42 24 42z", fill: "solid" },
		],
	],
	book: [
		["path", { d: "M5 8h13.5a5.5 5.5 0 0 1 5.5 5.5V43a4.5 4.5 0 0 0-4.5-4.5H5z", fill: "solid" }],
		["path", { d: "M43 8H29.5a5.5 5.5 0 0 0-5.5 5.5V43a4.5 4.5 0 0 1 4.5-4.5H43z", fill: "solid" }],
		["path", { d: "M10 16h8M10 23h8M30 16h8M30 23h8", stroke: "cut-thin" }],
	],
	camera: [
		["rect", { x: "3", y: "13", width: "42", height: "28", rx: "5", fill: "solid" }],
		["path", { d: "M15.5 14l3.5-7h10l3.5 7z", fill: "solid" }],
		["circle", { cx: "24", cy: "27", r: "7", stroke: "cut" }],
		["path", { d: "M37.5 19.5h.01", stroke: "cut-dot" }],
	],
	code: [
		["rect", { x: "3", y: "7", width: "42", height: "34", rx: "5", fill: "solid" }],
		["path", { d: "M17 18l-6 6 6 6M31 18l6 6-6 6M26.5 15 21.5 33", stroke: "cut" }],
	],
	rocket: [
		["path", { d: "M24 3c8.5 6.5 11.5 15.5 9.5 27h-19C12.5 18.5 15.5 9.5 24 3z", fill: "solid" }],
		["path", { d: "M14.5 23l-6 8.5v6.5l7.5-4.5zM33.5 23l6 8.5v6.5l-7.5-4.5z", fill: "solid" }],
		["path", { d: "M19.5 33.5h9L24 44z", fill: "solid" }],
		["circle", { cx: "24", cy: "17", r: "4.2", fill: "cut" }],
	],
};

/** Each drawing gets its own mask, as a mask is found by its id across the whole page. */
let masks = 0;

/** The emblem, `size` pixels square, in the theme's ink (see above). The cuts are holes, not paint: every part's cut
 * goes into one mask over the ink, so whatever the emblem sits on (a page, the rail, a tinted header) shows through
 * them and nothing outside the ink is ever drawn (Jonas, 9 November 2026: a white rim showed around one of the Members
 * emblem's two people on the page header). One mask is the same drawing as painting the parts in order, because no
 * emblem draws ink over a cut drawn before it. */
export function interfaceEmblem(emblem: Emblem | null, size: number): SVGSVGElement {
	return drawEmblem(
		EMBLEMS[emblem ?? "page"].map(([tag, attrs]) => {
			const { fill, stroke, ...shape } = attrs;
			return {
				tag,
				attrs: shape,
				fill: fill === "solid" ? "ink" : fill === "cut" ? "cut" : "none",
				stroke: stroke === "solid-line" ? "ink" : stroke ? "cut" : "none",
				width: stroke === "cut-thin" ? "2.6" : stroke === "cut-dot" ? "5.2" : "3.4",
			};
		}),
		size,
	);
}

/** An app's own icon (`@qorpera/cloud-client/app-icons`; 12 Nov 2026), drawn as an emblem is: its black parts in the
 * ink, its white parts as holes through them. */
export function appIconEmblem(icon: AppIcon, size: number): SVGSVGElement {
	return drawEmblem(
		icon.parts.map(({ tag, attrs, fill, stroke }) => {
			const { "stroke-width": width, ...shape } = attrs;
			return { tag, attrs: shape, fill, stroke, width: width ?? "3.4" };
		}),
		size,
	);
}

interface DrawnPart {
	readonly tag: string;
	readonly attrs: Readonly<Record<string, string>>;
	readonly fill: "ink" | "cut" | "none";
	readonly stroke: "ink" | "cut" | "none";
	/** The line's width, when it has one. */
	readonly width: string;
}

function drawEmblem(parts: readonly DrawnPart[], size: number): SVGSVGElement {
	const svg = document.createElementNS(NS, "svg");
	svg.setAttribute("viewBox", "0 0 48 48");
	svg.setAttribute("width", String(size));
	svg.setAttribute("height", String(size));
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("class", "interface-emblem");
	const id = `emblem-cuts-${++masks}`;
	const mask = document.createElementNS(NS, "mask");
	mask.setAttribute("id", id);
	mask.setAttribute("maskUnits", "userSpaceOnUse");
	for (const [name, value] of Object.entries({ x: "0", y: "0", width: "48", height: "48" }))
		mask.setAttribute(name, value);
	const whole = document.createElementNS(NS, "rect");
	for (const [name, value] of Object.entries({ x: "0", y: "0", width: "48", height: "48", fill: "#fff" }))
		whole.setAttribute(name, value);
	mask.append(whole);
	const ink = document.createElementNS(NS, "g");
	ink.setAttribute("mask", `url(#${id})`);
	for (const { tag, attrs, fill, stroke, width } of parts) {
		const make = () => {
			const part = document.createElementNS(NS, tag);
			for (const [name, value] of Object.entries(attrs)) part.setAttribute(name, value);
			return part;
		};
		if (fill === "ink" || stroke === "ink") {
			const part = make();
			part.setAttribute("fill", fill === "ink" ? INK : "none");
			if (fill === "ink") part.setAttribute("data-fill", "ink");
			if (stroke === "ink") lineOf(part, width, INK, "ink");
			ink.append(part);
		}
		if (fill === "cut" || stroke === "cut") {
			const hole = make();
			hole.setAttribute("fill", fill === "cut" ? "#000" : "none");
			if (stroke === "cut") lineOf(hole, width, "#000", "cut");
			mask.append(hole);
		}
	}
	const defs = document.createElementNS(NS, "defs");
	defs.append(mask);
	svg.append(defs, ink);
	return svg;
}

/** A part's line: its colour and width, with round ends and joins unless the part says otherwise. */
function lineOf(part: Element, width: string, colour: string, kind: "ink" | "cut") {
	part.setAttribute("stroke", colour);
	part.setAttribute("data-stroke", kind);
	part.setAttribute("stroke-width", width);
	if (!part.hasAttribute("stroke-linecap")) part.setAttribute("stroke-linecap", "round");
	if (!part.hasAttribute("stroke-linejoin")) part.setAttribute("stroke-linejoin", "round");
}
