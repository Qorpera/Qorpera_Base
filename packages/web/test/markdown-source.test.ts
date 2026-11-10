// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { markdown, markdownSourceOffset } from "../src/ui/markdown.ts";

afterEach(() => document.body.replaceChildren());

const source = [
	"You hold the **company-level** work &amp; the vision.",
	"",
	"## Your first job",
	"",
	"1. Hire the team",
	"2. Keep `it sharp`",
	"",
	"> Ask 😀 first.",
	"",
].join("\n");

function drawn(text = source): HTMLElement {
	const prose = markdown(text, { sourceRanges: true });
	document.body.replaceChildren(prose);
	return prose;
}

/** The drawn run of text that holds `text`. */
function run(root: Element, text: string): Text {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode())
		if (node instanceof Text && node.data.includes(text)) return node;
	throw new Error(`No drawn text holds "${text}"`);
}

describe("a place in drawn Markdown, found in its source", () => {
	it("marks each block with the stretch of the source it draws", () => {
		const blocks = [...drawn().children].map((block) => {
			const { sourceStart, sourceEnd } = (block as HTMLElement).dataset;
			return source.slice(Number(sourceStart), Number(sourceEnd)).trim();
		});
		expect(blocks).toEqual([
			"You hold the **company-level** work &amp; the vision.",
			"## Your first job",
			"1. Hire the team\n2. Keep `it sharp`",
			"> Ask 😀 first.",
		]);
	});

	it("leaves the blocks unmarked unless asked", () => {
		expect(markdown(source).querySelector("[data-source-start]")).toBeNull();
	});

	it("finds a caret inside a word, past the marks before it", () => {
		const root = drawn();
		const at = (text: string, offset: number) => markdownSourceOffset(source, run(root, text), offset);
		expect(at("You hold", 3)).toBe(3);
		// Inside the bold, after its "**".
		expect(at("company-level", 7)).toBe(source.indexOf("company-level") + 7);
		expect(at("Your first job", 5)).toBe(source.indexOf("Your first job") + 5);
		// The second item of a list, past the first item and both numbers.
		expect(at("Keep", 2)).toBe(source.indexOf("Keep") + 2);
		// Inside the code, after its "`".
		expect(at("it sharp", 4)).toBe(source.indexOf("`it sharp`") + 5);
		// A character of two code units counts as it stands in the source.
		expect(at("Ask", 6)).toBe(source.indexOf("😀") + 2);
	});

	it("puts a caret at the start of a run before its first character, not at the end of the run before", () => {
		const root = drawn();
		expect(markdownSourceOffset(source, run(root, "company-level"), 0)).toBe(source.indexOf("company-level"));
		expect(markdownSourceOffset(source, run(root, "Keep"), 0)).toBe(source.indexOf("Keep"));
		// The end of the first item stays in the first item.
		const first = run(root, "Hire the team");
		expect(markdownSourceOffset(source, first, first.data.length)).toBe(source.indexOf("Hire the team") + 13);
	});

	it("passes over a character the Markdown writes another way and goes on after it", () => {
		const root = drawn();
		const tail = run(root, "the vision.");
		// Drawn "work & the vision." from "work &amp; the vision.": the place after "the" in the last run.
		expect(markdownSourceOffset(source, tail, tail.data.indexOf("the") + 3)).toBe(source.indexOf("; the") + 5);
	});

	it("counts from the block's own start, with the source's line ends as the lexer reads them", () => {
		const windows = "First.\r\n\r\nSecond *one*.";
		const root = drawn(windows);
		// A text area's value has the same line ends the lexer reads.
		const value = windows.replace(/\r\n/g, "\n");
		expect(markdownSourceOffset(value, run(root, "one"), 1)).toBe(value.indexOf("one") + 1);
	});

	it("has no place for text outside every block", () => {
		const loose = document.createElement("p");
		loose.textContent = "Loose";
		document.body.append(loose);
		expect(markdownSourceOffset(source, loose.firstChild!, 2)).toBeUndefined();
	});
});
