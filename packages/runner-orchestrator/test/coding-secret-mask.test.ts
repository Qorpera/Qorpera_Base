import { describe, expect, it } from "vitest";
import { CODING_SECRET_MASK_MINIMUM_BYTES, CodingSecretMask } from "../src/coding-secret-mask.ts";

const SECRET = "tok~~~en?s3cr3t!";
const SPACED = "correct horse battery";

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

function run(mask: CodingSecretMask, chunks: readonly Uint8Array[]): string {
	const stream = mask.stream();
	const parts: Uint8Array[] = [];
	let pushed = 0;
	for (const chunk of chunks) {
		parts.push(stream.push(chunk));
		pushed += chunk.length;
		expect(stream.pending()).toBeLessThanOrEqual(pushed);
	}
	parts.push(stream.end());
	expect(stream.pending()).toBe(0);
	return Buffer.concat(parts).toString("utf8");
}

/** The text whole, then split at every offset into two and into three chunks. */
function splits(text: string): Uint8Array[][] {
	const all = bytes(text);
	const out: Uint8Array[][] = [[all]];
	for (let i = 1; i < all.length; i++) {
		out.push([all.subarray(0, i), all.subarray(i)]);
		for (let j = i + 1; j < all.length; j++) out.push([all.subarray(0, i), all.subarray(i, j), all.subarray(j)]);
	}
	return out;
}

function expectEverySplit(mask: CodingSecretMask, text: string, expected: string): void {
	for (const chunks of splits(text)) {
		const out = run(mask, chunks);
		if (out !== expected) expect({ chunks: chunks.map((chunk) => chunk.length), out }).toEqual({ expected });
	}
}

function percentEveryByte(text: string, upper: boolean): string {
	return [...bytes(text)]
		.map((byte, i) => {
			const hex = byte.toString(16).padStart(2, "0");
			return `%${upper || i % 2 ? hex.toUpperCase() : hex}`;
		})
		.join("");
}

describe("coding secret mask", () => {
	const mask = new CodingSecretMask([SECRET, SPACED, "line-one\nline-two"]);

	it("masks the exact bytes across every chunk boundary", () => {
		expectEverySplit(mask, `before ${SECRET} after`, "before *** after");
		expectEverySplit(mask, `${SECRET}`, "***");
		expectEverySplit(mask, `a ${SPACED}, b`, "a ***, b");
	});

	it("masks URL encoding in either hex case, every byte encoded, and + for a space", () => {
		expectEverySplit(mask, `?v=${encodeURIComponent(SECRET)}&x`, "?v=***&x");
		expectEverySplit(mask, `?v=${encodeURIComponent(SECRET).toLowerCase()}&x`, "?v=***&x");
		expectEverySplit(mask, `?v=${percentEveryByte(SECRET, true)}&x`, "?v=***&x");
		expectEverySplit(mask, `?v=${percentEveryByte(SECRET, false)}&x`, "?v=***&x");
		expectEverySplit(mask, `?${new URLSearchParams({ v: SPACED })}&x`, "?v=***&x");
		expectEverySplit(mask, `?v=${encodeURIComponent(SPACED)}&x`, "?v=***&x");
	});

	it("masks base64 at all three offsets, in both alphabets, padded or not", () => {
		const value = bytes(SECRET);
		const alphabets = new Set<string>();
		for (let offset = 0; offset < 3; offset++) {
			const payload = Buffer.concat([Buffer.from("abc".slice(0, offset)), value, Buffer.from("xy")]);
			const start = Math.ceil((8 * offset) / 6);
			const end = Math.floor((8 * (offset + value.length)) / 6);
			for (const alphabet of ["base64", "base64url"] as const) {
				const text = payload.toString(alphabet);
				alphabets.add(text.slice(start, end));
				expectEverySplit(mask, `b64 ${text} .`, `b64 ${text.slice(0, start)}***${text.slice(end)} .`);
			}
		}
		// The value's base64 differs between the alphabets at some offset.
		expect(alphabets.size).toBe(6);
		const padded = Buffer.from(value).toString("base64");
		expect(padded.endsWith("=")).toBe(true);
		const end = Math.floor((8 * value.length) / 6);
		expectEverySplit(mask, `"${padded}"`, `"***${padded.slice(end)}"`);
		expectEverySplit(mask, `"${padded.replace(/=+$/, "")}"`, `"***${padded.slice(end).replace(/=+$/, "")}"`);
	});

	it("masks a value whose newlines a terminal wrote as CR LF", () => {
		expectEverySplit(mask, "key:\r\nline-one\r\nline-two\r\n$ ", "key:\r\n***\r\n$ ");
		expectEverySplit(mask, "line-one\nline-two", "***");
	});

	it("passes what is not a value, and lets a held tail through at the end", () => {
		const near = `${SECRET.slice(0, -1)}X`;
		expectEverySplit(mask, `before ${near} after`, `before ${near} after`);
		const stream = mask.stream();
		const prefix = bytes(SECRET.slice(0, 10));
		expect(stream.push(prefix)).toHaveLength(0);
		expect(stream.pending()).toBe(prefix.length);
		expect(Buffer.from(stream.end()).toString()).toBe(SECRET.slice(0, 10));
		expect(stream.pending()).toBe(0);
		expect(stream.end()).toHaveLength(0);
		expect(() => stream.push(prefix)).toThrow("ended");
	});

	it("masks overlapping matches once, and adjacent ones without a gap", () => {
		const nested = new CodingSecretMask(["abcdefgh12345678", "12345678"]);
		expectEverySplit(nested, "[abcdefgh12345678]", "[***]");
		expectEverySplit(nested, "[12345678 12345678]", "[*** ***]");
		expectEverySplit(nested, "[12345678abcdefgh12345678]", "[***]");
		const crossed = new CodingSecretMask(["12345678", "5678abcd"]);
		expectEverySplit(crossed, "[12345678abcd]", "[***]");
		expectEverySplit(crossed, "[1234567 5678abc]", "[1234567 5678abc]");
	});

	it("never holds back more than the longest form could take", () => {
		const stream = mask.stream();
		const encoded = percentEveryByte(SPACED, true).slice(0, -1);
		expect(stream.push(bytes(encoded))).toHaveLength(0);
		expect(stream.pending()).toBe(encoded.length);
		expect(stream.pending()).toBeLessThan(3 * bytes(SPACED).length);
		expect(Buffer.from(stream.push(bytes("!\n"))).toString()).toBe(`${encoded}!\n`);
		expect(stream.pending()).toBe(0);
	});

	it("holds back no more for a long run of overlapping matches", () => {
		const periodic = new CodingSecretMask(["abababab"]);
		const stream = periodic.stream();
		const parts: Uint8Array[] = [];
		for (let i = 0; i < 100; i++) {
			parts.push(stream.push(bytes("ab")));
			expect(stream.pending()).toBeLessThan(3 * 8);
		}
		parts.push(stream.end());
		expect(Buffer.concat(parts).toString()).toBe("***");
		expectEverySplit(periodic, "[ababababab]", "[***]");
	});

	it("masks UTF-8 and binary values", () => {
		const unicode = new CodingSecretMask(["pässwörd-ünïcode"]);
		expectEverySplit(unicode, "p=pässwörd-ünïcode;", "p=***;");
		expectEverySplit(unicode, `p=${encodeURIComponent("pässwörd-ünïcode")};`, "p=***;");
		const binary = Uint8Array.from([0, 255, 13, 10, 37, 43, 32, 128, 7, 9]);
		const stream = new CodingSecretMask([binary]).stream();
		const framed = Buffer.concat([Buffer.from("<"), binary, Buffer.from(">")]);
		const out = Buffer.concat([stream.push(framed), stream.end()]);
		expect(out.toString()).toBe("<***>");
	});

	it("masks a value added after the stream started", () => {
		const growing = new CodingSecretMask();
		const stream = growing.stream();
		expect(Buffer.from(stream.push(bytes(`a ${SECRET} b `))).toString()).toBe(`a ${SECRET} b `);
		growing.add(SECRET);
		expect(growing.size).toBe(1);
		growing.add(SECRET);
		expect(growing.size).toBe(1);
		const out = Buffer.concat([stream.push(bytes(`c ${SECRET} d`)), stream.end()]).toString();
		expect(out).toBe("c *** d");
	});

	it("refuses a value too short to mask and passes everything without values", () => {
		expect(CODING_SECRET_MASK_MINIMUM_BYTES).toBe(8);
		expect(() => new CodingSecretMask(["1234567"])).toThrow(RangeError);
		const empty = new CodingSecretMask().stream();
		const chunk = bytes("plain output");
		expect(Buffer.from(empty.push(chunk)).toString()).toBe("plain output");
		expect(empty.pending()).toBe(0);
	});
});
