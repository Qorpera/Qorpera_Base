import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { folderKey } from "../packages/contracts/src/folder-key.ts";
import { hostedDatabase } from "./test-hosted-db-cluster.mjs";

/** The folder's key in JavaScript (@qorpera/contracts' folderKey) against the folder core's own,
 * `public.qorpera_folder_key`: every code point a text value can hold, alone (U+0001 to U+10FFFF without the
 * surrogates; text never holds U+0000), then whole paths that mix them, a fixed list and seeded random ones. The
 * database's key is the canonical one, so any difference fails, named by code point. */

const databaseName = "qorpera_folder_key";
const LAST = 0x10ffff;
const RANDOM_PATHS = 20_000;

const surrogate = (c) => c >= 0xd800 && c <= 0xdfff;
const hex = (c) => `U+${c.toString(16).toUpperCase().padStart(4, "0")}`;
const spell = (text) => [...text].map((char) => hex(char.codePointAt(0))).join(" ") || "(empty)";
const chars = (...codePoints) => String.fromCodePoint(...codePoints);

/** Paths whose keys the code points alone don't show: context (the final sigma), NFKC across the case mapping, and
 * the code points whose full case mapping is several code points. */
const PATHS = [
	"Straße/ÖKONOMI/Notes.md",
	"STRASSE/økonomi/notes.md",
	"İstanbul/Iİıi",
	"ΟΔΟΣ/Σίσυφος/ΣΣ.md",
	"ᾼᾳᾈᾀ/ῼῳ/ῌῃ",
	"ǰ/ΐ/ŉ/ﬀ/ﬆ",
	"ﬁle.TXT/ＡＢＣ①/㎒",
	"Ǆǅǆ/ǈ/ǋ",
	"ẞ/ß/ss",
	"Ꭰꭰᏸ/𐐀𐐨/𞤀𞤢",
	chars(0x212a, 0x2f, 0x2103, 0x2f, 0x212b),
	chars(0x65, 0x301, 0x2f, 0x41, 0x30a, 0x2f, 0x3b1, 0x301, 0x345, 0x2f, 0x391, 0x345, 0x301),
	chars(0x1100, 0x1161, 0x11a8, 0x2f, 0xac00, 0x11a8),
	chars(0x49, 0x307, 0x2f, 0x69, 0x307, 0x2f, 0x130, 0x301),
	// Code points newer than the core's Unicode, between ones it knows: a combining mark it would reorder, a base
	// it would compose with a known mark, a capital and an outlined letter it would fold.
	chars(0x61, 0x897, 0x323, 0x2f, 0x61, 0x323, 0x897),
	chars(0x105d2, 0x307, 0x2f, 0x1138b, 0x113c2, 0x2f, 0x1611e, 0x1611e),
	chars(0x41, 0xa7cb, 0x264, 0x2f, 0x10d50, 0x10d70, 0x2f, 0x1ccd6, 0x42, 0xff21),
];

/** A seeded PRNG (mulberry32), so a failure names a path the next run builds again. */
function random(seed) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Short paths drawn mostly from the scripts where case mapping and NFKC meet: Latin, Greek and its extended block,
 * combining marks, Hangul jamo and syllables, compatibility forms, and some from anywhere. */
function randomPaths(count) {
	const next = random(0x51f0);
	const pick = (from, to) => from + Math.floor(next() * (to - from + 1));
	const RANGES = [
		[0x20, 0x7e],
		[0xc0, 0x24f],
		[0x300, 0x36f],
		[0x370, 0x3ff],
		[0x1f00, 0x1fff],
		[0x400, 0x52f],
		[0x1100, 0x11ff],
		[0xac00, 0xd7a3],
		[0x2100, 0x218f],
		[0xfb00, 0xfb4f],
		[0xff00, 0xffef],
		[0x1d400, 0x1d7ff],
	];
	const codePoint = () => {
		if (next() < 0.15) {
			for (;;) {
				const c = pick(1, LAST);
				if (!surrogate(c)) return c;
			}
		}
		const [from, to] = RANGES[Math.floor(next() * RANGES.length)];
		return pick(from, to);
	};
	return Array.from({ length: count }, () => {
		let path = "";
		for (let length = pick(1, 10); length > 0; length--) path += next() < 0.1 ? "/" : String.fromCodePoint(codePoint());
		return path;
	});
}

async function main() {
	const database = await hostedDatabase(databaseName);
	try {
		const run = (sql) => database.cluster.psql(databaseName, sql, ["-qAt"]).trim();
		const unicode = run("select unicode_version();");
		process.stdout.write(
			`Folder key: PostgreSQL Unicode ${unicode}; Node ${process.versions.node} Unicode ${process.versions.unicode} (ICU ${process.versions.icu})\n`,
		);
		assert.equal(
			unicode,
			"15.1",
			"The core's Unicode moved: take its code points out of NEWER_THAN_CORE in packages/contracts/src/folder-key.ts",
		);

		// Every code point whose key is not the code point itself.
		const core = new Map(
			Object.entries(
				JSON.parse(
					run(`select coalesce(jsonb_object_agg(c, k), '{}')::text from (
						select c, public.qorpera_folder_key(chr(c)) as k
						from generate_series(1, ${LAST}) c where c not between ${0xd800} and ${0xdfff}
					) x where k <> chr(c);`),
				),
			).map(([c, key]) => [Number(c), key]),
		);
		assert.ok(core.size > 5000, `The core changes ${core.size} code points: too few for NFKC and case folding`);
		assert.equal(core.get(0x41), "a", "The core folds A");
		assert.equal(core.get(0x1e9e), "ß", "The core folds ẞ to ß");
		assert.equal(core.get(0x130), "i", "The core folds İ to i (simple case mapping)");
		assert.equal(core.get(0xdf), undefined, "The core keeps ß (simple case mapping)");
		assert.equal(core.get(0x1fb3), undefined, "The core keeps ᾳ (simple case mapping)");

		const differences = [];
		let checked = 0;
		for (let c = 1; c <= LAST; c++) {
			if (surrogate(c)) continue;
			checked++;
			const char = String.fromCodePoint(c);
			const expected = core.get(c) ?? char;
			const key = folderKey(char);
			if (key !== expected) differences.push(`${hex(c)}: folderKey ${spell(key)}, qorpera_folder_key ${spell(expected)}`);
		}

		const paths = [...PATHS, ...randomPaths(RANDOM_PATHS)];
		const json = JSON.stringify(paths);
		if (json.includes("$paths$")) throw new Error("A path holds the SQL quote: change the random seed");
		const keys = JSON.parse(
			run(`select jsonb_agg(public.qorpera_folder_key(p) order by n)::text
				from jsonb_array_elements_text($paths$${json}$paths$::jsonb) with ordinality as t(p, n);`),
		);
		assert.equal(keys.length, paths.length, "The core keyed every path");
		paths.forEach((path, i) => {
			const key = folderKey(path);
			if (key !== keys[i])
				differences.push(`path ${spell(path)}: folderKey ${spell(key)}, qorpera_folder_key ${spell(keys[i])}`);
		});

		if (differences.length > 0)
			throw new Error(
				`folderKey differs from qorpera_folder_key in ${differences.length} places:\n${differences.join("\n")}`,
			);
		process.stdout.write(
			`Folder key checks passed (${checked} code points, ${core.size} of them changed by the key; ${paths.length} paths)\n`,
		);
	} finally {
		database.close();
	}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	await main();
}
