/**
 * The folder's key for a path, as the folder core computes it (`public.qorpera_folder_key`, migration
 * 20260928120000): NFKC, then Unicode simple case mapping, upper case and then lower case, each code point to exactly
 * one code point (PostgreSQL's built-in `pg_c_utf8` collation), then NFKC again. Two paths with one key are one path.
 * The database's key is the canonical one: it holds the stored keys and the unique indexes, so every copy in
 * JavaScript calls this.
 *
 * JavaScript's `toUpperCase` and `toLowerCase` use full case mapping, which can turn one code point into several:
 * 'Straße' would become 'strasse' and 'İ' an 'i' with a combining dot above, where the core keeps 'straße' and 'i'.
 * So each code point is mapped on its own (which also leaves out the final sigma's context), and a mapping to several
 * code points counts as none, except for the few code points whose simple mapping is another single code point
 * (SIMPLE_UPPER, SIMPLE_LOWER).
 *
 * The core's Unicode is PostgreSQL 17's, 15.1, and JavaScript's is often newer. A code point the core's Unicode
 * doesn't know (NEWER_THAN_CORE) has no case mapping, no decomposition and combining class 0 there, so the core leaves
 * it as it is and nothing composes or reorders across it. Here it stays as it is too and parts the path, and each part
 * between is keyed on its own. scripts/test-folder-key.mjs compares this with the database's function for every code
 * point.
 */
export function folderKey(path: string): string {
	if (ASCII.test(path)) return path.toLowerCase();
	let key = "";
	let from = 0;
	let at = 0;
	for (const char of path) {
		if (newerThanCore(char.codePointAt(0)!)) {
			key += fold(path.slice(from, at)) + char;
			from = at + char.length;
		}
		at += char.length;
	}
	return key + fold(path.slice(from));
}

// ASCII keeps its NFKC form, and its full and simple case mappings agree.
const ASCII = /^[\x00-\x7f]*$/;

function fold(part: string): string {
	const text = part.normalize("NFKC");
	if (ASCII.test(text)) return text.toLowerCase();
	let folded = "";
	for (const char of text) folded += simpleLower(simpleUpper(char));
	return folded.normalize("NFKC");
}

/** Upper case where full mapping spells a letter out in several code points but simple mapping has one: the Greek
 * small letters with ypogegrammeni take their capital with prosgegrammeni ('ᾳ' to 'ᾼ'; full mapping gives 'ΑΙ'). */
const SIMPLE_UPPER = codePointMap([
	...[0x1f80, 0x1f90, 0x1fa0].flatMap((first) =>
		Array.from({ length: 8 }, (_, i): [number, number] => [first + i, first + 8 + i]),
	),
	[0x1fb3, 0x1fbc],
	[0x1fc3, 0x1fcc],
	[0x1ff3, 0x1ffc],
]);

/** Lower case where full mapping gives several code points but simple mapping one: 'İ' (U+0130) is 'i'. */
const SIMPLE_LOWER = codePointMap([[0x130, 0x69]]);

function codePointMap(pairs: readonly (readonly [number, number])[]): ReadonlyMap<string, string> {
	return new Map(pairs.map(([from, to]) => [String.fromCodePoint(from), String.fromCodePoint(to)] as const));
}

function simpleUpper(char: string): string {
	const upper = char.toUpperCase();
	return oneCodePoint(upper) ? upper : (SIMPLE_UPPER.get(char) ?? char);
}

function simpleLower(char: string): string {
	const lower = char.toLowerCase();
	return oneCodePoint(lower) ? lower : (SIMPLE_LOWER.get(char) ?? char);
}

function oneCodePoint(text: string): boolean {
	return text.length === 1 || (text.length === 2 && text.codePointAt(0)! > 0xffff);
}

/** The code points Unicode assigned after 15.1, the core's Unicode (PostgreSQL 17, `unicode_version()`): the ages
 * 16.0, 17.0 and 18.0 in https://www.unicode.org/Public/18.0.0/ucd/DerivedAge.txt, adjacent ranges merged, as first
 * and last code point in hexadecimal. When the core's PostgreSQL moves to a newer Unicode, its own code points come
 * out of this list (scripts/test-folder-key.mjs checks the core's version). */
const NEWER_THAN_CORE = Uint32Array.from(
	`
	558 58b-58c 5c8-5c9 88f 897 b53-b54 c5c cdc 1acf-1af0 1b4e-1b4f 1b7f 1c89-1c8a 208f 209d-209f 20c1-20c4
	2427-2429 2b96 2e60-2e63 31e4-31e5 a7cb-a7cf a7d2 a7d4 a7da-a7dd a7e2 a7f1 ab6c-ab6d fbc3-fbd2 fd90-fd91
	fdc8-fdce 105c0-105f3 107bb-107bf 10940-10959 10d40-10d65 10d69-10d85 10d8e-10d8f 10ec2-10ec7 10ec9-10eee
	10ef0-10efc 11380-11389 1138b 1138e 11390-113b5 113b7-113c0 113c2 113c5 113c7-113ca 113cc-113d5 113d7-113d8
	113e1-113e2 116d0-116e3 11b0a 11b60-11b67 11bc0-11be1 11bf0-11bf9 11db0-11ddb 11de0-11de9 11df0-11df1 11f5a
	1246f 12475-1247f 12550-12686 13460-143fa 16100-16139 16d40-16d79 16ea0-16eb8 16ebb-16ed3 16ff2-16ff6
	187f8-187ff 18cd6-18cda 18cff 18d09-18d20 18d80-18df2 18e00-19191 191a0-191d2 1b123-1b128 1b168 1cc00-1ccfc
	1cd00-1ceb3 1ceba-1ced0 1ced2-1ced4 1cedd-1cefd 1d127-1d128 1d1eb-1d1ff 1d250-1d281 1d6a6 1db00-1db1c
	1df1f-1df24 1df2b-1df81 1df90-1df96 1dfcd-1dfff 1e5d0-1e5fa 1e5ff 1e6c0-1e6de 1e6e0-1e6f5 1e6fe-1e6ff 1f1ae
	1f6d8-1f6d9 1f777-1f77a 1f7da-1f7db 1f7f1-1f7ff 1f8b2-1f8bb 1f8c0-1f8c1 1f8d0-1f8d8 1fa54-1fa57 1fa89-1fa8f
	1fabe 1fac6 1fac8 1facc-1facd 1fadc-1fadd 1fadf 1fae9-1faeb 1faef 1faf9-1fafa 1fbcb-1fbef 1fbfa 2b73a-2b73f
	2b81e 2cea2-2cead 323b0-33479 3d000-3fc3f
	`
		.trim()
		.split(/\s+/)
		.flatMap((range) => {
			const [first, last = first] = range.split("-");
			return [Number.parseInt(first!, 16), Number.parseInt(last!, 16)];
		}),
);

function newerThanCore(codePoint: number): boolean {
	if (codePoint < NEWER_THAN_CORE[0]!) return false;
	// The first range that ends at or after the code point.
	let low = 0;
	let high = NEWER_THAN_CORE.length / 2;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (NEWER_THAN_CORE[middle * 2 + 1]! < codePoint) low = middle + 1;
		else high = middle;
	}
	return low < NEWER_THAN_CORE.length / 2 && NEWER_THAN_CORE[low * 2]! <= codePoint;
}
