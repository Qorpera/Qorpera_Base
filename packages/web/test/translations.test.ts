import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DANISH, DANISH_PARTS } from "../src/ui/danish/index.ts";

/* The web app is offered in English and Danish. Interface text goes through
 * t() / uiText() with the English source as the key; text kept in a table
 * first is marked with phrase(). These checks keep the Danish complete and
 * tidy and catch English left unwrapped where interface text goes. (test/setup.ts
 * also fails a test file when a key built at run time has no Danish.) */

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const DANISH_DIR = join(SRC, "ui", "danish");

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return path === DANISH_DIR ? [] : sourceFiles(path);
		return entry.name.endsWith(".ts") ? [path] : [];
	});
}

// Shared code that takes t() as an option: the routine trigger words (cloud-client).
const SHARED = ["../../cloud-client/src/cloud-routines.ts"].map((path) =>
	fileURLToPath(new URL(path, import.meta.url)),
);
const sources = [...sourceFiles(SRC), ...SHARED].map((path) => ({
	path: path.startsWith(SRC) ? path.slice(SRC.length) : path.slice(path.indexOf("/packages/") + 10),
	text: readFileSync(path, "utf8"),
}));
const LITERAL = String.raw`"((?:[^"\\\n]|\\.)*)"`;
const KEY_SITE = new RegExp(String.raw`(?<![\w.$])(?:t|uiText|phrase)\(\s*` + LITERAL, "g");

/** Every key written in the code, where it is written. */
const keySites = sources.flatMap(({ path, text }) =>
	[...text.matchAll(KEY_SITE)].map((match) => ({ path, key: JSON.parse(`"${match[1]}"`) as string })),
);

function placeholders(text: string): string[] {
	return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
}

/** A template literal's own words, without its ${…} parts (which may nest). */
function templateWords(body: string): string {
	let words = "",
		depth = 0;
	for (let at = 0; at < body.length; at++) {
		if (depth === 0 && body[at] === "$" && body[at + 1] === "{") {
			depth = 1;
			at++;
		} else if (depth > 0) {
			if (body[at] === "{") depth++;
			else if (body[at] === "}") depth--;
		} else words += body[at];
	}
	return words;
}

describe("Danish interface text", () => {
	it("has Danish for every key written in the code", () => {
		const missing = keySites
			.filter(({ key }) => !Object.hasOwn(DANISH, key))
			.map(({ path, key }) => `${path}: ${key}`);
		expect(missing).toEqual([]);
	});

	it("never builds a key from a template literal", () => {
		const built = sources.flatMap(({ path, text }) =>
			[...text.matchAll(/(?<![\w.$])(?:t|uiText|phrase)\(\s*`/g)].map((match) => `${path}:${match.index}`),
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
		const written = new Set(keySites.map(({ key }) => key));
		expect(Object.keys(DANISH).filter((source) => !written.has(source))).toEqual([]);
	});

	it("leaves no English unwrapped where interface text goes", () => {
		// The data layer (src/cloud) writes no interface text; the developer's cloud
		// check stays English by decision (DECISIONS.md, 2026-09-24).
		const checked = (path: string) => !path.startsWith("cloud/") && path !== "app/views/cloudcheck.ts";
		// Names and examples that read the same in every language.
		const allowed = new Set(["Qorpera", "Co-Founder", "finance/invoices"]);
		// A string or a template literal (\x60 is the backtick).
		const value = `(?:${LITERAL}|${String.raw`\x60((?:[^\x60\\]|\\.)*)\x60`})`;
		const positions = [
			String.raw`(?:"aria-label"|"aria-description"|\bplaceholder|\btitle|\balt)\s*:\s*`,
			String.raw`setAttribute\(\s*"(?:aria-label|aria-description|title|placeholder|alt)",\s*`,
			String.raw`\.(?:textContent|placeholder|title)\s*=\s*`,
			String.raw`(?<![\w.])h\(\s*"[a-z0-9]+",\s*(?:null|\{[^{}]*\})\s*,\s*`,
			String.raw`(?<![\w.])(?:button|badge|spinner|\w+Skeleton)\(\s*`,
			String.raw`(?<![\w.])notice\(\s*"[a-z]+",\s*`,
			String.raw`confirm\(\s*`,
		].map((position) => new RegExp(position + value, "g"));
		const unwrapped = sources
			.filter(({ path }) => checked(path) && !path.startsWith("cloud-client/"))
			.flatMap(({ path, text }) =>
				positions.flatMap((pattern) =>
					[...text.matchAll(pattern)]
						.map((match) =>
							match[1] !== undefined ? (JSON.parse(`"${match[1]}"`) as string) : templateWords(match[2]!),
						)
						.filter((words) => /[A-Za-z]/.test(words) && !allowed.has(words))
						.map((words) => `${path}: ${JSON.stringify(words)}`),
				),
			);
		expect(unwrapped).toEqual([]);
	});
});
