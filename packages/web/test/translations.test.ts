import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DANISH, DANISH_PARTS } from "../src/ui/danish/index.ts";

/* The web app is offered in English and Danish. Interface text goes through
 * t() / uiText() with the English source as the key; these checks keep the
 * Danish complete and tidy. (test/setup.ts also fails a test file when a key
 * built at run time has no Danish.) */

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const DANISH_DIR = join(SRC, "ui", "danish");

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return path === DANISH_DIR ? [] : sourceFiles(path);
		return entry.name.endsWith(".ts") ? [path] : [];
	});
}

// The live Company File panel is shared with member-web and takes t() as an option.
const FILE_PANEL = fileURLToPath(new URL("../../member-web/src/file-panel.ts", import.meta.url));
const sources = [...sourceFiles(SRC), FILE_PANEL].map((path) => ({
	path: path.startsWith(SRC) ? path.slice(SRC.length) : "member-web/src/file-panel.ts",
	text: readFileSync(path, "utf8"),
}));
const CALL = /(?<![\w.$])(?:t|uiText)\(\s*("(?:[^"\\\n]|\\.)*")/g;

function placeholders(text: string): string[] {
	return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
}

describe("Danish interface text", () => {
	it("has Danish for every literal passed to t() and uiText()", () => {
		const missing = sources.flatMap(({ path, text }) =>
			[...text.matchAll(CALL)]
				.map((match) => JSON.parse(match[1]!) as string)
				.filter((source) => !Object.hasOwn(DANISH, source))
				.map((source) => `${path}: ${source}`),
		);
		expect(missing).toEqual([]);
	});

	it("never builds a key from a template literal", () => {
		const built = sources.flatMap(({ path, text }) =>
			[...text.matchAll(/(?<![\w.$])(?:t|uiText)\(\s*`/g)].map((match) => `${path}:${match.index}`),
		);
		expect(built).toEqual([]);
	});

	it("keeps the same {placeholders} in Danish", () => {
		const changed = Object.entries(DANISH)
			.filter(([source, danish]) => placeholders(source).join() !== placeholders(danish).join())
			.map(([source]) => source);
		expect(changed).toEqual([]);
	});

	it("keeps each key in one area file, with Danish in it", () => {
		const seen = new Map<string, string>();
		const duplicates: string[] = [];
		for (const [part, entries] of Object.entries(DANISH_PARTS)) {
			for (const [source, danish] of Object.entries(entries)) {
				if (seen.has(source)) duplicates.push(`${source} (${seen.get(source)}, ${part})`);
				seen.set(source, part);
				expect(danish.trim(), source).not.toBe("");
			}
		}
		expect(duplicates).toEqual([]);
	});

	it("drops Danish that no code asks for any more", () => {
		const all = sources.map(({ text }) => text).join("\n");
		const unused = Object.keys(DANISH).filter((source) => !all.includes(JSON.stringify(source)));
		expect(unused).toEqual([]);
	});
});
