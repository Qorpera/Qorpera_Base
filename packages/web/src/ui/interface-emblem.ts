/* An interface's emblem (RUNTIME-INTERFACES.md §3): one solid shape in the interface's colour with white cuts,
 * the same two materials as the agents' figures, so an interface reads as a sibling of an agent in the rail
 * without wearing a figure. The shapes are fixed here; a file only names one. */

import type { InterfaceEmblem } from "@qorpera/cloud-client/interfaces";
import { colourNameHex } from "./avatar.ts";

const NS = "http://www.w3.org/2000/svg";
const CUT = "#ffffff";

type Part = readonly [tag: string, attrs: Readonly<Record<string, string>>];

/** An emblem a file may name, or the Bank page's or the Sites page's, which only the web draws (app/bank-page.ts,
 * views/sites-page.ts). */
export type Emblem = InterfaceEmblem | "bank" | "globe";

/** Each emblem on a 48×48 grid: the solid parts take the colour, the cuts are white. */
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
};

/** The emblem, `size` pixels square. `colour` is an agent colour name; without one the emblem is gray. */
export function interfaceEmblem(emblem: Emblem | null, colour: string | null, size: number): SVGSVGElement {
	const hue = colourNameHex(colour ?? "") ?? colourNameHex("gray") ?? "#7c7c7a";
	const svg = document.createElementNS(NS, "svg");
	svg.setAttribute("viewBox", "0 0 48 48");
	svg.setAttribute("width", String(size));
	svg.setAttribute("height", String(size));
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("class", "interface-emblem");
	for (const [tag, attrs] of EMBLEMS[emblem ?? "page"]) {
		const part = document.createElementNS(NS, tag);
		for (const [name, value] of Object.entries(attrs)) {
			if (name === "fill") part.setAttribute("fill", value === "solid" ? hue : CUT);
			else if (name === "stroke") {
				part.setAttribute("stroke", value === "solid-line" ? hue : CUT);
				part.setAttribute("stroke-width", value === "cut-thin" ? "2.6" : value === "cut-dot" ? "5.2" : "3.4");
				part.setAttribute("stroke-linecap", "round");
				part.setAttribute("stroke-linejoin", "round");
				if (!("fill" in attrs)) part.setAttribute("fill", "none");
			} else part.setAttribute(name, value);
		}
		svg.append(part);
	}
	return svg;
}
