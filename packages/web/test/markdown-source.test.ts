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

	it("never lands in an image's address, also where its words are written as references", () => {
		const source = "![&#65;](https://example.com/A) and ![plan](plan.png)";
		const { at } = drawing(source);
		// Drawn "A": after it is after the reference, not at the "A" that ends the address.
		expect(at("A", 0)).toBe(source.indexOf("&#65;"));
		expect(at("A", 1)).toBe(source.indexOf("&#65;") + 5);
		expect(at("plan", 2)).toBe(source.indexOf("![plan]") + 4);
		expect(at("plan", 4)).toBe(source.indexOf("](plan.png)"));
		// Words whose bracket the lexer unescaped stand nowhere it can count to.
		expect(drawing("![a\\]b](x.png)").at("a]b", 1)).toBeUndefined();
	});

	it("counts code as it is written, its references unread", () => {
		const source = "`&amp;` and\n\n```html\n&lt;b&gt; x\n```";
		const { at } = drawing(source);
		// Drawn "&amp;" among the words: two characters in is two characters in.
		expect(at("&amp;", 0)).toBe(source.indexOf("&amp;"));
		expect(at("&amp;", 2)).toBe(source.indexOf("&amp;") + 2);
		expect(at("&amp;", 5)).toBe(source.indexOf("&amp;") + 5);
		expect(at("&lt;b&gt; x", 5)).toBe(source.indexOf("&lt;b") + 5);
		expect(at("&lt;b&gt; x", 11)).toBe(source.indexOf("\n```", 20));
	});

	it("counts a code's lines inside a list item past the indent before each", () => {
		const source = "- item\n\n  ```js\n  a &amp; b\n    deep\n  ```";
		const { at, run } = drawing(source);
		const code = run("a &amp; b").data;
		expect(code).toBe("a &amp; b\n  deep");
		expect(at("a &amp; b", 0)).toBe(source.indexOf("a &amp; b"));
		expect(at("a &amp; b", 3)).toBe(source.indexOf("a &amp; b") + 3);
		// The end of the first line, the start of the second (after the item's indent, before the code's own), and in it.
		expect(at("a &amp; b", 9)).toBe(source.indexOf("\n    deep"));
		expect(at("a &amp; b", 10)).toBe(source.indexOf("    deep") + 2);
		expect(at("a &amp; b", code.indexOf("deep") + 2)).toBe(source.indexOf("deep") + 2);
		expect(at("a &amp; b", code.length)).toBe(source.indexOf("\n  ```", 20));
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

	it("keeps each cell's text to its own cell, never the bars between the cells", () => {
		const source = "| h | i |\n| - | - |\n| \\| | b |";
		const { at } = drawing(source);
		// The first cell draws its escaped bar as a bar. The lexer rewrote it, so it has no place: least of all the
		// bar that starts the row.
		expect(at("|", 0)).toBeUndefined();
		expect(at("|", 1)).toBeUndefined();
		expect(at("b", 0)).toBe(source.lastIndexOf("b"));
		expect(at("b", 1)).toBe(source.lastIndexOf("b") + 1);
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

	it("puts the caret before the same character in the source as in the drawing, whatever the Markdown", () => {
		const corpus = [
			"Read [plan](https://example.com). Then [a.b](http://a.b/c.d).",
			'![&#65;](https://example.com/A) ![x](x) ![a b](<u v> "t")',
			"`&amp;` ``a`b`` `` ` `` ` x ` `two\nlines`",
			"```js\njs &amp; js\n```",
			"~~~\ntilde\n~~~\n\n```\nunterminated",
			"    indented code\n    more\n\nafter",
			"> quote **bold** [l](http://u.v).\n> second `code` line\n>\n> > nested *em*\nlazy line",
			"1. one\n2. two\n   continued [x](y.z).\n3. 3",
			"- a\n  - b\n    - c [d](e.f)\n  - g\n- h",
			"- [ ] todo &amp; more\n- [x] done\n\n* loose\n\n  para two\n\n* other",
			"# #\n\n## Title ##\n\nSetext\n===\n\n#hashtag\n---\n\n###### six",
			"a\\*b\\_c &lt;tag&gt; &copy; &#x1F600; &unknown; &amp;amp; &",
			"<div>html &amp; block</div>\n\nafter <b>inline</b> html <!-- c -->",
			"| h1 | h2 |\n| --- | :-: |\n| **b** | [l](u.v) |\n| - | `c` |\n\n> | q | r |\n> | - | - |\n> | s | t |",
			"Line one\nline two  \nline three\\\nline four",
			"*em **strong** em* ***both*** __under__ _u_ ~~del~~ **a*b*c**",
			"https://auto.link/x.y and <https://angle.link> and <me@x.yz> www.x.yz me@x.yz",
			"[ref][r] and [r] and [none][nope]\n\n[r]: http://ref.er/x",
			"Emoji 😀 **😀b** `😀` [😀](u)",
			"> - quote list\n>   more\n> - second\n>\n>   ```\n>   code in quote list\n>   ```",
			"\tTabbed code\n\n-\ttab item\n- \tb",
			"1) paren list\n2) two\n\n10. ten\n    - in ten",
			"\\# not heading &#35; \\> not quote \\[x\\](y)",
			"First.\r\n\r\nSecond *one*.\r\n- a\r\n- b",
			"- a\n\n      code in item\n\n- b",
			"[link *with em* and `code`](http://x.y/z) tail.",
			"| t |  u |\n|---|---|\n| \\| | v \\| w |\n| x | y |",
		];
		const wrong: string[] = [];
		const placeless: string[] = [];
		for (const source of corpus) {
			// As a text area holds it.
			const value = source.replace(/\r\n|\r/g, "\n");
			const walker = document.createTreeWalker(drawing(source).root, NodeFilter.SHOW_TEXT);
			for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
				const text = node.data;
				if (markdownSourceOffset(node, 0) === undefined) {
					placeless.push(text);
					continue;
				}
				let before = -1;
				for (let index = 0; index <= text.length; index++) {
					const at = markdownSourceOffset(node, index) ?? -1;
					// Further into the drawn text is never earlier in the source.
					if (at < before)
						wrong.push(`${JSON.stringify(text)} at ${index} goes back in ${JSON.stringify(source)}`);
					before = at;
					// The end has no character after it, and the middle of a pair of code units no caret.
					if (index === text.length || /[\uDC00-\uDFFF]/.test(text[index] ?? "")) continue;
					const [character = ""] = text.slice(index);
					const here = value.slice(at);
					const reference = /^&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/i.exec(here)?.[0];
					const read = reference && new DOMParser().parseFromString(reference, "text/html").body.textContent;
					// The same character as written, as a reference that reads as it, or behind the backslash that
					// escapes it.
					if (!here.startsWith(character) && !read?.startsWith(character) && !here.startsWith(`\\${character}`))
						wrong.push(`${JSON.stringify(text)} at ${index} is at ${JSON.stringify(here.slice(0, 12))}`);
				}
			}
		}
		expect(wrong).toEqual([]);
		// Code over two lines draws its line end as a space, and a cell draws its escaped bar as a bar: those have no
		// place, and nothing else here lacks one.
		expect(placeless).toEqual(["two lines", "|", "v | w"]);
	});

	it("has no place where no text of the source stands", () => {
		const loose = document.createElement("p");
		loose.textContent = "Loose";
		document.body.append(loose);
		expect(markdownSourceOffset(loose.firstChild!, 2)).toBeUndefined();
		// A drawing that was not asked for places keeps none.
		const plain = markdown("Plain *text*.");
		expect(markdownSourceOffset(plain.querySelector("em")!.firstChild!, 2)).toBeUndefined();
		// A cell whose bar the lexer rewrote has none either. The cell after it keeps its own: it is looked for in its
		// own cell, where the "b" before it is not.
		const table = "| x | y |\n| --- | --- |\n| a \\| b | b |\n| c | d |";
		const { at } = drawing(table);
		expect(at("y", 1)).toBe(table.indexOf("y") + 1);
		expect(at("a | b", 2)).toBeUndefined();
		expect(at("b", 1, 1)).toBe(table.lastIndexOf("b") + 1);
		expect(at("d", 1)).toBe(table.indexOf("d") + 1);
	});
});
