// The web app is drawn larger than its stylesheets are written (tokens.css
// --ui-scale, 140% today) on screens driven by a mouse or trackpad; phones
// and tablets keep the sizes the phone layout was drawn for. The stylesheets
// keep writing design pixels ("14px"); this build step turns each one into
// `calc(14 * var(--px))`, and tokens.css sets --px to --ui-scale pixels (1 on a
// coarse pointer). A part of the page that must keep its old size sets
// `--px: 1px` for itself and everything inside it (the minimized computer
// preview does). A query cannot read a variable, so each width breakpoint in
// @media is written for each pointer: as it stands for a coarse one, multiplied
// out for a fine one or none (spelled out rather than `not`, which older
// browsers cannot parse). Hairlines (under 2px) stay as written, so borders stay crisp,
// and so do SVG geometry properties, which count in the icon's own viewBox.
import { readFileSync } from "node:fs";
import { dirname } from "node:path";

/** Values below this many px are left alone: 1px borders, half-pixel blurs. */
const HAIRLINE = 2;
/** Where the app keeps its unscaled sizes; tokens.css sets --ui-scale: 1 under the same query. */
const TOUCH = "(pointer: coarse)";
const SCALED = ["(pointer: fine)", "(pointer: none)"];
/** Lengths in an SVG's user units: the icon's box scales, its strokes follow. */
const SVG_GEOMETRY = new Set(["stroke-width", "stroke-dasharray", "stroke-dashoffset", "cx", "cy", "r", "rx", "ry", "x", "y"]);
/** At-rules whose block must stay literal: @property values cannot hold var(). */
const LITERAL_BLOCKS = new Set(["property"]);
const NUMBER_PX = /([+-]?(?:\d+(?:\.\d+)?|\.\d+))px(?![\w-])/iy;
const QUERY_PX = /(?<![\w.#+-])([+-]?(?:\d+(?:\.\d+)?|\.\d+))px(?![\w-])/gi;

/** The scale the stylesheet declares for a mouse or trackpad; the build and the scripts both follow it. */
export function readUiScale(tokensPath) {
	const match = /--ui-scale:\s*([\d.]+)\s*;/.exec(readFileSync(tokensPath, "utf8"));
	const scale = Number(match?.[1]);
	if (!Number.isFinite(scale) || scale <= 0) throw new Error(`${tokensPath} does not declare --ui-scale`);
	return scale;
}

/** Copies a comment, string or url() starting at `start` verbatim; returns where it ends. */
function skipLiteral(css, start) {
	const c = css[start];
	if (c === "/" && css[start + 1] === "*") {
		const end = css.indexOf("*/", start + 2);
		return end < 0 ? css.length : end + 2;
	}
	if (c === '"' || c === "'") {
		let i = start + 1;
		while (i < css.length && css[i] !== c) i += css[i] === "\\" ? 2 : 1;
		return Math.min(css.length, i + 1);
	}
	if (/^url\(/i.test(css.slice(start, start + 4)) && !/[\w-]/.test(css[start - 1] ?? "")) {
		let i = start + 4;
		while (i < css.length && css[i] !== ")") {
			if (css[i] === '"' || css[i] === "'") i = skipLiteral(css, i);
			else i += css[i] === "\\" ? 2 : 1;
		}
		return Math.min(css.length, i + 1);
	}
	return start;
}

/** Splits a query list on the commas outside parentheses. */
function queries(list) {
	const parts = [];
	let depth = 0;
	let from = 0;
	for (let i = 0; i < list.length; i++) {
		if (list[i] === "(") depth++;
		else if (list[i] === ")") depth--;
		else if (list[i] === "," && depth === 0) {
			parts.push(list.slice(from, i));
			from = i + 1;
		}
	}
	parts.push(list.slice(from));
	return parts.map((part) => part.trim());
}

/** An @media prelude with design pixels, once for a coarse pointer as written and once scaled for the rest. */
function mediaPrelude(prelude, scale) {
	const plain = prelude.replace(/\/\*[\s\S]*?\*\//g, "");
	if (!/\dpx/i.test(plain)) return prelude;
	const list = queries(plain);
	const branches = list.flatMap((query) => {
		if (!query.startsWith("(")) throw new Error(`@media ${query}: a query with pixel widths must be a plain condition`);
		const scaled = query.replace(QUERY_PX, (_, value) => `${Number((Number(value) * scale).toFixed(4))}px`);
		const group = (condition) => (/\)\s+or\s+\(/i.test(condition) ? `(${condition})` : condition);
		return [`${TOUCH} and ${group(query)}`, ...SCALED.map((pointer) => `${pointer} and ${group(scaled)}`)];
	});
	return ` ${branches.join(", ")} `;
}

/** Rewrites every design pixel in one stylesheet. */
export function scaleDesignPx(css, scale) {
	let out = "";
	let i = 0;
	/** The at-rule whose prelude is being read, until its `{` or `;`. */
	let atRule;
	/** Brace depth at which a literal block (for example @property) closes. */
	let literalDepth = -1;
	let depth = 0;
	/** Where the current declaration (or selector) began, and whether it is SVG geometry. */
	let start = 0;
	let svg = false;
	while (i < css.length) {
		const literalEnd = skipLiteral(css, i);
		if (literalEnd > i) {
			out += css.slice(i, literalEnd);
			i = literalEnd;
			continue;
		}
		const c = css[i];
		if (c === "@") {
			const name = /^@([\w-]+)/.exec(css.slice(i));
			if (name) {
				atRule = name[1].toLowerCase();
				out += name[0];
				i += name[0].length;
				if (atRule === "media" || atRule === "container") {
					// The prelude runs to the block; comments and strings inside it are skipped whole.
					let end = i;
					while (end < css.length && css[end] !== "{" && css[end] !== ";") end = Math.max(end + 1, skipLiteral(css, end));
					const prelude = css.slice(i, end);
					if (atRule === "container" && /\dpx/i.test(prelude))
						throw new Error(`@container${prelude}: pixel widths in container queries are not scaled yet`);
					out += atRule === "media" ? mediaPrelude(prelude, scale) : prelude;
					i = end;
				}
				continue;
			}
		}
		if (c === "{") {
			if (atRule && LITERAL_BLOCKS.has(atRule) && literalDepth < 0) literalDepth = depth;
			atRule = undefined;
			depth++;
		} else if (c === "}") {
			depth--;
			if (depth === literalDepth) literalDepth = -1;
		} else if (c === ";") atRule = undefined;
		if (c === "{" || c === "}" || c === ";") {
			start = i + 1;
			svg = false;
		} else if (c === ":" && !atRule) {
			const property = css
				.slice(start, i)
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.trim()
				.toLowerCase();
			svg = SVG_GEOMETRY.has(property);
		}
		if (/[-+.\d]/.test(c) && !/[\w.#+-]/.test(css[i - 1] ?? "") && literalDepth < 0 && !svg && !atRule) {
			NUMBER_PX.lastIndex = i;
			const number = NUMBER_PX.exec(css);
			if (number) {
				out += Math.abs(Number(number[1])) < HAIRLINE ? number[0] : `calc(${number[1]} * var(--px))`;
				i += number[0].length;
				continue;
			}
		}
		out += c;
		i++;
	}
	return out;
}

/** esbuild plugin: every stylesheet in the bundle, imports included, goes through scaleDesignPx. */
export function designPxPlugin(scale) {
	return {
		name: "design-px",
		setup(build) {
			build.onLoad({ filter: /\.css$/ }, (args) => ({
				contents: scaleDesignPx(readFileSync(args.path, "utf8"), scale),
				loader: "css",
				resolveDir: dirname(args.path),
			}));
		},
	};
}
