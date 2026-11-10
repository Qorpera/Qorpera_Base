// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { markdown, markdownSourceOffset } from "../src/ui/markdown.ts";

afterEach(() => document.body.replaceChildren());

/** Draws `source` as an agent's card does and says where a caret in the drawn text falls in it: `offset` characters
 * into the drawn run of text that holds `text` (the `nth` such run, from 0). */
function drawing(source: string) {
	const root = markdown(source, { links: false, sourceRanges: true });
	document.body.replaceChildren(root);
	const run = (text: string, nth = 0): Text => {
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		let seen = 0;
		for (let node = walker.nextNode(); node; node = walker.nextNode())
			if (node instanceof Text && node.data.includes(text) && seen++ === nth) return node;
		throw new Error(`No drawn text holds "${text}"`);
	};
	return {
		root,
		run,
		at: (text: string, offset: number, nth = 0) => markdownSourceOffset(run(text, nth), offset),
	};
}

describe("a place in drawn Markdown, found in its source", () => {
	it("counts a caret inside plain words, bold and a heading", () => {
		const source = "You hold the **company-level** work.\n\n## Your first job\nFill it in.";
		const { at } = drawing(source);
		expect(at("You hold", 3)).toBe(3);
		// A run's start and end are inside the marks around it.
		expect(at("company-level", 0)).toBe(source.indexOf("company-level"));
		expect(at("company-level", 7)).toBe(source.indexOf("company-level") + 7);
		expect(at("company-level", 13)).toBe(source.indexOf("**", 20));
		expect(at(" work.", 6)).toBe(source.indexOf("\n"));
		expect(at("Your first job", 0)).toBe(source.indexOf("Your"));
		expect(at("Your first job", 5)).toBe(source.indexOf("first"));
		expect(at("Fill it in.", 0)).toBe(source.indexOf("Fill"));
	});

	it("never lands in a link's address", () => {
		const source = "Read [plan](https://example.com).";
		const { at } = drawing(source);
		// After the last full stop: the end, not the stop in "example.com".
		expect(at(".", 1)).toBe(source.length);
		expect(at(".", 0)).toBe(source.length - 1);
		expect(at("plan", 2)).toBe(source.indexOf("plan") + 2);
		expect(at("plan", 4)).toBe(source.indexOf("]"));
		const two = "See [a.b](http://a.b/c.d). Then [go](http://go.to/a.b), then stop.";
		const second = drawing(two);
		expect(second.at(". Then", 1)).toBe(two.indexOf("). Then") + 2);
		expect(second.at(", then stop.", 12)).toBe(two.length);
		expect(second.at("go", 1)).toBe(two.indexOf("[go]") + 2);
	});

	it("passes a list's numbers and bullets, also where the text spells the same", () => {
		const source = "10. 1 apple\n11. 10 pears\n\n- - dash\n- [x] done";
		const { at } = drawing(source);
		expect(at("1 apple", 0)).toBe(source.indexOf("1 apple"));
		expect(at("1 apple", 1)).toBe(source.indexOf(" apple"));
		expect(at("10 pears", 0)).toBe(source.indexOf("10 pears"));
		expect(at("10 pears", 2)).toBe(source.indexOf(" pears"));
		// A list in a list on one line: the text stands after both dashes.
		expect(at("dash", 0)).toBe(source.indexOf("dash"));
		expect(at("done", 2)).toBe(source.indexOf("done") + 2);
	});

	it("keeps to a fence's code, not the language its first line names", () => {
		const source = "```js\njs = 1\n```\n\nAnd `js` inline.";
		const { at } = drawing(source);
		expect(at("js = 1", 0)).toBe(source.indexOf("js = 1"));
		expect(at("js = 1", 2)).toBe(source.indexOf(" = 1"));
		expect(at("js = 1", 6)).toBe(source.indexOf("\n```"));
		// The second run that spells "js" is the code among the words: inside its ticks.
		expect(at("js", 0, 1)).toBe(source.indexOf("`js`") + 1);
		expect(at("js", 2, 1)).toBe(source.indexOf("`js`") + 3);
	});

	it("finds text in a quote and in a list inside a list, past the marks before each line", () => {
		const source = "> first line\n> [x](http://y.z). Done\n\n- alpha\n  - two [a](b.c). End\n  - three";
		const { at } = drawing(source);
		expect(at("first line", 5)).toBe(source.indexOf(" line"));
		expect(at(". Done", 1)).toBe(source.indexOf("). Done") + 2);
		expect(at(". Done", 6)).toBe(source.indexOf("\n\n"));
		expect(at("alpha", 5)).toBe(source.indexOf("alpha") + 5);
		expect(at("two ", 0)).toBe(source.indexOf("two"));
		expect(at(". End", 1)).toBe(source.indexOf("). End") + 2);
		expect(at("three", 2)).toBe(source.indexOf("three") + 2);
	});

	it("takes a character reference as the one character it draws, and an escape whole", () => {
		const source = "A &amp;a b\\*c";
		const { at } = drawing(source);
		// Drawn "A &a b": before the "&", after it, and after the "a" that follows.
		expect(at("A &a b", 2)).toBe(source.indexOf("&amp;"));
		expect(at("A &a b", 3)).toBe(source.indexOf("&amp;") + 5);
		expect(at("A &a b", 4)).toBe(source.indexOf(" b"));
		// The escaped star: before its backslash, or after the star.
		expect(at("*", 0)).toBe(source.indexOf("\\*"));
		expect(at("*", 1)).toBe(source.indexOf("\\*") + 2);
		expect(at("c", 1)).toBe(source.length);
	});

	it("keeps to a table's cells, past the line of dashes", () => {
		const source = "| Role | Now |\n| --- | --- |\n| - | 2 |";
		const { at } = drawing(source);
		expect(at("Now", 1)).toBe(source.indexOf("Now") + 1);
		expect(at("-", 0)).toBe(source.lastIndexOf("-"));
		expect(at("-", 1)).toBe(source.lastIndexOf("-") + 1);
		expect(at("2", 1)).toBe(source.indexOf("2") + 1);
	});

	it("takes a caret between elements as the text beside it", () => {
		const source = "One **two** three\n\n- x";
		const { root } = drawing(source);
		const [paragraph, list] = [...root.children];
		expect(markdownSourceOffset(paragraph!, 1)).toBe(source.indexOf("two"));
		expect(markdownSourceOffset(root, 1)).toBe(source.indexOf("x"));
		expect(markdownSourceOffset(root, 2)).toBe(source.length);
		expect(markdownSourceOffset(list!, 1)).toBe(source.length);
	});

	it("reads the source's line ends as a text area does", () => {
		const windows = "First.\r\n\r\nSecond *one*.";
		const value = windows.replace(/\r\n/g, "\n");
		expect(drawing(windows).at("one", 1)).toBe(value.indexOf("one") + 1);
	});

	it("has no place where no text of the source stands", () => {
		const loose = document.createElement("p");
		loose.textContent = "Loose";
		document.body.append(loose);
		expect(markdownSourceOffset(loose.firstChild!, 2)).toBeUndefined();
		// A drawing that was not asked for places keeps none.
		const plain = markdown("Plain *text*.");
		expect(markdownSourceOffset(plain.querySelector("em")!.firstChild!, 2)).toBeUndefined();
		// A cell whose bar the lexer rewrote has none either, and the cells after it keep theirs.
		const table = "| a \\| b |\n| --- |\n| c |";
		const { at } = drawing(table);
		expect(at("a | b", 2)).toBeUndefined();
		expect(at("c", 1)).toBe(table.indexOf("c") + 1);
	});
});
