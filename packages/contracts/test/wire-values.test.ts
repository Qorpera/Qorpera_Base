import { describe, expect, it } from "vitest";
import {
	isUuid,
	parseBoundedText,
	parseClosedRecord,
	parseInteger,
	parseRecord,
	parseSha256Hex,
	parseTimestamp,
	parseUuid,
	UUID_PATTERN,
	WireValueError,
} from "../src/index.ts";

const lower = "0f5d6a1e-7c1b-4a6e-9f10-2b3c4d5e6f70";

describe("wire values", () => {
	it("accepts a UUID in either letter case and returns the lower case the database prints", () => {
		expect(parseUuid(lower, "id")).toBe(lower);
		expect(parseUuid(lower.toUpperCase(), "id")).toBe(lower);
		expect(parseUuid("0F5d6A1e-7C1b-4A6e-9F10-2b3C4d5E6f70", "id")).toBe(lower);
		expect(isUuid(lower.toUpperCase())).toBe(true);
		expect(UUID_PATTERN.flags).toContain("i");
	});

	it.each([
		["no hyphens", "0f5d6a1e7c1b4a6e9f102b3c4d5e6f70"],
		["braces", `{${lower}}`],
		["surrounding space", ` ${lower}`],
		["version 0", "0f5d6a1e-7c1b-0a6e-9f10-2b3c4d5e6f70"],
		["version 9", "0f5d6a1e-7c1b-9a6e-9f10-2b3c4d5e6f70"],
		["an NCS variant", "0f5d6a1e-7c1b-4a6e-7f10-2b3c4d5e6f70"],
		["the nil UUID", "00000000-0000-0000-0000-000000000000"],
		["a non-hex letter", "0f5d6a1e-7c1b-4a6e-9f10-2b3c4d5e6f7g"],
		["a number", 7],
		["null", null],
	])("refuses %s as a UUID", (_label, value) => {
		expect(isUuid(value)).toBe(false);
		expect(() => parseUuid(value, "Run id")).toThrow(new WireValueError("Run id"));
	});

	it("takes SHA-256 digests only as lower-case hex, the way they are compared", () => {
		const digest = "a".repeat(64);
		expect(parseSha256Hex(digest, "digest")).toBe(digest);
		for (const value of ["A".repeat(64), "a".repeat(63), "a".repeat(65), `${"a".repeat(63)}g`, 1])
			expect(() => parseSha256Hex(value, "digest")).toThrow(WireValueError);
	});

	it("checks plain and closed objects", () => {
		expect(parseRecord({ a: 1 }, "body")).toEqual({ a: 1 });
		for (const value of [null, [], "x", 1, undefined])
			expect(() => parseRecord(value, "body")).toThrow("body is invalid");
		expect(parseClosedRecord({ a: 1, b: 2 }, "body", ["a"], ["b"])).toEqual({ a: 1, b: 2 });
		expect(parseClosedRecord({ a: 1 }, "body", ["a"], ["b"])).toEqual({ a: 1 });
		expect(() => parseClosedRecord({ a: 1, c: 3 }, "body", ["a"], ["b"])).toThrow("body has an unknown field");
		expect(() => parseClosedRecord({ b: 2 }, "body", ["a"], ["b"])).toThrow("body is missing a");
		// An inherited key is not a field.
		expect(() => parseClosedRecord(Object.create({ a: 1 }), "body", ["a"])).toThrow("body is missing a");
	});

	it("bounds text, integers and times", () => {
		expect(parseBoundedText("hello", "name", 5)).toBe("hello");
		expect(parseBoundedText("  ", "note", 5, 0)).toBe("  ");
		for (const value of ["hello!", "   ", "a\0b", 5])
			expect(() => parseBoundedText(value, "name", 5)).toThrow(WireValueError);
		expect(parseInteger(3, "count", 0, 3)).toBe(3);
		for (const value of [4, -1, 1.5, "3", Number.MAX_SAFE_INTEGER + 1])
			expect(() => parseInteger(value, "count", 0, 3)).toThrow(WireValueError);
		expect(parseTimestamp("2026-09-29T10:00:00+02:00", "at")).toBe("2026-09-29T08:00:00.000Z");
		for (const value of ["yesterday", "", 0, "2".repeat(65)])
			expect(() => parseTimestamp(value, "at")).toThrow(WireValueError);
	});

	it("never puts the refused value in its message", () => {
		const secret = "sk-live-PRIVATE-value";
		for (const check of [
			() => parseUuid(secret, "Run id"),
			() => parseSha256Hex(secret, "digest"),
			() => parseBoundedText(secret, "name", 3),
			() => parseTimestamp(secret, "at"),
		]) {
			expect(check).toThrow(WireValueError);
			try {
				check();
			} catch (error) {
				expect((error as Error).message).not.toContain(secret);
			}
		}
	});
});
