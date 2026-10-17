import { describe, expect, it } from "vitest";
import { CARRIES, SecretRefusal, SecretSet, type SecretValue, UNCHECKED } from "../src/folder-service/secret-scan.ts";
import { secretHashes as hashesOf, SECRET_KEY as KEY, secretsOf as setOf } from "./folder-service-fixtures.ts";

/** The save check's matcher (5j-5 (a)): a coding machine's secret values as the executor's keyed hashes, and the scan of
 * what the machine saves. The vectors pin the formula the executor's side follows too. */

/** Values and their hashes under `KEY`, as the executor sends them. None is a secret. */
const VECTORS: readonly (SecretValue & { readonly value: string })[] = [
	{ value: "test-value-0001", length: 15, start: 629920, whole: "5X_nxV1CHyqs5ZYNTg0gzw" },
	{ value: "tëst-välue-ø2", length: 16, start: 509688, whole: "xBn2UbqRMZ5bn2atiZ2EMQ" },
	{ value: "12345678", length: 8, start: 482076, whole: "2qRGAeL827FEO7IY3r5SvQ" },
];

/** What scanning `parts` in order ends in: nothing found, or the refusal's message. */
function scanned(set: SecretSet, parts: readonly Buffer[]): string | undefined {
	const scan = set.scan(parts.reduce((sum, part) => sum + part.byteLength, 0));
	try {
		for (const part of parts) scan.push(part);
		scan.end();
		return undefined;
	} catch (error) {
		if (!(error instanceof SecretRefusal)) throw error;
		return error.message;
	}
}

describe("the secret values' hashes", () => {
	it("are the pinned vectors, which find their values and nothing else", () => {
		for (const { value, ...hashes } of VECTORS) expect(hashesOf(KEY, value)).toEqual(hashes);
		const set = new SecretSet(KEY, VECTORS);
		expect(set.size).toBe(3);
		for (const { value } of VECTORS) {
			expect(set.carries(value)).toBe(true);
			expect(set.carries(`docs/${value}/notes.md`)).toBe(true);
			expect(set.carries(value.slice(1))).toBe(false);
			expect(set.carries(`${value.slice(0, -1)}_`)).toBe(false);
		}
		expect(set.carries("")).toBe(false);
		// Under another key the same hashes name other values.
		expect(new SecretSet(Buffer.alloc(32, 7), VECTORS).carries("test-value-0001")).toBe(false);
	});

	it("keep each value once, and tell the values a check against an older set did not look for", () => {
		const older = setOf("test-value-0001", "another-value-02");
		const newer = setOf("another-value-02", "test-value-0001", "a-third-value-03", "a-third-value-03");
		expect(newer.size).toBe(3);
		expect(newer.equals(setOf("a-third-value-03", "another-value-02", "test-value-0001"))).toBe(true);
		expect(newer.equals(older)).toBe(false);
		const since = newer.since(older);
		expect(since.size).toBe(1);
		expect(since.carries("a-third-value-03")).toBe(true);
		expect(since.carries("test-value-0001")).toBe(false);
		expect(newer.since(newer).size).toBe(0);
		expect(newer.since(undefined)).toBe(newer);
		// Under another key nothing was looked for.
		expect(newer.since(new SecretSet(Buffer.alloc(32, 7), [hashesOf(Buffer.alloc(32, 7), "test-value-0001")]))).toBe(
			newer,
		);
	});
});

describe("a file's scan", () => {
	const set = setOf("test-value-0001", "test-value-0001-and-longer", "12345678");

	it("finds a value wherever it is, across any split of the file's chunks", () => {
		for (const value of ["test-value-0001", "test-value-0001-and-longer", "12345678"]) {
			const file = Buffer.from(`before ${value} after`);
			for (let at = 0; at <= file.byteLength; at++)
				expect(scanned(set, [file.subarray(0, at), file.subarray(at)])).toBe(CARRIES);
			expect(
				scanned(
					set,
					[...file].map((byte) => Buffer.from([byte])),
				),
			).toBe(CARRIES);
			expect(scanned(set, [Buffer.from(value)])).toBe(CARRIES);
			expect(scanned(set, [Buffer.from(`${value}`), Buffer.alloc(100_000, 32)])).toBe(CARRIES);
			expect(scanned(set, [Buffer.alloc(100_000, 32), Buffer.from(value)])).toBe(CARRIES);
		}
		// A value cut short, or a byte changed, is no value.
		expect(scanned(set, [Buffer.from("test-value-000"), Buffer.from("2 and 1234567")])).toBeUndefined();
		expect(scanned(setOf("test-value-0001-and-longer"), [Buffer.from("test-value-0001-and-longe")])).toBeUndefined();
		expect(scanned(set, [Buffer.alloc(0)])).toBeUndefined();
		expect(scanned(set, [])).toBeUndefined();
	});

	it("scans nothing for a set with no values", () => {
		expect(scanned(new SecretSet(KEY, []), [Buffer.from("test-value-0001")])).toBeUndefined();
		expect(new SecretSet(KEY, []).carries("test-value-0001")).toBe(false);
	});

	it("refuses a file as not checked once its candidates cost more than the bound, and names nothing", () => {
		// Every 8 bytes the window of a long value's start: one hash over the value's length each.
		const long = `test-val${"x".repeat(32 * 1024 - 8)}`;
		const bound = setOf(long);
		const file = Buffer.from("test-val".repeat(8 * 1024));
		expect(scanned(bound, [file])).toBe(UNCHECKED);
		expect(scanned(bound, [file.subarray(0, 40 * 1024)])).toBeUndefined();
		// The refusal holds neither the value, nor its hashes, nor where.
		const scan = bound.scan(file.byteLength);
		let refusal: unknown;
		try {
			scan.push(file);
			scan.end();
		} catch (error) {
			refusal = error;
		}
		expect(refusal).toBeInstanceOf(SecretRefusal);
		const { message, stack } = refusal as SecretRefusal;
		expect(message).toBe(UNCHECKED);
		expect(`${stack}`.split("\n")[0]).toBe(`SecretRefusal: ${UNCHECKED}`);
		expect(`${stack}`).not.toMatch(/test-val|xxxx/);
		expect(`${stack}`).not.toContain(hashesOf(KEY, long).whole);
	});
});
