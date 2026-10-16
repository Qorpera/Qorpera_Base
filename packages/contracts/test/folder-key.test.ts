import { describe, expect, it } from "vitest";
import { folderKey } from "../src/index.ts";

// scripts/test-folder-key.mjs checks every code point against the database's qorpera_folder_key; these are the ones
// where JavaScript's full case mapping and the database's simple case mapping part.
describe("folder key", () => {
	it("folds ASCII to lower case", () => {
		expect(folderKey("Notes/README.md")).toBe("notes/readme.md");
		expect(folderKey("")).toBe("");
	});

	it("keeps ß, which full case mapping spells SS", () => {
		expect(folderKey("Straße")).toBe("straße");
		expect(folderKey("STRASSE")).toBe("strasse");
		expect(folderKey("Straße")).not.toBe(folderKey("strasse"));
		expect(folderKey("ẞ")).toBe("ß");
	});

	it("folds İ to a plain i, without the combining dot full case mapping adds", () => {
		expect(folderKey("İ")).toBe("i");
		expect(folderKey("İstanbul")).toBe(folderKey("istanbul"));
		expect(folderKey("ı")).toBe("i");
	});

	it("keeps the Greek letters with ypogegrammeni one letter each", () => {
		expect(folderKey("ᾳ")).toBe("ᾳ");
		expect(folderKey("ᾼ")).toBe("ᾳ");
		expect(folderKey("ᾀ")).toBe("ᾀ");
		expect(folderKey("ᾈ")).toBe("ᾀ");
		expect(folderKey("ῳ")).toBe("ῳ");
		expect(folderKey("ῼ")).toBe("ῳ");
		expect(folderKey("ῃ")).toBe("ῃ");
		expect(folderKey("ῌ")).toBe("ῃ");
		expect(folderKey("ᾳ")).not.toBe("αι");
	});

	it("maps every code point on its own, so every sigma folds to σ", () => {
		expect(folderKey("ΟΔΟΣ")).toBe("οδοσ");
		expect(folderKey("Σίσυφος")).toBe("σίσυφοσ");
		expect(folderKey("ΣΊΣΥΦΟΣ")).toBe("σίσυφοσ");
	});

	it("normalizes with NFKC before and after the case mapping", () => {
		expect(folderKey("ﬁle.TXT")).toBe("file.txt");
		expect(folderKey(String.fromCodePoint(0x212a))).toBe("k");
		expect(folderKey("ＡＢＣ")).toBe("abc");
		expect(folderKey(`e${String.fromCodePoint(0x301)}`)).toBe("é");
	});

	it("leaves code points newer than the core's Unicode 15.1 as they are, and nothing composes across them", () => {
		const chars = (...codePoints: number[]) => String.fromCodePoint(...codePoints);
		// Unicode 16's capital ram's horn (lower case U+0264), a Garay capital and an outlined A.
		for (const codePoint of [0xa7cb, 0x10d50, 0x1ccd6]) expect(folderKey(chars(codePoint))).toBe(chars(codePoint));
		expect(folderKey(chars(0x41, 0xa7cb, 0x42))).toBe(chars(0x61, 0xa7cb, 0x62));
		// A newer combining mark is a starter to the core: the dot below neither moves before it nor composes.
		expect(folderKey(chars(0x41, 0x323))).toBe(chars(0x1ea1));
		expect(folderKey(chars(0x41, 0x897, 0x323))).toBe(chars(0x61, 0x897, 0x323));
		// Todhri EI decomposes to a newer letter and a dot above; the core composes neither way.
		expect(folderKey(chars(0x105d2, 0x307))).toBe(chars(0x105d2, 0x307));
		expect(folderKey(chars(0x105c9))).toBe(chars(0x105c9));
		// The parts around them are keyed as usual.
		expect(folderKey(`Straße${chars(0x897)}ΟΔΟΣ`)).toBe(`straße${chars(0x897)}οδοσ`);
	});
});
