import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readUiScale, scaleDesignPx } from "./design-px.mjs";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const stylesheets = [
	...readdirSync(join(web, "src/styles")).map((file) => join(web, "src/styles", file)),
	join(web, "../member-web/ui/screens.css"),
];

test("design pixels become calc() on --px; hairlines, SVG strokes and literals stay", () => {
	const css = [
		'@import "./tokens.css";',
		".a { padding: 8px 12.5px; margin: -6px 0; font: 13px/1.5 var(--font-sans); border: 1px solid; box-shadow: 0 0 0 .5px red; }",
		".b { width: calc(100% - 16px); max-height: min(360px, 65dvh); left: var(--x, 20px); }",
		".icon { stroke-width: 4px; width: 18px; }",
		'.c::before { content: "12px"; background: url("icon-16px.svg"); mask: url(data:image/svg+xml,a%2012px) } /* 40px */',
		".d { transition: opacity 120ms; color: #12a4px; width: 100%; margin: +12px 12PX; }",
		"@property --rail-width { syntax: \"*\"; inherits: false; initial-value: 456px; }",
	].join("\n");
	assert.equal(
		scaleDesignPx(css, 1.25),
		[
			'@import "./tokens.css";',
			".a { padding: calc(8 * var(--px)) calc(12.5 * var(--px)); margin: calc(-6 * var(--px)) 0; font: calc(13 * var(--px))/1.5 var(--font-sans); border: 1px solid; box-shadow: 0 0 0 .5px red; }",
			".b { width: calc(100% - calc(16 * var(--px))); max-height: min(calc(360 * var(--px)), 65dvh); left: var(--x, calc(20 * var(--px))); }",
			".icon { stroke-width: 4px; width: calc(18 * var(--px)); }",
			'.c::before { content: "12px"; background: url("icon-16px.svg"); mask: url(data:image/svg+xml,a%2012px) } /* 40px */',
			".d { transition: opacity 120ms; color: #12a4px; width: 100%; margin: calc(+12 * var(--px)) calc(12 * var(--px)); }",
			"@property --rail-width { syntax: \"*\"; inherits: false; initial-value: 456px; }",
		].join("\n"),
	);
});

test("width breakpoints stay as written for a coarse pointer and are multiplied out for a fine one or none", () => {
	const css = "@media (max-width: 760px) { .rail { width: 304px; } }\n@media (hover: none) and (min-width: 1100px), (max-width: 560px) or (max-height: 400px) { .x { gap: 2px; } }\n@media (prefers-reduced-motion: reduce) { .y { top: 0; } }";
	assert.equal(
		scaleDesignPx(css, 1.25),
		[
			"@media (pointer: coarse) and (max-width: 760px), (pointer: fine) and (max-width: 950px), (pointer: none) and (max-width: 950px) { .rail { width: calc(304 * var(--px)); } }",
			"@media (pointer: coarse) and (hover: none) and (min-width: 1100px), (pointer: fine) and (hover: none) and (min-width: 1375px), (pointer: none) and (hover: none) and (min-width: 1375px), (pointer: coarse) and ((max-width: 560px) or (max-height: 400px)), (pointer: fine) and ((max-width: 700px) or (max-height: 500px)), (pointer: none) and ((max-width: 700px) or (max-height: 500px)) { .x { gap: calc(2 * var(--px)); } }",
			"@media (prefers-reduced-motion: reduce) { .y { top: 0; } }",
		].join("\n"),
	);
	assert.throws(() => scaleDesignPx("@media screen and (max-width: 760px) { .a { top: 0; } }", 1.25), /plain condition/);
	assert.throws(() => scaleDesignPx("@container (min-width: 400px) { .a { top: 0; } }", 1.25), /container/);
});

test("tokens.css declares the scale and --px, and the minimized computer keeps screen pixels", () => {
	const tokens = readFileSync(join(web, "src/styles/tokens.css"), "utf8");
	assert.equal(readUiScale(join(web, "src/styles/tokens.css")), 1.4);
	assert.match(tokens, /--px: calc\(var\(--ui-scale\) \* 1px\);/);
	assert.match(tokens, /@media \(pointer: coarse\) \{\s*:root \{ --ui-scale: 1; \}\s*\}/);
	const conversation = readFileSync(join(web, "src/styles/conversation.css"), "utf8");
	assert.match(conversation, /\.computer-panel:not\(\.is-entered\) \{ --px: 1px;/);
});

test("no design pixel in the web stylesheets escapes the scale", () => {
	for (const path of stylesheets) {
		const scaled = scaleDesignPx(readFileSync(path, "utf8"), 1.25)
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/url\([^)]*\)/g, "")
			.replace(/@media[^{]*/g, "")
			.replace(/@property[^}]*/g, "")
			.replace(/stroke-width:[^;}]*/g, "");
		const left = [...scaled.matchAll(/(?<![\w.#+-])([+-]?(?:\d+(?:\.\d+)?|\.\d+))px\b/gi)]
			.map((match) => match[0])
			.filter((value) => Math.abs(Number.parseFloat(value)) >= 2);
		assert.deepEqual(left, [], path);
	}
});
