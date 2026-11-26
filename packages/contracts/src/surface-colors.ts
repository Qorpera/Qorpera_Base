import {
	resolveSurfaceSource,
	SURFACE_COLORS_MAX_SERIES,
	type SurfaceChartColors,
	type SurfaceColorPreset,
	type SurfaceJsonReader,
	type SurfaceLayoutColors,
} from "./surface-layout.ts";

export interface SurfaceResolvedColors {
	readonly main: string;
	readonly compare: string;
	readonly up: string;
	readonly down: string;
	readonly series: readonly string[];
}

export const SURFACE_DARK_GROUND = "#1f2120";
export const SURFACE_DARK_MIN_CONTRAST = 3;
export const SURFACE_IDENTITY_TOKENS_PATH = "/identity/tokens.json";
export const SURFACE_OKABE_ITO = [
	"#0072b2",
	"#e69f00",
	"#009e73",
	"#cc79a7",
	"#56b4e9",
	"#d55e00",
	"#f0e442",
	"#000000",
] as const;

type Rgb = readonly [number, number, number];

interface NamedColour {
	readonly words: readonly string[];
	readonly rgb: Rgb;
}

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];
const GREY: Rgb = [160, 164, 170];
const QUIET_MAIN = "#5f6670";
const QUIET_COMPARE = "#b4b8be";
const CALM_GREYS = ["#8b9098", "#b8bcc2", "#6b7079", "#cfd2d6", "#545961", "#9ea3aa", "#dfe1e4"];
const BRIGHT = { compare: "#999999", up: "#009e73", down: "#d55e00" };
const SHADES: readonly (readonly [Rgb, number])[] = [
	[WHITE, 0.35],
	[BLACK, 0.3],
	[WHITE, 0.6],
	[BLACK, 0.5],
	[WHITE, 0.8],
	[BLACK, 0.65],
	[WHITE, 0.15],
	[BLACK, 0.15],
];

const GROUND_WORDS = ["background", "bg", "surface", "paper", "canvas", "ground", "white", "page"];
const INK_WORDS = ["ink", "text", "foreground", "fg", "black", "body"];
const MUTED_WORDS = ["muted", "subtle", "stone", "grey", "gray", "neutral", "slate", "mist"];
const UP_WORDS = ["success", "positive", "good", "green", "up", "growth", "gain"];
const DOWN_WORDS = ["danger", "error", "negative", "bad", "red", "down", "loss", "alert"];
const MAIN_WORDS = ["accent", "brand", "primary"];

function channel(text: string, scale: number): number | undefined {
	const value = text.endsWith("%") ? (Number(text.slice(0, -1)) * 255) / 100 : Number(text) * scale;
	return Number.isFinite(value) ? Math.min(255, Math.max(0, value)) : undefined;
}

function hslToRgb(hue: number, saturation: number, lightness: number): Rgb {
	const s = Math.min(1, Math.max(0, saturation));
	const l = Math.min(1, Math.max(0, lightness));
	const k = (n: number) => (n + hue / 30) % 12;
	const a = s * Math.min(l, 1 - l);
	const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
	return [f(0) * 255, f(8) * 255, f(4) * 255];
}

function parseColour(text: string): Rgb | undefined {
	const value = text.trim().toLowerCase();
	const hex = /^#([0-9a-f]{3,8})$/.exec(value)?.[1];
	if (hex !== undefined) {
		if (hex.length === 3 || hex.length === 4) {
			return [0, 1, 2].map((at) => Number.parseInt(`${hex[at]}${hex[at]}`, 16)) as unknown as Rgb;
		}
		if (hex.length === 6 || hex.length === 8) {
			return [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)) as unknown as Rgb;
		}
		return undefined;
	}
	const call = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(value);
	if (!call?.[1] || call[2] === undefined) return undefined;
	const parts = call[2]
		.split(/[\s,/]+/)
		.filter(Boolean)
		.slice(0, 3);
	if (parts.length !== 3) return undefined;
	if (call[1].startsWith("rgb")) {
		const rgb = parts.map((part) => channel(part, 1));
		return rgb.every((part) => part !== undefined) ? (rgb as unknown as Rgb) : undefined;
	}
	const [hue, saturation, lightness] = [
		Number(parts[0]?.replace(/deg$/, "")),
		Number(parts[1]?.replace(/%$/, "")),
		Number(parts[2]?.replace(/%$/, "")),
	];
	if (![hue, saturation, lightness].every(Number.isFinite)) return undefined;
	return hslToRgb(((hue % 360) + 360) % 360, saturation / 100, lightness / 100);
}

function toHex(rgb: Rgb): string {
	return `#${rgb.map((part) => Math.round(part).toString(16).padStart(2, "0")).join("")}`;
}

function mix(from: Rgb, toward: Rgb, amount: number): Rgb {
	return [0, 1, 2].map((at) => (from[at] ?? 0) + ((toward[at] ?? 0) - (from[at] ?? 0)) * amount) as unknown as Rgb;
}

function luminance(rgb: Rgb): number {
	const [r, g, b] = rgb.map((part) => {
		const value = part / 255;
		return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(a: Rgb, b: Rgb): number {
	const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

export function surfaceColorHex(colour: string): string | undefined {
	const rgb = parseColour(colour);
	return rgb ? toHex(rgb) : undefined;
}

export function surfaceColorContrast(a: string, b: string): number | undefined {
	const first = parseColour(a);
	const second = parseColour(b);
	return first && second ? contrast(first, second) : undefined;
}

function colourOf(value: unknown): Rgb | undefined {
	if (typeof value === "string") return parseColour(value);
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		if (typeof record.hex === "string") return parseColour(record.hex);
		if (typeof record.value === "string") return parseColour(record.value);
	}
	return undefined;
}

function wordsOf(name: string): string[] {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

function collect(group: unknown, prefix: readonly string[], depth: number, out: NamedColour[]): void {
	if (group === null || typeof group !== "object" || Array.isArray(group)) return;
	for (const [name, value] of Object.entries(group)) {
		const words = [...prefix, ...wordsOf(name)];
		const rgb = colourOf(value);
		if (rgb) out.push({ words, rgb });
		else if (depth < 2) collect(value, words, depth + 1, out);
	}
}

function identityColours(readJson: SurfaceJsonReader): NamedColour[] {
	for (const group of ["colors", "palette", "color"]) {
		const found = resolveSurfaceSource(`${SURFACE_IDENTITY_TOKENS_PATH}#/${group}`, readJson);
		const out: NamedColour[] = [];
		if (found.found) collect(found.value, [], 0, out);
		if (out.length > 0) return out;
	}
	return [];
}

function named(colour: NamedColour, words: readonly string[]): boolean {
	return colour.words.some((word) => words.includes(word));
}

function isGround(colour: NamedColour): boolean {
	return named(colour, GROUND_WORDS) || luminance(colour.rgb) > 0.85;
}

function isInk(colour: NamedColour): boolean {
	return named(colour, INK_WORDS) || luminance(colour.rgb) < 0.02;
}

function same(a: string, b: string): boolean {
	return surfaceColorHex(a) === surfaceColorHex(b);
}

function shadesOf(main: string, from: readonly string[]): string[] {
	const rgb = parseColour(main) ?? GREY;
	const series = [...from];
	for (const [toward, amount] of SHADES) {
		if (series.length >= SURFACE_COLORS_MAX_SERIES) break;
		const shade = toHex(mix(rgb, toward, amount));
		if (!series.some((colour) => same(colour, shade))) series.push(shade);
	}
	return series.slice(0, SURFACE_COLORS_MAX_SERIES);
}

function uniqueHexes(colours: readonly string[]): string[] {
	const out: string[] = [];
	for (const colour of colours) if (!out.some((seen) => same(seen, colour))) out.push(colour);
	return out;
}

function companyMain(identity: readonly NamedColour[]): string | undefined {
	for (const word of MAIN_WORDS) {
		const found = identity.find((colour) => colour.words.includes(word) && !isGround(colour));
		if (found && !(word === "primary" && isInk(found))) return toHex(found.rgb);
	}
	const usable = identity.find(
		(colour) => !isGround(colour) && !isInk(colour) && !named(colour, MUTED_WORDS) && !named(colour, UP_WORDS),
	);
	return usable ? toHex(usable.rgb) : undefined;
}

interface PresetColours {
	readonly main: string;
	readonly compare: string;
	readonly up: string;
	readonly down?: string;
	readonly series: readonly string[];
}

function presetColours(
	preset: SurfaceColorPreset,
	identity: readonly NamedColour[],
	mainOverride: string | undefined,
): PresetColours {
	if (preset === "bright") {
		const main = mainOverride ?? SURFACE_OKABE_ITO[0];
		return {
			main,
			...BRIGHT,
			series: uniqueHexes([main, ...SURFACE_OKABE_ITO]).slice(0, SURFACE_COLORS_MAX_SERIES),
		};
	}
	const found = companyMain(identity);
	const main = mainOverride ?? found ?? QUIET_MAIN;
	const mainRgb = parseColour(main) ?? GREY;
	if (found === undefined && mainOverride === undefined) {
		return { main, compare: QUIET_COMPARE, up: main, series: [main, ...CALM_GREYS] };
	}
	if (preset === "one-colour") {
		return {
			main,
			compare: toHex(mix(mainRgb, WHITE, 0.55)),
			up: main,
			down: toHex(mix(mainRgb, BLACK, 0.55)),
			series: shadesOf(main, [main]),
		};
	}
	if (preset === "calm") {
		return { main, compare: toHex(GREY), up: main, series: [main, ...CALM_GREYS] };
	}
	const usable = identity.filter((colour) => !isGround(colour));
	const muted = usable.find((colour) => named(colour, MUTED_WORDS) && !same(toHex(colour.rgb), main));
	const up = usable.find((colour) => named(colour, UP_WORDS));
	const down = usable.find((colour) => named(colour, DOWN_WORDS));
	return {
		main,
		compare: muted ? toHex(muted.rgb) : toHex(mix(GREY, mainRgb, 0.3)),
		up: up ? toHex(up.rgb) : main,
		...(down && { down: toHex(down.rgb) }),
		series: shadesOf(
			main,
			uniqueHexes([
				main,
				...usable.filter((colour) => !named(colour, INK_WORDS)).map((colour) => toHex(colour.rgb)),
			]),
		),
	};
}

function readColour(value: string | undefined, readJson: SurfaceJsonReader): string | undefined {
	if (value === undefined) return undefined;
	if (value.startsWith("#")) return surfaceColorHex(value);
	const found = resolveSurfaceSource(value, readJson);
	const rgb = found.found ? colourOf(found.value) : undefined;
	return rgb ? toHex(rgb) : undefined;
}

function darkestInk(identity: readonly NamedColour[], main: string): string | undefined {
	const inks = identity
		.filter((colour) => isInk(colour) && !same(toHex(colour.rgb), main))
		.sort((a, b) => luminance(a.rgb) - luminance(b.rgb));
	return inks[0] ? toHex(inks[0].rgb) : undefined;
}

export function resolveSurfaceColors(
	colors: SurfaceLayoutColors | undefined,
	readJson: SurfaceJsonReader,
): SurfaceResolvedColors {
	const identity = identityColours(readJson);
	const mainOverride = readColour(colors?.main, readJson);
	const base = presetColours(colors?.preset ?? "company", identity, mainOverride);
	const main = surfaceColorHex(base.main) ?? QUIET_MAIN;
	const compare = readColour(colors?.compare, readJson) ?? base.compare;
	const series = (colors?.series ?? [])
		.map((colour) => readColour(colour, readJson))
		.filter((colour): colour is string => colour !== undefined);
	let down = readColour(colors?.down, readJson) ?? base.down;
	if (down === undefined || same(down, main)) {
		down = darkestInk(identity, main) ?? (same(compare, main) ? undefined : compare);
	}
	return {
		main,
		compare,
		up: readColour(colors?.up, readJson) ?? base.up,
		down: down ?? toHex(mix(parseColour(main) ?? GREY, BLACK, 0.55)),
		series: series.length > 0 ? series : base.series,
	};
}

export function resolveSurfaceChartColor(
	value: string,
	colors: SurfaceResolvedColors,
	readJson: SurfaceJsonReader,
): string | undefined {
	if (value === "main" || value === "compare" || value === "up" || value === "down") return colors[value];
	const slot = /^series-([1-8])$/.exec(value)?.[1];
	if (slot !== undefined) {
		return colors.series.length > 0 ? colors.series[(Number(slot) - 1) % colors.series.length] : colors.main;
	}
	return readColour(value, readJson);
}

export function resolveSurfaceChartColors(
	chart: SurfaceChartColors | undefined,
	colors: SurfaceResolvedColors,
	readJson: SurfaceJsonReader,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(chart ?? {}).flatMap(([name, value]) => {
			const colour = resolveSurfaceChartColor(value, colors, readJson);
			return colour === undefined ? [] : [[name, colour]];
		}),
	);
}

export function liftSurfaceColorForDark(colour: string, ground = SURFACE_DARK_GROUND): string {
	const rgb = parseColour(colour);
	const groundRgb = parseColour(ground);
	if (!rgb || !groundRgb) return colour;
	for (let step = 0; step <= 20; step += 1) {
		const lifted = toHex(mix(rgb, WHITE, step / 20));
		if (contrast(parseColour(lifted) ?? WHITE, groundRgb) >= SURFACE_DARK_MIN_CONTRAST) return lifted;
	}
	return toHex(WHITE);
}

export function surfaceColorsForDark(
	colors: SurfaceResolvedColors,
	ground = SURFACE_DARK_GROUND,
): SurfaceResolvedColors {
	const lift = (colour: string) => liftSurfaceColorForDark(colour, ground);
	return {
		main: lift(colors.main),
		compare: lift(colors.compare),
		up: lift(colors.up),
		down: lift(colors.down),
		series: colors.series.map(lift),
	};
}
