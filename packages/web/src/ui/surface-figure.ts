import { h } from "./dom.ts";
import { phrase } from "./preferences.ts";

type Eye = readonly [x: number, y: number, width: number, height: number, turn: number];

const FIGURE_EYES = {
	browser: [
		[51.7, 62.77, 6, 14.7, -12],
		[64.3, 61.23, 6, 14.7, -12],
	],
	pointer: [
		[31.64, 51.66, 5.1, 12.5, -12],
		[42.36, 50.34, 5.1, 12.5, -12],
	],
	phone: [
		[49.43, 50.68, 5.31, 13, -12],
		[60.57, 49.32, 5.31, 13, -12],
	],
	monitor: [
		[50.7, 42.77, 6, 14.7, -12],
		[63.3, 41.23, 6, 14.7, -12],
	],
	can: [
		[52.64, 44.66, 5.1, 12.5, -12],
		[63.36, 43.34, 5.1, 12.5, -12],
	],
	bars: [
		[74.5, 40.55, 4.29, 10.5, -12],
		[83.5, 39.45, 4.29, 10.5, -12],
	],
	seal: [
		[49.7, 52.77, 6, 14.7, -12],
		[62.3, 51.23, 6, 14.7, -12],
	],
	palette: [
		[57.7, 52.77, 6, 14.7, -12],
		[70.3, 51.23, 6, 14.7, -12],
	],
	parcel: [
		[55.7, 60.77, 6, 14.7, -12],
		[68.3, 59.23, 6, 14.7, -12],
	],
	book: [
		[49.7, 52.77, 6, 14.7, -12],
		[62.3, 51.23, 6, 14.7, -12],
	],
	envelope: [
		[60.85, 70.63, 4.9, 12, -12],
		[71.15, 69.37, 4.9, 12, -12],
	],
	money: [
		[60.43, 67.68, 5.31, 13, -12],
		[71.57, 66.32, 5.31, 13, -12],
	],
	people: [
		[59.07, 41.61, 4.69, 11.5, -12],
		[68.93, 40.39, 4.69, 11.5, -12],
	],
	folder: [
		[51.7, 68.77, 6, 14.7, -12],
		[64.3, 67.23, 6, 14.7, -12],
	],
	gem: [
		[49.64, 50.66, 5.1, 12.5, -12],
		[60.36, 49.34, 5.1, 12.5, -12],
	],
	shop: [
		[55.43, 66.68, 5.31, 13, -12],
		[66.57, 65.32, 5.31, 13, -12],
	],
	postbox: [
		[51.7, 63.77, 6, 14.7, -12],
		[64.3, 62.23, 6, 14.7, -12],
	],
	piggy: [
		[60.64, 50.66, 5.1, 12.5, -12],
		[71.36, 49.34, 5.1, 12.5, -12],
	],
	cabinet: [
		[49.85, 29.63, 4.9, 12, -12],
		[60.15, 28.37, 4.9, 12, -12],
	],
	house: [
		[56.43, 72.68, 5.31, 13, -12],
		[67.57, 71.32, 5.31, 13, -12],
	],
	lighthouse: [
		[47.64, 65.66, 5.1, 12.5, -12],
		[58.36, 64.34, 5.1, 12.5, -12],
	],
	jar: [
		[51.7, 60.77, 6, 14.7, -12],
		[64.3, 59.23, 6, 14.7, -12],
	],
	headband: [
		[54.5, 72.55, 4.29, 10.5, -12],
		[63.5, 71.45, 4.29, 10.5, -12],
	],
	sofa: [
		[50.43, 40.68, 5.31, 13, -12],
		[61.57, 39.32, 5.31, 13, -12],
	],
	mug: [
		[55.7, 52.77, 6, 14.7, -12],
		[68.3, 51.23, 6, 14.7, -12],
	],
	lamp: [
		[49.7, 38.77, 6, 14.7, -12],
		[62.3, 37.23, 6, 14.7, -12],
	],
} as const satisfies Record<string, readonly Eye[]>;

export type SurfaceFigureId = keyof typeof FIGURE_EYES;

export const SURFACE_FIGURE_IDS = Object.keys(FIGURE_EYES) as readonly SurfaceFigureId[];

export const SURFACE_FIGURE_NAMES: Readonly<Record<SurfaceFigureId, string>> = {
	browser: phrase("Browser window"),
	pointer: phrase("Pointer"),
	phone: phrase("Phone"),
	monitor: phrase("Screen"),
	can: phrase("Database"),
	bars: phrase("Bar chart"),
	seal: phrase("Wax seal"),
	palette: phrase("Paint palette"),
	parcel: phrase("Parcel"),
	book: phrase("Book"),
	envelope: phrase("Envelope"),
	money: phrase("Money"),
	people: phrase("People"),
	folder: phrase("Folder"),
	gem: phrase("Gem"),
	shop: phrase("Shop"),
	postbox: phrase("Post box"),
	piggy: phrase("Piggy bank"),
	cabinet: phrase("Cabinet"),
	house: phrase("House"),
	lighthouse: phrase("Lighthouse"),
	jar: phrase("Jar"),
	headband: phrase("Headband"),
	sofa: phrase("Sofa"),
	mug: phrase("Mug"),
	lamp: phrase("Lamp"),
};

const FIGURE_ICON = "figure:";

export function surfaceFigureIcon(figure: SurfaceFigureId): string {
	return `${FIGURE_ICON}${figure}`;
}

export function surfaceFigureFromIcon(icon: string | null | undefined): SurfaceFigureId | undefined {
	if (!icon?.startsWith(FIGURE_ICON)) return undefined;
	const id = icon.slice(FIGURE_ICON.length);
	return Object.hasOwn(FIGURE_EYES, id) ? (id as SurfaceFigureId) : undefined;
}

export type SurfaceFigureState = "rest" | "working" | "attention";

function phase(figure: string): number {
	let hash = 0;
	for (const char of figure) hash = (hash * 31 + char.charCodeAt(0)) | 0;
	return Math.abs(hash % 6000) / 1000;
}

export function surfaceFigure(figure: SurfaceFigureId, state: SurfaceFigureState = "rest"): HTMLElement {
	const image = h("img", {
		class: "surface-figure-art",
		alt: "",
		draggable: "false",
		decoding: "async",
		src: new URL(`./assets/surfaces/figures-v1/${figure}.png`, document.baseURI).href,
	});
	const eyes = h(
		"span",
		{ class: "surface-figure-eyes" },
		FIGURE_EYES[figure].map(([x, y, width, height, turn]) => {
			const eye = h("span", { class: "surface-figure-eye" }, h("i"));
			eye.style.left = `${x}%`;
			eye.style.top = `${y}%`;
			eye.style.width = `${width}%`;
			eye.style.height = `${height}%`;
			eye.style.setProperty("--turn", `${turn}deg`);
			return eye;
		}),
	);
	const element = h(
		"span",
		{ class: `surface-figure is-${state}`, "data-figure": figure, "aria-hidden": "true" },
		h("span", { class: "surface-figure-body" }, image, eyes),
		state === "attention" ? h("span", { class: "surface-figure-ask" }, "!") : null,
	);
	element.style.setProperty("--figure-phase", `-${phase(figure).toFixed(2)}s`);
	return element;
}
