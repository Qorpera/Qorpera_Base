import { isInterfaceName } from "./interfaces.ts";

/* An app's own icons (Jonas, 12 November 2026: "change the icons of the interfaces and have a generate icon button too
 * for them to create a new custom one based on it's name or contents"; design page 6gSTTCcz3D8AjBpV3GmrH6). The agent
 * that made an app draws them on a member's ask and saves them with the app, `apps/<name>/icons/<id>.svg`; any member
 * may then pick one for their own drawer. An icon is drawn as the built-in emblems are: one shape on a 48 by 48 grid,
 * black where the app's colour goes and white where lines are cut out, so it takes any colour and sits beside them.
 *
 * The file is a small SVG of a fixed subset, read here without a DOM, so the web (which draws it) and save_app (which
 * refuses one it could not draw) read it alike:
 *   - `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">` and its closing tag; width and height may stand;
 *   - inside it only `path`, `circle`, `rect`, `ellipse`, `line`, `polyline` and `polygon`, each empty, at most 40;
 *   - fill and stroke are black (`#000`, `#000000`, `black`), white (`#fff`, `#ffffff`, `white`) or `none`; a shape
 *     with no fill is filled black, as SVG fills it;
 *   - their geometry (`d`, `points`, `x`, `y`, `width`, `height`, `cx`, `cy`, `r`, `rx`, `ry`, `x1`, `y1`, `x2`,
 *     `y2`) and `stroke-width`, `stroke-linecap`, `stroke-linejoin` and `fill-rule`; nothing else: no transform,
 *     style, class, id, text, image, link, gradient or group;
 *   - an XML declaration and comments may stand before the svg tag; nothing else outside it.
 * White cuts through every black part, whatever order they come in, as the built-in emblems' cuts do. At most 8 KiB.
 * Browser-safe. */

export const APP_ICONS_FOLDER = "icons";
export const APP_ICON_MAX_BYTES = 8 * 1024;
/** How many icons an app keeps: an agent drawing more removes its oldest. */
export const APP_ICONS_MAX = 12;
export const APP_ICON_PARTS_MAX = 40;
export const APP_ICON_ID_MAX_CHARS = 40;
const ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** What a part paints: the app's colour, a hole, or nothing. */
export type AppIconPaint = "ink" | "cut" | "none";
export type AppIconTag = "path" | "circle" | "rect" | "ellipse" | "line" | "polyline" | "polygon";
export interface AppIconPart {
	readonly tag: AppIconTag;
	/** Geometry and line attributes, as written (each checked); fill and stroke are in `fill` and `stroke`. */
	readonly attrs: Readonly<Record<string, string>>;
	readonly fill: AppIconPaint;
	readonly stroke: AppIconPaint;
}
export interface AppIcon {
	readonly parts: readonly AppIconPart[];
}
export type AppIconRead =
	| { readonly ok: true; readonly icon: AppIcon }
	| { readonly ok: false; readonly problem: string };

export function isAppIconId(value: string): boolean {
	return value.length <= APP_ICON_ID_MAX_CHARS && ID.test(value);
}

/** An icon's id from its file's name (`compass.svg` is `compass`), or null for any other name. */
export function appIconIdOf(fileName: string): string | null {
	if (!fileName.toLowerCase().endsWith(".svg")) return null;
	const id = fileName.slice(0, -4);
	return isAppIconId(id) ? id : null;
}

/** Where an app's icon is, from the app's name and the icon's id; null for a name or id that is neither. */
export function appIconPath(app: string, id: string): string | null {
	return isInterfaceName(app) && isAppIconId(id) ? `apps/${app}/${APP_ICONS_FOLDER}/${id}.svg` : null;
}

const TAGS: ReadonlySet<string> = new Set(["path", "circle", "rect", "ellipse", "line", "polyline", "polygon"]);
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
// Maps, not objects: an attribute named like an object's own (constructor, toString) is no geometry (review F3).
const GEOMETRY: ReadonlyMap<string, RegExp> = new Map([
	["d", /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s+eE-]{1,4000}$/],
	["points", /^[0-9.,\s+eE-]{1,2000}$/],
	...["x", "y", "width", "height", "cx", "cy", "r", "rx", "ry", "x1", "y1", "x2", "y2"].map(
		(name): [string, RegExp] => [name, NUMBER],
	),
]);
const LINE: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	["stroke-linecap", new Set(["round", "butt", "square"])],
	["stroke-linejoin", new Set(["round", "miter", "bevel"])],
	["fill-rule", new Set(["nonzero", "evenodd"])],
]);
const INK = new Set(["#000", "#000000", "black"]);
const CUT = new Set(["#fff", "#ffffff", "white"]);
const ROOT = new Set(["xmlns", "viewbox", "width", "height"]);

function paint(value: string | undefined, fallback: AppIconPaint): AppIconPaint | null {
	if (value === undefined) return fallback;
	const colour = value.trim().toLowerCase();
	return INK.has(colour) ? "ink" : CUT.has(colour) ? "cut" : colour === "none" ? "none" : null;
}

/** A tag's attributes, or null when they are not `name="value"` pairs (single or double quotes) without entities. */
function attributes(text: string): Map<string, string> | null {
	const found = new Map<string, string>();
	const pair = /\s*([A-Za-z][A-Za-z0-9:-]*)\s*=\s*(?:"([^"<&]*)"|'([^'<&]*)')/y;
	let at = 0;
	while (at < text.length) {
		if (/^\s*$/.test(text.slice(at))) break;
		pair.lastIndex = at;
		const match = pair.exec(text);
		if (!match) return null;
		const name = match[1]!.toLowerCase();
		if (found.has(name)) return null;
		found.set(name, match[2] ?? match[3] ?? "");
		at = pair.lastIndex;
	}
	return found;
}

/** Reads an icon file; what it cannot draw it refuses whole, with what to change. */
export function parseAppIcon(text: string): AppIconRead {
	const refuse = (problem: string): AppIconRead => ({ ok: false, problem });
	if (new TextEncoder().encode(text).length > APP_ICON_MAX_BYTES)
		return refuse(`an icon is at most ${APP_ICON_MAX_BYTES / 1024} KiB`);
	// What may stand before the svg tag: an XML declaration, comments and white space.
	let rest = text.replace(/^﻿/, "");
	for (;;) {
		const before = rest;
		rest = rest
			.replace(/^\s+/, "")
			.replace(/^<\?xml[^?]*\?>/, "")
			.replace(/^<!--[\s\S]*?-->/, "");
		if (rest === before) break;
	}
	const open = /^<svg\b([^>]*)>/i.exec(rest);
	if (!open) return refuse("an icon is one <svg> element, with nothing but its shapes in it");
	const root = attributes(open[1]!.replace(/\/\s*$/, ""));
	if (!root) return refuse('the svg tag\'s attributes must be name="value" pairs');
	for (const name of root.keys())
		if (!ROOT.has(name)) return refuse(`the svg tag takes xmlns, viewBox, width and height, not ${name}`);
	if (
		(root.get("viewbox") ?? "")
			.trim()
			.split(/[\s,]+/)
			.join(" ") !== "0 0 48 48"
	)
		return refuse('an icon is drawn on the 48 by 48 grid: viewBox="0 0 48 48"');
	const xmlns = root.get("xmlns");
	if (xmlns !== undefined && xmlns !== "http://www.w3.org/2000/svg") return refuse("xmlns must be the SVG namespace");
	rest = rest.slice(open[0].length);
	const close = /<\/svg\s*>\s*$/i.exec(rest);
	if (!close) return refuse("the icon must end with </svg> and nothing after it");
	let body = rest.slice(0, close.index);
	const parts: AppIconPart[] = [];
	const element = /^<([a-zA-Z]+)\b([^<>]*?)(\/?)>(?:\s*<\/\1\s*>)?/;
	for (;;) {
		body = body.replace(/^(?:\s+|<!--[\s\S]*?-->)+/, "");
		if (!body) break;
		const match = element.exec(body);
		if (!match) return refuse("inside the svg tag only shapes may stand, no text");
		const tag = match[1]!.toLowerCase();
		if (!TAGS.has(tag))
			return refuse(`${tag} is not a shape an icon may use: path, circle, rect, ellipse, line, polyline or polygon`);
		// An element written open must be closed at once: shapes hold nothing.
		if (!match[3] && !match[0].includes("</")) return refuse(`write <${tag} … /> with nothing inside it`);
		const found = attributes(match[2]!);
		if (!found) return refuse(`the attributes of a ${tag} must be name="value" pairs`);
		const attrs: Record<string, string> = {};
		let fill: AppIconPaint | null = tag === "line" || tag === "polyline" ? "none" : "ink";
		let stroke: AppIconPaint | null = "none";
		for (const [name, value] of found) {
			if (name === "fill") fill = paint(value, "ink");
			else if (name === "stroke") stroke = paint(value, "none");
			else if (GEOMETRY.has(name)) {
				if (!GEOMETRY.get(name)!.test(value.trim())) return refuse(`${tag}'s ${name} is not a number or path`);
				attrs[name] = value.trim();
			} else if (name === "stroke-width") {
				const width = Number(value);
				if (!NUMBER.test(value.trim()) || width < 0.5 || width > 12)
					return refuse("stroke-width is a number from 0.5 to 12");
				attrs[name] = value.trim();
			} else if (LINE.has(name)) {
				const allowed = LINE.get(name)!;
				if (!allowed.has(value.trim())) return refuse(`${name} is ${[...allowed].join(", ")}`);
				attrs[name] = value.trim();
			} else return refuse(`a ${tag} may not have ${name}: only its shape, fill, stroke and line attributes`);
		}
		if (fill === null || stroke === null)
			return refuse("fill and stroke are black where the colour goes, white where it is cut out, or none");
		parts.push({ tag: tag as AppIconTag, attrs, fill, stroke });
		if (parts.length > APP_ICON_PARTS_MAX) return refuse(`an icon has at most ${APP_ICON_PARTS_MAX} shapes`);
		body = body.slice(match[0].length);
	}
	if (!parts.some((part) => part.fill === "ink" || part.stroke === "ink"))
		return refuse("an icon needs at least one black shape");
	return { ok: true, icon: { parts } };
}
